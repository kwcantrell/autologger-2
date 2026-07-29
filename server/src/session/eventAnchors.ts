// Timecode→wall-time anchor interpolation for auto-generated events
// (auto-generate-event-logs design D4). Pure module — no hub/DB access; the
// generation turn's `create_event` tool (task 3.2) is the intended caller,
// feeding it the session's existing event rows plus snapshot session fields.
//
// A generated event's stored `wall_time_utc` derives from its supplied
// timecode — never the run-time clock — by piecewise-linear interpolation
// over the session's existing timecode↔wall anchor pairs: event rows carrying
// BOTH `timecode_total_frames` and a parseable `wall_time_utc`, including the
// `internal` `Recording N Started` rows (no category filter — every anchored
// row is a usable anchor). Anchors are sorted by timecode and clamped
// monotone (a later timecode never maps to an earlier wall time), so a
// generated event at timecode T sorts — by the feed's `wall_time_utc ASC,
// id ASC` order — between the anchor events bracketing T, and generated
// events sort among themselves in timecode order.
//
// Fallbacks (design D4): one usable anchor ⇒ constant offset from it; zero ⇒
// `sessions.started_at_utc` + (timecode − start offset) / fps. An empty or
// unparseable `started_at_utc` falls back to the Unix epoch, so relative
// ordering among generated events still holds even without a session start.

import { isoZ, parseUtcMs } from '../timecode';

/** The subset of event-row fields anchor extraction needs — kept structural
 * (like transcriptRemap's `AnchorCandidateEvent`) so this module doesn't
 * couple to the router-facing `EventRpc` type, which fits it structurally. */
export interface WallAnchorCandidateEvent {
  timecode_total_frames: number | null;
  wall_time_utc: string;
}

/** One usable timecode↔wall anchor pair. */
export interface TimecodeWallAnchor {
  timecodeTotalFrames: number;
  /** Epoch ms parsed from the row's `wall_time_utc`. */
  wallMs: number;
}

/** Snapshot session fields the fallback derivations need (design D4). */
export interface AnchorSessionFields {
  frameRate: number;
  startOffsetFrames: number;
  /** `sessions.started_at_utc`; may be `''`/unparseable ⇒ Unix epoch base. */
  startedAtUtc: string | null;
}

/** Sort by (timecode ASC, wall ASC), drop duplicate timecodes (keeping the
 * earliest wall), and clamp walls to a running max so the anchor sequence is
 * monotone non-decreasing on both axes. Idempotent. */
function normalizeAnchors(anchors: TimecodeWallAnchor[]): TimecodeWallAnchor[] {
  const sorted = anchors
    .filter((a) => Number.isFinite(a.timecodeTotalFrames) && Number.isFinite(a.wallMs))
    .sort((x, y) => x.timecodeTotalFrames - y.timecodeTotalFrames || x.wallMs - y.wallMs);
  const out: TimecodeWallAnchor[] = [];
  let maxWall = Number.NEGATIVE_INFINITY;
  for (const a of sorted) {
    if (out.length > 0 && out[out.length - 1].timecodeTotalFrames === a.timecodeTotalFrames) {
      continue;
    }
    maxWall = Math.max(maxWall, a.wallMs);
    out.push({ timecodeTotalFrames: a.timecodeTotalFrames, wallMs: maxWall });
  }
  return out;
}

/** Extract the usable anchor pairs from event rows: both fields present and
 * the wall time parseable. Returns them normalized (sorted, deduped, clamped
 * monotone) — build once per run and reuse across `wallMsForTimecode` calls. */
export function timecodeWallAnchors(events: WallAnchorCandidateEvent[]): TimecodeWallAnchor[] {
  const raw: TimecodeWallAnchor[] = [];
  for (const e of events) {
    const tf = e.timecode_total_frames;
    if (tf === null || tf === undefined || !Number.isFinite(Number(tf))) continue;
    const wallMs = parseUtcMs(e.wall_time_utc);
    if (Number.isNaN(wallMs)) continue;
    raw.push({ timecodeTotalFrames: Number(tf), wallMs });
  }
  return normalizeAnchors(raw);
}

/** Wall-clock epoch ms for a session timecode (in total frames), by
 * piecewise-linear interpolation between the bracketing anchors; beyond the
 * ends (and with a single anchor) a constant offset from the nearest anchor
 * at the session frame rate; with zero anchors the session-start fallback.
 * Defensively re-normalizes `anchors`, so unsorted input is safe. Monotone
 * non-decreasing in the timecode for fixed anchors + session fields. */
export function wallMsForTimecode(
  timecodeTotalFrames: number,
  anchors: TimecodeWallAnchor[],
  session: AnchorSessionFields,
): number {
  const fps = session.frameRate > 0 ? session.frameRate : 24.0; // formatRuntimeHms convention
  const msPerFrame = 1000 / fps;
  const a = normalizeAnchors(anchors);
  if (a.length === 0) {
    const startMs = parseUtcMs(session.startedAtUtc);
    const base = Number.isNaN(startMs) ? 0 : startMs; // '' / unparseable ⇒ Unix epoch
    return Math.round(base + (timecodeTotalFrames - session.startOffsetFrames) * msPerFrame);
  }
  const first = a[0];
  if (timecodeTotalFrames <= first.timecodeTotalFrames) {
    return Math.round(
      first.wallMs - (first.timecodeTotalFrames - timecodeTotalFrames) * msPerFrame,
    );
  }
  const last = a[a.length - 1];
  if (timecodeTotalFrames >= last.timecodeTotalFrames) {
    return Math.round(last.wallMs + (timecodeTotalFrames - last.timecodeTotalFrames) * msPerFrame);
  }
  for (let i = 0; i < a.length - 1; i++) {
    const lo = a[i];
    const hi = a[i + 1];
    if (timecodeTotalFrames <= hi.timecodeTotalFrames) {
      const span = hi.timecodeTotalFrames - lo.timecodeTotalFrames; // > 0: deduped
      const t = (timecodeTotalFrames - lo.timecodeTotalFrames) / span;
      return Math.round(lo.wallMs + t * (hi.wallMs - lo.wallMs));
    }
  }
  /* v8 ignore next 2 -- unreachable: the >= last branch above covers the tail */
  return Math.round(last.wallMs);
}

/** `wallMsForTimecode` rendered as the stored `wall_time_utc` isoZ string. */
export function wallTimeUtcForTimecode(
  timecodeTotalFrames: number,
  anchors: TimecodeWallAnchor[],
  session: AnchorSessionFields,
): string {
  return isoZ(new Date(wallMsForTimecode(timecodeTotalFrames, anchors, session)));
}
