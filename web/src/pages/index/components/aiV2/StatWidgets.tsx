// ai-v2-dashboards — simple stat-tile catalog widgets (task 4.3): one
// component each for session_duration, utterance_counts, question_counts,
// filler_counts, event_density. Each takes exactly its aggregate's shape
// (server/src/aiV2/aggregates.ts) as `data` and renders `UnavailableState`
// whenever `available` is false — NEVER a zero in its place (task 4.7).

import type { ReactNode } from 'react';
import { fmtHmsFromSec } from '../../../../shared/utils/timecode';
import { UnavailableState } from './UnavailableState';
import type {
  EventDensityData,
  FillerStatsData,
  SessionDurationData,
  UtteranceStatsData,
} from './widgetTypes';

function StatValue({ children }: { children: ReactNode }) {
  return (
    <div className="text-[2rem] font-semibold leading-[1.1] tracking-[-0.02em] text-v5-text">
      {children}
    </div>
  );
}

function StatSub({ children }: { children: ReactNode }) {
  return <div className="mt-1 text-[0.78rem] text-v5-muted">{children}</div>;
}

export function SessionDurationWidget({ data }: { data: SessionDurationData }) {
  if (!data.available || data.durationSec === null) {
    return <UnavailableState reason={data.reason ?? 'Session duration is unavailable.'} />;
  }
  return (
    <div className="flex flex-1 flex-col justify-center" data-testid="aiv2-widget-session_duration">
      <StatValue>
        {/* Mono/tabular-nums timecode rendering, matching the app's existing
            timecode convention (TimecodeDisplay.tsx). */}
        <span className="font-mono [font-variant-numeric:tabular-nums]">
          {fmtHmsFromSec(data.durationSec)}
        </span>
      </StatValue>
      <StatSub>Derived from word timings</StatSub>
    </div>
  );
}

export function UtteranceCountsWidget({ data }: { data: UtteranceStatsData }) {
  if (!data.available || data.utteranceCount === null) {
    return <UnavailableState reason={data.reason ?? 'Utterance counts are unavailable.'} />;
  }
  return (
    <div className="flex flex-1 flex-col justify-center" data-testid="aiv2-widget-utterance_counts">
      <StatValue>{String(data.utteranceCount)}</StatValue>
      <StatSub>Utterances (paragraph boundaries)</StatSub>
    </div>
  );
}

export function QuestionCountsWidget({ data }: { data: UtteranceStatsData }) {
  if (!data.available || data.questionCount === null) {
    return <UnavailableState reason={data.reason ?? 'Question counts are unavailable.'} />;
  }
  return (
    <div className="flex flex-1 flex-col justify-center" data-testid="aiv2-widget-question_counts">
      <StatValue>{String(data.questionCount)}</StatValue>
      <StatSub>Questions asked</StatSub>
    </div>
  );
}

export function FillerCountsWidget({ data }: { data: FillerStatsData }) {
  if (!data.available || data.fillerCount === null) {
    return <UnavailableState reason={data.reason ?? 'Filler-word counts are unavailable.'} />;
  }
  return (
    <div className="flex flex-1 flex-col justify-center" data-testid="aiv2-widget-filler_counts">
      <StatValue>{String(data.fillerCount)}</StatValue>
      <StatSub>Filler words (um, uh, ...)</StatSub>
    </div>
  );
}

export function EventDensityWidget({ data }: { data: EventDensityData }) {
  if (!data.available || data.eventsPerMinute === null) {
    return <UnavailableState reason={data.reason ?? 'Event density is unavailable.'} />;
  }
  return (
    <div className="flex flex-1 flex-col justify-center" data-testid="aiv2-widget-event_density">
      <StatValue>{data.eventsPerMinute.toFixed(1)}</StatValue>
      <StatSub>Events per minute</StatSub>
    </div>
  );
}
