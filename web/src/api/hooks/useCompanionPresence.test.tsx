import { act, renderHook } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../client';
import { useCompanionPresence } from './useCompanionPresence';

// --- useCompanionPresence interval hygiene ---
//
// The hook's contract has three moving parts and they interact, so the tests
// drive all three through their real triggers rather than in isolation:
//
//  1. a visibility-dependent presence cadence — 5s visible, 10s hidden. The
//     hidden cadence is a hard requirement, not an optimization knob: the server
//     prunes presence entries at PRESENCE_FRESH_MS = 15s and Companion refuses
//     commands without a fresh entry, so a hidden tab that went silent would
//     break every Companion command ~15s after backgrounding,
//  2. an immediate post on every visibility transition (Companion needs to hear
//     `visible: false` the instant it happens, not up to 5s later), and
//  3. an immediate post on an `isPlaying` toggle that must NOT re-arm the
//     interval (a toggle at t=2.5s leaves the next cadence post at t=5s).
//
// The fetch layer is mocked at the module boundary (the useSession/useTeams
// idiom), keeping the module's real `apiUrl` for the pagehide beacon path.
// Visibility is driven by shadowing `document.visibilityState` with a
// configurable own property and dispatching the real `visibilitychange` event.
// The harness renders under StrictMode like its sibling hook tests, so the
// mount pass posts twice (mount → cleanup → remount); every assertion is
// therefore a DELTA against the post count observed right after mount, which
// is also what makes case 5 ("a rerender does not stack a second timer")
// meaningful.

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

function setVisibilityState(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
}

/** Flip visibility and fire the event the browser would fire with it. */
function changeVisibility(value: DocumentVisibilityState): void {
  act(() => {
    setVisibilityState(value);
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function postCount(): number {
  return mockedApiFetch.mock.calls.length;
}

function lastBody(): { session_id: string | null; visible: boolean; is_playing: boolean } {
  const call = mockedApiFetch.mock.calls.at(-1);
  if (!call) throw new Error('no presence post recorded');
  return JSON.parse(String((call[1] as RequestInit).body));
}

beforeEach(() => {
  vi.useFakeTimers();
  mockedApiFetch.mockReset();
  mockedApiFetch.mockResolvedValue(undefined as never);
  setVisibilityState('visible');
});

afterEach(() => {
  vi.useRealTimers();
  setVisibilityState('visible');
});

describe('useCompanionPresence', () => {
  it('posts on mount and then on the 5s cadence while visible', () => {
    renderHook(() => useCompanionPresence('sess-1', false), { wrapper });

    expect(postCount()).toBeGreaterThanOrEqual(1);
    expect(lastBody()).toMatchObject({ session_id: 'sess-1', visible: true, is_playing: false });
    const base = postCount();

    act(() => vi.advanceTimersByTime(5_000));
    expect(postCount()).toBe(base + 1);

    act(() => vi.advanceTimersByTime(10_000));
    expect(postCount()).toBe(base + 3);
  });

  it('hiding posts once immediately and then heartbeats on the slower 10s cadence', () => {
    renderHook(() => useCompanionPresence('sess-1', false), { wrapper });
    const base = postCount();

    changeVisibility('hidden');

    // The transition itself is reported right away — that report is what lets
    // Companion re-target another tab.
    expect(postCount()).toBe(base + 1);
    expect(lastBody().visible).toBe(false);

    // …and then a reduced, but non-zero, cadence: nothing at the visible 5s
    // mark, one post at 10s.
    act(() => vi.advanceTimersByTime(9_999));
    expect(postCount()).toBe(base + 1);
    act(() => vi.advanceTimersByTime(1));
    expect(postCount()).toBe(base + 2);
    expect(lastBody().visible).toBe(false);

    // …and it keeps going for as long as the tab stays hidden: 5 more over 50s,
    // versus 10 the visible cadence would have posted.
    act(() => vi.advanceTimersByTime(50_000));
    expect(postCount()).toBe(base + 7);
  });

  it('a hidden tab never lets its server presence entry go stale (gaps < 15s TTL)', () => {
    // PRESENCE_FRESH_MS on the server is 15_000; entries older than that are
    // pruned and Companion's primarySession()/requireActiveSession stop seeing
    // this tab, so every command 409s. The cadence must therefore keep every
    // gap between consecutive posts strictly under that TTL — with margin.
    const PRESENCE_FRESH_MS = 15_000;
    const stamps: number[] = [];
    mockedApiFetch.mockImplementation(() => {
      stamps.push(Date.now());
      return Promise.resolve(undefined as never);
    });

    renderHook(() => useCompanionPresence('sess-1', true), { wrapper });
    changeVisibility('hidden');
    act(() => vi.advanceTimersByTime(120_000));

    expect(stamps.length).toBeGreaterThan(1);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    expect(Math.max(...gaps)).toBeLessThan(PRESENCE_FRESH_MS);
    // A real safety margin, not a hairline pass — hidden-tab timers get
    // throttled and can slip past their nominal deadline.
    expect(Math.max(...gaps)).toBeLessThanOrEqual(PRESENCE_FRESH_MS - 5_000);
  });

  it('returning to visible posts immediately and resumes the cadence', () => {
    renderHook(() => useCompanionPresence('sess-1', false), { wrapper });
    changeVisibility('hidden');
    act(() => vi.advanceTimersByTime(60_000));
    // Baseline taken after the hidden stretch, so the hidden heartbeats above
    // are absorbed and the deltas below measure only the resumed 5s cadence.
    const base = postCount();

    changeVisibility('visible');
    expect(postCount()).toBe(base + 1);
    expect(lastBody().visible).toBe(true);

    act(() => vi.advanceTimersByTime(5_000));
    expect(postCount()).toBe(base + 2);
    act(() => vi.advanceTimersByTime(5_000));
    expect(postCount()).toBe(base + 3);
  });

  it('an isPlaying toggle posts exactly once and leaves the cadence where it was', () => {
    const { rerender } = renderHook(
      ({ playing }: { playing: boolean }) => useCompanionPresence('sess-1', playing),
      { wrapper, initialProps: { playing: false } },
    );
    const base = postCount();

    act(() => vi.advanceTimersByTime(2_500));
    expect(postCount()).toBe(base); // mid-cadence, nothing due yet

    rerender({ playing: true });
    expect(postCount()).toBe(base + 1);
    expect(lastBody().is_playing).toBe(true);

    // The toggle must not have re-armed the interval: the next cadence post is
    // still owed at t=5s from mount, i.e. 2.5s from here — not 5s from here.
    act(() => vi.advanceTimersByTime(2_500));
    expect(postCount()).toBe(base + 2);
    expect(lastBody().is_playing).toBe(true);

    // …and no extra post lands in the 2.5s the old cadence would have added.
    act(() => vi.advanceTimersByTime(2_499));
    expect(postCount()).toBe(base + 2);
  });

  it('a rerender with the same sessionId does not stack a second timer', () => {
    const { rerender } = renderHook(({ id }: { id: string }) => useCompanionPresence(id, false), {
      wrapper,
      initialProps: { id: 'sess-1' },
    });
    const base = postCount();

    rerender({ id: 'sess-1' });
    rerender({ id: 'sess-1' });
    expect(postCount()).toBe(base); // no re-post, no re-arm

    act(() => vi.advanceTimersByTime(5_000));
    expect(postCount()).toBe(base + 1);
  });
});
