// Roll-origination tracking (session-deep-links, design D4; spec:
// web-session-routing "Originator-scoped transport stop on route departure").
//
// Plain module state — deliberately NOT React state. The departure watcher
// (departureWatcher.ts) must read it synchronously from inside the navigation
// wrapper / a raw `popstate` handler, both of which run outside React's
// render cycle and before React re-renders (design D4's whole point). Scoped
// to "the current workspace mount": set when THIS client issues
// transport-start (TransportControls.tsx, the client's transport-start call
// site) for the session currently open; cleared once the departure watcher
// consumes it (fires the stop) so a later departure — or a later mount of the
// same id — starts unattributed.
//
// Risk accepted by design: a reload mid-roll forgets this client started the
// roll (module state, not persisted). Failing safe (a missed auto-stop) beats
// failing destructive (stopping someone else's roll) — see design.md Risks.

let originatedSessionId: string | null = null;

/**
 * Call when this client successfully issues transport-start for `sessionId`.
 *
 * Callers are responsible for confirming the client is still on `sessionId`'s
 * route before calling this (see `TransportControls.tsx`'s call site) —
 * `start.mutateAsync()` is awaited before that call site reaches this line,
 * so the user may have already navigated away by the time it resolves.
 * Marking unconditionally here would record a stale origination for a
 * session this client is no longer viewing: the departure watcher only
 * checks "does the flag's id match the route being left", not "was the flag
 * just set for the route we're currently on" — a stale flag for sess-1 set
 * while the client is already parked on sess-2's route would satisfy that
 * check on sess-2's *next*, unrelated departure and stop sess-2's roll
 * instead (phase-5 review finding: the async-gap origination race). This
 * function stays a plain, unconditional setter — tests exercise it directly
 * as a stand-in for "this client issued transport-start" without going
 * through the real component (see AppShell.test.tsx, departureWatcher.test.tsx).
 */
export function markOriginated(sessionId: string): void {
  originatedSessionId = sessionId;
}

/** The session id this client originated the current roll for, if any. */
export function getOriginatedSessionId(): string | null {
  return originatedSessionId;
}

/** Consume the flag — called by the departure watcher once it has fired (or
 *  decided not to fire) for the departure it just observed. */
export function clearOrigination(): void {
  originatedSessionId = null;
}

/** Test seam: reset between tests so origination never leaks across specs. */
export function resetOriginationForTesting(): void {
  originatedSessionId = null;
}
