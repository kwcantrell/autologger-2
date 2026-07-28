import type { CategoryRecord } from '../studio';
import type { SessionHub } from '../session/SessionHub';
import type { TimecodeCtx } from '../session/sessionCore';
import { mapLogCategory } from './categoryMatch';
import type { ParsedLogRow } from './sheetsFetch';
import { secondsToTotalFrames } from './sheetTimecode';
import { syncLogRowsToSeams, type TranscriptToken } from './syncScore';

export interface SessionLogImportResult {
  created: number;
  skipped: number;
  lines: string[];
}

function timedTranscriptTokens(hub: SessionHub): TranscriptToken[] {
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
  // Fallback: one part from first segment wall clock span if present.
  const seg = segs[0];
  if (seg.started_at_utc && seg.ended_at_utc) {
    const ms =
      Date.parse(seg.ended_at_utc) - Date.parse(seg.started_at_utc);
    if (Number.isFinite(ms) && ms > 0) return [{ duration_s: ms / 1000 }];
  }
  throw new Error('Session is missing stitch seam metadata; re-import audio with seam parts.');
}

/** Import parsed log rows into a session event feed (sync + create-at-frames). */
export function runSessionLogImport(input: {
  hub: SessionHub;
  rows: ParsedLogRow[];
  categories: CategoryRecord[];
  ctx: TimecodeCtx;
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
  const transcript = timedTranscriptTokens(input.hub);
  if (transcript.length === 0) {
    throw new Error(
      'Transcript is missing or untimed. Generate the transcript before importing logs.',
    );
  }

  const parts = seamPartsForSession(input.hub);
  const sync = syncLogRowsToSeams(
    input.rows.map((r) => ({ sheetSec: r.sheetSec, message: r.message, type: r.type })),
    parts,
    transcript,
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
