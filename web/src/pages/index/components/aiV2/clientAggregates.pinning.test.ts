// ai-v2-dashboards — pinning test (task 5.6; design D11's option (c)): proves
// `clientAggregates.ts` (this workspace's hand-mirrored copy) produces
// BYTE-IDENTICAL output to the REAL `server/src/aiV2/aggregates.ts` functions
// on the same fixtures, so the two cannot silently diverge into "two
// implementations of the same aggregation logic" — the exact failure mode
// design D11 warns against.
//
// This is a TEST-ONLY cross-workspace import (dynamic, not a static import
// site any bundler ever sees in production code — `clientAggregates.ts`'s own
// header explains why the shipped web bundle does not import server/src
// directly). If a future change edits server/src/aiV2/aggregates.ts without
// updating this file's mirror, this test fails loudly instead of the two
// quietly drifting apart.

import { describe, expect, it } from 'vitest';
import * as clientAggregates from './clientAggregates';

// Vitest/esbuild resolve this relative path at test-run time only; nothing
// under web/src ever imports server/src at runtime or in the built bundle.
const serverAggregates = await import('../../../../../../server/src/aiV2/aggregates.ts');

// Full server-shape fixtures (every field the REAL server types require) —
// deliberately not the minimal `clientAggregates.ts` input shapes, so the
// exact same objects satisfy both sides' type checks and both sides run over
// byte-identical data.
function timedWord(
  speaker: string,
  word: string,
  start_sec: number,
  end_sec: number,
  ordinal: number,
) {
  return {
    id: `w${ordinal}`,
    session_time: '00:00:00',
    speaker,
    word,
    start_sec,
    end_sec,
    ordinal,
    created_at_utc: '2026-07-21T00:00:00.000Z',
  };
}

const TIMED_WORDS = [
  timedWord('0', 'hello', 0, 10, 0),
  timedWord('0', 'there', 10, 20, 1),
  timedWord('0', 'friend', 20, 30, 2),
  timedWord('1', 'well', 30, 40, 3),
  timedWord('1', 'thanks', 40, 50, 4),
  timedWord('1', 'um', 50, 60, 5),
];

const DEGENERATE_WORDS = [timedWord('0', 'hello', 0, 0, 0), timedWord('1', 'world', 0, 0, 1)];

const EMPTY_WORDS: typeof TIMED_WORDS = [];

function paragraph(text: string, ordinal: number) {
  return {
    id: `p${ordinal}`,
    start_sec: ordinal * 10,
    end_sec: ordinal * 10 + 5,
    speaker: '0',
    text,
    ordinal,
    created_at_utc: '2026-07-21T00:00:00.000Z',
  };
}

const PARAGRAPHS = [
  paragraph('How are you today?', 0),
  paragraph('I am doing well, thanks for asking.', 1),
];

function topic(
  id: string,
  session_time: string,
  duration_sec: number,
  topic_level: number,
  summary: string,
  ordinal: number,
) {
  return {
    id,
    session_time,
    duration_sec,
    topic_level,
    summary,
    ordinal,
    created_at_utc: '2026-07-21T00:00:00.000Z',
  };
}

const TOPICS = [
  topic('t1', '0:00', 60, 0, 'Intro', 0),
  topic('t2', '0:01', 120, 1, 'Deep dive', 1),
];

function event(category: string, event_id: string) {
  return {
    event_id,
    wall_time_utc: '2026-07-21T00:00:00.000Z',
    timecode: null,
    frame_rate: null,
    timecode_total_frames: null,
    category,
    message: '',
    metadata_json: '{}',
  };
}

const EVENTS = [event('marker', 'e1'), event('marker', 'e2'), event('note', 'e3')];

describe('clientAggregates pinned against the real server/src/aiV2/aggregates.ts', () => {
  it('computeSessionDuration matches on timed, degenerate, and empty fixtures', () => {
    for (const words of [TIMED_WORDS, DEGENERATE_WORDS, EMPTY_WORDS]) {
      expect(clientAggregates.computeSessionDuration(words)).toEqual(
        serverAggregates.computeSessionDuration(words),
      );
    }
  });

  it('computeTalkTimeBySpeaker matches on timed, degenerate, and empty fixtures', () => {
    for (const words of [TIMED_WORDS, DEGENERATE_WORDS, EMPTY_WORDS]) {
      expect(clientAggregates.computeTalkTimeBySpeaker(words)).toEqual(
        serverAggregates.computeTalkTimeBySpeaker(words),
      );
    }
  });

  it('computeUtteranceStats matches on populated and empty paragraph fixtures', () => {
    for (const paragraphs of [PARAGRAPHS, []]) {
      expect(clientAggregates.computeUtteranceStats(paragraphs)).toEqual(
        serverAggregates.computeUtteranceStats(paragraphs),
      );
    }
  });

  it('FILLER_WORDS and computeFillerStats match verbatim', () => {
    expect(clientAggregates.FILLER_WORDS).toEqual(serverAggregates.FILLER_WORDS);
    for (const words of [TIMED_WORDS, EMPTY_WORDS]) {
      expect(clientAggregates.computeFillerStats(words)).toEqual(
        serverAggregates.computeFillerStats(words),
      );
    }
  });

  it('computeTopicTimeline matches on populated and empty fixtures', () => {
    for (const topics of [TOPICS, []]) {
      expect(clientAggregates.computeTopicTimeline(topics)).toEqual(
        serverAggregates.computeTopicTimeline(topics),
      );
    }
  });

  it('computeEventCounts matches on populated and empty fixtures', () => {
    for (const events of [EVENTS, []]) {
      expect(clientAggregates.computeEventCounts(events)).toEqual(
        serverAggregates.computeEventCounts(events),
      );
    }
  });

  it('computeEventDensity matches for available and unavailable duration', () => {
    expect(clientAggregates.computeEventDensity(EVENTS, 90)).toEqual(
      serverAggregates.computeEventDensity(EVENTS, 90),
    );
    expect(clientAggregates.computeEventDensity(EVENTS, null)).toEqual(
      serverAggregates.computeEventDensity(EVENTS, null),
    );
    expect(clientAggregates.computeEventDensity(EVENTS, 0)).toEqual(
      serverAggregates.computeEventDensity(EVENTS, 0),
    );
  });
});
