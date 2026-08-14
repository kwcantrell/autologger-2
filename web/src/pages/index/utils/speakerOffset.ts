import type { TranscriptWord } from '../../../api/types';

/**
 * Display/export offset for numeric speaker ids: DeepGram numbers speakers
 * from 0, hand-entered transcripts typically from 1 — offset by +1 exactly
 * when a speaker 0 exists so both conventions read "Speaker 1..N". Shared by
 * TranscribeFeed (feed display) and ExportFeed (transcript CSV) so the two
 * labelings cannot drift apart.
 */
export function speakerOffsetFromWords(words: readonly TranscriptWord[] | undefined): number {
  if (!words || words.length === 0) return 0;
  const nums = words.map((w) => Number.parseInt(w.speaker, 10)).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return 0;
  return Math.min(...nums) === 0 ? 1 : 0;
}

/** The ONLY display shape `formatSpeaker` ever synthesises: the literal word
 *  `Person`, one space, and a base-10 integer (possibly negative, since the
 *  offset is subtracted/added blind). Anything else the operator types is a
 *  custom label and is stored verbatim. */
const PERSON_LABEL = /^Person (-?\d+)$/;

/**
 * RAW speaker id -> DISPLAY label. A speaker whose stored value is a bare
 * base-10 integer string is a diarization id (DeepGram stores `Number(w.speaker)`
 * stringified) and renders as `Person <id + offset>`; anything else is a custom
 * label the operator typed and renders verbatim.
 *
 * Shared by TranscribeRow (feed display) and transcriptCsv (export) — a single
 * definition, so the two labelings and `parseSpeaker`'s inverse cannot drift.
 */
export function formatSpeaker(speaker: string, offset: number): string {
  const n = Number.parseInt(speaker, 10);
  if (!Number.isNaN(n) && String(n) === speaker.trim()) {
    return `Person ${n + offset}`;
  }
  return speaker;
}

/**
 * DISPLAY label -> RAW speaker id: the exact inverse of `formatSpeaker`, for
 * converting text out of an editable speaker control back into storage space.
 *
 * "Genuinely custom" means: anything `formatSpeaker` would not have produced.
 * The test is inverse-by-construction rather than a lookalike match — the
 * candidate raw id is re-formatted and must reproduce the given string
 * byte-for-byte. So `"Person 1"` under offset 1 parses back to `"0"`, while
 * `"Ari"`, `"Person one"`, `"person 1"`, `"Person 1 "` (stray space) and
 * `"Speaker 1"` are all custom labels returned verbatim.
 *
 * Consequence worth knowing: under offset 1 (a 0-based transcript), typing the
 * out-of-range label `"Person 0"` yields raw `"-1"` — the consistent inverse,
 * and stable (it keeps rendering as `"Person 0"`), but it drags the feed-wide
 * `speakerOffsetFromWords` minimum below 0 and so re-labels every sibling row.
 * That is preferred over storing `"Person 0"` literally, which would freeze
 * that one row's label out of sync with its siblings forever.
 */
export function parseSpeaker(display: string, offset: number): string {
  const m = PERSON_LABEL.exec(display);
  if (!m) return display;
  const raw = String(Number.parseInt(m[1], 10) - offset);
  return formatSpeaker(raw, offset) === display ? raw : display;
}
