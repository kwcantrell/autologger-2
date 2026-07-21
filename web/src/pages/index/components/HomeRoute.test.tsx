import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessions } from '../../../api/hooks/useSessions';
import type { Session, SessionsResponse } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { setNavigationImplForTesting } from '../navigation';
import { HomeRoute } from './HomeRoute';

// --- HomeRoute component tests (ui-refresh, task 5.1; spec: web-home-launch
// "Branded home launch surface", all four scenarios) ---
//
// Mocked at the module boundary (the V6Rail.test.tsx idiom): `useSessions`
// is stubbed directly rather than driven through a real QueryClient, since
// this component's only data dependency is the sessions list shape. Navigation
// is recorded through the shared `navigate` wrapper's test seam (the
// SessionRoute.test.tsx idiom).

vi.mock('../../../api/hooks/useSessions', () => ({
  useSessions: vi.fn(),
}));

const mockedUseSessions = vi.mocked(useSessions);

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Ep 12 Live Log',
    deck_title: '',
    show_id: 'show-1',
    show_code: 'SH',
    show_name: 'Show One',
    episode: '12',
    notes: '',
    session_status: 'active',
    frame_rate: 30,
    start_offset_frames: 0,
    created_at_utc: '2026-07-14T00:00:00Z',
    episode_date: null,
    event_count: 3,
    is_rolling: false,
    current_take: 0,
    rolling_timecode: null,
    total_runtime_hms: '00:00:00',
    archived: false,
    ...overrides,
  };
}

function mockSessions(data: SessionsResponse | undefined) {
  mockedUseSessions.mockReturnValue({ data } as unknown as ReturnType<typeof useSessions>);
}

let navRecord: string[] = [];

beforeEach(() => {
  navRecord = [];
  setNavigationImplForTesting((path) => navRecord.push(path));
});

afterEach(() => {
  setNavigationImplForTesting(null);
  vi.clearAllMocks();
});

describe('HomeRoute', () => {
  it('renders the wordmark, the resume card for the first active session, and New Session — scenario "Home with existing sessions"', () => {
    mockSessions({
      active: [
        sessionFixture({ id: 'sess-1', title: 'First Active' }),
        sessionFixture({ id: 'sess-2', title: 'Second Active' }),
      ],
      archived: [],
    });

    renderStrict(<HomeRoute onNewSession={() => {}} />);

    expect(document.querySelector('#home-launch')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'AutoLogger' })).not.toBeNull();
    // Resume card is the FIRST entry of the active list (server order), not
    // some other active session.
    const resumeCard = screen.getByRole('button', { name: /jump back in/i });
    expect(resumeCard.textContent).toContain('First Active');
    expect(resumeCard.textContent).not.toContain('Second Active');
    expect(screen.getByRole('button', { name: /new session/i })).not.toBeNull();
  });

  it('activating the resume card navigates to that session via the shared navigation wrapper', () => {
    mockSessions({ active: [sessionFixture({ id: 'sess-7' })], archived: [] });

    renderStrict(<HomeRoute onNewSession={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /jump back in/i }));
    expect(navRecord).toEqual(['/sessions/sess-7']);
  });

  it('with no active sessions, shows the wordmark and a primary create-session action with copy that is correct for archived-only users — scenario "No active sessions"', () => {
    // Archived sessions exist, but none are active: the copy must not claim
    // this would be the user's "first" session.
    mockSessions({ active: [], archived: [sessionFixture({ id: 'old-1', archived: true })] });

    renderStrict(<HomeRoute onNewSession={() => {}} />);

    expect(screen.queryByRole('button', { name: /jump back in/i })).toBeNull();
    const cta = screen.getByRole('button', { name: /start a session/i });
    expect(cta.textContent?.toLowerCase()).not.toContain('first');
  });

  it('activating New Session opens the AppShell-owned modal — scenario "New Session opens the shared modal"', () => {
    mockSessions({ active: [], archived: [] });
    const onNewSession = vi.fn();

    renderStrict(<HomeRoute onNewSession={onNewSession} />);

    fireEvent.click(screen.getByRole('button', { name: /start a session/i }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('with an active session present, New Session still calls onNewSession (button label reads "New session")', () => {
    mockSessions({ active: [sessionFixture()], archived: [] });
    const onNewSession = vi.fn();

    renderStrict(<HomeRoute onNewSession={onNewSession} />);

    fireEvent.click(screen.getByRole('button', { name: /^new session$/i }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });
});
