import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfile } from '@/api/hooks/useProfile';
import { RootGate } from '@/pages/index/RootGate';
import { renderStrict } from '../../test/renderStrict';
import { AppLoadingSkeleton } from './AppLoadingSkeleton';

// --- AppLoadingSkeleton single-sourcing (nextjs-frontend-migration, task 5.1;
// design D9.1, panel rework 2026-08-13) ---
//
// Done-ness gate: a jsdom test asserting the `dynamic()` `loading` fallback
// (verbatim usage: `IndexIsland.tsx` / `AdminIsland.tsx` both do
// `loading: () => <AppLoadingSkeleton />`) and the island's own in-app loading
// branch (`RootGate.tsx`'s `LoadingState`, rendered while `useProfile()` is
// pending) render the SAME component -- not two hand-maintained copies of the
// loading markup that happen to look alike today and can silently drift
// tomorrow.
//
// The assertion is deliberately identity-based rather than markup-based: a
// forked mirror could trivially copy-paste the same class list / aria
// attributes / `data-testid`, which would pass a pure DOM-shape comparison
// while still being a second hand-maintained definition. Wrapping the real
// `AppLoadingSkeleton` export in a `vi.fn` spy and asserting it is the
// function React actually invokes on BOTH render paths catches that class of
// drift; a DOM-shape check is kept as a secondary, documentation-level
// assertion.
//
// Mutation check performed against the working tree (not committed): with
// `RootGate.tsx`'s `LoadingState` temporarily reverted to inline `<output>`
// markup (no `AppLoadingSkeleton` call), this test's second assertion failed
// as expected (`toHaveBeenCalledTimes` stayed at the fallback-only count);
// reverted back to the shared-component call before committing.

vi.mock('./AppLoadingSkeleton', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./AppLoadingSkeleton')>();
  return {
    ...actual,
    AppLoadingSkeleton: vi.fn(actual.AppLoadingSkeleton),
  };
});

vi.mock('@/api/hooks/useProfile', () => ({
  useProfile: vi.fn(),
}));

const mockedAppLoadingSkeleton = vi.mocked(AppLoadingSkeleton);
const mockedUseProfile = vi.mocked(useProfile);

describe('AppLoadingSkeleton single-sourcing (task 5.1)', () => {
  beforeEach(() => {
    mockedAppLoadingSkeleton.mockClear();
    mockedUseProfile.mockReset();
  });

  it('is the exact same component the dynamic()-loading fallback and RootGate loading branch both render', () => {
    // dynamic() fallback path, verbatim: IndexIsland/AdminIsland's
    // `loading: () => <AppLoadingSkeleton />`.
    const fallback = renderStrict(<AppLoadingSkeleton />);
    const fallbackCallCount = mockedAppLoadingSkeleton.mock.calls.length;
    expect(fallbackCallCount).toBeGreaterThan(0);
    const fallbackNode = fallback.container.querySelector('[data-testid="app-loading-skeleton"]');
    expect(fallbackNode).not.toBeNull();

    // RootGate's own in-app loading branch: no profile data yet, query
    // pending (not errored) -- the `LoadingState` branch.
    mockedUseProfile.mockReturnValue({
      data: undefined,
      isError: false,
      isFetching: true,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useProfile>);

    const gate = renderStrict(<RootGate />);

    // Identity: RootGate's loading branch called the SAME spied function --
    // not a hand-rolled copy that happens to hardcode a matching testid.
    expect(mockedAppLoadingSkeleton.mock.calls.length).toBeGreaterThan(fallbackCallCount);

    // Secondary, documentation-level shape check: the rendered node still
    // carries the shared component's structural contract.
    const gateNode = gate.container.querySelector('[data-testid="app-loading-skeleton"]');
    expect(gateNode).not.toBeNull();
    expect(gateNode?.className).toBe(fallbackNode?.className);
    expect(gateNode?.getAttribute('aria-busy')).toBe(fallbackNode?.getAttribute('aria-busy'));
    expect(gateNode?.getAttribute('aria-live')).toBe(fallbackNode?.getAttribute('aria-live'));
    expect(gateNode?.getAttribute('aria-label')).toBe(fallbackNode?.getAttribute('aria-label'));
    expect(gateNode?.tagName).toBe(fallbackNode?.tagName);

    // RootGate's own opt-in: a stable id its other tests/e2e specs key on,
    // and the video progressive-enhancement content in place of the static
    // wordmark panel -- both layered on the one shared frame, not a fork of
    // it.
    expect(gate.container.querySelector('#root-gate-loading')).not.toBeNull();
    expect(gate.container.querySelector('.autologger-loading-video')).not.toBeNull();

    // No user- or session-derived data in the skeleton (spec requirement):
    // the fallback's rendered content carries no data attributes/text beyond
    // the static wordmark.
    expect(fallbackNode?.textContent).toBe('AutoLogger');
  });
});
