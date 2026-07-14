import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_RETURN_STASH_KEY } from '../../../shared/utils/loginReturnStash';
import { renderStrict } from '../../../test/renderStrict';
import { setNavigationImplForTesting } from '../navigation';
import { useLoginReturnConsume } from '../useLoginReturnConsume';
import { LoginPage } from './LoginPage';

// LoginPage anchor wiring (session-deep-links, task 6.2/6.4; design D6):
// the three sign-in affordances stay plain anchors to `/auth/google/start`
// (the login-gate e2e asserts their hrefs) with a synchronous onClick stash
// write. jsdom logs/throws on a real anchor navigation, so every click test
// installs a capture-phase listener that prevents the default navigation —
// this is test-only plumbing, not a change to LoginPage's own behavior.

function setLocation(pathAndQuery: string) {
  const url = new URL(pathAndQuery, 'https://example.test');
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
}

function preventAnchorNavigation(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.closest('a')) e.preventDefault();
}

beforeEach(() => {
  sessionStorage.clear();
  setLocation('/');
  document.addEventListener('click', preventAnchorNavigation, true);
});

afterEach(() => {
  document.removeEventListener('click', preventAnchorNavigation, true);
  sessionStorage.clear();
});

describe('LoginPage anchors', () => {
  it('all three affordances keep their /auth/google/start href', () => {
    renderStrict(<LoginPage />);

    expect(document.getElementById('login-btn-google')?.getAttribute('href')).toBe(
      '/auth/google/start',
    );
    expect(document.getElementById('login-btn-create-account')?.getAttribute('href')).toBe(
      '/auth/google/start',
    );
  });

  it('the error-retry affordance keeps its href when the error banner is shown', () => {
    setLocation('/?login_error=state_invalid');
    renderStrict(<LoginPage />);

    expect(document.getElementById('login-error-retry')?.getAttribute('href')).toBe(
      '/auth/google/start',
    );
  });

  it('Google sign-in click stashes the current deep link', () => {
    setLocation('/sessions/abc?x=1');
    renderStrict(<LoginPage />);

    fireEvent.click(document.getElementById('login-btn-google') as HTMLElement);

    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/abc?x=1');
  });

  it('create-account click stashes the current deep link', () => {
    setLocation('/sessions/abc');
    renderStrict(<LoginPage />);

    fireEvent.click(document.getElementById('login-btn-create-account') as HTMLElement);

    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/abc');
  });

  it('a click at / (no deep link) writes no stash', () => {
    setLocation('/');
    renderStrict(<LoginPage />);

    fireEvent.click(document.getElementById('login-btn-google') as HTMLElement);

    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('retry from the error landing page does not clobber an existing stash', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/original');
    setLocation('/?login_error=state_invalid');
    renderStrict(<LoginPage />);

    fireEvent.click(document.getElementById('login-error-retry') as HTMLElement);

    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/original');
  });
});

describe('LoginPage -> post-login consume round trip', () => {
  // Simulates the real app flow end to end: LoginPage stashes on sign-in
  // click; after the OAuth round-trip the app re-renders logged in, and the
  // consume hook (as wired into AppShell) validates and replace-navigates
  // to the stashed path, clearing it.
  function ConsumeOnLogin({ loggedIn }: { loggedIn: boolean }) {
    useLoginReturnConsume(loggedIn);
    return null;
  }

  let navigateCalls: Array<[string, { replace?: boolean } | undefined]>;

  beforeEach(() => {
    navigateCalls = [];
    setNavigationImplForTesting((path, options) => {
      navigateCalls.push([path, options]);
    });
  });

  afterEach(() => {
    setNavigationImplForTesting(null);
  });

  it('deep link survives the sign-in round-trip', () => {
    setLocation('/sessions/abc?x=1');
    const { unmount } = renderStrict(<LoginPage />);
    fireEvent.click(document.getElementById('login-btn-google') as HTMLElement);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/abc?x=1');
    unmount();

    // OAuth round-trip completes; the app re-renders with auth.logged_in
    // true (AppShell mounts, or in this isolated test, the consume hook
    // directly).
    renderStrict(<ConsumeOnLogin loggedIn={true} />);

    expect(navigateCalls).toEqual([['/sessions/abc?x=1', { replace: true }]]);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('failed attempt keeps the return path: retry from the error page still returns to the original deep link', () => {
    setLocation('/sessions/abc');
    const first = renderStrict(<LoginPage />);
    fireEvent.click(document.getElementById('login-btn-google') as HTMLElement);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/abc');
    first.unmount();

    // Callback fails: 302 to /?login_error=<code>.
    setLocation('/?login_error=state_invalid');
    const second = renderStrict(<LoginPage />);
    fireEvent.click(document.getElementById('login-error-retry') as HTMLElement);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/abc');
    second.unmount();

    // Retry succeeds.
    renderStrict(<ConsumeOnLogin loggedIn={true} />);

    expect(navigateCalls).toEqual([['/sessions/abc', { replace: true }]]);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });
});
