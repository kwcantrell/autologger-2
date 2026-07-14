// Post-login deep-link stash — write + consume (session-deep-links, design
// D6; spec: web-login-experience, "Post-login deep-link return").
//
// Companion to loginReturnPath.ts's validator. The write side below only
// ever inspects this tab's own trusted `window.location`; the consume side
// re-validates through `validateLoginReturnPath` regardless (the stash is a
// sessionStorage value — untrusted the moment it's read back, per that
// module's own reasoning about surviving a write bug or a future caller).

import { isSessionRoutePathname, validateLoginReturnPath } from './loginReturnPath';

export const LOGIN_RETURN_STASH_KEY = 'autologger:login-return';

/**
 * Stash the current path+query for post-login return IFF the current
 * location is a session deep link (`/sessions/:id`). Call synchronously
 * from a LoginPage anchor's `onClick`, before the browser follows the
 * anchor's `href` to `/auth/google/start` — the write completes before
 * navigation begins.
 *
 * When the current location is NOT a session deep link (e.g. `/` or
 * `/?login_error=<code>`), this is a deliberate no-op: any existing stash
 * is left untouched, so retrying sign-in from the error landing page can't
 * clobber a previously stashed deep link (spec: "Failed attempt keeps the
 * return path").
 */
export function stashLoginReturnPathIfDeepLink(): void {
  const { pathname, search } = window.location;
  if (!isSessionRoutePathname(pathname)) return;
  try {
    sessionStorage.setItem(LOGIN_RETURN_STASH_KEY, `${pathname}${search}`);
  } catch {
    // sessionStorage unavailable (private mode, disabled storage, quota,
    // …) — the stash is a best-effort convenience; failing to write it
    // just means no post-login return, not a broken sign-in.
  }
}

export type LoginReturnNavigate = (path: string, options?: { replace?: boolean }) => void;

/**
 * Consume the stash, if any: read -> remove -> validate -> replace-navigate
 * on success. Callers pass their app's navigation function explicitly (this
 * module stays decoupled from any router/navigation layer).
 *
 * The stash is removed immediately after being read, BEFORE validation or
 * navigation runs — not after. That ordering is what makes every exit path
 * (valid, invalid, or a throwing `navigateFn`) clear the stash: there is no
 * path through this function that reads a stash without immediately
 * clearing it. It's also what makes repeated calls idempotent (a second
 * call — e.g. a React StrictMode double-invoke of the effect that calls
 * this — reads `null` and no-ops), without any extra guard state.
 */
export function consumeLoginReturnStash(navigateFn: LoginReturnNavigate): void {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(LOGIN_RETURN_STASH_KEY);
  } catch {
    return;
  }
  if (raw === null) return;

  try {
    sessionStorage.removeItem(LOGIN_RETURN_STASH_KEY);
  } catch {
    // Best-effort clear; a raw value was still read above at most once per
    // call, so a failed removal here doesn't reintroduce a double-consume
    // within this call — it only risks a stale value surviving for a later
    // call, which is no worse than sessionStorage being unavailable at all.
  }

  const validated = validateLoginReturnPath(raw);
  if (validated === null) return;

  try {
    navigateFn(validated, { replace: true });
  } catch {
    // The stash is already cleared above; swallow so a navigation failure
    // doesn't escape a React effect and crash the render — the user simply
    // stays wherever the failed navigate left them.
  }
}
