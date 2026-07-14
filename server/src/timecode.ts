// SMPTE timecode math + UTC helpers — ported from src/autologger/models.py.
// Pure functions shared by the session hub (event/transport timecodes) and the
// router layer (master clock + cheap list-row rolling timecode from catalog
// projection cols).

export interface Timecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  frame_rate: number;
}

/** Render a UTC Date as ISO-8601 with a trailing Z (mirrors models.iso_z). */
export function isoZ(d: Date): string {
  return d.toISOString();
}

/** Parse an ISO-8601 instant; returns epoch ms, or NaN when unparseable. */
export function parseUtcMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(String(iso).replace('+00:00', 'Z'));
}

/** Timecode.from_total_frames — linear frame count → wall-style components. */
export function fromTotalFrames(total: number, frameRate: number): Timecode {
  if (frameRate <= 0) throw new Error('frame_rate must be positive');
  const fps = Math.round(frameRate * 1000) / 1000;
  const fpsI = Math.max(1, Math.round(fps));
  const f = total % fpsI;
  let t = Math.floor(total / fpsI);
  const s = t % 60;
  t = Math.floor(t / 60);
  const m = t % 60;
  const h = Math.floor(t / 60) % 24;
  return { hours: h, minutes: m, seconds: s, frames: f, frame_rate: fps };
}

/** Timecode.to_total_frames — components → linear frame count. */
export function toTotalFrames(tc: Timecode): number {
  const fps = Math.round(tc.frame_rate);
  return tc.hours * 3600 * fps + tc.minutes * 60 * fps + tc.seconds * fps + tc.frames;
}

/** Timecode.format_smpte — `HH:MM:SS:FF` (`;` separator for 29.97 drop-frame). */
export function formatSmpte(tc: Timecode): string {
  const sep = Math.abs(tc.frame_rate - 29.97) < 0.001 * 29.97 ? ';' : ':';
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(tc.hours)}:${p2(tc.minutes)}:${p2(tc.seconds)}${sep}${p2(tc.frames)}`;
}

export interface TransportFields {
  is_rolling: boolean;
  elapsed_frames: number;
  roll_started_at_utc: string | null;
}

/** _transport_state_for_row timecode — offset + elapsed + (now − roll_start)·fps when rolling. */
export function transportTimecode(
  frameRate: number,
  startOffsetFrames: number,
  tr: TransportFields,
  nowMs: number,
): Timecode {
  const base = Math.trunc(tr.elapsed_frames || 0);
  let extra = 0;
  if (tr.is_rolling && tr.roll_started_at_utc) {
    const started = parseUtcMs(tr.roll_started_at_utc);
    if (!Number.isNaN(started)) {
      extra = Math.max(0, Math.trunc(((nowMs - started) / 1000) * frameRate));
    }
  }
  const total = Math.max(0, startOffsetFrames + base + extra);
  return fromTotalFrames(total, frameRate);
}

/** _timecode_for_mark — timecode at an arbitrary mark instant (used by add_event). */
export function timecodeForMark(
  frameRate: number,
  startOffsetFrames: number,
  tr: TransportFields,
  markMs: number,
): Timecode {
  let total = startOffsetFrames + Math.trunc(tr.elapsed_frames || 0);
  if (tr.is_rolling && tr.roll_started_at_utc) {
    const started = parseUtcMs(tr.roll_started_at_utc);
    if (!Number.isNaN(started) && markMs >= started) {
      total += Math.max(0, Math.trunc(((markMs - started) / 1000) * frameRate));
    }
  }
  return fromTotalFrames(Math.max(0, total), frameRate);
}

/** _format_runtime_hms — HH:MM:SS from a linear frame count. */
export function formatRuntimeHms(totalFrames: number, frameRate: number): string {
  const fr = frameRate && frameRate > 0 ? frameRate : 24.0;
  const tf = Math.max(0, Math.trunc(totalFrames));
  if (tf <= 0) return '00:00:00';
  const tc = fromTotalFrames(tf, fr);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(tc.hours)}:${p2(tc.minutes)}:${p2(tc.seconds)}`;
}
