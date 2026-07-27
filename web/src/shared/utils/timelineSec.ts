// feed-row-seek, task 2.3; design D3.
//
// Converts a session-time string (the `HH:MM:SS:FF` / `HH:MM:SS;FF` shape
// the server renders via `formatSmpte(fromTotalFrames(...))`,
// server/src/timecode.ts) into a timeline second — the coordinate space the
// timeline, markers, and audio clips use.
//
// Deliberately NOT either `parseSmpteToSec` (one in
// `shared/utils/audioClips.ts`, honors the frame field; one in
// `shared/utils/timecode.ts`, discards it) — NEITHER is correct here. Both
// treat HH:MM:SS as literal seconds (`h*3600 + m*60 + s (+ f/fps)`), which
// is wrong at every non-integer frame rate the app offers (23.976 / 29.97 /
// 59.94): `fromTotalFrames` decomposes a linear frame count at
// `Math.round(frameRate)`, not at the actual rate, so `HH:MM:SS` encodes
// `totalFrames / Math.round(fps)` while the timeline lives in
// `totalFrames / fps` (the ACTUAL, non-rounded rate). The literal-seconds
// reading is systematically early by ~0.1% of elapsed time — several
// seconds off within an hour, which matters because a jump that's off by
// that much can land in a different recording (design D6).
//
// This is not a novel derivation — it mirrors the app's own existing
// inverse, `server/src/routers/events.ts`'s event-edit PUT handler:
//   const fps = Math.round(Number(row.frame_rate));
//   const totalFrames = (hh * 3600 + mm * 60 + ss) * fps;
// ...then divides by the ACTUAL (non-rounded) frame rate to land back in
// timeline-second space. Do NOT "simplify" this to either `parseSmpteToSec`
// above — that would silently reintroduce the literal-seconds defect an
// import auto-fix could otherwise slip back in.

// Hour: 1-2 digits (renderer never truncates via padStart(2,'0'), and
// `fromTotalFrames` wraps hours to 0-23, but a hand-typed string is
// tolerated at up to 2 digits). Minutes/seconds: exactly 2 digits, matching
// what the renderer always emits. Frame field: 1-3 digits, optional —
// `padStart(2,'0')` does not truncate, so rates at/above 100fps legitimately
// emit 3-digit frame fields (e.g. "105"). Separator before the frame field
// is ':' or ';' — formatSmpte uses ';' for ~29.97fps drop-frame notation;
// `fromTotalFrames` performs no drop-frame renumbering, so treating ';' the
// same as ':' is correct for every string this app actually renders.
const SESSION_TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})(?:[:;](\d{1,3}))?$/;

/**
 * Convert a session-time string to a timeline second in the same
 * coordinate space as timeline markers and audio clips, or `null` when the
 * string is empty, malformed, or otherwise unresolvable.
 *
 * `null` (never `0`) means "no position" — callers must not conflate an
 * unresolvable row with a row that resolves to second zero.
 */
export function sessionTimeToTimelineSec(
  str: string | null | undefined,
  fps: number,
): number | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const roundedFps = Math.round(fps);
  if (roundedFps <= 0) return null;

  const trimmed = String(str ?? '').trim();
  if (!trimmed) return null;

  const m = SESSION_TIME_RE.exec(trimmed);
  if (!m) return null;

  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ff = m[4] != null ? Number(m[4]) : 0;
  if (![hh, mm, ss, ff].every((n) => Number.isFinite(n))) return null;

  // Reject rather than clamp: clamping would still display one time and
  // jump to another (design D3). `events.ts` already rejects mm/ss > 59
  // with a 400 on the same shape.
  if (mm > 59 || ss > 59) return null;
  if (ff >= roundedFps) return null;

  const totalFrames = (hh * 3600 + mm * 60 + ss) * roundedFps + ff;
  const sec = totalFrames / fps;
  return Number.isFinite(sec) && sec >= 0 ? sec : null;
}

// Whole-branch audit fix wave, finding I2. `TranscribeRow` names its jump
// control's accessible name after `row.session_time` (the row's DISPLAYED
// time) — but a row can resolve its position from `start_sec` instead (when
// `session_time` is blank or unparseable; design D4's fallback). That leaves
// the displayed cell, and therefore the button's `aria-label`, empty or
// showing stale/garbage text while the button still jumps somewhere real: an
// accessible name identifying nothing, or the wrong thing.
//
// `formatTimelineSec` renders a RESOLVED timeline second back into the
// `HH:MM:SS:FF` shape the app displays, for exactly that fallback case. It
// mirrors `server/src/timecode.ts`'s `fromTotalFrames`/`formatSmpte` (the
// same rounded-rate decomposition `sessionTimeToTimelineSec` above inverts)
// and MUST be the exact inverse of that function — decomposing at a
// different rate (e.g. treating `sec` as literal HH:MM:SS) reintroduces the
// coordinate-space bug design D3 exists to eliminate.

/**
 * Format a timeline second back into the `HH:MM:SS:FF` (or `;FF` for the
 * ~29.97fps drop-frame separator) string the app renders elsewhere. Exact
 * inverse of `sessionTimeToTimelineSec`. Returns `null` when `sec`/`fps`
 * aren't finite/usable — callers must not fall back to guessing a display
 * string for an unresolvable value.
 */
export function formatTimelineSec(sec: number, fps: number): string | null {
  if (!Number.isFinite(sec) || sec < 0) return null;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const roundedFps = Math.round(fps);
  if (roundedFps <= 0) return null;

  const totalFrames = Math.round(sec * fps);
  const ff = totalFrames % roundedFps;
  let t = Math.floor(totalFrames / roundedFps);
  const ss = t % 60;
  t = Math.floor(t / 60);
  const mm = t % 60;
  const hh = Math.floor(t / 60) % 24;

  // Mirrors formatSmpte's drop-frame separator choice for ~29.97fps.
  const sep = Math.abs(fps - 29.97) < 0.001 * 29.97 ? ';' : ':';
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}${sep}${p2(ff)}`;
}
