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
//  1. a 5s presence cadence that runs ONLY while the tab is visible,
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

  it('hiding posts once immediately and then stops the cadence entirely', () => {
    renderHook(() => useCompanionPresence('sess-1', false), { wrapper });
    const base = postCount();

    changeVisibility('hidden');

    // The transition itself is reported right away — that report is what lets
    // Companion re-target another tab.
    expect(postCount()).toBe(base + 1);
    expect(lastBody().visible).toBe(false);

    // …and then silence, however long the tab stays hidden.
    act(() => vi.advanceTimersByTime(60_000));
    expect(postCount()).toBe(base + 1);
  });

  it('returning to visible posts immediately and resumes the cadence', () => {
    renderHook(() => useCompanionPresence('sess-1', false), { wrapper });
    changeVisibility('hidden');
    act(() => vi.advanceTimersByTime(60_000));
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
