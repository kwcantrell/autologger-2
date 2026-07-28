// ai-v2-dashboards — useAiV2WidgetData (task 5.6). Real fixtures render real
// data; no-timings/anchorless fixtures still render the unavailable state
// (no zeros-as-data regression, task 4.7's property held with REAL
// client-side aggregation in the path now) — spec "Data unavailability is a
// rendered state, never a zero". Category-label resolution + the honest
// "labels unavailable" (never a bare id) is covered at the
// `EventCountByCategoryWidget` level (see that widget's own concerns); this
// file asserts the HOOK builds a correct label map (resolved ids present,
// unresolved ids absent so the widget's own fallback engages, `internal`
// always present).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../../api/client';
import type { Category, LogEvent, SessionTopic, TranscriptWord } from '../../../../api/types';
import { useAiV2WidgetData } from './useAiV2WidgetData';
import type { WidgetLayout } from './widgetTypes';

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </StrictMode>
  );
}

function word(overrides: Partial<TranscriptWord> & Pick<TranscriptWord, 'id'>): TranscriptWord {
  return {
    session_id: 'sess-1',
    session_time: '00:00:00',
    speaker: '0',
    word: 'hello',
    start_sec: 0,
    end_sec: 0,
    ordinal: 0,
    created_at_utc: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

const REAL_TIMED_WORDS: TranscriptWord[] = [
  word({ id: 'w0', speaker: '0', word: 'hello', start_sec: 0, end_sec: 10, ordinal: 0 }),
  word({ id: 'w1', speaker: '0', word: 'there', start_sec: 10, end_sec: 20, ordinal: 1 }),
  word({ id: 'w2', speaker: '1', word: 'um', start_sec: 20, end_sec: 30, ordinal: 2 }),
  word({ id: 'w3', speaker: '1', word: 'thanks', start_sec: 30, end_sec: 40, ordinal: 3 }),
];

const NO_TIMING_WORDS: TranscriptWord[] = [
  word({ id: 'w0', speaker: '0', word: 'hello', start_sec: 0, end_sec: 0, ordinal: 0 }),
  word({ id: 'w1', speaker: '1', word: 'world', start_sec: 0, end_sec: 0, ordinal: 1 }),
];

const TOPICS: SessionTopic[] = [
  {
    id: 't1',
    session_time: '0:00',
    duration_sec: 60,
    topic_level: 0,
    summary: 'Intro',
    ordinal: 0,
    created_at_utc: '2026-07-21T00:00:00.000Z',
  },
];

function event(overrides: Partial<LogEvent> & Pick<LogEvent, 'event_id' | 'category'>): LogEvent {
  return {
    wall_time_utc: '2026-07-21T00:00:00.000Z',
    timecode: '00:00:00:00',
    frame_rate: 30,
    timecode_total_frames: 0,
    category_label: overrides.category,
    category_color: '#888888',
    message: '',
    metadata: {},
    ...overrides,
  };
}

const EVENTS: LogEvent[] = [
  event({ event_id: 'e1', category: 'marker' }),
  event({ event_id: 'e2', category: 'marker' }),
  event({ event_id: 'e3', category: 'deleted-cat-id' }), // no matching Category below
  event({ event_id: 'e4', category: 'internal' }),
];

const CATEGORIES: Category[] = [
  {
    id: 'marker',
    label: 'Marker',
    color: '#ff0000',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  },
];

function mockResponses(opts: {
  words?: TranscriptWord[];
  topics?: SessionTopic[];
  events?: LogEvent[];
  categories?: Category[];
}) {
  mockedApiFetch.mockImplementation((path: string) => {
    if (path.includes('transcript-words')) return Promise.resolve({ words: opts.words ?? [] });
    if (path.includes('topics')) return Promise.resolve({ topics: opts.topics ?? [] });
    if (path.includes('show-categories')) {
      return Promise.resolve({
        categories: opts.categories ?? [],
        show_name: 'Show',
        show_code: 'SH',
      });
    }
    if (path.includes('events')) {
      const events = opts.events ?? [];
      return Promise.resolve({
        events,
        total: events.length,
        logged_event_count: events.length,
        offset: 0,
        limit: 2000,
      });
    }
    return Promise.reject(new Error(`unexpected apiFetch path: ${path}`));
  });
}

const ALL_WIDGETS: WidgetLayout[] = [
  { id: 'w-duration', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 },
  { id: 'w-talk', type: 'talk_time_by_speaker', title: 'Talk time', x: 0, y: 0, w: 4, h: 2 },
  { id: 'w-utt', type: 'utterance_counts', title: 'Utterances', x: 0, y: 0, w: 4, h: 2 },
  { id: 'w-q', type: 'question_counts', title: 'Questions', x: 0, y: 0, w: 4, h: 2 },
  { id: 'w-filler', type: 'filler_counts', title: 'Fillers', x: 0, y: 0, w: 4, h: 2 },
  { id: 'w-topics', type: 'topic_timeline', title: 'Topics', x: 0, y: 0, w: 4, h: 2 },
  { id: 'w-cat', type: 'event_count_by_category', title: 'Categories', x: 0, y: 0, w: 4, h: 2 },
  { id: 'w-density', type: 'event_density', title: 'Density', x: 0, y: 0, w: 4, h: 2 },
  { id: 'w-excerpt', type: 'transcript_excerpt', title: 'Excerpt', x: 0, y: 0, w: 4, h: 2 },
];

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('useAiV2WidgetData — real fixtures render real data', () => {
  it('computes real, available data for every widget type EXCEPT utterance/question counts', async () => {
    mockResponses({
      words: REAL_TIMED_WORDS,
      topics: TOPICS,
      events: EVENTS,
      categories: CATEGORIES,
    });

    const { result } = renderHook(() => useAiV2WidgetData('sess-1', ALL_WIDGETS), {
      wrapper: wrapperFor(makeClient()),
    });

    // Whole-branch audit fix wave (Fix 5): a widget's entry is now WITHHELD
    // while its underlying query is still loading (see the dedicated
    // "loading vs. empty" describe block below) rather than appearing
    // immediately off a `[] | undefined` default — wait for the queries to
    // actually resolve by polling for the real, settled duration value
    // specifically.
    await waitFor(() =>
      expect(result.current['w-duration']).toEqual({
        widgetType: 'session_duration',
        sessionDuration: { available: true, reason: null, durationSec: 40 },
      }),
    );
    const data = result.current;

    expect(data['w-talk']).toMatchObject({
      widgetType: 'talk_time_by_speaker',
      talkTimeBySpeaker: {
        available: true,
        reason: null,
        bySpeaker: expect.arrayContaining([
          { speaker: '0', talkTimeSec: 20 },
          { speaker: '1', talkTimeSec: 20 },
        ]),
      },
    });

    expect(data['w-filler']).toEqual({
      widgetType: 'filler_counts',
      fillerCounts: { available: true, reason: null, fillerCount: 1 }, // "um"
    });

    expect(data['w-topics']).toEqual({
      widgetType: 'topic_timeline',
      topicTimeline: {
        entries: [
          { topicId: 't1', sessionTime: '0:00', durationSec: 60, topicLevel: 0, summary: 'Intro' },
        ],
      },
    });

    expect(data['w-density']).toEqual({
      widgetType: 'event_density',
      eventDensity: { available: true, reason: null, eventsPerMinute: 6 }, // 4 events / (40s/60)
    });

    expect(data['w-excerpt']).toMatchObject({
      widgetType: 'transcript_excerpt',
      transcriptExcerpt: expect.objectContaining({
        available: true,
        text: 'hello there um thanks',
      }),
    });

    // event_count_by_category: real counts + resolved labels.
    const catWidget = data['w-cat'];
    expect(catWidget?.widgetType).toBe('event_count_by_category');
    if (catWidget?.widgetType === 'event_count_by_category') {
      expect(catWidget.eventCountByCategory).toEqual({
        totalEvents: 4,
        byCategory: { marker: 2, 'deleted-cat-id': 1, internal: 1 },
      });
      // Resolved via useShowCategories.
      expect(catWidget.categoryLabels?.marker).toBe('Marker');
      // Well-known system category, resolved regardless of studio categories.
      expect(catWidget.categoryLabels?.internal).toBe('Internal');
      // NOT resolvable — deliberately absent so the widget renders the
      // honest "labels unavailable" fallback, never a fabricated label.
      expect(catWidget.categoryLabels?.['deleted-cat-id']).toBeUndefined();
    }
  });

  it('utterance_counts/question_counts are ALWAYS unavailable client-side — no paragraph route exists (D11), never zeros', async () => {
    mockResponses({
      words: REAL_TIMED_WORDS,
      topics: TOPICS,
      events: EVENTS,
      categories: CATEGORIES,
    });

    const { result } = renderHook(() => useAiV2WidgetData('sess-1', ALL_WIDGETS), {
      wrapper: wrapperFor(makeClient()),
    });

    // Force a real wait on the queries settling (not just the trivially-true
    // pre-load default) via a sibling widget that only reaches its expected
    // value once the real fixtures have loaded.
    await waitFor(() =>
      expect(result.current['w-density']).toMatchObject({
        eventDensity: { available: true, eventsPerMinute: 6 },
      }),
    );

    expect(result.current['w-utt']).toMatchObject({
      widgetType: 'utterance_counts',
      utteranceCounts: { available: false, utteranceCount: null, questionCount: null },
    });
    expect(result.current['w-q']).toMatchObject({
      widgetType: 'question_counts',
      questionCounts: { available: false, utteranceCount: null, questionCount: null },
    });
  });
});

describe('useAiV2WidgetData — degraded/absent data never renders as zero', () => {
  it('a manually-entered transcript (start_sec/end_sec never written) renders unavailable, not zeros', async () => {
    mockResponses({ words: NO_TIMING_WORDS, topics: [], events: [], categories: [] });

    const { result } = renderHook(
      () =>
        useAiV2WidgetData('sess-1', [
          ALL_WIDGETS[0], // session_duration
          ALL_WIDGETS[1], // talk_time_by_speaker
          ALL_WIDGETS[7], // event_density
        ]),
      { wrapper: wrapperFor(makeClient()) },
    );

    // The pre-load default (`words: undefined -> []`) ALSO reports
    // `available: false`, so waiting on that alone would pass trivially
    // before the fixture even loads — wait on the SPECIFIC degenerate-timing
    // reason text instead, which only appears once the real 2-word,
    // all-zero-timing fixture has actually resolved.
    await waitFor(() =>
      expect(result.current['w-duration']).toMatchObject({
        sessionDuration: {
          reason:
            'This transcript has no word timings (manually entered, or not anchored to recorded audio).',
        },
      }),
    );
    const data = result.current;

    expect(data['w-duration']).toMatchObject({
      sessionDuration: { available: false, durationSec: null },
    });
    expect(data['w-duration']).not.toMatchObject({ sessionDuration: { durationSec: 0 } });

    expect(data['w-talk']).toMatchObject({
      talkTimeBySpeaker: { available: false, bySpeaker: [] },
    });

    expect(data['w-density']).toMatchObject({
      eventDensity: { available: false, eventsPerMinute: null },
    });
  });
});

// Whole-branch audit fix wave (Fix 5): before this fix, `words ?? []`/
// `topics ?? []`/`events ?? []` coalesced "the fetch hasn't returned yet"
// with "the fetch returned a genuinely empty result" — so a widget like
// `topic_timeline`/`event_count_by_category` briefly rendered its settled
// "No topics/events recorded for this session." text during the loading
// window, misleadingly asserting the session had been measured and found
// empty. These tests use a controllable (never-auto-resolving) `apiFetch`
// promise to hold a query in its loading state on purpose, so the
// still-loading and now-settled assertions are checking two genuinely
// different points in time, not a coincidentally-fast resolution.
describe('useAiV2WidgetData — loading is distinguished from a genuinely empty result', () => {
  it("withholds topic_timeline's entry while topics are still loading, then supplies the real (empty) result once settled", async () => {
    let resolveTopics: ((value: { topics: SessionTopic[] }) => void) | undefined;
    mockedApiFetch.mockImplementation((path: string) => {
      if (path.includes('transcript-words')) return Promise.resolve({ words: [] });
      if (path.includes('topics')) {
        return new Promise((resolve) => {
          resolveTopics = resolve;
        });
      }
      if (path.includes('show-categories')) {
        return Promise.resolve({ categories: [], show_name: 'Show', show_code: 'SH' });
      }
      if (path.includes('events')) {
        return Promise.resolve({
          events: [],
          total: 0,
          logged_event_count: 0,
          offset: 0,
          limit: 2000,
        });
      }
      return Promise.reject(new Error(`unexpected apiFetch path: ${path}`));
    });

    const { result } = renderHook(
      () => useAiV2WidgetData('sess-1', [ALL_WIDGETS[5]]), // topic_timeline only
      { wrapper: wrapperFor(makeClient()) },
    );

    // Still loading: NO entry at all — never the settled "no topics" shape
    // synthesized off the `topics ?? []` default. `DashboardGrid`'s existing
    // "no data provided" fallback covers the gap in the meantime (not a new
    // zeros-as-data path — this widget simply has no entry yet).
    expect(result.current['w-topics']).toBeUndefined();

    // The fetch now settles — genuinely empty (no topics recorded).
    resolveTopics?.({ topics: [] });

    await waitFor(() =>
      expect(result.current['w-topics']).toEqual({
        widgetType: 'topic_timeline',
        topicTimeline: { entries: [] },
      }),
    );
  });

  it("withholds session_duration's entry while words are still loading, then supplies the real (unavailable) result once settled", async () => {
    let resolveWords: ((value: { words: TranscriptWord[] }) => void) | undefined;
    mockedApiFetch.mockImplementation((path: string) => {
      if (path.includes('transcript-words')) {
        return new Promise((resolve) => {
          resolveWords = resolve;
        });
      }
      if (path.includes('topics')) return Promise.resolve({ topics: [] });
      if (path.includes('show-categories')) {
        return Promise.resolve({ categories: [], show_name: 'Show', show_code: 'SH' });
      }
      if (path.includes('events')) {
        return Promise.resolve({
          events: [],
          total: 0,
          logged_event_count: 0,
          offset: 0,
          limit: 2000,
        });
      }
      return Promise.reject(new Error(`unexpected apiFetch path: ${path}`));
    });

    const { result } = renderHook(
      () => useAiV2WidgetData('sess-1', [ALL_WIDGETS[0]]), // session_duration only
      { wrapper: wrapperFor(makeClient()) },
    );

    expect(result.current['w-duration']).toBeUndefined();

    resolveWords?.({ words: [] });

    await waitFor(() =>
      expect(result.current['w-duration']).toEqual({
        widgetType: 'session_duration',
        sessionDuration: {
          available: false,
          reason: 'This session has no transcript words yet.',
          durationSec: null,
        },
      }),
    );
  });
});

describe('useAiV2WidgetData — real fixtures render real data (degraded/absent)', () => {
  it('an empty transcript (no words at all) renders unavailable, not zeros', async () => {
    mockResponses({ words: [], topics: [], events: [], categories: [] });

    const { result } = renderHook(() => useAiV2WidgetData('sess-1', [ALL_WIDGETS[0]]), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(1));
    expect(result.current['w-duration']).toEqual({
      widgetType: 'session_duration',
      sessionDuration: {
        available: false,
        reason: 'This session has no transcript words yet.',
        durationSec: null,
      },
    });
  });
});
