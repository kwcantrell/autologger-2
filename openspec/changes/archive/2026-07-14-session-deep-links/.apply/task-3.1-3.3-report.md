# Task 3.1–3.3 report — Router + URL-driven session state

Implementer subagent, 2026-07-14, branch `session-deep-links`.
Status: **DONE** — tasks 3.1, 3.2, 3.3 complete, all gates green per commit.

## Commits

- `71094f9` `feat(web): URL-driven session state via wouter; retire dataset/V3 session spine`
  (tasks 3.1 + 3.2 — entangled: removing the `useState` forces `syncChrome`'s removal)
- `f9cedd8` `test(web): routing + spine retirement coverage` (task 3.3)

`wouter@3.10.0` added to `web/package.json` dependencies; lockfile updated at root
(clean diff: wouter + its deps `mitt`, `regexparam`, `use-sync-external-store` only).

## Architecture of the navigation wrapper

`web/src/pages/index/navigation.ts` — the single navigation funnel (D1/D4):

- Exports `navigate(path, { replace? })`, the ONLY navigation API app code uses.
  It delegates to a module-private `impl`, defaulting to wouter's
  `navigate` from `wouter/use-browser-location` (pushState/replaceState +
  wouter's patched-history events, so `useRoute` re-renders).
- Phase-5 readiness: because every in-app navigation already flows through this
  one function, the departure watcher can later subscribe here (plus a raw
  `popstate` listener) and fire synchronously before React commits. NO
  transport-stop/departure logic was implemented in this phase (contract).
- Test seam: `setNavigationImplForTesting(next | null)` reroutes `navigate()`
  through `memoryLocation().navigate` so tests can assert on recorded history;
  `null` restores the browser impl. Production code never calls it.

### AppShell rewiring (D2/D3)

- `const [onSessionRoute, sessionRouteParams] = useRoute('/sessions/:id')`;
  `activeSessionId` derived from the match (empty string otherwise). No `<Route>`
  tree, no `<Router>` provider in production (wouter's default browser location);
  `main.tsx`/`RootGate` untouched.
- `handleSelectSession`: `if (sid !== activeSessionId) navigate('/sessions/' +
  encodeURIComponent(sid))` — the guard is the D3 re-select no-op (session cards
  fire `onSelect` unguarded). Create (NewSessionModal `onCreated`) rides the same
  handler. YT-import kickoff logic unchanged.
- `handleCloseSession`: keeps the direct `window.AutoLogger_stopTransportIfNeeded?.()`
  call (close-stops-the-roll behavior survives this phase; phase 5 replaces it),
  then `navigate('/')` **guarded on an active session** — the studio-switch caller
  is reachable with no session open and must not stack duplicate `/` entries —
  then invalidates the `sessions` query (the old rAF deferral dropped; ordering
  was cosmetic).
- Unmatched paths (e.g. the dev raw entry `/src/pages/index/index.html`): no route
  match → home view renders, URL untouched (non-normative note in the spec).
- The `requestAnimationFrame(syncChrome)` dances are gone entirely.

### Studio-switch close path

`HomeSettingsModal` gained a required `onCloseSession` prop (threaded
AppShell → `WorkspaceStatic` → modal); the save handler's
`if (activeStudioId !== prevStudioId)` branch calls it in place of
`window.V3_closeSession?.()`. Same behavior as the close control by construction
(it IS `handleCloseSession`).

## How the visibility swap moved (3.2, D9)

`syncChrome` owned two behaviors; both are now render-driven:

1. **Placeholder ↔ grid swap** — in `SessionWorkspace.tsx` JSX:
   `#v3-session-placeholder` gets `hidden` appended via clsx when `sessionId` is
   truthy; `#v3-session-grid` (previously statically `hidden`) gets `hidden` only
   when `sessionId` is falsy. Both elements stay in the DOM with their ids at all
   times (matching the old DOM shape — e2e asserts on those ids later). `hidden`
   winning over the co-present `flex` utility is pre-existing, proven behavior:
   the old static markup shipped `hidden flex` on the grid and rendered hidden.
   syncChrome's third act — re-adding `hidden` to `#v3-session-loading` — was
   redundant (that overlay is statically `hidden` in JSX) and was dropped.
2. **Title reset** — a route-keyed effect in AppShell:
   `if (!activeSessionId) document.title = 'AutoLogger'`. Checked who sets
   session titles: **nothing currently writes a per-session `document.title`**
   (repo-wide grep: the only `document.title` writer was syncChrome itself), so
   the reset is the entire observable title behavior, and it's preserved.

Removed: `syncChrome`, both `body.dataset.sessionId` write sites +
`window.V3_selectSession`/`V3_closeSession` (assignments AND `Window` interface
declarations). All other window globals (`Home_reloadSessionList`,
`AutoLogger_closeSettingsModal`, `AutoLogger_seekAudio`,
`AutoLogger_stopTransportIfNeeded`, `AutoLogger_invalidateEvents`) untouched;
`body.dataset.v4Transport` (CSS transport panels) untouched. Repo grep confirms
only explanatory comments mention `syncChrome` now; zero references to `V3_*`
or `dataset.sessionId` in `web/src`.

## What was mocked in tests (3.3)

All tests render under StrictMode via `renderStrict`; auto-cleanup via
`web/src/test/setup.ts`.

- **`AppShell.test.tsx`** (12 tests) — RootGate.test.tsx idiom: `useProfile`,
  `useYoutubeImport`, `useQueryClient` (`@tanstack/react-query`), `Toast`,
  `useIsMobile`, `loadingVideo`, `perfDebug` mocked at the module boundary.
  `V6Rail` mocked to buttons firing `onSelectSession('sess-1'|'sess-2')` /
  `onCloseSession` / `onNewSession`; `WorkspaceStatic` mocked to a sentinel
  exposing its received `sessionId` (the "workspace mount" observable) plus a
  button standing in for the studio-switch branch; `NewSessionModal` mocked to
  fire `onCreated('created-1')`. Location driven by
  `memoryLocation({ path, record: true })` + `<Router hook={...}>` + the
  navigation test seam — history asserted as exact arrays. The **browser-Back
  test** uses jsdom's real history (no Router wrapper, default wrapper impl:
  pushState → `history.back()` → popstate → waitFor).
  Covers: select/create/close/Back drive URL + workspace mount; re-select adds
  no entry; session switch pushes; deep-linked initial mount; close stops
  transport exactly once; close with no session pushes nothing; studio-switch
  path pushes `/` like close; unmatched path renders home without URL rewrite;
  title reset on no-session mount and on close; no dataset writes / no `V3_*`
  globals after transitions.
- **`SessionWorkspace.test.tsx`** (3 tests) — every data/socket/audio hook
  (`useSessionStatus`, `useEvents`, `useAudioClips`, `useWaveforms`,
  `useSessionSocket`, `useCompanionPresence`, `useRemoteRecordingGate`,
  `useRecoveryStopWarning`, `useDebugTransportOverride`, `apiFetch`,
  `useQueryClient`) and every heavy child (AudioPlayer/Recorder/SaveOverlay,
  CategoryButtonStrip, EventLogSheet, ExportModal, MarkerNav, TimecodeDisplay,
  Timeline, Topics/TranscribeFeed, TransportControls + `getTransportState`,
  Tooltip) mocked. Asserts the `hidden`-class swap in both directions and on
  rerender (close path), both ids always present.
- **`HomeSettingsModal.test.tsx`** (2 tests) — profile hooks, react-query,
  `showToast` mocked; `Dialog` mocked to a passthrough, `Select` to a native
  `<select>` (radix-free studio switching), `FpsSelect`/`EventButtonsTable`
  stubbed. Asserts `onCloseSession` called exactly once on a studio-changed
  save (and `mutateAsync` got `active_studio_id: 'studio-2'`), and not called
  on an unchanged save — the explicit "Studio-switch close path still works"
  test line from the consistency read.

## Per-commit suite output tails

Commit `71094f9` (impl; suites run pre-tests, its tree is the verified tree
minus the three new test files — a strict subset of passing tests):

```
web typecheck: clean (tsc --noEmit, no output)
 Test Files  5 passed (5)      # web (incl. pre-existing RootGate + tier tests)
      Tests  26 passed (26)    # ← includes the 17 new tests staged next commit
```

Branch tip `f9cedd8` (full gates):

```
npm run typecheck → clean (server, web, companion, e2e tsconfig)
npm test:
  server:     Test Files  43 passed (43) / Tests  252 passed (252)
  web:        Test Files   5 passed (5)  / Tests   26 passed (26)
  companion:  Test Files   6 passed (6)  / Tests   20 passed (20)
npm run lint → 0 errors; 4 pre-existing warnings (TopicsRow.tsx noFocusedTests
false-positive on a local `fit()` fn, loadingVideo.ts useOptionalChain ×2 + 1),
none in files this change touched. Biome reformatted the two new test files
(--write is the repo's lint script behavior); committed post-format.
```

## Self-review

- **Frozen contract**: no server, e2e, or API-surface changes; `web/` only.
- **D1/D2 held**: wouter is render-side only (`useRoute` in AppShell); no
  `<Route>` tree; RootGate/main.tsx untouched; no popstate listener added (that
  is phase 5's, via the wrapper + raw listener).
- **D3 held**: push on select/create, push `/` on close, no-op re-select,
  unmatched paths don't rewrite. The close-with-no-session guard is a defensive
  extension in D3's spirit (no duplicate entries); flagged for the whole-branch
  review in case the reviewer prefers unconditional navigation.
- **Param encoding note**: `navigate` encodes the id with `encodeURIComponent`;
  wouter unescapes locations with `decodeURI` before matching. For the app's
  real ids (UUID-like) both are identity transforms; exotic ids are phase-4
  resolution territory (`%2F` residual is recorded in the design).
- **Known red (by design)**: `e2e/smoke.spec.ts:46` still reads
  `body.dataset.sessionId` — flips in task 8.1. e2e was not run (contract).
- **StrictMode**: all new effects are idempotent (title set, no subscriptions);
  the full web tier renders under StrictMode and passes.
- Not done here (later phases): resolution states/`useSession(id)` (phase 4),
  originator-scoped departure stop (phase 5), stash/validator (6), Vite
  middleware + README (7), e2e flips (8).
