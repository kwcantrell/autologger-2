import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfile } from '../../api/hooks/useProfile';
import type { ProfilePayload } from '../../api/types';
import { renderStrict } from '../../test/renderStrict';
import { RootGate } from './RootGate';

// --- RootGate gate-state tests (session-deep-links, task 2.2) ---
// Pays down the add-login-screen residual: covers the four render states
// documented in RootGate.tsx's header comment, plus the two edge cases the
// header calls out by name — the data-first background-refetch-error branch
// and the mid-session sign-out flip. `useProfile` is mocked directly (no
// react-query, no network); `AppShell` and `LoginPage` are mocked to shallow
// sentinels so this stays a gate test, not an integration test.

vi.mock('../../api/hooks/useProfile', () => ({
  useProfile: vi.fn(),
}));

vi.mock('./AppShell', () => ({
  AppShell: () => <div data-testid="app-shell-sentinel" />,
}));

vi.mock('./components/LoginPage', () => ({
  LoginPage: () => <div data-testid="login-page-sentinel" />,
}));

const mockedUseProfile = vi.mocked(useProfile);

type ProfileQueryResult = Pick<
  ReturnType<typeof useProfile>,
  'data' | 'isError' | 'isFetching' | 'refetch'
>;

function profileQuery(overrides: Partial<ProfileQueryResult> = {}): ProfileQueryResult {
  return {
    data: undefined,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function profilePayload(authOverrides: Partial<ProfilePayload['auth']> = {}): ProfilePayload {
  return {
    active_studio_id: 'studio-1',
    active_show_id: 'show-1',
    active_studio: { id: 'studio-1', name: 'Studio One', categories: [] },
    studios: [],
    studio_settings: {},
    shows: [],
    new_session_defaults: { title_prefix: '', default_frame_rate: 30 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: null,
      ...authOverrides,
    },
  };
}

function useMock(overrides: Partial<ProfileQueryResult> = {}) {
  mockedUseProfile.mockReturnValue(
    profileQuery(overrides) as unknown as ReturnType<typeof useProfile>,
  );
}

function noSentinels() {
  expect(screen.queryByTestId('app-shell-sentinel')).toBeNull();
  expect(screen.queryByTestId('login-page-sentinel')).toBeNull();
}

beforeEach(() => {
  mockedUseProfile.mockReset();
});

describe('RootGate', () => {
  it('renders the loading treatment when there is no data and the query is pending', () => {
    useMock({ data: undefined, isError: false, isFetching: true });

    const { container } = renderStrict(<RootGate />);

    expect(container.querySelector('#root-gate-loading')).not.toBeNull();
    expect(container.querySelector('#root-gate-error')).toBeNull();
    noSentinels();
  });

  it('renders the error panel with a retry control when the initial load fails', () => {
    const refetch = vi.fn();
    useMock({ data: undefined, isError: true, isFetching: false, refetch });

    const { container } = renderStrict(<RootGate />);

    expect(container.querySelector('#root-gate-error')).not.toBeNull();
    noSentinels();

    const retry = screen.getByRole('button', { name: /try again/i });
    expect(retry.hasAttribute('disabled')).toBe(false);

    fireEvent.click(retry);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('disables the retry control while a retry is in flight (isFetching)', () => {
    useMock({ data: undefined, isError: true, isFetching: false });

    const { rerender } = renderStrict(<RootGate />);

    useMock({ data: undefined, isError: true, isFetching: true });
    rerender(<RootGate />);

    const retry = screen.getByRole('button', { name: /retrying/i });
    expect(retry.hasAttribute('disabled')).toBe(true);
  });

  it('renders LoginPage when oauth is configured and the user is logged out', () => {
    useMock({ data: profilePayload({ oauth_configured: true, logged_in: false }) });

    renderStrict(<RootGate />);

    expect(screen.getByTestId('login-page-sentinel')).not.toBeNull();
    expect(screen.queryByTestId('app-shell-sentinel')).toBeNull();
  });

  it('renders AppShell when logged in', () => {
    useMock({ data: profilePayload({ oauth_configured: true, logged_in: true }) });

    renderStrict(<RootGate />);

    expect(screen.getByTestId('app-shell-sentinel')).not.toBeNull();
    expect(screen.queryByTestId('login-page-sentinel')).toBeNull();
  });

  it('renders AppShell in oauth-unconfigured dev mode (logged out but no gate)', () => {
    useMock({ data: profilePayload({ oauth_configured: false, logged_in: false }) });

    renderStrict(<RootGate />);

    expect(screen.getByTestId('app-shell-sentinel')).not.toBeNull();
    expect(screen.queryByTestId('login-page-sentinel')).toBeNull();
  });

  it('stays on AppShell during a background refetch failure (data-first branch)', () => {
    useMock({
      data: profilePayload({ oauth_configured: true, logged_in: true }),
      isError: true,
    });

    const { container } = renderStrict(<RootGate />);

    expect(screen.getByTestId('app-shell-sentinel')).not.toBeNull();
    expect(container.querySelector('#root-gate-error')).toBeNull();
  });

  it('flips from AppShell to LoginPage on a mid-session sign-out refetch', () => {
    useMock({ data: profilePayload({ oauth_configured: true, logged_in: true }) });
    const { rerender } = renderStrict(<RootGate />);
    expect(screen.getByTestId('app-shell-sentinel')).not.toBeNull();

    useMock({ data: profilePayload({ oauth_configured: true, logged_in: false }) });
    rerender(<RootGate />);

    expect(screen.getByTestId('login-page-sentinel')).not.toBeNull();
    expect(screen.queryByTestId('app-shell-sentinel')).toBeNull();
  });
});
