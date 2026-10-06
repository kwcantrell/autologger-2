import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfile } from '../../../api/hooks/useProfile';
import { useSessions } from '../../../api/hooks/useSessions';
import type { ProfilePayload, Session, SessionsResponse } from '../../../api/types';
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

vi.mock('../../../api/hooks/useProfile', () => ({ useProfile: vi.fn() }));

const mockedUseSessions = vi.mocked(useSessions);

// show-grants D13: the components read show access from the profile through `useShowAccess`;
// `useProfile` is mocked at the module boundary. The default profile can access `show-1` (the
// session fixtures' show) in the active team `studio-1`.
function accessProfile(
  shows: Array<{ id: string; studio_id?: string; can_access: boolean }> = [
    { id: 'show-1', can_access: true },
  ],
): ProfilePayload {
  return {
    active_studio_id: 'studio-1',
    active_show_id: shows[0]?.id ?? '',
    shows: shows.map((s) => ({
      studio_id: 'studio-1',
      name: s.id,
      show_code: s.id.toUpperCase(),
      title_suffix: 'date',
      ...s,
    })),
    auth: { logged_in: true, oauth_configured: true, user: null },
  } as unknown as ProfilePayload;
}

function mockProfile(p: ProfilePayload) {
  vi.mocked(useProfile).mockReturnValue({ data: p } as unknown as ReturnType<typeof useProfile>);
}

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
  mockProfile(accessProfile());
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
    // shadcn-port-shell 3.2: the shared Button, primary when nothing can be resumed.
    expect(cta.getAttribute('data-variant')).toBe('default');
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

    const cta = screen.getByRole('button', { name: /^new session$/i });
    // Secondary (outline) beside the resume card.
    expect(cta.getAttribute('data-variant')).toBe('outline');
    fireEvent.click(cta);
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });
});

describe('HomeRoute follows show access (show-grants D13)', () => {
  it('a member with no accessible show in the active team: no resume card and no New Session — scenario "Home for a member without access"', () => {
    mockProfile(accessProfile([{ id: 'show-1', can_access: false }]));
    mockSessions({ active: [sessionFixture({ id: 'sess-1', show_id: 'show-1' })], archived: [] });

    renderStrict(<HomeRoute onNewSession={() => {}} />);

    expect(screen.getByRole('heading', { name: 'AutoLogger' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /jump back in/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /new session|start a session/i })).toBeNull();
  });

  it('skips the resume card when the first active session is not openable, but keeps New Session', () => {
    mockProfile(
      accessProfile([
        { id: 'show-1', can_access: false },
        { id: 'show-2', can_access: true },
      ]),
    );
    mockSessions({ active: [sessionFixture({ id: 'sess-1', show_id: 'show-1' })], archived: [] });

    renderStrict(<HomeRoute onNewSession={() => {}} />);

    expect(screen.queryByRole('button', { name: /jump back in/i })).toBeNull();
    expect(screen.getByRole('button', { name: /start a session/i })).not.toBeNull();
  });
});
