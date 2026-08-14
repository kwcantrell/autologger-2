# Tasks: settings-modal-mount-cost

> Gated 2026-08-13 (panel + gate rulings folded across all four artifacts), then extended
> 2026-08-13 with phase 2 after profiling on the reporter's data. `file:line` anchors are
> orientation only — locate the quoted code by content before editing.

## 1. Baseline evidence

**Tasks 1.1/1.2 are DONE — performed 2026-08-13, before apply.** The halt-gate passed. Two
profiles were taken against the production serve path on the reporter's own data, and they
partition the click into two independent costs (numbers and method in `design.md`):

- **Modal mount** — 1,337 mounts, ~70 ms, dominated by Radix `Select` item trees (12
  `SelectTrigger` mounts, matching the modal's Select inventory exactly). Addressed by phases 3–4.
- **Workspace re-render — claim withdrawn.** Originally recorded here as "+11,097 re-renders and
  70 ms → 101 ms once a session workspace is open, caused by a defeated `memo`." That render-count
  claim was withdrawn post-apply: it came from an over-counting instrument, and ground truth shows
  the workspace re-renders zero times on a settings click either way (see design.md D0 and
  `.apply/phase2-diagnostic.md`). What phase 2 actually addressed is a real but modest prop-identity
  defect at the shell-to-workspace boundary, kept for correctness rather than a measured win.

- [x] 1.1 Baseline profile of the settings-open click, production serve path, reporter's data.
- [x] 1.2 Halt-gate attribution — **passed**.
- [x] 1.3 Extend the baseline with the two paths not yet separated, same method (CDP + React
      DevTools render profile + `longtask` observer): the **reopen** path and the **first Event
      Buttons tab activation**, on a show with many event buttons. Record to
      `openspec/changes/settings-modal-mount-cost/.apply/profile-before.md`.

## 2. Keep the shell-to-workspace boundary memoizable

Spec: "The shell-to-workspace render boundary stays memoizable". Design: D0.

> **Rescoped 2026-08-13.** This phase originally claimed the change's largest performance win. That
> claim was withdrawn — the render counts behind it were a profiling-tool artifact
> (`.apply/phase2-diagnostic.md`). The fix and its tests are kept for correctness only; task 2.3's
> verification criterion is void and replaced below.

- [x] 2.1 Write the failing test in `AppShell.test.tsx`: with a session workspace mounted, a shell
      state change (open the settings modal) must not re-render the workspace subtree. Assert via a
      render counter on a mocked `SessionRoute`/`WorkspaceStatic` child, or by asserting that the
      props crossing the boundary keep a stable identity across shell renders — presence assertions
      cannot see this. Extend to the other shell overlays and the mobile rail toggle per the second
      scenario. Confirm it fails against the current implementation.
- [x] 2.2 Give `onOpenMobileNav` a stable identity in `AppShell` — `useCallback`, matching
      `handleOpenSettings` / `handleCloseSettings` / `handleOpenNewSession` alongside it — so
      `WorkspaceStatic`'s existing `memo` holds. Locate by content: the inline
      `onOpenMobileNav={() => setRailOpen(true)}` arrow on the `SessionRoute` element. Verify no
      other prop crossing that boundary is unstable (`sessionId` and `ytImportPending` are a string
      and a boolean). Gate: `npm run typecheck` + `npm test`.
- [x] 2.3 ~~Re-profile and confirm the re-render count drops to the no-session baseline.~~
      **Void — criterion withdrawn.** Executed, and it failed: counts were identical before and
      after (17,238). The follow-up diagnostic established the counts themselves were unreliable
      and that `SessionWorkspace` renders zero times on the click either way. Recorded in
      `.apply/phase2-diagnostic.md` and the ledger. Nothing further to verify at this phase: the
      rescoped requirement is prop stability, which task 2.1's tests already assert with a
      mutation check.
- [x] 2.4 Correct the rationale left in the tree by the withdrawn claim: the code comment in
      `AppShell.tsx`, the delta spec requirement, and design D0 must assert only prop stability,
      with the withdrawal recorded rather than silently dropped.

## 3. Deferred tab content

Spec: "Settings modal defers inactive tab content". Design: D2.

- [x] 3.1 Write the failing tests in `HomeSettingsModal.test.tsx` (which already mocks
      `./EventButtonsTable` — extend that mock with a **mount counter**, since the reopen scenario
      is about mounts, not final DOM), one per spec scenario: (a) opening mounts only General's
      content while all four `aria-controls` targets resolve; (b) activating Event Buttons mounts
      it and switching back keeps it mounted; (c) **close-then-reopen records zero mounts of the
      panel content** across the transition; (d) editing General and saving without ever activating
      Event Buttons still submits the same `show_updates`; (e) activating Event Buttons, editing
      nothing, and closing raises no discard confirmation. Confirm each fails for the stated reason.
- [x] 3.2 Implement: a `visitedTabs` `Set<TabId>` seeded `{'general'}`, added to where the tablist
      button currently calls `setActiveTab(tab.id)`; gate only each panel's **children** on
      membership, leaving the four wrappers' `id`/`role`/`aria-labelledby`/`hidden`/`SECTION_CLASS`
      untouched. Move the open-reset out of the passive `isOpen` effect into the render-phase
      `prevOpen` pattern written out in design D2, resetting `activeTab`, `visitedTabs`,
      `initialized`, and `initialSnapshot` together. Never unmount a visited tab. Gate:
      `npm run typecheck` + `npm test`.

## 4. Lazy per-row type control

Spec: "Event-button rows defer their type control". Design: D3.

- [x] 4.1 Write the failing tests for `EventButtonsTable`, one per spec scenario: (a) rendering N
      rows mounts no listbox-style overlay component and the count does not grow with N; (b) a
      single activation opens the control, operable, with the same options and selected value —
      cover mouse click **and** a bare `click` with no preceding pointer/focus events (the
      assistive-technology and touch path); (c) tabbing to the control leaves focus **on** it, with
      the same accessible name, role, and ARIA state, operable without any pointer event. Note the
      existing `HomeSettingsModal.test.tsx` mocks `./Select` wholesale, so these assertions belong
      at the `EventButtonsTable` level against the real component.
- [x] 4.2 Add an optional `defaultOpen` pass-through to `web/src/pages/index/components/Select.tsx`
      (additive; existing call sites untouched). Verify the other three call sites — `FpsSelect`,
      the copy-from-show select, the suffix select — are unaffected.
- [x] 4.3 Implement the inert trigger + intent upgrade in `EventButtonsTable.tsx`: a non-Radix
      trigger carrying the same classes, accessible name, role, ARIA state (expanded/disabled), and
      displayed value. Upgrade on activation, mounting the real `Select` with `defaultOpen` so the
      already-consumed gesture is not required to re-fire on the new node (design D3 — Radix opens
      on `pointerDown` for mouse, so a swap-on-pointerdown would not open). Hover/focus may
      pre-warm the upgrade; a focus-triggered upgrade must `.focus()` the new trigger via a ref.
      Gate: `npm run typecheck` + `npm test`.

## 5. Final gates

- [ ] 5.1 `npm run typecheck` and `npm test` (full workspace sweep).
- [ ] 5.2 Re-run the measurements from 1.1/1.3 and record them beside the baseline, using only the
      instruments this change trusts (`PerformanceObserver` long-task timings and/or `console.log`
      ground truth — not `agent-browser react renders`, whose per-component and aggregate counts
      this change found unreliable; see D0 and `.apply/phase2-diagnostic.md`): the modal-mount cost
      (task 1.1's baseline) and the first Event Buttons tab activation must both improve — these are
      what phases 3–4 (deferred tab content, lazy per-row `Select`) can actually deliver. Do **not**
      expect the settings-open click's 67–143 ms session-dependent long task (D0.1) to improve —
      that cost's cause is untested and out of scope for this change; phase 2's contribution to it
      was the withdrawn claim. If the modal-mount or first-tab-activation numbers are unchanged,
      that is a finding for the whole-branch review, not a rounding error. Record the numbers in
      `design.md`.
- [ ] 5.3 `npm run e2e` (chromium + login-gate) **and** `npm run e2e:visual` (visual-desktop +
      visual-mobile). The settings snapshots and the teams smoke flow both click
      `#v6-settings-tab-event-buttons` before touching table content. This change alters no UI
      intentionally — the lazy trigger is specified as a visual stand-in — so **any** visual diff is
      branch-induced signal to investigate, not a baseline to re-bless.
- [ ] 5.4 `npm run docs:check` — the atlas drift gate. No new capability is added, so no
      `web-docs/model/components.ts` attachment is expected; confirm the gate is clean rather than
      assuming it.
- [ ] 5.5 `npm run lint` (report-only) over the touched paths.
