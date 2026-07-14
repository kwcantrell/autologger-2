import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_RETURN_STASH_KEY } from '../../shared/utils/loginReturnStash';
import { renderStrict } from '../../test/renderStrict';
import { setNavigationImplForTesting } from './navigation';
import { useLoginReturnConsume } from './useLoginReturnConsume';

// Hook-level tests for the post-login deep-link consume effect
// (session-deep-links, task 6.3/6.4; design D6). `AppShell` calls this hook
// with its own explicit `profile.auth.logged_in === true` check — these
// tests exercise the hook directly via a minimal host component so the gate
// (`loggedIn`) and the StrictMode double-invoke behavior are unambiguous,
// without pulling in all of AppShell's other mocked children.

function Host({ loggedIn }: { loggedIn: boolean }) {
  useLoginReturnConsume(loggedIn);
  return null;
}

let navigateCalls: Array<[string, { replace?: boolean } | undefined]>;

beforeEach(() => {
  sessionStorage.clear();
  navigateCalls = [];
  setNavigationImplForTesting((path, options) => {
    navigateCalls.push([path, options]);
  });
});

afterEach(() => {
  setNavigationImplForTesting(null);
  sessionStorage.clear();
});

describe('useLoginReturnConsume', () => {
  it('consumes a valid stash on loggedIn=true: replace-navigates and clears it', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/abc?x=1');

    renderStrict(<Host loggedIn={true} />);

    expect(navigateCalls).toEqual([['/sessions/abc?x=1', { replace: true }]]);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('no-stash logged-in boot navigates nowhere', () => {
    renderStrict(<Host loggedIn={true} />);

    expect(navigateCalls).toEqual([]);
  });

  it('anonymous-shell boot (logged_in false) never consumes even with a stash present', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/abc');

    renderStrict(<Host loggedIn={false} />);

    expect(navigateCalls).toEqual([]);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/abc');
  });

  it('discards a malicious stash without navigating, and clears it', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '//evil.com');

    renderStrict(<Host loggedIn={true} />);

    expect(navigateCalls).toEqual([]);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('discards a same-origin out-of-router stash (/admin/users) without navigating', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/admin/users');

    renderStrict(<Host loggedIn={true} />);

    expect(navigateCalls).toEqual([]);
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('StrictMode double-mount consumes exactly once', () => {
    // renderStrict wraps in <StrictMode>, which double-invokes effects in
    // dev; consumeLoginReturnStash's remove-before-navigate ordering makes
    // the second invocation a no-op (it reads no stash) rather than a
    // second navigation.
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/abc');

    renderStrict(<Host loggedIn={true} />);

    expect(navigateCalls).toHaveLength(1);
  });

  it('does not re-consume when loggedIn stays true across a re-render with no new stash', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/abc');
    const { rerender } = renderStrict(<Host loggedIn={true} />);
    expect(navigateCalls).toHaveLength(1);

    rerender(
      <StrictMode>
        <Host loggedIn={true} />
      </StrictMode>,
    );

    expect(navigateCalls).toHaveLength(1);
  });
});
