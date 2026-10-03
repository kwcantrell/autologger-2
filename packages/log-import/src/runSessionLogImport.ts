import type { CategoryRecord } from '@autologger/domain';
import type { SessionHubFacade, TimecodeCtx } from '@autologger/session-core';
import { mapLogCategory } from './categoryMatch';
import type { ParsedLogRow } from './sheetsFetch';
import { secondsToTotalFrames } from './sheetTimecode';
import { syncLogRowsToSeams, type TranscriptToken } from './syncScore';

export interface SessionLogImportResult {
  created: number;
  skipped: number;
  lines: string[];
}

/** Consumed by `routers/logImport.ts`'s `ensureTimedTranscript` coordinator
 * (feature-service-packages D2) — no caller remains in this module. */
export async function timedTranscriptTokens(hub: SessionHubFacade): Promise<TranscriptToken[]> {
  const words = await hub.listTranscriptWords();
  const out: TranscriptToken[] = [];
  for (const w of words) {
    const start = Number(w.start_sec);
    if (!Number.isFinite(start) || start <= 0) continue;
    if (!String(w.word ?? '').trim()) continue;
    out.push({ word: String(w.word), startSec: start });
  }
  return out;
}

async function seamPartsForSession(hub: SessionHubFacade): Promise<{ duration_s: number }[]> {
  const seams = await hub.getAudioSeamParts();
  if (seams && seams.length > 0) return seams;
  const segs = await hub.listAudioSegments();
  if (segs.length === 0) throw new Error('Session has no audio segments.');
  const seg = segs[0];
  if (seg.started_at_utc && seg.ended_at_utc) {
    const ms = Date.parse(seg.ended_at_utc) - Date.parse(seg.started_at_utc);
    if (Number.isFinite(ms) && ms > 0) return [{ duration_s: ms / 1000 }];
  }
  throw new Error('Session is missing stitch seam metadata; re-import audio with seam parts.');
}

/** Import parsed log rows into a session event feed (sync + create-at-frames). Async so the
 * catalog mirror (`projectLive`) can be awaited (async-session-callers D5). */
export async function runSessionLogImport(input: {
  hub: SessionHubFacade;
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
  }) => void | Promise<void>;
}): Promise<SessionLogImportResult> {
  const lines: string[] = [];
  if (input.transcript.length === 0) {
    throw new Error('Transcript is missing or untimed after ensure step.');
  }

  const parts = await seamPartsForSession(input.hub);
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

  let created = 0;
  let skipped = 0;
  let lastProjection: Parameters<typeof input.projectLive>[0] | null = null;

  for (const a of sync.assignments) {
    const mapped = mapLogCategory(a.row.type, a.row.message, input.categories);
    const frames = secondsToTotalFrames(a.sessionSec, input.ctx.frameRate);
    const meta: Record<string, unknown> = { imported_from_sheets: true };
    if (mapped.importOption) meta.import_option = mapped.importOption;
    // The duplicate check (a non-internal event with the same frames and message) and the insert
    // are one hub transaction per row (async-session-hub design D7, S10): a later identical row of
    // this batch, or a row a concurrent import stored, is skipped.
    const result = await input.hub.addEventAtTotalFramesIfAbsent({
      category: mapped.categoryId,
      message: mapped.message,
      metadataJson: JSON.stringify(meta),
      timecodeTotalFrames: frames,
      ctx: input.ctx,
    });
    if (!result.created) {
      skipped += 1;
      continue;
    }
    created += 1;
    lastProjection = result.projection;
  }

  if (lastProjection) await input.projectLive(lastProjection);
  lines.push(`Created ${created}, skipped ${skipped} duplicate(s).`);
  return { created, skipped, lines };
}
