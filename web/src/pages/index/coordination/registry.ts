/**
 * The one-to-one coordination registry (web-coordination-seam D1).
 *
 * Distant components in the session workspace coordinate through a single
 * owner per handle rather than through shared `window` globals. This module
 * is the sole declaration site for every handle's name and signature — see
 * `HandlerMap` below — and the sole implementation of the register /
 * unregister / invoke contract every owner and caller uses. Callers do not
 * need to know which component owns a handle.
 *
 * Deliberately import-free: `departureWatcher.ts` calls into this module at
 * module evaluation time, and `navigation.ts` calls into
 * `departureWatcher.ts` at module scope too, so an import cycle here would
 * be reachable at the point both modules are first evaluated. This module
 * SHALL import no other application module (spec: "React-external callers
 * are first-class").
 *
 * **One owner per handle, by construction.** Registering while a handler is
 * already registered replaces it — so React StrictMode's double-invocation
 * (register -> unregister -> register) leaves exactly one live handler.
 * Unregistering is identity-scoped: it clears the handle only if the
 * handler passed to `unregister` is STILL the one currently registered,
 * compared by function reference — the same idiom `addEventListener` /
 * `removeEventListener` already use. A stale owner's teardown (its own
 * now-replaced closure) is therefore a no-op rather than a clobber of a
 * newer owner's registration. This is forward insurance against a hazard
 * that is unreachable in the tree as it stands today, not repair of an
 * observed defect (design D3).
 *
 * There is deliberately **no unconditional `clear(handle)`**. An owner that
 * becomes ineligible unregisters only the handler IT registered, which is a
 * no-op when it holds none. An unconditional clear would re-admit the exact
 * clobber identity-scoped teardown exists to forbid, through a second door
 * (D3's closing paragraph).
 *
 * Invoking an unregistered handle is a silent no-op and never throws; a
 * value-returning handle (`getTimelineZoom`) yields `undefined` when
 * unowned — never a fabricated default. A caller's own fallback policy
 * stays in the caller, not here (D2).
 *
 * Every invoke function is synchronous, so a React-external caller (e.g.
 * `departureWatcher.ts`, which fires from `popstate` / the navigation
 * wrapper before React re-renders or commits) observes its call's effect
 * before returning — the ordering `web-session-routing`'s
 * "Originator-scoped transport stop on route departure" depends on.
 */

/** Every coordination handle's name and signature — the single declaration site. */
interface HandlerMap {
  seekAudio: (sec: number) => void;
  seekAudioAndPlay: (sec: number) => void;
  stopTransportIfNeeded: () => void;
  setManualScrubSec: (sec: number | null) => void;
  scrollTimelineToSec: (sec: number, totalSec?: number) => void;
  getTimelineZoom: () => number;
  invalidateEvents: () => void;
}

/** The seven coordination handle names. */
export type HandleName = keyof HandlerMap;

const handlers: { [K in HandleName]?: HandlerMap[K] } = {};

/**
 * Register `handler` as the current owner of `handle`, replacing any
 * handler already registered. The registry serves one owner per handle, by
 * construction — a handle does not fan out to multiple concurrently
 * registered handlers.
 */
export function register<K extends HandleName>(handle: K, handler: HandlerMap[K]): void {
  handlers[handle] = handler;
}

/**
 * Unregister `handler` from `handle`, but only if it is still the
 * currently registered handler (identity-scoped teardown, design D3). A
 * stale owner passing its own now-replaced closure is a no-op — it does
 * not clear a newer owner's registration. This is the only way to clear a
 * handle; there is no unconditional `clear(handle)`.
 */
export function unregister<K extends HandleName>(handle: K, handler: HandlerMap[K]): void {
  if (handlers[handle] === handler) {
    delete handlers[handle];
  }
}

/**
 * Whether `handle` currently has a registered handler. Distinguishes
 * "unowned" from "registered to a handler that does nothing", which
 * invoking alone cannot (both produce no observable effect).
 */
export function isRegistered(handle: HandleName): boolean {
  return handlers[handle] !== undefined;
}

/**
 * Clear every registration. Tests only — `web/src/test/setup.ts` calls
 * this in `afterEach`; production code never calls it.
 */
export function reset(): void {
  (Object.keys(handlers) as HandleName[]).forEach((handle) => {
    delete handlers[handle];
  });
}

// --- Typed invoke functions — one per handle. Each is a silent no-op when
// no owner is registered, and each resolves the handler at call time (never
// captures it at import time). ---

export function seekAudio(sec: number): void {
  handlers.seekAudio?.(sec);
}

export function seekAudioAndPlay(sec: number): void {
  handlers.seekAudioAndPlay?.(sec);
}

export function stopTransportIfNeeded(): void {
  handlers.stopTransportIfNeeded?.();
}

export function setManualScrubSec(sec: number | null): void {
  handlers.setManualScrubSec?.(sec);
}

export function scrollTimelineToSec(sec: number, totalSec?: number): void {
  handlers.scrollTimelineToSec?.(sec, totalSec);
}

/** Value-shaped: yields `undefined` when unowned — never a fabricated default (D2). */
export function getTimelineZoom(): number | undefined {
  return handlers.getTimelineZoom?.();
}

export function invalidateEvents(): void {
  handlers.invalidateEvents?.();
}
