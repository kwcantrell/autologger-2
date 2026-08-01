import type { CategoryRecord } from '../studio';
import type { SessionHub } from '../session/SessionHub';
import type { TimecodeCtx } from '../session/sessionCore';
import type { Bindings, Config } from '../types';
import { generateTranscriptWords, TranscriptGenerateError } from '../node/generateTranscript';
import { mapLogCategory } from './categoryMatch';
import type { ParsedLogRow } from './sheetsFetch';
import { secondsToTotalFrames } from './sheetTimecode';
import { syncLogRowsToSeams, type TranscriptToken } from './syncScore';

export interface SessionLogImportResult {
  created: number;
  skipped: number;
  lines: string[];
}

export function timedTranscriptTokens(hub: SessionHub): TranscriptToken[] {
  const words = hub.listTranscriptWords();
  const out: TranscriptToken[] = [];
  for (const w of words) {
    const start = Number(w.start_sec);
    if (!Number.isFinite(start) || start <= 0) continue;
    if (!String(w.word ?? '').trim()) continue;
    out.push({ word: String(w.word), startSec: start });
  }
  return out;
}

function seamPartsForSession(hub: SessionHub): { duration_s: number }[] {
  const seams = hub.getAudioSeamParts();
  if (seams && seams.length > 0) return seams;
  const segs = hub.listAudioSegments();
  if (segs.length === 0) throw new Error('Session has no audio segments.');
  const seg = segs[0];
  if (seg.started_at_utc && seg.ended_at_utc) {
    const ms = Date.parse(seg.ended_at_utc) - Date.parse(seg.started_at_utc);
    if (Number.isFinite(ms) && ms > 0) return [{ duration_s: ms / 1000 }];
  }
  throw new Error('Session is missing stitch seam metadata; re-import audio with seam parts.');
}

/** Ensure timed transcript words exist; generate via DeepGram when missing. */
export async function ensureTimedTranscript(input: {
  sessionId: string;
  getHub: () => SessionHub;
  config: Config;
  audio: Bindings['ports']['audio'];
  ctx: TimecodeCtx;
  onProgress: (line: string) => void;
}): Promise<TranscriptToken[]> {
  let tokens = timedTranscriptTokens(input.getHub());
  if (tokens.length > 0) {
    input.onProgress(`Transcript already present (${tokens.length} timed words).`);
    return tokens;
  }

  input.onProgress('Generating transcript (DeepGram)…');
  const attempt = async (): Promise<TranscriptToken[]> => {
    const words = await generateTranscriptWords({
      config: input.config,
      audio: input.audio,
      getHub: input.getHub,
      ctx: input.ctx,
      sessionId: input.sessionId,
    });
    const next = timedTranscriptTokens(input.getHub());
    if (next.length === 0) {
      throw new Error(
        `Transcript generation finished (${words.length} words) but none have usable timing for sync.`,
      );
    }
    return next;
  };

  try {
    tokens = await attempt();
    input.onProgress(`Transcript ready (${tokens.length} timed words).`);
    return tokens;
  } catch (err) {
    const isUpstream =
      err instanceof TranscriptGenerateError &&
      (err.code === 'upstream' || err.code === 'in_flight');
    if (isUpstream) {
      input.onProgress(
        `Transcript generation failed (${err.message}); retrying once…`,
      );
      // Brief pause: clears in-flight slot races and transient DeepGram blips.
      await new Promise((r) => setTimeout(r, 2000));
      try {
        tokens = await attempt();
        input.onProgress(`Transcript ready after retry (${tokens.length} timed words).`);
        return tokens;
      } catch (retryErr) {
        if (retryErr instanceof TranscriptGenerateError) {
          throw new Error(`Transcript generation failed: ${retryErr.message}`);
        }
        throw retryErr;
      }
    }
    if (err instanceof TranscriptGenerateError) {
      throw new Error(`Transcript generation failed: ${err.message}`);
    }
    throw err;
  }
}

/** Import parsed log rows into a session event feed (sync + create-at-frames). */
export function runSessionLogImport(input: {
  hub: SessionHub;
  rows: ParsedLogRow[];
  categories: CategoryRecord[];
  ctx: TimecodeCtx;
  /** Pre-resolved timed transcript tokens (after ensureTimedTranscript). */
  transcript: TranscriptToken[];
  projectLive: (projection: {
    event_count: number;
    max_timecode_total_frames: number | null;
    is_rolling: boolean;
    current_take: number;
    transport_elapsed_frames: number;
    roll_started_at_utc: string | null;
  }) => void;
}): SessionLogImportResult {
  const lines: string[] = [];
  if (input.transcript.length === 0) {
    throw new Error('Transcript is missing or untimed after ensure step.');
  }

  const parts = seamPartsForSession(input.hub);
  const sync = syncLogRowsToSeams(
    input.rows.map((r) => ({ sheetSec: r.sheetSec, message: r.message, type: r.type })),
    parts,
    input.transcript,
  );

  for (const p of sync.parts) {
    lines.push(
      `Part ${p.partIndex + 1}: offset ${p.offsetSec.toFixed(2)}s (score ${p.confidence.toFixed(2)}; ref “${p.ref.message.slice(0, 48)}”)`,
    );
  }

  const existing = input.hub.exportEvents().filter((e) => e.category.toLowerCase() !== 'internal');
  const existingKeys = new Set(
    existing.map((e) => `${e.timecode_total_frames ?? ''}\n${e.message}`),
  );

  let created = 0;
  let skipped = 0;
  let lastProjection: Parameters<typeof input.projectLive>[0] | null = null;

  for (const a of sync.assignments) {
    const mapped = mapLogCategory(a.row.type, a.row.message, input.categories);
    const frames = secondsToTotalFrames(a.sessionSec, input.ctx.frameRate);
    const key = `${frames}\n${mapped.message}`;
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    const meta: Record<string, unknown> = { imported_from_sheets: true };
    if (mapped.importOption) meta.import_option = mapped.importOption;
    const { projection } = input.hub.addEventAtTotalFrames({
      category: mapped.categoryId,
      message: mapped.message,
      metadataJson: JSON.stringify(meta),
      timecodeTotalFrames: frames,
      ctx: input.ctx,
    });
    existingKeys.add(key);
    created += 1;
    lastProjection = projection;
  }

  if (lastProjection) input.projectLive(lastProjection);
  lines.push(`Created ${created}, skipped ${skipped} duplicate(s).`);
  return { created, skipped, lines };
}
