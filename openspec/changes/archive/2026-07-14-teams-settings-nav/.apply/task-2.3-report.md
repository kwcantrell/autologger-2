# Task 2.3 report — TeamsRoute back affordance + rail same-route guard

## What was implemented

1. **`TeamsRoute.tsx`** — added one shared "Back to sessions" control inside the
   stable `#teams-route-placeholder` container, using the `STATE_BUTTON` idiom
   copied from `SessionRoute.tsx`'s not-found/error states (same class string).
   The container now renders a fragment once `profile` has loaded: whichever of
   `SignedInRequiredNotice` / the signed-in page rendered, followed by a single
   `<button onClick={() => navigate('/')}>Back to sessions</button>` — one JSX
   node in the source, present in the DOM in both non-loading states (absent
   only in the `!profile` null-loading gap, per the task spec). Navigation goes
   through the shared `navigate()` wrapper (`../navigation`), matching the
   existing idiom.
2. **`V6Rail.tsx`** — added the one-line same-route guard to the rail's Teams
   button. Added `const [onTeamsRoute] = useRoute('/teams');` (wouter's
   `useRoute`, the exact idiom `AppShell.tsx` already uses for the same route)
   and changed the button's `onClick` from unconditional `navigate('/teams')`
   to `() => { if (!onTeamsRoute) navigate('/teams'); }`.

## Files changed

- `web/src/pages/index/components/TeamsRoute.tsx`
- `web/src/pages/index/components/V6Rail.tsx`
- `web/src/pages/index/components/TeamsRoute.test.tsx` (2 new tests + navigation test seam wiring)
- `web/src/pages/index/components/V6Rail.test.tsx` (new file, 2 tests)
- `openspec/changes/teams-settings-nav/tasks.md` (ticked 2.3)

## TDD RED → GREEN evidence

RED (before implementation), `cd web && npx vitest run
src/pages/index/components/TeamsRoute.test.tsx
src/pages/index/components/V6Rail.test.tsx`:

```
FAIL TeamsRoute.test.tsx > back-to-sessions affordance ... > is present in the
     signed-in-required state ... — unable to find button "back to sessions"
FAIL TeamsRoute.test.tsx > back-to-sessions affordance ... > is present in the
     signed-in state ... — unable to find button "back to sessions"
FAIL V6Rail.test.tsx > ... > pushes no history entry when clicked while
     already on /teams — expected ['/teams'] but got ['/teams','/teams']
 Test Files  2 failed (2)
      Tests  3 failed | 8 passed (11)
```

(The V6Rail "navigates to /teams when not already on /teams" test passed
immediately — that's the pre-existing unguarded behavior, kept as a regression
pin; only the same-route guard test was RED.)

GREEN (after implementation), same command:

```
 Test Files  2 passed (2)
      Tests  11 passed (11)
```

## Test commands + output

- `cd web && npx vitest run src/pages/index/components/TeamsRoute.test.tsx src/pages/index/components/V6Rail.test.tsx` → 2 files passed, 11 tests passed.
- `npm run typecheck` (root, all workspaces) → clean, no errors.
- `npm test` (root: server + web + companion vitest) → server 47 files/338 tests
  passed; web 18 files/172 tests passed (includes the 11 above); companion 6
  files/20 tests passed.
- `npm run lint` → 4 pre-existing warnings in `web/src/shared/utils/loadingVideo.ts`
  (unrelated `useOptionalChain` suggestions, not touched by this task); no
  warnings in any file this task changed.

## Self-review findings

- Confirmed only one back-button JSX node exists in `TeamsRoute.tsx` (not
  duplicated per branch) — satisfies "one SHARED control" from the task text;
  both new TeamsRoute tests assert on `getByRole('button', { name: /back to
  sessions/i })`, which would fail with a "multiple elements" error if the
  control were duplicated instead of shared, since only one state renders at a
  time but a duplicated-per-branch approach would still pass that assertion —
  the actual evidence for "shared, not duplicated" is the diff itself (single
  JSX occurrence), not test behavior; noting this as a residual: a
  code-structure property, not a runtime-observable one.
- `useRoute` from `wouter` used in `V6Rail.tsx` requires no `<Router>` ancestor
  in production (wouter falls back to the default browser-location hook,
  exactly as `AppShell.tsx`'s own `useRoute('/teams')` already relies on
  un-wrapped) — verified by grepping the `pages/index` tree for `<Router`
  usage outside test files: none found, confirming this matches the existing
  pattern rather than introducing a new dependency.
- Did not touch `HomeSettingsModal.tsx`, `AppShell.tsx`, or `SessionRoute.tsx`
  beyond what already existed (only imported `navigate`/`useRoute` — no shared
  file bodies modified there).
- Verified via `git status --short` that the working tree's unrelated
  in-progress files (`server/src/node/audioMerge.*`, `server/scripts/`,
  `server/src/test/fixtures/`, `package.json`/`package-lock.json`/
  `server/tsconfig.json` modifications, `openspec/changes/deepgram-transcription/`)
  were never staged or touched.
