# teams-settings-nav — tasks

> Gate passed 2026-07-14 (panel + owner decisions recorded in design.md "Gate
> decisions"). Plan of record.
> file:line anchors are orientation only — locate code by content before editing.

## 1. Category round-trip fix (both directions + types)

- [x] 1.1 TDD: failing tests first, against **wire-accurate `name`-keyed fixtures**
      (the real `profile.shows[].categories` shape — a `label`-keyed fixture passes
      against broken code): (a) `showToShowDraft` hydrates existing category names
      (non-blank) from a `name`-keyed show; (b) `handleSave` posts categories whose
      entries carry `name`; (c) `EventButtonsTable.copyFromShow` copies names from a
      `name`-keyed source show. Then fix: hydrate `c.name ?? c.label ?? ''` in both
      readers, send `name:` in `handleSave`, and split the request/`shows[].categories`
      category type from the `label`-keyed read type in `web/src/api/types.ts` (keep
      `label` typing for the events/Companion/`active_studio` read surfaces).
- [x] 1.2 Add the `['show-categories']` invalidation to `handleSave` + test pin
      (design D4).

## 2. Settings modal lift + teams back affordance

- [x] 2.1 TDD: failing test first — settings modal opens on `/teams`
      (`AppShell.test.tsx`: render at `/teams`, click `#v6-btn-settings`, assert dialog
      present); then move the `HomeSettingsModal` mount from
      `SessionRoute`/`WorkspaceStatic` into `AppShell` (single mount beside the route
      switch), deleting the dead `showSettings`/`onCloseSettings`/`onCloseSession` prop
      threading from both components (`WorkspaceStatic` stays as a memo wrapper —
      recorded deferral). Add `activeTab` to the modal's reset-on-open effect. Expect and
      perform the mock rework design D1 names: mock `HomeSettingsModal` (or extend the
      profile-hooks module mock) in `AppShell.test.tsx`, and rewire the studio-switch pin
      to the AppShell-level modal asserting the same observable (save with studio change
      on `/sessions/:id` → navigate `/`).
- [x] 2.2 Behavior pins: settings still opens on `/` and `/sessions/:id`; open modal
      survives a route change (spec scenario); modal mounts closed during the
      profile-loading window and never for the onboarding branch; studio-switch save on
      `/teams` does not navigate.
- [x] 2.3 TDD: failing test first — `TeamsRoute` renders one shared back-to-sessions
      affordance (present in both the signed-in and signed-in-required states) that
      calls the shared `navigate('/')`; then add the control in the stable
      `#teams-route-placeholder` container using the existing `STATE_BUTTON` idiom.
      Add the one-line same-route guard to the rail's Teams button (gate decision 1) +
      test pin (clicking Teams while on `/teams` pushes no history entry).

## 3. E2E + gates

- [x] 3.1 Extend the teams e2e smoke: on `/teams`, Settings opens the modal; the back
      affordance lands on `/` with the home view rendered. Add a settings-save
      round-trip through the real server (edit a category name → Save → success toast →
      reload → name persisted). Re-bless the settings-modal visual snapshot (blank
      category names → real names) as a reviewed diff.
- [x] 3.2 Full gates: `npm run typecheck`, `npm test`, `npm run lint`, `npm run e2e`.
