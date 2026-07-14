// Single navigation funnel for the SPA (session-deep-links, design D1/D4).
//
// ALL in-app navigations go through this `navigate()` — never call
// `history.pushState`/`replaceState` or wouter's own navigate directly from
// app code. Keeping one funnel is load-bearing: a later phase subscribes here
// (plus a raw `popstate` listener) to observe route departures synchronously,
// before React re-renders (the originator-scoped transport stop, design D4).
// wouter itself stays render-side only (design D1): it derives route state
// from the location; it is never the mechanism for navigation side-effects.

import { navigate as browserNavigate } from 'wouter/use-browser-location';

export interface NavigateOptions {
  replace?: boolean;
}

type NavigateImpl = (path: string, options?: NavigateOptions) => void;

const defaultImpl: NavigateImpl = (path, options) => browserNavigate(path, options);

let impl: NavigateImpl = defaultImpl;

/**
 * Navigate the SPA to `path` (pushes a history entry; `{ replace: true }`
 * replaces the current one). wouter's location hooks observe the change and
 * re-render route-derived state.
 */
export function navigate(path: string, options?: NavigateOptions): void {
  impl(path, options);
}

/**
 * Test seam: reroute `navigate()` through a memory location (wouter's
 * `memoryLocation().navigate`) so tests can record and assert on history.
 * Pass `null` to restore the browser implementation. Production code must
 * never call this.
 */
export function setNavigationImplForTesting(next: NavigateImpl | null): void {
  impl = next ?? defaultImpl;
}
