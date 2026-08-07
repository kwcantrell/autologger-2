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
// row is a usable anchor).
//
// Anchors are INTERVAL-valued (Phase-2 fix wave): a stopped transport freezes
// the timecode while wall time keeps moving, so on real multi-take sessions
// several rows share one timecode with walls spread across the dead air
// between takes. Per distinct timecode the anchor keeps the earliest and
// latest observed walls (`wallLoMs`/`wallHiMs`, clamped monotone across
// anchors); the segment [tc_i, tc_i+1] interpolates from `wallHi_i` to
// `wallLo_i+1`, so a generated event at timecode T sorts — by the feed's
// `wall_time_utc ASC, id ASC` order — AFTER every row at the anchor timecode
// below T (dead-air notes and the next take's `Recording N Started` included)
// and BEFORE every row at the anchor timecode above T, and generated events
// sort among themselves in timecode order.
//
// Fallbacks (design D4): one usable anchor ⇒ constant offset from it; zero ⇒
// `sessions.started_at_utc` + (timecode − start offset) / fps. An empty or
// unparseable `started_at_utc` falls back to the Unix epoch, so relative
// ordering among generated events still holds even without a session start.

import { isoZ, parseUtcMs } from '@autologger/domain';

/** The subset of event-row fields anchor extraction needs — kept structural
 * (like transcriptRemap's `AnchorCandidateEvent`) so this module doesn't
 * couple to the router-facing `EventRpc` type, which fits it structurally. */
export interface WallAnchorCandidateEvent {
  timecode_total_frames: number | null;
  wall_time_utc: string;
}

/** One usable timecode↔wall anchor: the INTERVAL of walls observed at a
 * distinct timecode (lo === hi when a single row carries the timecode). */
export interface TimecodeWallAnchor {
  timecodeTotalFrames: number;
  /** Earliest wall (epoch ms) observed at this timecode, after normalization. */
  wallLoMs: number;
  /** Latest wall (epoch ms) observed at this timecode, after normalization. */
  wallHiMs: number;
}

/** Snapshot session fields the fallback derivations need (design D4). */
export interface AnchorSessionFields {
  frameRate: number;
  startOffsetFrames: number;
  /** `sessions.started_at_utc`; may be `''`/unparseable ⇒ Unix epoch base. */
  startedAtUtc: string | null;
}

/** Sort by timecode, merge duplicate timecodes into one interval spanning all
 * observed walls (lo = min, hi = max), then clamp monotone: each interval's lo
 * is raised to at least the previous interval's hi (and hi to at least its own
 * lo), so the anchor sequence is non-decreasing across both axes. Idempotent. */
function normalizeAnchors(anchors: TimecodeWallAnchor[]): TimecodeWallAnchor[] {
  const sorted = anchors
    .filter(
      (a) =>
        Number.isFinite(a.timecodeTotalFrames) &&
        Number.isFinite(a.wallLoMs) &&
        Number.isFinite(a.wallHiMs),
    )
    .sort((x, y) => x.timecodeTotalFrames - y.timecodeTotalFrames);
  const merged: TimecodeWallAnchor[] = [];
  for (const a of sorted) {
    const lo = Math.min(a.wallLoMs, a.wallHiMs);
    const hi = Math.max(a.wallLoMs, a.wallHiMs);
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.timecodeTotalFrames === a.timecodeTotalFrames) {
      prev.wallLoMs = Math.min(prev.wallLoMs, lo);
      prev.wallHiMs = Math.max(prev.wallHiMs, hi);
    } else {
      merged.push({ timecodeTotalFrames: a.timecodeTotalFrames, wallLoMs: lo, wallHiMs: hi });
    }
  }
  let maxWall = Number.NEGATIVE_INFINITY;
  for (const a of merged) {
    a.wallLoMs = Math.max(a.wallLoMs, maxWall);
    a.wallHiMs = Math.max(a.wallHiMs, a.wallLoMs);
    maxWall = a.wallHiMs;
  }
  return merged;
}

/** A usable `timecode_total_frames` value from a raw row: a finite number, or
 * a NON-EMPTY numeric string (SQLite rows are loosely typed at this seam).
 * Notably `''` is rejected — `Number('')` is 0, which would fabricate a bogus
 * tc-0 anchor from a string-ish row. */
function usableTotalFrames(raw: number | null): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && (raw as string).trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Extract the usable anchor pairs from event rows: both fields present and
 * the wall time parseable. Returns them normalized (sorted, duplicate
 * timecodes merged into intervals, clamped monotone). Contract: the production
 * caller (`create_event` in aiMcpServer.ts) deliberately rebuilds this FRESH
 * on every call — each generated insert becomes an anchor for the next, which
 * is what keeps a run's events sorting among themselves in timecode order.
 * That is a declared asymmetry with the run's dedup basis, which is frozen at
 * run start: anchors are live mid-run, the embedded-events snapshot is not. */
export function timecodeWallAnchors(events: WallAnchorCandidateEvent[]): TimecodeWallAnchor[] {
  const raw: TimecodeWallAnchor[] = [];
  for (const e of events) {
    const tf = usableTotalFrames(e.timecode_total_frames);
    if (tf === null) continue;
    const wallMs = parseUtcMs(e.wall_time_utc);
    if (Number.isNaN(wallMs)) continue;
    raw.push({ timecodeTotalFrames: tf, wallLoMs: wallMs, wallHiMs: wallMs });
  }
  return normalizeAnchors(raw);
}

/** Wall-clock epoch ms for a session timecode (in total frames): piecewise-
 * linear interpolation across segment [tc_i, tc_i+1] from `wallHi_i` to
 * `wallLo_i+1`; below the first anchor (and at it) a constant offset from
 * `wallLo_first` at the session frame rate; above the last (and at it) from
 * `wallHi_last`; with zero anchors the session-start fallback. Defensively
 * re-normalizes `anchors`, so unsorted input is safe. Monotone non-decreasing
 * in the timecode for fixed anchors + session fields.
 *
 * Precondition: `timecodeTotalFrames` is finite and parser-bounded (< 24h at
 * the session rate — `parseTimecodeString` gates every caller-supplied value).
 * A non-finite input is still guarded here rather than silently misplaced: it
 * returns the clamped nearest-anchor wall (+∞ ⇒ last hi; −∞/NaN ⇒ first lo;
 * zero anchors ⇒ the session-start base) instead of propagating NaN/±∞. */
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
    if (!Number.isFinite(timecodeTotalFrames)) return base;
    return Math.round(base + (timecodeTotalFrames - session.startOffsetFrames) * msPerFrame);
  }
  const first = a[0];
  const last = a[a.length - 1];
  if (!Number.isFinite(timecodeTotalFrames)) {
    return timecodeTotalFrames === Number.POSITIVE_INFINITY ? last.wallHiMs : first.wallLoMs;
  }
  if (timecodeTotalFrames <= first.timecodeTotalFrames) {
    return Math.round(
      first.wallLoMs - (first.timecodeTotalFrames - timecodeTotalFrames) * msPerFrame,
    );
  }
  if (timecodeTotalFrames >= last.timecodeTotalFrames) {
    return Math.round(
      last.wallHiMs + (timecodeTotalFrames - last.timecodeTotalFrames) * msPerFrame,
    );
  }
  for (let i = 0; i < a.length - 1; i++) {
    const lo = a[i];
    const hi = a[i + 1];
    if (timecodeTotalFrames <= hi.timecodeTotalFrames) {
      const span = hi.timecodeTotalFrames - lo.timecodeTotalFrames; // > 0: merged
      const t = (timecodeTotalFrames - lo.timecodeTotalFrames) / span;
      return Math.round(lo.wallHiMs + t * (hi.wallLoMs - lo.wallHiMs));
    }
  }
  /* v8 ignore next 3 -- defensive tail: the timecode is finite (guarded above)
   * and strictly between the first and last anchors, so a segment matched. */
  return Math.round(last.wallHiMs);
}

/** `wallMsForTimecode` rendered as the stored `wall_time_utc` isoZ string.
 * Same finite-timecode precondition; parser-bounded inputs (< 24h) over
 * real-row anchors always land within `Date`'s representable range. */
export function wallTimeUtcForTimecode(
  timecodeTotalFrames: number,
  anchors: TimecodeWallAnchor[],
  session: AnchorSessionFields,
): string {
  return isoZ(new Date(wallMsForTimecode(timecodeTotalFrames, anchors, session)));
}
