# Tasks 5.1 / 5.2 — Originator-scoped transport stop on route departure

Branch: `session-deep-links`. Commits:
- `1901141` feat(web): originator-scoped transport stop on route departure (task 5.1
  + the two AppShell tests that had to change to match the new contract)
- `9a1760a` test(web): departure-watcher matrix for originator-scoped transport stop
  (task 5.2)

## Where the flag lives

`web/src/pages/index/transportOrigination.ts` — plain module state (a closured
`let originatedSessionId: string | null`), deliberately not React state. Exports:
`markOriginated(sessionId)`, `getOriginatedSessionId()`, `clearOrigination()`,
`resetOriginationForTesting()`.

Set at the client's actual transport-start call site:
`web/src/pages/index/components/TransportControls.tsx`'s `handleClick` (idx===1,
"roll timecode"), immediately after `await start.mutateAsync()` succeeds. This is
the only in-app caller of `useTransport(sessionId).start`, so it's the single place
"this client issued transport-start" is true. `SessionWorkspace.tsx`'s
`window.AutoLogger_stopTransportIfNeeded` definition/cleanup effect (still gated on
`sessionId && !blocksMedia && isRolling`) is untouched, per the brief.

Scoping: the flag holds a session id, not a boolean, so "scoped per-mount" falls out
of the departure watcher's own comparison (see below) rather than needing an
explicit reset-on-mount effect — a stale flag from a prior mount of the *same* id is
consumed (fires + clears) the first time that id's route is departed, exactly like a
fresh one would be. A reload forgets it (module state), matching the design's
accepted Risk (fail-safe: missed auto-stop beats a wrong stop).

## Watcher wiring (wrapper + popstate)

`web/src/pages/index/departureWatcher.ts`:
- `handleWrapperNavigation(nextPath)` — called synchronously from
  `navigation.ts`'s `navigate()`, **before** it delegates to the underlying impl
  (browser `pushState`/`replaceState`, or the `wouter/memory-location` test seam).
- `handlePopstate()` — a raw `window.addEventListener('popstate', ...)` listener,
  installed once at module load (`installDepartureWatcher()` runs at the bottom of
  the file, at import time — not inside a React effect, so there is nothing for
  StrictMode's render/effect double-invocation to double-register).

Both compute the same predicate: `departsOriginatedSession(nextPath)` — extracts
the `:id` segment from `nextPath` (or `window.location.pathname` for popstate) via
`/^\/sessions\/([^/]+)$/`, `decodeURIComponent`s it (navigate() callers build
targets with `encodeURIComponent`, e.g. `AppShell.handleSelectSession`; the flag
holds the raw, wouter-decoded id), and compares against `getOriginatedSessionId()`.
If the flag is set and the target doesn't match that id's route (home, a different
session, or anything else), it fires `window.AutoLogger_stopTransportIfNeeded?.()`
once and calls `clearOrigination()`. wouter's `useRoute` is never referenced by
this module (design D1/D4 division of labor holds).

`navigation.ts`'s `navigate()` is now:
```ts
export function navigate(path: string, options?: NavigateOptions): void {
  handleWrapperNavigation(path);
  impl(path, options);
}
```

`AppShell.handleCloseSession`'s direct `window.AutoLogger_stopTransportIfNeeded?.()`
call is removed; its `navigate('/')` call (still gated on `activeSessionId` per D3,
unchanged) is what now stops the roll, via the watcher. The settings-modal
studio-switch branch (`HomeSettingsModal` → `onCloseSession` prop) turned out to
call this exact same `handleCloseSession` function — there was only one direct call
site to remove, not two as the brief's phrasing suggested; verified by grep before
editing.

## Exactly-once guarantee

Firing and clearing happen together (`fireStopAndClear`), so a second departure
after the flag has already been consumed reads `getOriginatedSessionId() === null`
and short-circuits before ever touching the global. Verified directly:
`departureWatcher.test.tsx`'s "switching to another session id" test performs two
sequential switches (originated session → sess-2 → sess-1) and asserts
`stop` is still at exactly 1 call after the second. `navigate()`'s underlying impl
(`wouter/use-browser-location`'s `navigate`, which calls `pushState`) never itself
dispatches a `popstate` event (only real back/forward do), so wrapper-driven and
popstate-driven firings can't double-count the same transition.

## Ordering proof (stop fires before SessionWorkspace's effects can clear the global)

`navigate()`'s body calls `handleWrapperNavigation(path)` — which runs
`fireStopAndClear` synchronously if applicable — strictly before `impl(path,
options)`, which is what actually mutates history/location state. React's
state-driven re-render (wouter's location subscription firing, `AppShell`
re-rendering with a new `activeSessionId`, `SessionWorkspace` unmounting/updating)
only happens after that state mutation, asynchronously relative to the synchronous
call stack: click handler → `navigate()` → `handleWrapperNavigation()` [stop fires,
flag cleared] → `impl()` [history mutates] → (later, un-batched from this call)
React commits → `SessionWorkspace`'s effects run and may clear/redefine
`window.AutoLogger_stopTransportIfNeeded`. By the time that effect runs, the stop
call has already fired and read whatever the global was at click time. Same
argument for `popstate`: the browser has already updated `window.location` by the
time the event fires, but the raw listener still runs before React's own popstate
subscription re-renders and before any effect cleanup — `handlePopstate` isn't
gated behind React at all.

This is provably not an effect-cleanup design: no `useEffect` in this feature ever
calls `clearOrigination`, `markOriginated`+stop together, or subscribes to route
state. StrictMode's double-invocation of render bodies/effects therefore cannot
call `navigate()` or dispatch `popstate` on its own — confirmed by the dedicated
"StrictMode double-invoke on mount issues no transport-stop command" test, which
renders under `renderStrict` (StrictMode) and asserts zero stop calls purely from
mounting.

## Test suite tails

Web tier: 46 passed (8 files) — the pre-existing 40 plus 6 new in
`departureWatcher.test.tsx`. Two pre-existing `AppShell.test.tsx` tests
("closing... still stops the transport", "the studio-switch save path...") had to
be updated: they previously asserted the old unconditional-stop behavior, which the
spec explicitly changes (D4's accepted behavior change — closing no longer stops a
roll started elsewhere). Both now call `markOriginated('sess-1')` before the close
action, which is the correct way to assert the *new*, originator-scoped contract;
without that call they'd now correctly assert *no* stop, which the new dedicated
`departureWatcher.test.tsx` covers explicitly (non-originator close/switch/popstate
tests).

- `npm run typecheck` (root, all 4 projects): clean.
- `npm test` (root): server 252 passed, web 46 passed, companion 20 passed.
- `npm run lint` (web + e2e): clean; biome auto-formatted the two new files'
  import ordering (`--write`), no unrelated files touched (verified via
  `git status`/`git diff` — `loadingVideo.ts` warnings it also printed were
  pre-existing and unsafe-fix-only, not applied).

## Concerns / residual notes

- The report's ordering argument for the `navigate()` path (wrapper fires before
  `impl`) is airtight by construction (synchronous call order in one function);
  the `popstate` path relies on the browser having already updated
  `window.location` before dispatching the event and on our raw listener running
  before wouter's own popstate subscription re-renders — both are standard
  DOM/React behavior, not something this code controls, but they're exactly the
  properties design D4 calls out as "the whole point."
- `sessionIdOf`'s regex (`^/sessions/([^/]+)$`) only matches exact single-segment
  session routes, consistent with the server's route matching (D7) and this
  change's URL shape (no URL state beyond the session id, per Non-Goals) — not
  reused/asserted against nested or query-bearing paths since none exist in this
  app today.
- No new server/e2e surface touched; `web/src/pages/index/` is the only directory
  with changes.

## Files touched

- `web/src/pages/index/transportOrigination.ts` (new)
- `web/src/pages/index/departureWatcher.ts` (new)
- `web/src/pages/index/departureWatcher.test.tsx` (new)
- `web/src/pages/index/navigation.ts` (wire `handleWrapperNavigation` into `navigate()`)
- `web/src/pages/index/components/TransportControls.tsx` (`markOriginated` on transport-start success)
- `web/src/pages/index/AppShell.tsx` (remove direct stop call from `handleCloseSession`)
- `web/src/pages/index/AppShell.test.tsx` (update 2 tests to the originator-scoped contract)

## Fix round 1 (phase-5 review, 2026-07-14)

Two findings from the phase-5 whole-branch review, both fixed in commit `fd51e3b`.

### 1. Important — async-gap origination race

`TransportControls.tsx`'s roll-button handler `await`s `start.mutateAsync()` before
calling `markOriginated(sessionId)`. Failure sequence: user clicks roll on sess-1 →
navigates away (switch to another session, or leaves the workspace) before the
mutation resolves → the departure watcher sees a null flag at that departure (no
fire, no clear, correct so far) → the awaited mutation then resolves and calls
`markOriginated('sess-1')` **after** the client has moved on → the flag is now stale,
pointing at a route the client isn't on. The watcher's `departsOriginatedSession`
predicate only checks "does the target match the flagged id", not "is the flagged id
the route we're actually leaving" — so the client's *next*, unrelated departure (say,
from sess-2, which happens to be rolling via another client) satisfies that check
(target ≠ 'sess-1') and fires sess-2's stop closure: a non-originator killing another
operator's roll, exactly the class originator-scoping exists to eliminate.

**Where the guard lives, and why there (not in `markOriginated`):** the first attempt
guarded inside `markOriginated` itself using `window.location.pathname`, matching the
reviewer's illustrative "current location still matches `/sessions/<sessionId>`"
suggestion. That broke two existing tests (`AppShell.test.tsx`'s close and
studio-switch-close cases): that file drives routing through a `wouter/memory-location`
Router seam and calls `markOriginated(sessionId)` **directly** as a stand-in for "this
client issued transport-start", entirely decoupled from `window.location` (which stays
`/` throughout those tests — only real browser navigation, exercised in
`departureWatcher.test.tsx`, ever touches it). A location-based guard inside
`markOriginated` is therefore invisible to real production navigation state in that
test harness and always no-ops there.

Root-caused instead to React lifecycle: `SessionWorkspace` never remounts
`TransportControls` on a same-tree session switch (no `key={sessionId}`; it just
re-renders with a new `sessionId` prop) but does unmount it when the session becomes
falsy (close, archived/error/not-found interstitial swap). So the guard moved to the
actual call site, `TransportControls.tsx`, using two refs:
- `latestSessionIdRef` — reassigned every render (`latestSessionIdRef.current =
  sessionId`) — catches the switch case (a later render's prop no longer matches the
  async closure's `sessionId`).
- `mountedRef` — flipped false in a `useEffect` cleanup with an empty dependency array
  — catches full unmount, which stops `latestSessionIdRef` from updating and would
  otherwise leave it frozen on the stale id.

`handleClick`'s roll branch now reads: `if (mountedRef.current &&
latestSessionIdRef.current === sessionId) markOriginated(sessionId);`.
`markOriginated` itself stays an unconditional plain setter — `AppShell.test.tsx` and
`departureWatcher.test.tsx`'s "originate" button both call it directly and still work
unchanged.

**Regression test:** new `web/src/pages/index/components/TransportControls.test.tsx`
mounts the real `TransportControls` (mocking only `useSessionStatus`, `useTransport`
with a controllable/deferred `mutateAsync`, and `useQueryClient`), against the real,
unmocked `transportOrigination`/`departureWatcher` modules:
- "does not mark origination for a session the client has switched away from before
  the mutation resolves" — click roll → `rerender` with a new `sessionId` prop
  (simulating the switch) → call `handleWrapperNavigation` for that switch (asserts
  nothing fires, flag still null) → resolve the deferred mutation → assert
  `getOriginatedSessionId()` stays `null` → arm a stop spy and call
  `handleWrapperNavigation('/')` (an unrelated later departure) → assert the spy is
  **never called** (this is the exact race: a pre-fix build lets the stale flag arm
  and this assertion fails).
- "does not mark origination for a session the client has fully navigated away from
  (unmount) before the mutation resolves" — same shape via `unmount()` instead of
  `rerender`.
- "still marks origination normally when the client stays on the same session route"
  — sanity check that the guard doesn't false-negative the common case.

### 2. Minor — missing same-id-navigation test

Added to `departureWatcher.test.tsx`: "navigating to the same session id (e.g. a
replace navigation) neither fires the stop nor clears the flag" — originates on
sess-1, then calls `navigate('/sessions/sess-1', { replace: true })`, and asserts the
stop global is never called and `getOriginatedSessionId()` is still `'sess-1'`
afterward. Locks in the behavior phase 6's post-login stash-return replace-navigate
will depend on (same `navigate()` wrapper, same target route as current).

The file's original async-gap test (added, then rewritten once the guard moved to
`TransportControls.tsx`) was removed from `departureWatcher.test.tsx` in favor of the
dedicated `TransportControls.test.tsx` coverage above, with a comment pointing there —
testing the race by calling `markOriginated` directly in this file would no longer
exercise the actual fix, since the guard no longer lives inside `markOriginated`.

### Suite tail (post-fix)

- `npm run typecheck` (root, all 4 projects): clean.
- `npm test` (root): server 252 passed, web **50** passed (9 files — the pre-existing
  46 minus 1 (superseded async-gap test) plus 1 (same-id test) plus 3 new in
  `TransportControls.test.tsx`), companion 20 passed.
- `npm run lint` (web + e2e): clean for all touched files; the 4 pre-existing
  `loadingVideo.ts` `useOptionalChain` warnings are unrelated (unsafe-fix-only,
  untouched by this change, as noted in the original report).
