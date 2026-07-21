// ai-v2-dashboards — web-side widget catalog + aggregate prop shapes (tasks
// 4.3/4.4/4.7). Mirrors two server modules deliberately KEPT IN SYNC BY HAND
// rather than imported across the workspace boundary (web never imports from
// server/src — the two ship as independent deployables):
//   - server/src/aiV2/catalog.ts   -> WIDGET_TYPES / WidgetType / WidgetLayout /
//                                      INTERACTION_KINDS / DashboardInteraction
//   - server/src/aiV2/aggregates.ts -> the `*AggregateData` interfaces below
//     (field-for-field matches of computeSessionDuration/computeTalkTimeBySpeaker/
//     computeUtteranceStats/computeFillerStats/computeTopicTimeline/
//     computeEventCounts/computeEventDensity's return shapes)
//
// Components in this directory are PROP-DRIVEN (design D3/D4, this unit's
// brief): they take these shapes as data, never fetch, never compute an
// aggregate themselves. Phase 5 wires a real session data source; until then
// callers (previews, tests, a future dashboard-state consumer) construct
// these shapes directly.

/** The full v1 widget catalog — verbatim copy of `WIDGET_TYPES` in
 * server/src/aiV2/catalog.ts. A widget type is registered here ONLY when a
 * component exists for it below (closed set — spec "Widget catalog is a
 * closed set"). No `sentiment_series`/`sentiment_by_topic` entry. */
export const WIDGET_TYPES = [
  'talk_time_by_speaker',
  'session_duration',
  'utterance_counts',
  'question_counts',
  'filler_counts',
  'topic_timeline',
  'event_count_by_category',
  'event_density',
  'transcript_excerpt',
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

export function isWidgetType(value: string): value is WidgetType {
  return (WIDGET_TYPES as readonly string[]).includes(value);
}

/** Layout DSL — verbatim shape of `widgetLayoutSchema` in catalog.ts (the
 * server is the validating authority; this is the render-side mirror). */
export interface WidgetLayout {
  id: string;
  type: WidgetType;
  /** Agent- or user-authored display title. TEXT ONLY, always (spec "No
   * agent-authored markup is ever rendered") — every component in this
   * directory renders it as a plain string child, never markup/href/src/style. */
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Named interaction vocabulary — verbatim copy of `INTERACTION_KINDS`. */
export const INTERACTION_KINDS = [
  'highlight_speaker',
  'filter_by_topic',
  'scroll_to_time',
] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export interface DashboardInteraction {
  kind: InteractionKind;
  sourceWidgetId: string;
  targetWidgetId: string;
}

// -- aggregate data shapes (mirrors server/src/aiV2/aggregates.ts) --------------

export interface SessionDurationData {
  available: boolean;
  reason: string | null;
  durationSec: number | null;
}

export interface SpeakerTalkTimeSlice {
  /** Diarization index as stored (a string), e.g. "0", "1" — NOT a resolved
   * display name (server/src/aiV2/aggregates.ts D2a note; name resolution is
   * deferred, tasks.md 0b.3). Components format this as honest "Speaker N"
   * text, never a fabricated name. */
  speaker: string;
  talkTimeSec: number;
}

export interface TalkTimeData {
  available: boolean;
  reason: string | null;
  bySpeaker: SpeakerTalkTimeSlice[];
}

export interface UtteranceStatsData {
  available: boolean;
  reason: string | null;
  utteranceCount: number | null;
  questionCount: number | null;
}

export interface FillerStatsData {
  available: boolean;
  reason: string | null;
  fillerCount: number | null;
}

export interface TopicTimelineEntry {
  topicId: string;
  /** Raw `session_time` string, passed through verbatim — no invented
   * numeric precision (D2a: this column has no format validation). */
  sessionTime: string;
  durationSec: number;
  topicLevel: number;
  summary: string;
}

export interface TopicTimelineDataT {
  /** Always a real, measured state — an empty list is a real empty session,
   * never "unavailable" (aggregates.ts: topics carry no timing-degeneracy
   * problem). */
  entries: TopicTimelineEntry[];
}

export interface EventCountsData {
  totalEvents: number;
  /** Keyed by the OPAQUE category id (D2a: labels live in the catalog DB,
   * outside this scope) — components render the raw id as honest text
   * unless an optional label map is supplied. */
  byCategory: Record<string, number>;
}

export interface EventDensityData {
  available: boolean;
  reason: string | null;
  eventsPerMinute: number | null;
}

/** transcript_excerpt has no dedicated pure aggregate function in
 * aggregates.ts (it's a raw bounded window computed directly from
 * `listTranscriptWords` in mcpTools.ts) — this is this unit's render-side
 * shape for it. `available` tracks "does any transcript text exist at all"
 * (independent of timing); `timestampSec`/`speaker` are independently
 * nullable so a manually-entered transcript can show its quote honestly
 * while omitting a fabricated "0:00" timecode or invented speaker name. */
export interface TranscriptExcerptData {
  available: boolean;
  reason: string | null;
  /** Diarization index, or null when unknown/unavailable. */
  speaker: string | null;
  text: string;
  /** null when word timing is degenerate/unavailable for this excerpt —
   * render "—", never a fabricated "0:00". */
  timestampSec: number | null;
}
