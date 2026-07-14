# teams-settings-nav — proposal

## Why

Two shipped defects in the teams-era shell. (1) On `/teams`, the rail's Settings button
does nothing and there is no in-app way back to the sessions home view: `HomeSettingsModal`
is mounted inside `SessionRoute`/`WorkspaceStatic`, which `TeamsRoute` *replaces*, so the
button flips state nothing consumes — and nothing on `/teams` navigates to `/` (rail
session links reach `/sessions/:id`, but the no-session home is unreachable without
browser Back). (2) Saving settings fails with "Each category needs a name." whenever a
show has categories — and the root cause is **two-sided**. The wire shape of
`profile.shows[].categories` is the raw stored `CategoryRecord` (key **`name`** —
`showApiDict` passes `categories_json` through verbatim; only `/api/events`, Companion,
and `active_studio` go through the `label`-mapping shaper). The client both *hydrates*
drafts from the wrong key (`c.label ?? ''` → every existing category name is blank in the
Event Buttons tab — the repo's own blessed visual snapshot shows the empty inputs) and
*sends* the wrong key (`label:`) on save. Fixing only the outbound key would still send
`name: ""` and 400 identically.

## What Changes

- **Lift `HomeSettingsModal` to `AppShell`** so the rail's Settings button works on every
  route (`/`, `/sessions/:id`, `/teams`). `SessionRoute`/`WorkspaceStatic` stop mounting
  it and drop the now-dead `showSettings`/`onCloseSettings`/`onCloseSession` prop
  threading. The `showSettings` state, studio-switch save behavior, and modal semantics
  are preserved — with one deliberate improvement: the modal can no longer be unmounted by
  a route change while `showSettings` stays `true` (today that desyncs the flag, deadens
  the button, and surprise-reopens the modal on the next navigation). The modal now
  survives route changes while open; `activeTab` is reset in the existing reset-on-open
  effect so a reopen still starts fresh.
- **Add a leave affordance to the Teams page**: a single "Back to sessions" control inside
  the stable `TeamsRoute` container — present in both the signed-in and
  signed-in-required states — navigating to `/` via the shared navigation wrapper (same
  idiom as the session route's error/not-found states).
- **Fix the category save round-trip, client-side, in both directions**: hydrate drafts
  from `name` (`c.name ?? c.label ?? ''` in `showToShowDraft` and the copy-from-show
  path), send `name` in `handleSave`, and split the request category type in
  `web/src/api/types.ts` (the current `Category` type hard-requires `label`, so the
  payload fix alone fails typecheck; the read sites that legitimately consume `label` —
  events, Companion shapes — keep their type). Regression tests use wire-accurate
  `name`-keyed fixtures; the blessed visual snapshot showing blank name inputs is
  re-blessed with names visible.
- **Invalidate `['show-categories']` on save** — saves have never succeeded, so nothing
  ever invalidated the category-button query; without this, a now-working save leaves an
  open session's button strip serving deleted/renamed categories for its `staleTime`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-management`: the "Teams management UI" requirement gains two shell-integration
  clauses — the app shell's settings affordance SHALL function on `/teams`, and the page
  SHALL provide an affordance returning to the sessions view (in every rendered state).

The category fix is *not* a requirement change: the server's frozen surface already
defines both directions (`showApiDict` serves `name`-keyed categories; the update
validator requires `name`); the client is brought into conformance on both. The
alternative — reshaping `showApiDict` server-side to serve `label` — was considered and
rejected: it changes a frozen response shape (verbatim Python-ported behavior) and would
need its own `api-contract-freeze` delta to preserve a client bug.

## Impact

- **Web only**: `AppShell.tsx`, `SessionRoute.tsx`, `WorkspaceStatic.tsx`,
  `TeamsRoute.tsx`, `HomeSettingsModal.tsx` (hydrate + payload + invalidation),
  `EventButtonsTable.tsx` (copy-from-show hydrate), `web/src/api/types.ts` (request
  category type split), plus component tests. Note: `AppShell.test.tsx` currently mocks
  the profile-hooks module with only `useProfile` and fakes the studio-switch path
  through a mocked `SessionRoute` — the lift requires reworking those mocks and rewiring
  the studio-switch pin to the AppShell-level modal without weakening it.
- **Contract impact: none.** No server file changes; no route, shape, or status-code
  changes. The settings save request becomes contract-conforming (previously it produced
  a 400 the server already defines).
- **e2e**: the teams smoke gains settings-open and back-navigation assertions; a
  settings-save round-trip through the real server is added (a mocked-fixture test alone
  would have masked this bug's read side); the settings-modal visual snapshot is
  re-blessed.

## Non-Goals

- No server-side changes of any kind (no `label` aliasing in the validator, no
  `showApiDict` reshaping).
- No rail redesign or new Home rail item — the page-level back affordance is the chosen
  shape. (The rail's Teams button does gain a one-line same-route navigation guard —
  gate decision 1; the active-route *styling* remains out of scope.)
- No changes to the settings modal's tabs, save semantics, or studio-switch close path —
  including the pre-existing behaviors that working saves now resurface (active-show flip
  on save, settings-blob-before-shows persist ordering on validation failure, stale-draft
  last-write-wins between concurrent editors). These are recorded at the gate as
  consciously accepted, not silently shipped.
