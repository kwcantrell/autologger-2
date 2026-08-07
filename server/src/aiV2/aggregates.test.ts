// Unit tests for the ai-v2-dashboards aggregate toolset (design D4, spec
// "Session-scoped aggregate toolset"). Pure functions over already-read hub
// rows — no SessionHub, no I/O, no agent. Fixtures are entirely synthetic
// (never sourced from the private reference dashboard, per the gate).
//
// TDD note: this file is written before `aggregates.ts` exists (RED), then
// the implementation is added to turn it GREEN.

import type { EventRpc } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import type { Topic } from '../session/topicStore';
import type { TranscriptParagraph, TranscriptWord } from '../session/transcriptStore';
import {
  computeEventCounts,
  computeEventDensity,
  computeFillerStats,
  computeSessionDuration,
  computeTalkTimeBySpeaker,
  computeTopicTimeline,
  computeUtteranceStats,
  FILLER_WORDS,
} from './aggregates';

// -- fixture builders ---------------------------------------------------------

/** A synthetic, fully-timed transcript: speaker "0" talks 0..40s, speaker "1"
 * talks 40..100s, ten words of 10s each, perfectly contiguous (no gaps, no
 * overlaps) so that summed per-speaker talk time equals session duration
 * exactly — the invariant task 1.1 asks us to assert. */
function timedWord(
  speaker: string,
  word: string,
  start_sec: number,
  end_sec: number,
  ordinal: number,
): TranscriptWord {
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

const TIMED_WORDS: TranscriptWord[] = [
  timedWord('0', 'hello', 0, 10, 0),
  timedWord('0', 'there', 10, 20, 1),
  timedWord('0', 'friend', 20, 30, 2),
  timedWord('0', 'today', 30, 40, 3),
  timedWord('1', 'well', 40, 50, 4),
  timedWord('1', 'thanks', 50, 60, 5),
  timedWord('1', 'for', 60, 70, 6),
  timedWord('1', 'having', 70, 80, 7),
  timedWord('1', 'me', 80, 90, 8),
  timedWord('1', 'here', 90, 100, 9),
];

/** A manually-entered transcript: schema default 0.0 for every word (D2a) —
 * the degenerate case the aggregate must surface as "unavailable", never as
 * a measured zero. */
const DEGENERATE_WORDS: TranscriptWord[] = [
  timedWord('0', 'hello', 0, 0, 0),
  timedWord('1', 'world', 0, 0, 1),
];

function paragraph(
  speaker: string,
  text: string,
  start_sec: number | null,
  end_sec: number | null,
  ordinal: number,
): TranscriptParagraph {
  return {
    id: `p${ordinal}`,
    start_sec,
    end_sec,
    speaker,
    text,
    ordinal,
    created_at_utc: '2026-07-21T00:00:00.000Z',
  };
}

const PARAGRAPHS: TranscriptParagraph[] = [
  paragraph('0', 'Hello there friend, how are you today?', 0, 40, 0),
  paragraph('1', 'Well thanks for having me here.', 40, 100, 1),
  paragraph('0', 'What did you think of the show?', 100, 130, 2),
];

function topic(
  sessionTime: string,
  durationSec: number,
  level: number,
  summary: string,
  ordinal: number,
): Topic {
  return {
    id: `t${ordinal}`,
    session_time: sessionTime,
    duration_sec: durationSec,
    topic_level: level,
    summary,
    ordinal,
    created_at_utc: '2026-07-21T00:00:00.000Z',
  };
}

const TOPICS: Topic[] = [
  topic('00:00:00', 40, 1, 'Introductions', 0),
  topic('00:00:40', 60, 1, 'Main discussion', 1),
];

function event(category: string, ordinal: number): EventRpc {
  return {
    event_id: `e${ordinal}`,
    wall_time_utc: '2026-07-21T00:00:00.000Z',
    timecode: null,
    frame_rate: null,
    timecode_total_frames: null,
    category,
    message: 'note',
    metadata_json: '{}',
  };
}

const EVENTS: EventRpc[] = [event('cat-a', 0), event('cat-a', 1), event('cat-b', 2)];

// -- session duration ---------------------------------------------------------

describe('computeSessionDuration', () => {
  it('computes the max(end_sec) - min(start_sec) extent over fully-timed words', () => {
    const result = computeSessionDuration(TIMED_WORDS);
    expect(result.available).toBe(true);
    expect(result.durationSec).toBe(100);
  });

  it('is unavailable, never zero-as-data, when every word carries 0/0 timing', () => {
    const result = computeSessionDuration(DEGENERATE_WORDS);
    expect(result.available).toBe(false);
    expect(result.durationSec).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it('is unavailable for an empty transcript', () => {
    const result = computeSessionDuration([]);
    expect(result.available).toBe(false);
    expect(result.durationSec).toBeNull();
  });
});

// -- talk time by speaker ------------------------------------------------------

describe('computeTalkTimeBySpeaker', () => {
  it('sums per-speaker talk time and it equals the session duration for contiguous coverage', () => {
    const talk = computeTalkTimeBySpeaker(TIMED_WORDS);
    const duration = computeSessionDuration(TIMED_WORDS);
    expect(talk.available).toBe(true);
    expect(duration.available).toBe(true);
    const sum = talk.bySpeaker.reduce((acc, s) => acc + (s.talkTimeSec ?? 0), 0);
    expect(sum).toBe(duration.durationSec);
  });

  it('matches hand-computed per-speaker totals', () => {
    const talk = computeTalkTimeBySpeaker(TIMED_WORDS);
    const bySpeaker = Object.fromEntries(talk.bySpeaker.map((s) => [s.speaker, s.talkTimeSec]));
    expect(bySpeaker['0']).toBe(40);
    expect(bySpeaker['1']).toBe(60);
  });

  it('is unavailable, never zero-filled per speaker, when timings are degenerate', () => {
    const talk = computeTalkTimeBySpeaker(DEGENERATE_WORDS);
    expect(talk.available).toBe(false);
    expect(talk.bySpeaker).toEqual([]);
    expect(talk.reason).toBeTruthy();
  });
});

// -- utterance / question counts (from persisted paragraphs, D2a) -------------

describe('computeUtteranceStats', () => {
  it('counts utterances as paragraphs and questions as paragraphs ending in "?"', () => {
    const stats = computeUtteranceStats(PARAGRAPHS);
    expect(stats.available).toBe(true);
    expect(stats.utteranceCount).toBe(3);
    expect(stats.questionCount).toBe(2); // "...today?" and "...show?"
  });

  it('is unavailable, never zero-as-data, when no paragraphs are persisted', () => {
    const stats = computeUtteranceStats([]);
    expect(stats.available).toBe(false);
    expect(stats.utteranceCount).toBeNull();
    expect(stats.questionCount).toBeNull();
    expect(stats.reason).toBeTruthy();
  });
});

// -- filler counts (from raw words, independent of paragraph availability) ----

describe('computeFillerStats', () => {
  it('counts exact filler-word matches, case-insensitively', () => {
    const words: TranscriptWord[] = [
      timedWord('0', 'Um', 0, 1, 0),
      timedWord('0', 'so', 1, 2, 1),
      timedWord('0', 'hello', 2, 3, 2),
      timedWord('1', 'uh', 3, 4, 3),
      timedWord('1', 'friend', 4, 5, 4),
    ];
    const stats = computeFillerStats(words);
    expect(stats.available).toBe(true);
    // "Um" and "uh" are in FILLER_WORDS; "so" and "hello"/"friend" are not.
    expect(stats.fillerCount).toBe(2);
  });

  it('the filler vocabulary is a fixed, exported list (documented, not invented ad hoc)', () => {
    expect(FILLER_WORDS.length).toBeGreaterThan(0);
    expect(FILLER_WORDS).toContain('um');
  });

  it('is unavailable for an empty transcript, never reporting a measured zero', () => {
    const stats = computeFillerStats([]);
    expect(stats.available).toBe(false);
    expect(stats.fillerCount).toBeNull();
    expect(stats.reason).toBeTruthy();
  });
});

// -- topic timeline -------------------------------------------------------------

describe('computeTopicTimeline', () => {
  it('passes through topic rows verbatim, inventing no numeric time from the unvalidated string field', () => {
    const timeline = computeTopicTimeline(TOPICS);
    expect(timeline.entries).toHaveLength(2);
    expect(timeline.entries[0]).toEqual({
      topicId: 't0',
      sessionTime: '00:00:00',
      durationSec: 40,
      topicLevel: 1,
      summary: 'Introductions',
    });
    expect(timeline.entries[1].sessionTime).toBe('00:00:40');
  });

  it('is an empty (not unavailable) timeline when there are no topics', () => {
    const timeline = computeTopicTimeline([]);
    expect(timeline.entries).toEqual([]);
  });
});

// -- event counts + density -----------------------------------------------------

describe('computeEventCounts', () => {
  it('counts events by opaque category id and a total', () => {
    const counts = computeEventCounts(EVENTS);
    expect(counts.totalEvents).toBe(3);
    expect(counts.byCategory).toEqual({ 'cat-a': 2, 'cat-b': 1 });
  });

  it('is zero-total (a real, measured count) for no events, distinct from "unavailable"', () => {
    const counts = computeEventCounts([]);
    expect(counts.totalEvents).toBe(0);
    expect(counts.byCategory).toEqual({});
  });
});

describe('computeEventDensity', () => {
  it('computes events-per-minute against an available session duration', () => {
    const duration = computeSessionDuration(TIMED_WORDS); // 100 sec
    const density = computeEventDensity(EVENTS, duration.durationSec);
    expect(density.available).toBe(true);
    // 3 events / (100s / 60) = 1.8 events/min
    expect(density.eventsPerMinute).toBeCloseTo(1.8, 5);
  });

  it('is unavailable, never zero-as-data, when session duration is unavailable', () => {
    const density = computeEventDensity(EVENTS, null);
    expect(density.available).toBe(false);
    expect(density.eventsPerMinute).toBeNull();
    expect(density.reason).toBeTruthy();
  });
});
