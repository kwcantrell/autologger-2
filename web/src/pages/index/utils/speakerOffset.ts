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
