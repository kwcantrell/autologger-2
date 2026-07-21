// ai-v2-dashboards — the catalog dispatch component + sample-data registry
// (tasks 4.3/4.4). `CatalogWidget` is THE single component both the grid
// (`DashboardGrid.tsx`, real dashboard data) and the question-view preview
// slot (`AiV2Panel.tsx`, sample data) render through — spec "Previews reflect
// the rendered result": "Every preview SHALL be produced by the same
// component that renders the widget in a dashboard." There is exactly one
// switch statement mapping a catalog `WidgetType` to its component (task 4.3:
// "one component per type"); a widget type absent from this switch renders
// nothing rather than throwing (defensive — spec: "A dashboard naming a type
// outside the catalog SHALL be rejected on validation and SHALL NOT be
// stored or rendered"; this is belt-and-braces on the already-validated path).

import { EventCountByCategoryWidget } from './EventCountByCategoryWidget';
import {
  EventDensityWidget,
  FillerCountsWidget,
  QuestionCountsWidget,
  SessionDurationWidget,
  UtteranceCountsWidget,
} from './StatWidgets';
import { TalkTimeBySpeakerWidget } from './TalkTimeBySpeakerWidget';
import { TopicTimelineWidget } from './TopicTimelineWidget';
import { TranscriptExcerptWidget } from './TranscriptExcerptWidget';
import { WidgetChrome } from './WidgetChrome';
import type {
  EventCountsData,
  EventDensityData,
  FillerStatsData,
  SessionDurationData,
  TalkTimeData,
  TopicTimelineDataT,
  TranscriptExcerptData,
  UtteranceStatsData,
  WidgetType,
} from './widgetTypes';

/** Discriminated union: one variant per catalog type, each carrying exactly
 * that type's aggregate shape (+ the two `talk_time_by_speaker`/
 * `transcript_excerpt` interaction props DashboardGrid may inject). Using a
 * discriminated union (rather than a `Record<WidgetType, Component>` map)
 * keeps every case fully type-narrowed with no `any`/cast at the render site. */
export type CatalogWidgetData =
  | { widgetType: 'session_duration'; sessionDuration: SessionDurationData }
  | {
      widgetType: 'talk_time_by_speaker';
      talkTimeBySpeaker: TalkTimeData;
      onSpeakerSelect?: (speakerId: string) => void;
      highlightSpeaker?: string | null;
    }
  | { widgetType: 'utterance_counts'; utteranceCounts: UtteranceStatsData }
  | { widgetType: 'question_counts'; questionCounts: UtteranceStatsData }
  | { widgetType: 'filler_counts'; fillerCounts: FillerStatsData }
  | { widgetType: 'topic_timeline'; topicTimeline: TopicTimelineDataT }
  | { widgetType: 'event_count_by_category'; eventCountByCategory: EventCountsData }
  | { widgetType: 'event_density'; eventDensity: EventDensityData }
  | {
      widgetType: 'transcript_excerpt';
      transcriptExcerpt: TranscriptExcerptData;
      highlightSpeaker?: string | null;
    };

interface CatalogWidgetProps {
  title: string;
  meta?: string;
  data: CatalogWidgetData;
}

/** THE ONE render path every catalog widget type goes through — grid and
 * preview both call this component with the same `data.widgetType`, so they
 * can never resolve to two different implementations (task 4.4's gate). */
export function CatalogWidget({ title, meta, data }: CatalogWidgetProps) {
  return (
    <WidgetChrome title={title} meta={meta}>
      {renderBody(data)}
    </WidgetChrome>
  );
}

function renderBody(data: CatalogWidgetData) {
  switch (data.widgetType) {
    case 'session_duration':
      return <SessionDurationWidget data={data.sessionDuration} />;
    case 'talk_time_by_speaker':
      return (
        <TalkTimeBySpeakerWidget
          data={data.talkTimeBySpeaker}
          onSpeakerSelect={data.onSpeakerSelect}
          highlightSpeaker={data.highlightSpeaker}
        />
      );
    case 'utterance_counts':
      return <UtteranceCountsWidget data={data.utteranceCounts} />;
    case 'question_counts':
      return <QuestionCountsWidget data={data.questionCounts} />;
    case 'filler_counts':
      return <FillerCountsWidget data={data.fillerCounts} />;
    case 'topic_timeline':
      return <TopicTimelineWidget data={data.topicTimeline} />;
    case 'event_count_by_category':
      return <EventCountByCategoryWidget data={data.eventCountByCategory} />;
    case 'event_density':
      return <EventDensityWidget data={data.eventDensity} />;
    case 'transcript_excerpt':
      return (
        <TranscriptExcerptWidget
          data={data.transcriptExcerpt}
          highlightSpeaker={data.highlightSpeaker}
        />
      );
    default: {
      // Exhaustiveness guard: TS rejects an unhandled WidgetType at compile
      // time (`data` narrows to `never` here). At runtime this can only be
      // reached by a value that bypassed the closed-catalog validation
      // upstream — render nothing rather than throw (defensive, per task 4.3).
      const _exhaustive: never = data;
      void _exhaustive;
      return null;
    }
  }
}

/** Purely a lookup registry of catalog type -> "does a component exist"
 * (used by `DashboardGrid` to ignore/skip an unrecognized type before ever
 * calling `CatalogWidget` — task 4.3: "the grid renderer rejects/ignores an
 * unknown type"). Rendering itself always goes through `CatalogWidget`'s
 * switch above, so there is exactly one dispatch path, never two to drift
 * apart. */
export const KNOWN_WIDGET_TYPES: ReadonlySet<WidgetType> = new Set([
  'session_duration',
  'talk_time_by_speaker',
  'utterance_counts',
  'question_counts',
  'filler_counts',
  'topic_timeline',
  'event_count_by_category',
  'event_density',
  'transcript_excerpt',
] satisfies WidgetType[]);

// -- sample data for previews (task 4.4) ----------------------------------------
// Synthetic only (never sourced from the private reference demo — see
// tasks.md header). One healthy sample per catalog type, used ONLY to
// populate a question-option preview through the real component.

export const SAMPLE_WIDGET_DATA: Record<WidgetType, CatalogWidgetData> = {
  session_duration: {
    widgetType: 'session_duration',
    sessionDuration: { available: true, reason: null, durationSec: 5524 },
  },
  talk_time_by_speaker: {
    widgetType: 'talk_time_by_speaker',
    talkTimeBySpeaker: {
      available: true,
      reason: null,
      bySpeaker: [
        { speaker: '0', talkTimeSec: 3424 },
        { speaker: '1', talkTimeSec: 1546 },
        { speaker: '2', talkTimeSec: 554 },
      ],
    },
  },
  utterance_counts: {
    widgetType: 'utterance_counts',
    utteranceCounts: { available: true, reason: null, utteranceCount: 214, questionCount: 41 },
  },
  question_counts: {
    widgetType: 'question_counts',
    questionCounts: { available: true, reason: null, utteranceCount: 214, questionCount: 41 },
  },
  filler_counts: {
    widgetType: 'filler_counts',
    fillerCounts: { available: true, reason: null, fillerCount: 18 },
  },
  topic_timeline: {
    widgetType: 'topic_timeline',
    topicTimeline: {
      entries: [
        { topicId: 't1', sessionTime: '0:00', durationSec: 360, topicLevel: 0, summary: 'Intro' },
        {
          topicId: 't2',
          sessionTime: '0:06',
          durationSec: 1320,
          topicLevel: 0,
          summary: 'Budget review',
        },
        {
          topicId: 't3',
          sessionTime: '0:28',
          durationSec: 1440,
          topicLevel: 0,
          summary: 'Q3 roadmap',
        },
      ],
    },
  },
  event_count_by_category: {
    widgetType: 'event_count_by_category',
    eventCountByCategory: {
      totalEvents: 403,
      byCategory: { marker: 214, note: 89, highlight: 47, question: 41, internal: 12 },
    },
  },
  event_density: {
    widgetType: 'event_density',
    eventDensity: { available: true, reason: null, eventsPerMinute: 4.4 },
  },
  transcript_excerpt: {
    widgetType: 'transcript_excerpt',
    transcriptExcerpt: {
      available: true,
      reason: null,
      speaker: '1',
      timestampSec: 2537,
      text: 'If we lock the export pipeline this quarter, everything downstream gets simpler.',
    },
  },
};

/** Renders the SAME `CatalogWidget` path used by `DashboardGrid`, on sample
 * data, for the question-view preview slot (spec "Previews reflect the
 * rendered result"; task 4.4's fixed seam is `AiV2Design`'s
 * `renderOptionPreview` prop). Returns `null` for a `widgetType` outside the
 * closed catalog rather than fabricating a stand-in preview — matches
 * `AiV2Design`'s own "no preview at all rather than a fabricated one" default. */
export function renderCatalogWidgetPreview(widgetType: string, title: string) {
  if (!(KNOWN_WIDGET_TYPES as Set<string>).has(widgetType)) return null;
  const data = SAMPLE_WIDGET_DATA[widgetType as WidgetType];
  return <CatalogWidget title={title} data={data} />;
}
