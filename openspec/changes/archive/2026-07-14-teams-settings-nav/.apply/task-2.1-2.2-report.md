# teams-settings-nav — Phase 2, tasks 2.1 + 2.2 report

## Scope

Lift `HomeSettingsModal` from `SessionRoute`/`WorkspaceStatic` to `AppShell`, mounted once
beside the route switch (design D1). Delete the dead `showSettings`/`onCloseSettings`/
`onCloseSession` prop threading from `SessionRoute` and `WorkspaceStatic`. Add `activeTab`
to the modal's reset-on-open effect. Rewire the AppShell studio-switch pin and the "settings
opens" test to the new mount point. Did **not** touch `TeamsRoute`, `V6Rail` (beyond adding
a settings button to its AppShell.test.tsx mock), or any server code — per instructions,
those are the next unit.

## Files changed

- `web/src/pages/index/AppShell.tsx` — imports and mounts `HomeSettingsModal` unconditionally
  beside the route switch (`isOpen={showSettings}`, `onClose={handleCloseSettings}`,
  `onCloseSession={handleCloseSession}`); `SessionRoute` no longer receives
  `showSettings`/`onCloseSettings`/`onCloseSession`.
- `web/src/pages/index/components/SessionRoute.tsx` — dropped the `HomeSettingsModal` import
  and mount, `showSettings`/`onCloseSettings`/`onCloseSession` from `SessionRouteProps`, and
  the `settingsModal` fragment wrapping in every render branch (loading/error/not-found/
  archived now return bare state components).
- `web/src/pages/index/components/WorkspaceStatic.tsx` — dropped the `HomeSettingsModal`
  import/mount and the three dead props; kept as a bare `memo` wrapper over
  `SessionWorkspace` (recorded deferral per D1, not inlined into `SessionRoute`).
- `web/src/pages/index/components/HomeSettingsModal.tsx` — reset-on-open effect now also
  calls `setActiveTab('general')` (previously relied on unmount to reset the tab; the modal
  no longer unmounts on route change).
- `web/src/pages/index/AppShell.test.tsx` — V6Rail mock gained a `#v6-btn-settings` button
  wired to `onOpenSettings`; `SessionRoute` mock lost its `onCloseSession`/studio-switch
  stand-in button; added a `HomeSettingsModal` mock (renders `role="dialog"` only while
  `isOpen`, plus `settings-modal-close`/`studio-switch-close` stand-in buttons) — this is the
  design-D1-mandated mock rework. Rewired the pre-existing studio-switch-navigates-home test
  to open settings first, then click `studio-switch-close`. Added: "settings opens on /teams",
  "settings still opens on /" and "on /sessions/:id", "an open modal survives a route change"
  (browser Back between `/` and `/teams`), "the modal mounts closed during the profile-loading
  window", "studio-switch save on /teams does not navigate".
- `web/src/pages/index/AppShell.onboarding.test.tsx` — added assertions to the existing
  zero-membership onboarding test: no `#v6-btn-settings` and no `role="dialog"` render for the
  onboarding branch (this file exercises the real `useProfile`/`useCreateTeam` hooks against a
  real `QueryClient`, unlike `AppShell.test.tsx`, so it's the right place to pin this without
  needing to mock `HomeSettingsModal` there — the onboarding branch early-returns before the
  route switch / modal mount is ever reached, so the real modal never renders in this test
  either).
- `web/src/pages/index/components/SessionRoute.test.tsx` — dropped the `HomeSettingsModal`
  mock (module no longer imports it) and the three dead props from `renderRoute`.
- `web/src/pages/index/components/HomeSettingsModal.test.tsx` — added a new describe block
  pinning the `activeTab` reset: open, switch to Event Buttons, close (rerender `isOpen`
  false), reopen (rerender `isOpen` true, same instance — no unmount), assert General is
  active again.
- `web/src/pages/index/departureWatcher.test.tsx` — added a `HomeSettingsModal: () => null`
  mock. This file renders the real `AppShell` with a `useProfile` module mock that only stubs
  `useProfile` (no `useProfileMutation`/`useCreateShow`); post-lift, AppShell mounts the real
  `HomeSettingsModal` unconditionally, which now pulls those hooks and would throw against the
  partial mock. This file's concern is departure/transport-stop, not settings, so a null mock
  is the correct scope (same fix class the design's D1 note anticipated for `AppShell.test.tsx`
  — this file needed the same treatment but wasn't named explicitly in the task).

## TDD evidence

RED (captured before implementation): ran
`cd web && npx vitest run src/pages/index/AppShell.test.tsx` after writing the new/rewired
tests and mocks but before touching `AppShell.tsx`/`SessionRoute.tsx`/`WorkspaceStatic.tsx`.
6 failures: the 5 new tests plus the pre-existing "studio-switch save path" test (whose old
`studio-switch-close` button lived in the now-removed `SessionRoute` mock fragment) —
```
× the studio-switch save path navigates to / like the close control, stopping an originated roll
× settings opens on /teams (the rail Settings button now works there)
× settings still opens on /
× settings still opens on /sessions/:id
× an open modal survives a route change (browser Back between / and /teams)
× studio-switch save on /teams does not navigate (no open session to close)
 Test Files  1 failed (1)
      Tests  6 failed | 13 passed (19)
```

GREEN (after the lift + prop deletion + activeTab reset):
`cd web && npx vitest run` → `Test Files 17 passed (17)`, `Tests 168 passed (168)`.

## Full gate commands (run from repo root)

- `npm run typecheck` → server + web + companion + e2e all clean, no errors.
- `npm test` → server 338/338 passed, web 168/168 passed, companion 20/20 passed.
- `npm run lint` → clean for every file touched in this unit (the two pre-existing warnings
  biome reports are in `web/src/shared/utils/loadingVideo.ts`, untouched by this unit, and
  predate it — biome's `--write` auto-formatted two of my test files during the lint run,
  formatting only, reverified green after).

## Self-review findings

- Confirmed Radix `Dialog.Root`/`RadixDialog.Portal` renders nothing to the DOM while
  `open={false}` (read `web/src/shared/ui/Dialog.tsx`), so mounting `HomeSettingsModal`
  unconditionally in `AppShell` is safe for the "mounts closed during profile-loading" and
  "never for onboarding" behavior pins — no extra DOM/CSS/focus-trap side effects while
  closed.
- Verified `handleCloseSession`'s existing `if (activeSessionId) navigate('/')` guard already
  produces the "studio-switch save on /teams does not navigate" behavior for free (no
  `activeSessionId` on `/teams`) — pinned by test, no production code change needed for that
  specific pin.
- Did not touch `handleSave` logic in `HomeSettingsModal.tsx` per the phase-1 ledger note
  (only its reset-on-open effect, for `activeTab`).
- Searched the whole `web/src` tree for other tests that render the real `AppShell` tree
  (`grep -rl AppShell src --include="*.test.tsx"`) to catch every file that would need the
  same `HomeSettingsModal` mock treatment; found and fixed `departureWatcher.test.tsx` in
  addition to `AppShell.test.tsx`. `RootGate.test.tsx`, `useLoginReturnConsume.test.tsx`,
  `LoginPage.test.tsx`, and `SessionWorkspace.test.tsx` only mention "AppShell" in
  comments/mocks, not real renders — confirmed via grep, no changes needed there.
- Did not touch `TeamsRoute.tsx`, `V6Rail.tsx` (production code), or any server file, per
  scope instructions.
- Verified via `git status --short` before staging that none of the pre-existing uncommitted
  foreign files (`server/src/node/audioMerge.*`, `server/scripts/`,
  `server/src/test/fixtures/`, `package-lock.json`, `server/package.json`,
  `server/tsconfig.json`) were touched by any edit in this unit.

## Commits

- Staged and committed only the files listed above under "Files changed" (explicit paths,
  no `git add -A`/`git add .`).
