// ai-v2-dashboards — client-side aggregate computations for the REAL
// dashboard renderer (task 5.6; design D11; spec "Data unavailability is a
// rendered state, never a zero" + "Session-scoped aggregate toolset").
//
// D11 (apply-time owner ruling): the rendered dashboard computes its
// widgets' data in the web, from the session data the existing
// `useTranscriptWords`/`useTopics`/`useEvents` hooks already fetch for other
// tabs — no new HTTP route. This module mirrors the PURE, dependency-free
// computations in `server/src/aiV2/aggregates.ts` field-for-field (same
// function names, same constants, same degenerate-timing detection, same
// `available`/`reason`/null discipline) rather than re-deriving the logic —
// see this directory's `clientAggregates.pinning.test.ts`, which imports the
// REAL server functions (a test-only cross-workspace import — never shipped)
// and asserts byte-identical output against these on shared fixtures, so the
// two cannot silently diverge.
//
// Why mirror rather than import the server module into the shipped web
// bundle (design D11 offers both as options): `aggregates.ts` itself is
// pure (zero runtime imports, `import type` only), but its declared
// PARAMETER types are re-exported from `server/src/session/transcriptStore.ts`
// / `topicStore.ts` / `server/src/studio.ts`, which are NOT dependency-free —
// pulling the module into web's `tsc`/Vite graph as production code would
// pull those in for type resolution too, and widgetTypes.ts (this same
// directory, Phase 4) already established the precedent of hand-mirroring
// this exact module pair (`catalog.ts`/`aggregates.ts`) for the documented
// reason that web and server "ship as independent deployables" — importing
// server/src into the web production bundle, and loosening Vite's dev-server
// `server.fs.allow` to permit it, is a larger, riskier build-config change
// than this task's scope warrants. The pinning test gives the "provably in
// sync" guarantee option (c) requires without that risk.
//
// `transcript_excerpt` has NO server `aggregates.ts` counterpart to mirror —
// mcpTools.ts computes it ad hoc as an offset/limit-bounded raw word page,
// a different shape than this widget's single-excerpt prop. `computeTranscriptExcerpt`
// below is a NEW client-only derivation (not a mirror, not pinned against the
// server) that follows the same never-fabricate discipline: real quote text
// when any transcript exists, honest null-degrading of speaker/timestamp
// independently of each other.

import type {
  EventCountsData,
  EventDensityData,
  FillerStatsData,
  SessionDurationData,
  TalkTimeData,
  TopicTimelineDataT,
  TranscriptExcerptData,
  UtteranceStatsData,
} from './widgetTypes';

// -- input shapes ---------------------------------------------------------------
// Minimal, locally-owned shapes (structurally compatible with the web's own
// `TranscriptWord`/`SessionTopic`/`LogEvent` API types) — this module does not
// import `../../../../api/types` so it stays independently testable/pinnable
// against the server's fixtures without needing the whole API type surface.

export interface AggWord {
  speaker: string;
  word: string;
  start_sec: number;
  end_sec: number;
}

export interface AggParagraph {
  text: string;
}

export interface AggTopic {
  id: string;
  session_time: string;
  duration_sec: number;
  topic_level: number;
  summary: string;
}

export interface AggEvent {
  category: string;
}

// -- shared helpers ---------------------------------------------------------------

/** True when every word's start/end are exactly 0 — the shared signature of
 * "timing was never populated" (manually-entered rows, or an anchorless
 * DeepGram remap) — verbatim mirror of aggregates.ts's own check. */
function wordTimingsAreDegenerate(words: AggWord[]): boolean {
  return words.length > 0 && words.every((w) => w.start_sec === 0 && w.end_sec === 0);
}

const NO_TRANSCRIPT_REASON = 'This session has no transcript words yet.';
const NO_TIMING_REASON =
  'This transcript has no word timings (manually entered, or not anchored to recorded audio).';
const NO_DURATION_REASON = 'Session duration is unavailable (no word timings to derive it from).';
const NO_PARAGRAPHS_REASON =
  'No utterance boundaries are available for this transcript (generate it via DeepGram to populate paragraphs).';

// -- session duration ------------------------------------------------------------

export function computeSessionDuration(words: AggWord[]): SessionDurationData {
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

export function computeTalkTimeBySpeaker(words: AggWord[]): TalkTimeData {
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

// -- utterance / question counts --------------------------------------------------
// The web has no route exposing persisted paragraphs (`persist-deepgram-
// enrichment` shipped `SessionHub.listTranscriptEnrichment()` as an in-process
// hub read with NO HTTP route — non-contract-bearing, agent-only via the MCP
// tool). D11 forbids adding one. So this always receives `[]` from the real
// wiring (`useAiV2WidgetData.ts`) and always renders the honest unavailable
// state for `utterance_counts`/`question_counts` in the CLIENT-rendered
// dashboard, never zeros — an accepted consequence of "no new HTTP route",
// not a bug. The function itself still takes a real parameter (rather than
// being hardcoded) so it stays pinned against the server's identical logic.
export function computeUtteranceStats(paragraphs: AggParagraph[]): UtteranceStatsData {
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

// -- filler counts ------------------------------------------------------------------

/** Verbatim mirror of aggregates.ts's `FILLER_WORDS` — pinned by
 * `clientAggregates.pinning.test.ts`. */
export const FILLER_WORDS: readonly string[] = ['um', 'uh', 'umm', 'uhh', 'erm', 'hmm'];

const FILLER_WORD_SET = new Set(FILLER_WORDS);

export function computeFillerStats(words: AggWord[]): FillerStatsData {
  if (words.length === 0) {
    return { available: false, reason: NO_TRANSCRIPT_REASON, fillerCount: null };
  }
  const fillerCount = words.filter((w) => FILLER_WORD_SET.has(w.word.trim().toLowerCase())).length;
  return { available: true, reason: null, fillerCount };
}

// -- topic timeline ----------------------------------------------------------------

export function computeTopicTimeline(topics: AggTopic[]): TopicTimelineDataT {
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

export function computeEventCounts(events: AggEvent[]): EventCountsData {
  const byCategory: Record<string, number> = {};
  for (const e of events) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }
  return { totalEvents: events.length, byCategory };
}

export function computeEventDensity(
  events: AggEvent[],
  durationSec: number | null,
): EventDensityData {
  if (durationSec === null || durationSec <= 0) {
    return { available: false, reason: NO_DURATION_REASON, eventsPerMinute: null };
  }
  return { available: true, reason: null, eventsPerMinute: events.length / (durationSec / 60) };
}

// -- transcript excerpt (client-only; no server counterpart, see module header) --

/** Bounded recency window: the excerpt widget shows the tail of the
 * transcript rather than the whole thing — deterministic, and honest (never
 * claims to represent the "most interesting" moment, just the most recent
 * words available). */
const EXCERPT_WORD_WINDOW = 40;

function majoritySpeaker(words: AggWord[]): string | null {
  if (words.length === 0) return null;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = -1;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
    }
  }
  return best;
}

/** `available` tracks "does any transcript text exist at all" — independent
 * of timing (widgetTypes.ts's own doc comment on `TranscriptExcerptData`).
 * `timestampSec` degrades to `null` independently when the excerpt window's
 * own timing is degenerate — never a fabricated "0:00". `speaker` is the
 * majority diarization index across the window, never an invented name. */
export function computeTranscriptExcerpt(words: AggWord[]): TranscriptExcerptData {
  if (words.length === 0) {
    return {
      available: false,
      reason: NO_TRANSCRIPT_REASON,
      speaker: null,
      text: '',
      timestampSec: null,
    };
  }
  const windowWords = words.slice(-EXCERPT_WORD_WINDOW);
  const text = windowWords
    .map((w) => w.word)
    .join(' ')
    .trim();
  const speaker = majoritySpeaker(windowWords);
  const timestampSec = wordTimingsAreDegenerate(windowWords) ? null : windowWords[0].start_sec;
  return { available: true, reason: null, speaker, text, timestampSec };
}
