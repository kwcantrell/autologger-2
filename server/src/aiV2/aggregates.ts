// ai-v2-dashboards — session-scoped aggregate computations (design D4, spec
// "Session-scoped aggregate toolset"). Pure functions over already-read hub
// rows (`SessionHub.listTranscriptWords`, `listTranscriptEnrichment`,
// `listTopics`, `listEvents`) — no SessionHub, no I/O, no MCP wiring here.
// Phase 2.4's in-process MCP tools call these functions and JSON-serialize
// their return values directly; treat the exported shapes as the tool
// contract and change them deliberately.
//
// Degraded-data honesty (design D2a/D2b, spec "Data unavailability is a
// rendered state, never a zero"): `start_sec`/`end_sec` read back as exactly
// 0 for every word on a manually-entered transcript (schema default) and for
// every word of an anchorless DeepGram remap (`transcriptRemap.ts` writes
// literal zeros) — the shared signature of "no timing data" this module
// treats as degenerate. Every aggregate that depends on timing surfaces that
// as `available: false` with a `reason`, and its numeric fields as `null` —
// NEVER as a measured `0`. A caller must check `available` before reading the
// numeric fields; Phase 4 renders `available: false` as the explicit
// unavailable state.

import type { EventRpc } from '@autologger/domain';
import type { Topic } from '../session/topicStore';
import type { TranscriptParagraph, TranscriptWord } from '../session/transcriptStore';

// -- shared helpers ------------------------------------------------------------

/** True when every word's start/end are exactly 0 — the shared signature of
 * "timing was never populated" for both manually-entered rows (schema
 * default `0.0`, never written) and anchorless DeepGram remaps (literal
 * `start_sec: 0, end_sec: 0`). A single genuinely-zero-start word amid
 * otherwise-timed words is NOT degenerate; only a wholly-untimed transcript
 * is, matching the two documented write paths that produce this shape. */
function wordTimingsAreDegenerate(words: TranscriptWord[]): boolean {
  return words.length > 0 && words.every((w) => w.start_sec === 0 && w.end_sec === 0);
}

const NO_TRANSCRIPT_REASON = 'This session has no transcript words yet.';
const NO_TIMING_REASON =
  'This transcript has no word timings (manually entered, or not anchored to recorded audio).';
const NO_DURATION_REASON = 'Session duration is unavailable (no word timings to derive it from).';
const NO_PARAGRAPHS_REASON =
  'No utterance boundaries are available for this transcript (generate it via DeepGram to populate paragraphs).';

// -- session duration ------------------------------------------------------------

export interface SessionDurationAggregate {
  available: boolean;
  /** Present only when `available` is false. */
  reason: string | null;
  /** `max(end_sec) - min(start_sec)` across all words; `null` when unavailable. */
  durationSec: number | null;
}

/** Session duration derived from the word-timing extents (design D2 table:
 * "session_duration ← start_sec/end_sec extents"). Unavailable (never `0`)
 * for an empty transcript or one whose timings are wholly degenerate. */
export function computeSessionDuration(words: TranscriptWord[]): SessionDurationAggregate {
  if (words.length === 0) {
    return { available: false, reason: NO_TRANSCRIPT_REASON, durationSec: null };
  }
  if (wordTimingsAreDegenerate(words)) {
    return { available: false, reason: NO_TIMING_REASON, durationSec: null };
  }
  const minStart = Math.min(...words.map((w) => w.start_sec));
  const maxEnd = Math.max(...words.map((w) => w.end_sec));
  return { available: true, reason: null, durationSec: maxEnd - minStart };
}

// -- talk time by speaker --------------------------------------------------------

export interface SpeakerTalkTime {
  /** Diarization index as stored (a string; design D2a — "a diarization
   * index, not a name"). Never resolved to a display name here. */
  speaker: string;
  talkTimeSec: number;
}

export interface TalkTimeAggregate {
  available: boolean;
  reason: string | null;
  /** Empty when `available` is false. */
  bySpeaker: SpeakerTalkTime[];
}

/** Per-speaker talk time (design D2 table: "talk_time_by_speaker"), summed
 * from each word's own `end_sec - start_sec`. Unavailable, with an empty
 * `bySpeaker`, under the same degenerate-timing signature as
 * `computeSessionDuration` — never reported as a measured `0` per speaker. */
export function computeTalkTimeBySpeaker(words: TranscriptWord[]): TalkTimeAggregate {
  if (words.length === 0) {
    return { available: false, reason: NO_TRANSCRIPT_REASON, bySpeaker: [] };
  }
  if (wordTimingsAreDegenerate(words)) {
    return { available: false, reason: NO_TIMING_REASON, bySpeaker: [] };
  }
  const totals = new Map<string, number>();
  for (const w of words) {
    totals.set(w.speaker, (totals.get(w.speaker) ?? 0) + (w.end_sec - w.start_sec));
  }
  return {
    available: true,
    reason: null,
    bySpeaker: [...totals.entries()].map(([speaker, talkTimeSec]) => ({ speaker, talkTimeSec })),
  };
}

// -- utterance / question counts (from persisted paragraphs, D2a) ----------------

export interface UtteranceStatsAggregate {
  available: boolean;
  reason: string | null;
  utteranceCount: number | null;
  questionCount: number | null;
}

/** Utterance and question counts against the persisted-paragraph boundary
 * (design D2a's fix: raw words have no utterance boundary in storage; the
 * `persist-deepgram-enrichment` change gives one). One utterance == one
 * paragraph; a question is a paragraph whose text ends in "?". Unavailable
 * (never a measured `0`) when no paragraphs are persisted — a manually
 * entered transcript, or one generated before paragraph persistence shipped. */
export function computeUtteranceStats(paragraphs: TranscriptParagraph[]): UtteranceStatsAggregate {
  if (paragraphs.length === 0) {
    return {
      available: false,
      reason: NO_PARAGRAPHS_REASON,
      utteranceCount: null,
      questionCount: null,
    };
  }
  const questionCount = paragraphs.filter((p) => p.text.trim().endsWith('?')).length;
  return {
    available: true,
    reason: null,
    utteranceCount: paragraphs.length,
    questionCount,
  };
}

// -- filler counts (from raw words, independent of paragraph availability) -------

/** Fixed, exported filler vocabulary (single-token, case-insensitive exact
 * match). Deliberately conservative: DeepGram's `smart_format` strips most
 * disfluencies (design D2a), so a low or zero count over a formatted
 * transcript is an honest reflection of what's stored, not a bug in this
 * function — it must never be inflated to seem more informative. */
export const FILLER_WORDS: readonly string[] = ['um', 'uh', 'umm', 'uhh', 'erm', 'hmm'];

const FILLER_WORD_SET = new Set(FILLER_WORDS);

export interface FillerStatsAggregate {
  available: boolean;
  reason: string | null;
  fillerCount: number | null;
}

/** Filler-word count over raw transcript words. Independent of paragraph/
 * timing availability — it only needs words to exist at all. Unavailable
 * (never a measured `0`) only when the transcript itself is empty. */
export function computeFillerStats(words: TranscriptWord[]): FillerStatsAggregate {
  if (words.length === 0) {
    return { available: false, reason: NO_TRANSCRIPT_REASON, fillerCount: null };
  }
  const fillerCount = words.filter((w) => FILLER_WORD_SET.has(w.word.trim().toLowerCase())).length;
  return { available: true, reason: null, fillerCount };
}

// -- topic timeline ----------------------------------------------------------------

export interface TopicTimelineEntry {
  topicId: string;
  /** Raw `session_time` string, passed through verbatim. Design D2a: this
   * column is `z.string().max(20)` with no format validation, so this module
   * does NOT parse or invent a numeric time from it — that would be
   * fabricating precision the stored data doesn't have. */
  sessionTime: string;
  durationSec: number;
  topicLevel: number;
  summary: string;
}

export interface TopicTimelineAggregate {
  /** Empty when there are no topics — this is a real, measured empty state,
   * not an "unavailable" one (topics are free of the timing-degeneracy
   * problem: every topic row prints in full regardless of transcript
   * state), so there is no `available` flag here. */
  entries: TopicTimelineEntry[];
}

/** Topic timeline (design D2 table: "topic_timeline ← session_topics"). A
 * verbatim field-rename passthrough — no derived/invented values. */
export function computeTopicTimeline(topics: Topic[]): TopicTimelineAggregate {
  return {
    entries: topics.map((t) => ({
      topicId: t.id,
      sessionTime: t.session_time,
      durationSec: t.duration_sec,
      topicLevel: t.topic_level,
      summary: t.summary,
    })),
  };
}

// -- event counts + density -----------------------------------------------------

export interface EventCountsAggregate {
  totalEvents: number;
  /** Keyed by the opaque category id (design D2a: `events.category` is a
   * catalog-DB-resolved id, not a label — resolving it to a display label is
   * outside SessionHub and outside this module's scope). */
  byCategory: Record<string, number>;
}

/** Event counts by (opaque) category id. Always available — event rows carry
 * no timing-degeneracy problem, so a `0`/`{}` result for no events is a real
 * measured empty state, not a fabricated one. */
export function computeEventCounts(events: EventRpc[]): EventCountsAggregate {
  const byCategory: Record<string, number> = {};
  for (const e of events) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }
  return { totalEvents: events.length, byCategory };
}

export interface EventDensityAggregate {
  available: boolean;
  reason: string | null;
  eventsPerMinute: number | null;
}

/** Event density (events per minute of session duration). Takes the already-
 * computed `durationSec` (from `computeSessionDuration`) rather than
 * re-deriving it, so degenerate-timing unavailability propagates instead of
 * being silently re-computed as a different `0`. */
export function computeEventDensity(
  events: EventRpc[],
  durationSec: number | null,
): EventDensityAggregate {
  if (durationSec === null || durationSec <= 0) {
    return { available: false, reason: NO_DURATION_REASON, eventsPerMinute: null };
  }
  return { available: true, reason: null, eventsPerMinute: events.length / (durationSec / 60) };
}
