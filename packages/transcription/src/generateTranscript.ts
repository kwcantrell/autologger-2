// Shared DeepGram transcript generation used by the HTTP generate route and
// sheets-log-import (auto-generate when timed words are missing).

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobStore, Config } from '@autologger/ports';
import {
  holdRunLease,
  type RunLeaseHold,
  type SessionHubFacade,
  type TimecodeCtx,
  type TranscriptWord,
} from '@autologger/session-core';
import { mergeAudioSegments } from './audioMerge';
import type { TranscribeGroupResult } from './deepgram';
import { DeepgramUpstreamError, transcribeGroup } from './deepgram';
import { deepgramConfigured, deepgramModel } from './deepgramConfig';
import { generationInFlightDetail, transcriptGenerationLock } from './transcriptGenerationLock';
import type { EnrichmentGroup, SegmentAnchorInfo } from './transcriptRemap';
import {
  recordingStartAnchors,
  remapTranscriptEnrichment,
  remapTranscriptWords,
} from './transcriptRemap';

export const DEEPGRAM_MAX_GROUP_BYTES = 2_000_000_000;

export const TRANSCRIPT_UNAVAILABLE = 'Transcription is unavailable on this deployment.';
/** Fallback detail when the holder title cannot be resolved (rare). */
export const GENERATION_IN_FLIGHT_DETAIL =
  'A transcript generation run is already in progress on this deployment; try again once it completes.';
export const NO_AUDIO_DETAIL = 'This session has no recorded audio to transcribe.';
export const ALL_UNREADABLE_DETAIL =
  "None of this session's recorded audio segments could be read for transcription.";
export const NO_SPEECH_DETAIL =
  "DeepGram detected no speech in this session's audio; the existing transcript was left unchanged.";
export const UPSTREAM_FAILURE_DETAIL = 'DeepGram transcription failed or timed out.';

export class TranscriptGenerateError extends Error {
  constructor(
    readonly code:
      | 'unavailable'
      | 'in_flight'
      | 'no_audio'
      | 'unreadable'
      | 'no_speech'
      | 'upstream'
      | 'oversize',
    message: string,
    /** in_flight only: the session whose identifiers `message` names (always the requested one). */
    readonly holderSessionId?: string,
  ) {
    super(message);
    this.name = 'TranscriptGenerateError';
  }
}

function sizeLimitDetail(bytes: number): string {
  return `Combined audio for one codec group is ${bytes} bytes, over DeepGram's ${DEEPGRAM_MAX_GROUP_BYTES}-byte (2 GB) upload limit.`;
}

export function exceedsGroupSizeLimit(bytes: number): boolean {
  return bytes > DEEPGRAM_MAX_GROUP_BYTES;
}

export interface GenerateTranscriptDeps {
  config: Config;
  audio: BlobStore;
  /** Resolves the session hub at the point of use, so a reference is never held idle across
   * the provider call (async-session-hub design D6). */
  getHub: () => Promise<SessionHubFacade>;
  ctx: TimecodeCtx;
  sessionId: string;
  /** Optional abort before the provider call starts. */
  signal?: AbortSignal | null;
  /** Optional catalog title lookup for enriched 409 detail (lock-status). */
  resolveSessionTitle?: (sessionId: string) => string | null | Promise<string | null>;
}

/** The `in_flight` refusal for `deps.sessionId` (run-status-and-sweeper D3): the holder-named
 * detail when the run's start is known, else `GENERATION_IN_FLIGHT_DETAIL`. Either way the holder
 * is the requested session. */
async function inFlightError(
  deps: GenerateTranscriptDeps,
  startedAtMs: number | null,
): Promise<TranscriptGenerateError> {
  const detail =
    startedAtMs === null
      ? GENERATION_IN_FLIGHT_DETAIL
      : generationInFlightDetail(
          deps.sessionId,
          (await deps.resolveSessionTitle?.(deps.sessionId)) ?? null,
          startedAtMs,
        );
  return new TranscriptGenerateError('in_flight', detail, deps.sessionId);
}

/** Run DeepGram transcription and atomically replace session words. */
export async function generateTranscriptWords(
  deps: GenerateTranscriptDeps,
): Promise<TranscriptWord[]> {
  if (!deepgramConfigured(deps.config)) {
    throw new TranscriptGenerateError('unavailable', TRANSCRIPT_UNAVAILABLE);
  }
  // The session's run in this process (run-status-and-sweeper D3): only the same session is
  // refused, with the holder-named detail at this process's start of the run. The holder is always
  // the requested session; it rides on the error so the route redacts by the session the detail
  // names (async-session-callers D5).
  if (!transcriptGenerationLock.tryAcquire(deps.sessionId)) {
    const startedAtMs = transcriptGenerationLock.startedAt(deps.sessionId);
    throw await inFlightError(deps, startedAtMs);
  }

  const blobStore = deps.audio;
  let scratchDir: string | null = null;
  let lease: RunLeaseHold | null = null;
  try {
    // The session's `transcript-generation` run lease, inside the try so a claim that throws still
    // frees the session's run (session-run-leases D4). The run already excludes this process, so a
    // refusal means another process generates for this session: the holder-named detail at the
    // lease's start, or the generic detail when the live row has no start (it expired or was
    // released in between, or pre-9c code wrote it; run-status-and-sweeper D3).
    lease = await holdRunLease({
      getHub: deps.getHub,
      kind: 'transcript-generation',
      sessionId: deps.sessionId,
    });
    if (lease === null) {
      const startedAtMs = await (await deps.getHub()).runLeaseStartedAt('transcript-generation');
      throw await inFlightError(deps, startedAtMs);
    }

    const segments = await (await deps.getHub()).listAudioSegments();
    if (segments.length === 0) {
      throw new TranscriptGenerateError('no_audio', NO_AUDIO_DETAIL);
    }

    scratchDir = await mkdtemp(join(blobStore.scratchRoot(), `${deps.sessionId}-`));
    const inputPaths = segments.map((s) => blobStore.resolveKeyPath(s.r2_key));

    const { groups } = await mergeAudioSegments(inputPaths, scratchDir);
    if (groups.length === 0) {
      throw new TranscriptGenerateError('unreadable', ALL_UNREADABLE_DETAIL);
    }

    if (deps.signal?.aborted) {
      throw new TranscriptGenerateError(
        'unreadable',
        'Transcript generation request was aborted before transcription started; no provider request was made.',
      );
    }

    const apiKey = deps.config.DEEPGRAM_API_KEY;
    const model = deepgramModel(deps.config);
    const enrichmentGroups: EnrichmentGroup[] = [];
    for (const group of groups) {
      const { size } = await stat(group.outPath);
      if (exceedsGroupSizeLimit(size)) {
        throw new TranscriptGenerateError('oversize', sizeLimitDetail(size));
      }
      if (deps.signal?.aborted) {
        throw new TranscriptGenerateError(
          'unreadable',
          'Transcript generation request was aborted before transcription started; no provider request was made.',
        );
      }
      let result: TranscribeGroupResult;
      try {
        result = await transcribeGroup({
          outPath: group.outPath,
          family: group.family,
          apiKey,
          model,
        });
      } catch (err) {
        if (err instanceof DeepgramUpstreamError) {
          throw new TranscriptGenerateError('upstream', UPSTREAM_FAILURE_DETAIL);
        }
        throw err;
      }
      enrichmentGroups.push({
        segments: group.segments,
        words: result.words,
        paragraphs: result.paragraphs,
        sentiments: result.sentiments,
      });
    }

    const segmentInfo: SegmentAnchorInfo[] = segments.map((s, i) => ({
      path: inputPaths[i],
      ordinal: s.ordinal,
      recordingOrdinal: s.recording_ordinal,
      // chunked-live-recording task 3.1 (design D5) — threaded from
      // AudioSegmentMeta.started_at_utc for task 3.2's per-member
      // event-wall-time anchor derivation; resolveAnchors (transcriptRemap.ts)
      // consumes it as of task 3.2 to compute each member's anchor as
      // `A + max(0, (startedAtUtc - eventWallTimeUtc) / 1000)`.
      startedAtUtc: s.started_at_utc,
    }));
    // The anchors read, the remap and the replace are one hub transaction (async-session-hub
    // design D7, S9), so the words are remapped against the anchors the replace commits with. A
    // `no_speech` throw from inside the remap rolls it back and writes nothing. `return await`:
    // the finally below releases the lease and then the session's run only after the replace
    // has committed.
    const hub = await deps.getHub();
    return await hub.replaceTranscriptWordsRemapped((events) => {
      const anchors = recordingStartAnchors(events);
      const remappedWords = remapTranscriptWords(
        enrichmentGroups,
        segmentInfo,
        anchors,
        deps.ctx.frameRate,
      );
      if (remappedWords.length === 0) {
        throw new TranscriptGenerateError('no_speech', NO_SPEECH_DETAIL);
      }
      return {
        words: remappedWords,
        enrichment: remapTranscriptEnrichment(enrichmentGroups, segmentInfo, anchors),
      };
    });
  } finally {
    // The lease, then the session's run (session-run-leases D4 step 3), then the scratch dir.
    if (lease !== null) await lease.release();
    transcriptGenerationLock.release(deps.sessionId);
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  }
}
