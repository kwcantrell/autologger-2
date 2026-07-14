// Post-login deep-link return-path validator (session-deep-links, design D6;
// spec: web-login-experience, "Post-login deep-link return" validation
// clause; extended with `/teams` by teams-self-serve, design D6).
//
// Reject-by-default. A stashed value only ever came from this tab's own
// sessionStorage (see the stash write/consume unit, task 6.2/6.3), but it is
// still treated as untrusted input: the point of validating on the consume
// side is to survive a stash write bug, a future caller that stashes
// unsanitized data, or a same-origin script writing to the key directly.
//
// Recipe order is load-bearing (design D6): cheap syntactic rejects run
// BEFORE the URL parse, because `new URL()` alone is not a sufficient
// guard — WHATWG URL parsing treats a leading `//` as protocol-relative
// (network-path reference, i.e. "same scheme, attacker host") and, for
// special schemes, silently treats `\` the same as `/` when locating the
// authority section, so `/\evil.com` parses to host `evil.com` exactly like
// `//evil.com` does. Both must be caught as strings, before any URL
// resolution happens. Ordering also matters for control characters: the
// WHATWG parser strips ASCII tab/newline from the input as a
// pre-processing step, so `/\t/evil.com` (a literal tab between two
// slashes) collapses to the equivalent of `//evil.com` once parsed — that
// bypass only exists if the control-character check runs after (or is
// skipped in favor of) the URL parse, so it must run before it too.
const SESSIONS_ROUTE_RE = /^\/sessions\/([^/]+)$/;
const TEAMS_ROUTE_PATHNAME = '/teams';
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * True iff `pathname` matches the session-workspace route — exactly
 * `/sessions/:id` (one non-empty segment).
 */
export function isSessionRoutePathname(pathname: string): boolean {
  const match = SESSIONS_ROUTE_RE.exec(pathname);
  return match !== null && match[1].length > 0;
}

/** True iff `pathname` matches the team-management route — exactly `/teams`. */
export function isTeamsRoutePathname(pathname: string): boolean {
  return pathname === TEAMS_ROUTE_PATHNAME;
}

/**
 * True iff `pathname` matches ANY router-known route — currently
 * `/sessions/:id` or `/teams` (teams-self-serve, design D6). Shared between
 * this validator (untrusted stash input, full URL-parse recipe below) and
 * the stash WRITE side (`loginReturnStash.ts`, which only ever inspects this
 * tab's own trusted `window.location.pathname`) so both sides agree on
 * "what counts as a deep link" from one definition instead of two regexes
 * (or a regex and a set of exact-match checks) drifting apart. Extend this
 * predicate — not its two consumers — when the router gains a new route.
 */
export function isRouterKnownPathname(pathname: string): boolean {
  return isSessionRoutePathname(pathname) || isTeamsRoutePathname(pathname);
}

/**
 * Validate an unknown value as a post-login return path.
 *
 * Accepts only same-origin, router-known paths (currently `/sessions/:id`
 * or `/teams`) with their query string preserved. Returns the validated
 * `pathname + search` on success, `null` on any rejection — callers must
 * treat `null` as "discard the stash, stay on `/`" and never partially
 * trust a rejected value.
 */
export function validateLoginReturnPath(value: unknown): string | null {
  // 1. Must be a string, non-empty, starting with exactly one `/`. This
  //    also rejects scheme-qualified values (`https://…`, `javascript:…`)
  //    outright, since those don't start with `/` at all.
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;

  // 2. No `\` anywhere, no ASCII control characters (0x00-0x1F, 0x7F) —
  //    see the module comment above for why both are protocol-relative
  //    bypasses once the URL parser gets to them.
  if (value.includes('\\')) return null;
  if (CONTROL_CHAR_RE.test(value)) return null;

  // 3. Must resolve, relative to the current origin, to a URL whose origin
  //    is unchanged. Once steps 1-2 have run, a value starting with a
  //    single `/` and free of `\`/control chars cannot actually change
  //    origin under WHATWG resolution (path-absolute references always
  //    inherit the base's origin) — this check is deliberately kept as a
  //    second, independent gate rather than relying on that invariant.
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;

  // 4. The parsed pathname must match a router-known route: exactly
  //    `/sessions/<single-non-empty-segment>` or exactly `/teams`.
  //    Percent-encoded separators (e.g. `%2F`) are never decoded back into
  //    `/` by `URL#pathname`, so they can't be used to smuggle extra
  //    segments past this check — they just fail to match and get rejected.
  if (!isRouterKnownPathname(url.pathname)) return null;

  return `${url.pathname}${url.search}`;
}
