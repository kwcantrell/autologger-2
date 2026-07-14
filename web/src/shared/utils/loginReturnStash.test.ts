import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeLoginReturnStash,
  LOGIN_RETURN_STASH_KEY,
  stashLoginReturnPathIfDeepLink,
} from './loginReturnStash';

// Write + consume rules (session-deep-links, design D6; spec:
// web-login-experience "Post-login deep-link return"). The write side only
// ever inspects trusted `window.location`; the consume side re-validates
// through `validateLoginReturnPath` (loginReturnPath.test.ts owns the full
// bypass corpus for that validator — these tests exercise the stash
// plumbing around it: write-gating, single-use clearing, and StrictMode
// double-call idempotency).

function setLocation(pathAndQuery: string) {
  const url = new URL(pathAndQuery, 'https://example.test');
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
}

beforeEach(() => {
  sessionStorage.clear();
  setLocation('/');
});

afterEach(() => {
  sessionStorage.clear();
});

describe('stashLoginReturnPathIfDeepLink', () => {
  it('stashes the current path+query when the location is a session deep link', () => {
    setLocation('/sessions/abc?x=1');
    stashLoginReturnPathIfDeepLink();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/abc?x=1');
  });

  it('stashes a bare session path with no query', () => {
    setLocation('/sessions/abc');
    stashLoginReturnPathIfDeepLink();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/abc');
  });

  it('leaves any existing stash untouched when the location is /', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/original');
    setLocation('/');
    stashLoginReturnPathIfDeepLink();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/original');
  });

  it('leaves any existing stash untouched on the error-retry landing (/?login_error=…)', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/original');
    setLocation('/?login_error=state_invalid');
    stashLoginReturnPathIfDeepLink();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/original');
  });

  it('writes nothing new when off a deep link and no stash previously existed', () => {
    setLocation('/');
    stashLoginReturnPathIfDeepLink();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('does not stash a non-router path such as /admin/users', () => {
    setLocation('/admin/users');
    stashLoginReturnPathIfDeepLink();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });
});

describe('consumeLoginReturnStash', () => {
  it('validates, replace-navigates, and clears a valid stash', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/abc?x=1');
    const navigateFn = vi.fn();

    consumeLoginReturnStash(navigateFn);

    expect(navigateFn).toHaveBeenCalledTimes(1);
    expect(navigateFn).toHaveBeenCalledWith('/sessions/abc?x=1', { replace: true });
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it.each([
    ['//evil.com', '//evil.com'],
    ['/\\evil.com', '/\\evil.com'],
    ['https://evil.com/x', 'https://evil.com/x'],
    ['a same-origin non-router path', '/admin/users'],
  ])('discards a malicious/out-of-router stash (%s) without navigating, and clears it', (_label, value) => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, value);
    const navigateFn = vi.fn();

    consumeLoginReturnStash(navigateFn);

    expect(navigateFn).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('does nothing when no stash is present', () => {
    const navigateFn = vi.fn();
    consumeLoginReturnStash(navigateFn);
    expect(navigateFn).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('clears the stash even when navigateFn throws', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/abc');
    const navigateFn = vi.fn(() => {
      throw new Error('boom');
    });

    expect(() => consumeLoginReturnStash(navigateFn)).not.toThrow();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBeNull();
  });

  it('is idempotent across repeated calls (StrictMode double-invoke safety)', () => {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, '/sessions/abc');
    const navigateFn = vi.fn();

    consumeLoginReturnStash(navigateFn);
    consumeLoginReturnStash(navigateFn);

    expect(navigateFn).toHaveBeenCalledTimes(1);
  });
});
