import { useEffect } from 'react';
import { consumeLoginReturnStash } from '../../shared/utils/loginReturnStash';
import { navigate } from './navigation';

/**
 * Consumes the post-login deep-link stash (session-deep-links, design D6)
 * when `loggedIn` is true. `loggedIn` MUST be the caller's own explicit
 * `auth.logged_in === true` check — never inferred from this hook (or its
 * caller component) merely being mounted: dev anonymous mode mounts
 * `AppShell` with `logged_in: false` and must never consume the stash
 * (spec: web-login-experience, "Post-login deep-link return").
 *
 * StrictMode-safe by construction: `consumeLoginReturnStash` removes the
 * stash before validating/navigating, so a double-invoked effect's second
 * call reads no stash and no-ops — no extra ref/guard needed here.
 */
export function useLoginReturnConsume(loggedIn: boolean): void {
  useEffect(() => {
    if (!loggedIn) return;
    consumeLoginReturnStash(navigate);
  }, [loggedIn]);
}
