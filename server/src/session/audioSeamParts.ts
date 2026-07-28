/** Audio seam part durations persisted on session meta after local-audio-import. */

export const AUDIO_SEAM_PARTS_META_KEY = 'audio_seam_parts_json';
export const AUDIO_SEAM_PARTS_HEADER = 'x-audio-seam-parts';

export interface AudioSeamPart {
  duration_s: number;
}

const SUM_TOLERANCE_S = 0.5;

export function parseAudioSeamPartsHeader(
  raw: string | undefined,
  durationS: number,
): AudioSeamPart[] {
  if (raw === undefined || raw.trim() === '') {
    return [{ duration_s: durationS }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('X-Audio-Seam-Parts must be a JSON array of { duration_s }.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('X-Audio-Seam-Parts must be a non-empty JSON array.');
  }
  const parts: AudioSeamPart[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('X-Audio-Seam-Parts entries must be objects with duration_s.');
    }
    const n = Number((item as { duration_s?: unknown }).duration_s);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error('X-Audio-Seam-Parts duration_s must be a positive finite number.');
    }
    parts.push({ duration_s: n });
  }
  const sum = parts.reduce((acc, p) => acc + p.duration_s, 0);
  if (Math.abs(sum - durationS) > SUM_TOLERANCE_S) {
    throw new Error(
      `X-Audio-Seam-Parts durations sum (${sum}) must be within ${SUM_TOLERANCE_S}s of duration_s (${durationS}).`,
    );
  }
  return parts;
}

export function serializeAudioSeamParts(parts: AudioSeamPart[]): string {
  return JSON.stringify(parts);
}

export function deserializeAudioSeamParts(raw: string | null): AudioSeamPart[] | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const parts: AudioSeamPart[] = [];
    for (const item of parsed) {
      const n = Number((item as { duration_s?: unknown })?.duration_s);
      if (!Number.isFinite(n) || n <= 0) return null;
      parts.push({ duration_s: n });
    }
    return parts;
  } catch {
    return null;
  }
}
