// Originator-scoped transport-stop departure watcher (session-deep-links,
// design D4; spec: web-session-routing "Originator-scoped transport stop on
// route departure").
//
// Subscribes to the single navigation wrapper (navigation.ts's `navigate()`
// calls `handleWrapperNavigation` synchronously before delegating to the
// underlying impl) plus a raw `popstate` listener — NEVER wouter's route hook
// (design D1/D4: wouter is render-side only; its hooks fire during render,
// too late to guarantee the stop call lands before `SessionWorkspace`'s
// effects clear or redefine `window.AutoLogger_stopTransportIfNeeded` for the
// incoming route). Both subscriptions fire synchronously, pre-render/
// pre-commit — that ordering is the whole point of D4, not an accident:
//   click handler -> navigate() -> handleWrapperNavigation() [stop fires] ->
//   impl() [history mutates / location state updates] -> React re-renders
//   (async/batched) -> SessionWorkspace's effects run post-commit.
// popstate is dispatched by the browser only after the URL has already
// changed, so `window.location.pathname` there already reflects the target —
// no separate "previous path" bookkeeping is needed either way: origination
// is scoped to a specific session id (transportOrigination.ts), and a
// departure is simply "the target is not that id's route" — passive viewers
// never have the flag set, so they never fire, by construction.
//
// Not an unmount/effect cleanup: cleanups run child-first (the global would
// already be cleared by the time a parent's cleanup ran) and StrictMode
// double-invokes them in dev (which would spuriously stop a remotely-rolling
// session on mount). This module never touches React lifecycles at all.

import { clearOrigination, getOriginatedSessionId } from './transportOrigination';

/** Extracts and decodes the `:id` segment from a `/sessions/:id` path, or
 *  `null` if `path` doesn't match that shape (home, an unmatched path, or a
 *  path with extra segments). Handles encoding: `navigate()` callers build
 *  targets with `encodeURIComponent(sid)` (AppShell's select/create), while
 *  `getOriginatedSessionId()` holds the raw, decoded id (as read from
 *  wouter's already-decoded route param) — so this decodes before comparing. */
function sessionIdOf(path: string): string | null {
  const idx = path.search(/[?#]/);
  const pathname = idx === -1 ? path : path.slice(0, idx);
  const match = /^\/sessions\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** True iff `nextPath` is a same-document departure from the session this
 *  client originated the roll for (or there is nothing to depart from). */
function departsOriginatedSession(nextPath: string): boolean {
  const originated = getOriginatedSessionId();
  if (!originated) return false;
  return sessionIdOf(nextPath) !== originated;
}

function fireStopAndClear(): void {
  window.AutoLogger_stopTransportIfNeeded?.();
  clearOrigination();
}

/**
 * Called by navigation.ts's `navigate()`, synchronously, before it delegates
 * to the underlying navigation impl (browser pushState/replaceState, or the
 * `wouter/memory-location` test seam). Covers: the close control, in-app
 * navigation to `/`, and switching to another session id.
 */
export function handleWrapperNavigation(nextPath: string): void {
  if (departsOriginatedSession(nextPath)) fireStopAndClear();
}

function handlePopstate(): void {
  if (departsOriginatedSession(window.location.pathname)) fireStopAndClear();
}

let installed = false;

/**
 * Idempotent. Installing at module scope (called once below, at import time)
 * rather than from a React effect is deliberate: module evaluation happens
 * once regardless of StrictMode's render/effect double-invocation, so there
 * is no double-registration to guard against.
 */
export function installDepartureWatcher(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('popstate', handlePopstate);
}

/** Test seam: undo the module-scope installation so tests can reinstall
 *  against a fresh `window` / reassert idempotency. */
export function uninstallDepartureWatcherForTesting(): void {
  window.removeEventListener('popstate', handlePopstate);
  installed = false;
}

installDepartureWatcher();
