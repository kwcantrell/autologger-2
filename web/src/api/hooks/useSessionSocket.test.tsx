import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioSegmentsKeys } from './useAudio';
import { eventsKeys } from './useEvents';
import { useSessionSocket } from './useSessionSocket';
import { sessionStatusKeys } from './useSessionStatus';

// --- useSessionSocket burst coalescing (auto-generate-event-logs, task 5.2) ---
//
// `event.changed` frames are the server's per-insert broadcast; a bulk generation
// run emits them in a burst (server emission semantics unchanged — gate
// 2026-07-28). The hook debounces the events-query invalidation with a leading
// edge (the first frame of a burst — and therefore a single manual log —
// invalidates immediately) plus a ~1s trailing refetch, so a quiet period always
// ends with a refetch reflecting final state. Every other frame type keeps its
// per-frame invalidation. The socket itself is faked at the global constructor
// boundary; frames are injected straight into `onmessage`, and fake timers drive
// the coalescing window.

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  // -- test drivers --
  open() {
    this.onopen?.();
  }

  frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const SESSION_ID = 'sess-socket-1';

function renderSocket() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </StrictMode>
  );
  const utils = renderHook(() => useSessionSocket(SESSION_ID), { wrapper });
  // StrictMode double-mounts the effect: the first socket is torn down
  // immediately, the LAST instance is the live one.
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error('useSessionSocket opened no WebSocket');
  const countByKey = (key: readonly unknown[]) =>
    invalidate.mock.calls.filter(
      ([arg]) => JSON.stringify((arg as { queryKey?: unknown })?.queryKey) === JSON.stringify(key),
    ).length;
  return {
    ...utils,
    qc,
    ws,
    invalidate,
    eventsCalls: () => countByKey(eventsKeys.all(SESSION_ID)),
    statusCalls: () => countByKey(sessionStatusKeys.bySession(SESSION_ID)),
  };
}

describe('useSessionSocket — event.changed burst coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a single frame invalidates the events query immediately (leading edge)', () => {
    const { ws, invalidate, eventsCalls } = renderSocket();
    act(() => ws.open());
    invalidate.mockClear();

    act(() => ws.frame({ type: 'event.changed' }));

    // No timer advance: the common single-manual-log case must not wait ~1s.
    expect(eventsCalls()).toBe(1);
  });

  it('a 60-frame burst coalesces to a bounded refetch count with one trailing refetch after quiet', () => {
    const { ws, invalidate, eventsCalls } = renderSocket();
    act(() => ws.open());
    invalidate.mockClear();

    // 60 frames over ~600ms — all inside one coalescing window after the leading edge.
    act(() => {
      for (let i = 0; i < 60; i += 1) {
        ws.frame({ type: 'event.changed' });
        vi.advanceTimersByTime(10);
      }
    });
    const duringBurst = eventsCalls();
    expect(duringBurst).toBe(1); // leading edge only — not one per frame

    // Quiet period ends with exactly one trailing refetch (final state).
    act(() => vi.advanceTimersByTime(1_000));
    expect(eventsCalls()).toBe(duringBurst + 1);
    expect(eventsCalls()).toBeLessThanOrEqual(3);

    // The trailing refetch does not self-perpetuate once the burst is over.
    act(() => vi.advanceTimersByTime(5_000));
    expect(eventsCalls()).toBe(duringBurst + 1);
  });

  it('a continuing burst refetches about once per second, then settles on final state', () => {
    const { ws, invalidate, eventsCalls } = renderSocket();
    act(() => ws.open());
    invalidate.mockClear();

    // 60 frames over ~3s: leading edge + one trailing per elapsed window.
    act(() => {
      for (let i = 0; i < 60; i += 1) {
        ws.frame({ type: 'event.changed' });
        vi.advanceTimersByTime(50);
      }
    });
    act(() => vi.advanceTimersByTime(1_000));

    const total = eventsCalls();
    expect(total).toBeGreaterThanOrEqual(2); // leading + trailing at minimum
    expect(total).toBeLessThanOrEqual(5); // ~1/s over ~3s, never 60
  });

  it('other frame types keep per-frame invalidation (coalescing scoped to events)', () => {
    const { ws, invalidate, statusCalls, eventsCalls } = renderSocket();
    act(() => ws.open());
    invalidate.mockClear();

    act(() => {
      ws.frame({ type: 'transport.changed' });
      ws.frame({ type: 'transport.changed' });
      ws.frame({ type: 'transport.changed' });
    });

    expect(statusCalls()).toBe(3);
    expect(eventsCalls()).toBe(0);
  });

  it('unmount during an open window clears the trailing timer (no late invalidation)', () => {
    const { ws, invalidate, eventsCalls, unmount } = renderSocket();
    act(() => ws.open());
    invalidate.mockClear();

    act(() => {
      ws.frame({ type: 'event.changed' });
      ws.frame({ type: 'event.changed' }); // trailing now pending
    });
    expect(eventsCalls()).toBe(1);

    unmount();
    invalidate.mockClear();
    act(() => vi.advanceTimersByTime(5_000));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

// --- WS-open resync freshness gate (perf-fixes B2) ---
//
// resync() still fires its three invalidateQueries calls on every open, but
// each now carries a predicate that skips queries whose data is already
// fresher than the connect attempt (`dataUpdatedAt >= connectStartedAt`) and
// mount fetches still in flight with no data yet. The invalidate SPY cannot
// see predicate filtering (the call happens either way), so these tests
// assert through query state — `qc.getQueryState(key)?.isInvalidated` — over
// seeded caches. Vitest fake timers fake `Date`, so `vi.advanceTimersByTime`
// moves both the reconnect timers and the `Date.now()` freshness clock.

describe('useSessionSocket — WS-open resync freshness gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const statusKey = sessionStatusKeys.bySession(SESSION_ID);
  // A concrete per-page events key: resync targets the eventsKeys.all() PREFIX,
  // so invalidation reaching this key proves prefix matching composes with the
  // predicate (the reason the gate is a predicate at all).
  const eventsPageKey = eventsKeys.page(SESSION_ID, 0, 2000);
  const audioKey = audioSegmentsKeys.bySession(SESSION_ID);

  const seedAll = (qc: QueryClient) => {
    qc.setQueryData(statusKey, { is_rolling: false });
    qc.setQueryData(eventsPageKey, { events: [] });
    qc.setQueryData(audioKey, { segments: [], has_audio: false });
  };

  it('first open with freshly seeded caches invalidates none of them', () => {
    const { ws, qc } = renderSocket();
    // Seed after connect() recorded connectStartedAt — the just-landed mount
    // fetch case: data provably fresher than the connect attempt.
    act(() => vi.advanceTimersByTime(5));
    seedAll(qc);

    act(() => ws.open());

    expect(qc.getQueryState(statusKey)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(eventsPageKey)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(audioKey)?.isInvalidated).toBe(false);
  });

  it('reconnect: data last updated before the reconnect attempt IS invalidated (catch-up preserved)', () => {
    const { ws, qc } = renderSocket();
    act(() => ws.open());

    // A healthy connection span, then data lands, then the socket drops.
    act(() => vi.advanceTimersByTime(3_000));
    seedAll(qc);
    act(() => {
      ws.onclose?.();
    });

    // Past the max jittered backoff (~1.3s after a healthy drop): the
    // reconnect attempt re-records connectStartedAt AFTER the seed above.
    act(() => vi.advanceTimersByTime(2_000));
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws2).not.toBe(ws);
    act(() => ws2.open());

    expect(qc.getQueryState(statusKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(eventsPageKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(audioKey)?.isInvalidated).toBe(true);
  });

  it('reconnect: data refreshed after the reconnect attempt started is NOT invalidated', () => {
    const { ws, qc } = renderSocket();
    act(() => ws.open());
    act(() => vi.advanceTimersByTime(3_000));
    act(() => {
      ws.onclose?.();
    });

    // Let the reconnect attempt start (timer fires within the advance), THEN
    // seed — dataUpdatedAt lands at/after the attempt's connectStartedAt.
    act(() => vi.advanceTimersByTime(2_000));
    seedAll(qc);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    act(() => ws2.open());

    expect(qc.getQueryState(statusKey)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(eventsPageKey)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(audioKey)?.isInvalidated).toBe(false);
  });

  it('a mount fetch still in flight (no data yet) is not invalidated-restarted by open', () => {
    const { ws, qc } = renderSocket();
    // In-flight fetch with no data: fetchStatus 'fetching', dataUpdatedAt 0.
    void qc
      .fetchQuery({ queryKey: statusKey, queryFn: () => new Promise(() => {}) })
      .catch(() => undefined);
    expect(qc.getQueryState(statusKey)?.fetchStatus).toBe('fetching');
    expect(qc.getQueryState(statusKey)?.dataUpdatedAt).toBe(0);

    act(() => ws.open());

    expect(qc.getQueryState(statusKey)?.isInvalidated).toBe(false);
  });
});
