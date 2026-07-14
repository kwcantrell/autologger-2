import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWrapperNavigation } from '../departureWatcher';
import { getOriginatedSessionId, resetOriginationForTesting } from '../transportOrigination';
import { TransportControls } from './TransportControls';

// --- Async-gap origination-guard regression (session-deep-links phase-5
// review) ---
//
// TransportControls' roll-button handler awaits `start.mutateAsync()` before
// calling `markOriginated(sessionId)` (design D4). Between the click and that
// await resolving, the user can navigate elsewhere — switching to another
// session (this component re-renders with a new `sessionId` prop; it is
// never unmounted on a same-tree switch, see SessionWorkspace) or leaving the
// workspace entirely (this component unmounts, gated on `sessionId` being
// truthy). Marking origination for the stale, closed-over `sessionId` after
// either of those would leave a flag pointing at a route the client is no
// longer on; the departure watcher's "target isn't the flagged id" check
// would then fire on a LATER, unrelated departure — see
// `transportOrigination.ts`'s `markOriginated` doc comment and
// `departureWatcher.test.tsx`'s matrix for the watcher side of this
// contract. This file exercises the guard at its actual call site
// (`mountedRef` + `latestSessionIdRef` in TransportControls.tsx), using the
// real `transportOrigination`/`departureWatcher` modules end-to-end.

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: () => ({ data: { is_rolling: false, audio_recording_lease_alive: false } }),
}));

let resolveStart: (() => void) | null;
let mockStart: { mutateAsync: ReturnType<typeof vi.fn> };

vi.mock('../../../api/hooks/useTransport', () => ({
  useTransport: () => ({
    start: mockStart,
    stop: { mutateAsync: vi.fn().mockResolvedValue(undefined) },
  }),
}));

function rollButton() {
  return screen.getByRole('button', { name: 'Roll timecode' });
}

beforeEach(() => {
  resolveStart = null;
  mockStart = {
    mutateAsync: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    ),
  };
  window.AutoLogger_stopTransportIfNeeded = undefined;
});

afterEach(() => {
  resetOriginationForTesting();
  window.AutoLogger_stopTransportIfNeeded = undefined;
  vi.clearAllMocks();
});

describe('TransportControls origination guard (async-gap race)', () => {
  it('does not mark origination for a session the client has switched away from before the mutation resolves', async () => {
    const { rerender } = render(<TransportControls sessionId="sess-1" />);

    fireEvent.click(rollButton());
    expect(mockStart.mutateAsync).toHaveBeenCalledTimes(1);

    // The user switches to another session while transport-start for sess-1
    // is still in flight: SessionWorkspace re-renders this same component
    // with a new sessionId prop (no unmount on a same-tree switch), and the
    // departure watcher observes the navigation away from sess-1 — with
    // nothing to fire yet, since the flag was never set (mirrors the real
    // navigate() call navigation.ts wires through).
    rerender(<TransportControls sessionId="sess-2" />);
    handleWrapperNavigation('/sessions/sess-2');
    expect(getOriginatedSessionId()).toBeNull();

    // The in-flight mutation resolves now, after the switch. The guard must
    // stop the stale markOriginated('sess-1') call from landing.
    resolveStart?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(getOriginatedSessionId()).toBeNull();

    // A later, unrelated departure (sess-2 rolling via another client; this
    // client never originated it) must not fire the stop global — a
    // pre-fix build would have left the stale sess-1 flag armed, which
    // satisfies the watcher's "target isn't the flagged id" check on this
    // departure and fires it regardless of which session is really rolling.
    const stop = vi.fn();
    window.AutoLogger_stopTransportIfNeeded = stop;
    handleWrapperNavigation('/');
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not mark origination for a session the client has fully navigated away from (unmount) before the mutation resolves', async () => {
    const { unmount } = render(<TransportControls sessionId="sess-1" />);

    fireEvent.click(rollButton());
    expect(mockStart.mutateAsync).toHaveBeenCalledTimes(1);

    // The user closes the session / leaves the workspace entirely before the
    // mutation resolves: this component unmounts (SessionWorkspace gates it
    // on `sessionId` being truthy).
    unmount();
    handleWrapperNavigation('/');
    expect(getOriginatedSessionId()).toBeNull();

    resolveStart?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(getOriginatedSessionId()).toBeNull();
  });

  it('still marks origination normally when the client stays on the same session route', async () => {
    render(<TransportControls sessionId="sess-1" />);

    fireEvent.click(rollButton());
    resolveStart?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(getOriginatedSessionId()).toBe('sess-1');
  });
});
