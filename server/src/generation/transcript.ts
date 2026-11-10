// The transcript step (OpenSpec change `batch-autogenerate`, design D6, D7, D9): the runner shared
// by `POST /api/sessions/:sessionId/transcript-words/generate` and the batch worker. It resolves
// the principal's speech-to-text credential (unconfigured before forbidden, the route's frozen
// order), applies the approved-user rule, then runs `generateTranscriptWords` (the in-process
// session run and the `transcript-generation` run lease) and returns a typed outcome instead of an
// HTTP answer. The route maps each outcome to its unchanged status and detail.

import type { Row } from '@autologger/catalog';
import { TranscriptNotEmptyError, type TranscriptWord } from '@autologger/session-core';
import { generateTranscriptWords, TranscriptGenerateError } from '@autologger/transcription';
import { resolveSttCredential } from '../auth/providerResolve';
import { runFeatureAllowed } from '../env';
import { type GenerationPrincipal, hubFor, isRateLimitStatus, timecodeCtx } from './principal';

/** A failed or refused generation, by `TranscriptGenerateError` code (plus `rate-limited`, an
 * `upstream` failure the provider answered `429`). */
export type TranscriptErrorCode =
  | 'no_audio'
  | 'no_speech'
  | 'upstream'
  | 'rate-limited'
  | 'oversize'
  | 'missing_blob'
  | 'unreadable';

export type TranscriptOutcome =
  | { kind: 'unconfigured' }
  | { kind: 'forbidden' }
  /** The session's run is held (here or by another process): the route's 409, whose detail may
   * name the holder session. */
  | { kind: 'busy'; detail: string; holderSessionId: string | undefined }
  /** `onlyIfEmpty` and the session gained words: nothing was written. */
  | { kind: 'present' }
  | { kind: 'error'; code: TranscriptErrorCode; detail: string }
  | { kind: 'ok'; words: TranscriptWord[] };

export interface TranscriptRunOptions {
  /** The session's catalog row (its frame rate and offset). */
  row: Row;
  /** Write only into a still-empty transcript (the batch's gap rule). */
  onlyIfEmpty?: boolean;
  /** Abort before the provider call starts (the request's signal). */
  signal?: AbortSignal | null;
}

/** The outcome of a generation error; anything else rethrows. */
export function transcriptOutcomeOf(err: unknown): TranscriptOutcome {
  if (err instanceof TranscriptNotEmptyError) return { kind: 'present' };
  if (!(err instanceof TranscriptGenerateError)) throw err;
  switch (err.code) {
    case 'in_flight':
      return { kind: 'busy', detail: err.message, holderSessionId: err.holderSessionId };
    case 'unavailable':
      return { kind: 'unconfigured' };
    case 'upstream':
      return {
        kind: 'error',
        code: isRateLimitStatus(err.upstreamStatus) ? 'rate-limited' : 'upstream',
        detail: err.message,
      };
    default:
      return { kind: 'error', code: err.code, detail: err.message };
  }
}

export async function runTranscript(
  p: GenerationPrincipal,
  sessionId: string,
  opts: TranscriptRunOptions,
): Promise<TranscriptOutcome> {
  // byo-ai-providers D3: the principal's own speech-to-text key; none is unconfigured, before the
  // approval check (the route's frozen order).
  const stt = await resolveSttCredential(p.env, p.user.id);
  if (stt === null) return { kind: 'unconfigured' };
  if (!runFeatureAllowed(p.env.config, p.user)) return { kind: 'forbidden' };
  try {
    const words = await generateTranscriptWords({
      stt,
      audio: p.env.ports.audio,
      getHub: () => hubFor(p, sessionId),
      ctx: timecodeCtx(opts.row),
      sessionId,
      signal: opts.signal,
      resolveSessionTitle: async (id) => {
        const row = await p.catalog.sessions.getSessionIndexRow(id);
        return row === null ? null : String(row.title ?? '');
      },
      ...(opts.onlyIfEmpty === true ? { onlyIfEmpty: true } : {}),
    });
    return { kind: 'ok', words };
  } catch (err) {
    return transcriptOutcomeOf(err);
  }
}
