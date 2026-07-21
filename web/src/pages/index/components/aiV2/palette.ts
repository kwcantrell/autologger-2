// ai-v2-dashboards — data-viz palette helpers (design.md "UI design brief").
// The eight validated categorical slots are declared as CSS custom properties
// in web/src/shared/theme/tailwind.css (--viz-series-1..8); this module is
// the single place that assigns an ENTITY (a speaker index) to a SLOT, so
// every widget in a dashboard agrees on the same speaker -> color mapping
// without any cross-widget prop threading.

const SERIES_SLOT_COUNT = 8;

/** Speaker ids are diarization indices ("0", "1", "2", ...), so the numeric
 * value itself is already a stable, deterministic, dashboard-independent
 * ordering — index "0" is always slot 1, everywhere, matching the brief's
 * "speakers take slots 1..N consistently across every widget". Falls back to
 * a hash of the raw id for a non-numeric speaker id (defensive; diarization
 * indices are always numeric strings in practice). Slots never cycle past 8
 * distinct hues (brief: "assigned... in fixed order and never cycled") — a
 * 9th+ speaker shares the last slot rather than reusing an earlier one under
 * a different meaning. */
export function speakerSlot(speakerId: string): number {
  const parsed = Number.parseInt(speakerId, 10);
  const ordinal = Number.isFinite(parsed) && parsed >= 0 ? parsed : hashOrdinal(speakerId);
  return Math.min(ordinal, SERIES_SLOT_COUNT - 1) + 1; // 1-based
}

export function speakerColorVar(speakerId: string): string {
  return `var(--viz-series-${speakerSlot(speakerId)})`;
}

/** Honest speaker label — "Speaker N" (1-based, human-friendly) from a
 * diarization index. Resolved display names are deferred (tasks.md 0b.3);
 * this is never a fabricated name. */
export function speakerLabel(speakerId: string): string {
  const parsed = Number.parseInt(speakerId, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? `Speaker ${parsed + 1}` : `Speaker ${speakerId}`;
}

function hashOrdinal(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SERIES_SLOT_COUNT;
}

/** Single-series marks (event density, nominal category bars) — never
 * colored by value; text never wears a series color (brief: identity comes
 * from a swatch beside text tokens, not colored text). */
export const VIZ_SINGLE = 'var(--viz-single)';
