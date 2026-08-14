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

import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../../api/client';
import type { Category, LogEvent, SessionTopic, TranscriptWord } from '../../../../api/types';
import { TranscriptWordsGateProvider } from '../../hooks/TranscriptWordsGateContext';
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

/** Same wrapper, plus an explicit deferred-words gate (perf plan B4). Every
 *  test above deliberately renders WITHOUT a provider, reading the context's
 *  load-bearing `true` defaults — i.e. the pre-gate behaviour, unchanged. The
 *  gate-specific tests at the bottom of this file are the only ones that need
 *  the shut-gate case a real (Dashboards-tab-only) session presents.
 *
 *  `dashboardsTabActive` defaults to `true` here (matching the context's own
 *  default) so that only the tests specifically about the tab half of the
 *  dashboards-side trigger have to mention it. */
function wrapperWithGate(client: QueryClient, enabled: boolean, dashboardsTabActive = true) {
  return ({ children }: { children: React.ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <TranscriptWordsGateProvider enabled={enabled} dashboardsTabActive={dashboardsTabActive}>
          {children}
        </TranscriptWordsGateProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

const fetchedTranscriptWords = () =>
  mockedApiFetch.mock.calls.some(([path]) => String(path).includes('transcript-words'));

function word(overrides: Partial<TranscriptWord> & Pick<TranscriptWord, 'id'>): TranscriptWord {
  return {
    session_time: '00:00:00',
    speaker: '0',
    word: 'hello',
    start_sec: 0,
    end_sec: 0,
    ordinal: 0,
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

// --- Deferred transcript-words fetch (perf plan B4) ---
//
// The Dashboards tab is not one of the words-dependent TABS, so its gate stays
// shut on activation; what makes this hook need the multi-MB word list is the
// CONFIG — a dashboard containing any words-derived widget — AND that config
// being SHOWN, i.e. the Dashboards tab active (the panel is mounted, and its
// config loaded, from session mount, so the config alone is not a condition).
// These tests pin both directions of each half of that trigger, its stickiness,
// plus the loading-semantics consequence of gating a query at all (a disabled
// pending query reports `isLoading === false`, so the words signal reads
// `isPending && enabled` instead).
describe('useAiV2WidgetData — deferred transcript-words fetch', () => {
  it('issues no transcript-words request for a config with no words-derived widget', async () => {
    mockResponses({
      words: REAL_TIMED_WORDS,
      topics: TOPICS,
      events: EVENTS,
      categories: CATEGORIES,
    });

    const { result } = renderHook(
      () =>
        useAiV2WidgetData('sess-1', [
          ALL_WIDGETS[5], // topic_timeline
          ALL_WIDGETS[6], // event_count_by_category
        ]),
      { wrapper: wrapperWithGate(makeClient(), false) },
    );

    // Wait for the widgets that DO have a source to settle, so "no words
    // request" is a real absence rather than a not-yet-issued one.
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));
    expect(fetchedTranscriptWords()).toBe(false);
  });

  it('issues the request for a shown config containing a words-derived widget, even with the tab gate shut', async () => {
    mockResponses({
      words: REAL_TIMED_WORDS,
      topics: TOPICS,
      events: EVENTS,
      categories: CATEGORIES,
    });

    const { result } = renderHook(
      () => useAiV2WidgetData('sess-1', [ALL_WIDGETS[8]]), // transcript_excerpt
      { wrapper: wrapperWithGate(makeClient(), false) },
    );

    await waitFor(() =>
      expect(result.current['w-excerpt']).toMatchObject({
        widgetType: 'transcript_excerpt',
        transcriptExcerpt: expect.objectContaining({
          available: true,
          text: 'hello there um thanks',
        }),
      }),
    );
    expect(fetchedTranscriptWords()).toBe(true);
  });

  // --- The config trigger is ANDed with the Dashboards tab being SHOWN ---
  //
  // `AiV2Panel` is always mounted and loads its persisted dashboard in a mount
  // effect, so `widgets` is populated on session mount whether or not the user
  // ever shows the tab. Without the tab half of the condition, any saved
  // dashboard containing one of the five words widgets re-armed the multi-MB
  // fetch on every session mount.
  it('issues no request for a words-derived widget while the Dashboards tab is hidden', async () => {
    mockResponses({
      words: REAL_TIMED_WORDS,
      topics: TOPICS,
      events: EVENTS,
      categories: CATEGORIES,
    });

    const { result } = renderHook(
      () =>
        useAiV2WidgetData('sess-1', [
          ALL_WIDGETS[8], // transcript_excerpt — words-derived
          ALL_WIDGETS[5], // topic_timeline — a source that DOES settle
        ]),
      { wrapper: wrapperWithGate(makeClient(), false, false) },
    );

    // Wait for the widget that has an ungated source, so "no words request" is
    // a real absence rather than a not-yet-issued one.
    await waitFor(() => expect(result.current['w-topics']).toBeDefined());
    expect(fetchedTranscriptWords()).toBe(false);
    // The shut-gate `?? []` answer is published for the excerpt here, exactly
    // as the hook's comment describes — and it is unobservable: the panel this
    // data feeds is hidden, and the render that SHOWS it is the same render
    // that flips the gate open (the context update and the latch happen
    // together), so no zeros-as-data state is ever on screen. The test below
    // pins that flip.
  });

  it('issues the request as soon as the Dashboards tab is shown, and stays enabled after it is hidden again', async () => {
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

    // The tab's activity is a PROP of the provider, not of the hook, so it is
    // driven through a mutable box the wrapper reads on every render.
    const tab = { active: false };
    const client = makeClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StrictMode>
        <QueryClientProvider client={client}>
          <TranscriptWordsGateProvider enabled={false} dashboardsTabActive={tab.active}>
            {children}
          </TranscriptWordsGateProvider>
        </QueryClientProvider>
      </StrictMode>
    );

    const seen: Array<Record<string, unknown>> = [];
    const { result, rerender } = renderHook(
      () => {
        const data = useAiV2WidgetData('sess-1', [ALL_WIDGETS[0]]); // session_duration
        seen.push(data);
        return data;
      },
      { wrapper },
    );
    expect(fetchedTranscriptWords()).toBe(false);

    seen.length = 0;
    tab.active = true;
    rerender();
    await waitFor(() => expect(fetchedTranscriptWords()).toBe(true));
    // Not one render from the flip onward handed the widget the settled
    // "no transcript words yet" answer — the gate opens in the same render
    // that shows the panel.
    expect(seen.some((snapshot) => snapshot['w-duration'] !== undefined)).toBe(false);

    // Sticky the other way: hiding the tab again must not un-enable a query
    // whose data has not arrived yet. If it did, `wordsLoading` would go false
    // with `data === undefined` and the widget would be handed the settled
    // "no transcript words" answer for a session nothing has measured.
    tab.active = false;
    rerender();
    expect(result.current['w-duration']).toBeUndefined();

    resolveWords?.({ words: REAL_TIMED_WORDS });
    await waitFor(() =>
      expect(result.current['w-duration']).toEqual({
        widgetType: 'session_duration',
        sessionDuration: { available: true, reason: null, durationSec: 40 },
      }),
    );
  });

  // The loading-semantics property, end to end: no render in the
  // disabled -> enabled -> resolved sequence may publish the settled "no
  // transcript words yet" answer, because none of them has measured anything.
  // Every render is captured (not just the final one) — the bad state would be
  // transient and `result.current` alone cannot see it.
  //
  // Honest note on strength: this test passes against `isLoading` too. On v5
  // the enabling render already carries react-query's optimistic `isFetching`,
  // so `isLoading` is true there and the flash the plan predicted never
  // materialises. The case that genuinely separates the two signals is the
  // paused query below; this one pins the user-visible property regardless of
  // which signal implements it.
  it('never publishes a settled empty result on the render where the words query becomes enabled', async () => {
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

    const seen: Array<Record<string, unknown>> = [];
    const { result, rerender } = renderHook(
      ({ widgets }: { widgets: WidgetLayout[] }) => {
        const data = useAiV2WidgetData('sess-1', widgets);
        seen.push(data);
        return data;
      },
      {
        wrapper: wrapperWithGate(makeClient(), false),
        initialProps: { widgets: [] as WidgetLayout[] },
      },
    );

    // Shut gate, no words widget: the payload is never requested.
    expect(fetchedTranscriptWords()).toBe(false);

    seen.length = 0;
    rerender({ widgets: [ALL_WIDGETS[0]] }); // session_duration

    await waitFor(() => expect(fetchedTranscriptWords()).toBe(true));
    // Not one render in the flip window handed the widget an entry — it stays
    // withheld (DashboardGrid's "no data provided" placeholder) until the real
    // words arrive.
    expect(seen.some((snapshot) => snapshot['w-duration'] !== undefined)).toBe(false);

    resolveWords?.({ words: REAL_TIMED_WORDS });

    await waitFor(() =>
      expect(result.current['w-duration']).toEqual({
        widgetType: 'session_duration',
        sessionDuration: { available: true, reason: null, durationSec: 40 },
      }),
    );
  });

  // The case the `isPending && wordsEnabled` signal exists for. An enabled
  // query that react-query has PAUSED (browser offline, default `networkMode:
  // 'online'`) is pending with `isFetching === false`, so `isLoading` is
  // `false` while `data` is `undefined` — reading it publishes "This session
  // has no transcript words yet." for a session nothing has ever measured.
  // Gate-intent: this assertion fails if the words signal is reverted to
  // `wordsQuery.isLoading`.
  it('reads an offline-paused words query as loading, never as a measured-empty session', async () => {
    mockResponses({ words: REAL_TIMED_WORDS, topics: [], events: [], categories: [] });
    onlineManager.setOnline(false);
    try {
      const { result } = renderHook(
        () => useAiV2WidgetData('sess-1', [ALL_WIDGETS[0]]), // session_duration
        { wrapper: wrapperFor(makeClient()) },
      );

      // Paused: nothing was requested, and nothing may be claimed about the
      // session's transcript.
      await waitFor(() => expect(mockedApiFetch).not.toHaveBeenCalled());
      expect(result.current['w-duration']).toBeUndefined();

      // Back online, the real (available) answer arrives.
      onlineManager.setOnline(true);
      await waitFor(() =>
        expect(result.current['w-duration']).toEqual({
          widgetType: 'session_duration',
          sessionDuration: { available: true, reason: null, durationSec: 40 },
        }),
      );
    } finally {
      onlineManager.setOnline(true);
    }
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
