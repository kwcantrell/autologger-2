# Tasks

## 1. Content primitives

- [x] 1.1 Theme `input`, `textarea`, `label`, `field`, `alert`, `badge`, `empty`, `spinner` and `separator` to V5 by replacing their base strings (D1).
  - Test first: `primitives.smoke.test.tsx` gains a case that these contents keep none of `bg-input/30`, `rounded-md`, `border-dashed` or `line-clamp-1`, and that `Spinner` has `motion-reduce:animate-none`.
  - Verify with `npx vitest run src/shared/components/ui src/shadcnHygiene.repo.test.ts`.
  - Evidence: test first: smoke case "content primitives keep no shadcn input/radius/dashed/clamp leftovers; spinner honours reduced motion" -> `1 failed` (`slot: "input"`); after replacing input/textarea/label/field/alert/badge/empty/spinner base strings with the legacy V5 form vocabulary -> `npx vitest run src/shared/components/ui src/shadcnHygiene.repo.test.ts` `Tests 29 passed (29)`; full `npx vitest run` green; typecheck clean
- [x] 1.2 Run `npx shadcn@latest add checkbox --dry-run`, then `add checkbox`. Normalize the file (local `cn`, no `dark:`, V5 base) and run `npm uninstall -w web cn` if the CLI re-adds it.
  - Test first: a smoke case where a `Checkbox` with a `Label` is `role="checkbox"` named by the label, and a click toggles `aria-checked`.
  - Verify the smoke and hygiene tests pass, and that `grep -E '"cn"' web/package.json` prints nothing.
  - Evidence: test first: smoke "checkbox is a labelled role=checkbox that toggles" -> `Failed to resolve import "./checkbox"`; `npx shadcn@latest add checkbox --yes`, `npm uninstall -w web cn` (CLI re-added it), normalized (local cn, no dark-mode variants, V5 base) -> `npx vitest run src/shared/components/ui src/shadcnHygiene.repo.test.ts` `Tests 30 passed (30)`; `grep -c "\"cn\"" web/package.json` -> `0`; lint/typecheck clean

## 2. Route states and rescue

- [x] 2.1 Add `pages/index/components/RouteState.tsx` (D2).
  - Test first: `RouteState.test.tsx` checks that:
    - it renders the given `id` and `role`, and passes `data-testid`/`data-variant` through
    - `frame="route"`/`"gate"` wrap the panel in exactly `ROUTE_STATE_PAGE`/`GATE_PAGE`
    - the title is an `<h1>`
    - actions are buttons
    - `role="status"` never also renders an `alert`
  - Verify with `npx vitest run src/pages/index/components/RouteState.test.tsx`.
  - Evidence: test first: `npx vitest run src/pages/index/components/RouteState.test.tsx` -> `Failed to resolve import "./RouteState"`; after RouteState (Empty panel, <h1>, explicit role, frame prop, rest passthrough) -> with webBoundaries `Tests 114 passed (114)` (id/role, no alert on status, testid/data-variant passthrough, badge, frame classes === ROUTE_STATE_PAGE / GATE_PAGE)
- [x] 2.2 Port SessionRoute's not-found, error and archived states, RootGate's error, and ChunkLoadBoundary's route variant onto `RouteState`. ChunkLoadBoundary's overlay variant becomes `Alert`.
  - Test first: add role assertions to `SessionRoute.test.tsx` (not-found is `status` with no `alert`; error is `alert`) and to `RootGate.test.tsx` (error is `alert`).
  - Verify those suites and `ChunkLoadBoundary.test.tsx`, `webBoundaries.repo.test.ts` and `AppLoadingSkeleton.test.tsx` pass.
  - Evidence: test first: SessionRoute (not-found status + data-slot empty + no alert + Button back; error alert + empty), RootGate (#root-gate-error alert + empty, retry Button), ChunkLoadBoundary (route empty+alert, overlay data-slot alert) -> `3 failed | 24 passed` and `2 failed | 5 passed`; after porting to RouteState / Alert / Button -> those + AppLoadingSkeleton + webBoundaries + RouteState `Tests 143 passed (143)`; full `npx vitest run` -> `Test Files 122 passed (122) Tests 1524 passed (1524)`; lint/typecheck clean
- [x] 2.3 ChunkRescueBanner becomes a destructive `Alert` with `Button`s (D6).
  - Test first: assert that `Discard` and `Discard remaining` have `data-variant="destructive"` and the other actions are `outline`.
  - Verify `ChunkRescueBanner.test.tsx` passes (exactly one alert; list structure; names).
  - Evidence: test first: "renders as the destructive Alert with destructive Discard actions" (data-slot alert, aria-live assertive, Discard/Discard remaining destructive, Retry/Retry all/Download outline) -> `1 failed | 16 passed (17)`; after Alert variant=destructive (block layout, AlertDescription headline) + Button -> `Tests 17 passed (17)` (one alert, list, names, hideToast persistence); typecheck/lint clean

## 3. Shell, home, sessions

- [x] 3.1 Rail and mobile nav (D6): lucide icons, plus `Button` for clear-search, the search toggle and the hamburger.
  - Test first: rewrite the Batch Import icon assertion in `V6Rail.test.tsx` to check `svg.lucide-upload`. It fails on the hand SVG.
  - Verify `V6Rail`, `AppShell`, `AppShell.onboarding` and `SessionWorkspace.maximizeLog` pass.
  - Evidence: test first: V6Rail Batch Import icon test rewritten to `svg.lucide-upload` (aria-hidden, currentColor) -> `× uses an up-arrow upload icon …` on the hand SVG; after lucide Menu/Plus/Upload/Search/X/Users/Settings, Button ghost for search-toggle/clear and Button outline for the AppShell hamburger -> V6Rail + AppShell* + SessionWorkspace.maximizeLog `Tests 63 passed (63)` (search toggle still a <button>, footer classes, ids); typecheck clean
- [x] 3.2 HomeRoute: `Button` (`variant` follows whether there's a recent session) with lucide `Plus`/`ArrowRight`.
  - Test first: the New Session button has `data-variant="default"` with no recent session and `"outline"` with one.
  - Verify `HomeRoute.test.tsx` passes.
  - Evidence: test first: HomeRoute CTA `data-variant` default (no recent) / outline (with recent) -> `2 failed | 5 passed (7)`; after Button + lucide Plus/ArrowRight -> HomeRoute + SessionRoute `Tests 20 passed (20)`; typecheck/lint clean
- [x] 3.3 RecentSessionsList: the `⋮` menu becomes `DropdownMenu` (D3), and the rename dialog uses `Field`/`Input`/`Button`.
  - Test first:
    - the open helper uses `pointerDown`
    - choosing Rename, Archive or Delete by click and by Enter, and pressing Enter on the trigger, never call `onSelectSession` (panel critical finding; fails before the guard)
    - a new case opens the menu with Enter and checks `role="menu"` and the menuitems Rename/Archive/Delete
    - the rename input has the accessible name "Session name"
  - Verify `RecentSessionsList.test.tsx` passes, including the pinned live classes and the buttonless no-access rows.
  - Evidence: test first: open helper → pointerDown, 3 "never selects the row" cases (Enter on trigger opens role=menu; item click; item Enter), rename input named "Session name" -> on the legacy Popover `10 failed | 8 passed (18)`; after DropdownMenu (non-modal, content stops propagation, row ROW_IGNORE incl. [role=menu]/[role=menuitem]) + Field/Input/Button rename + V5-themed dropdown primitive -> `Tests 18 passed (18)`; guard proof: guard removed -> `2 failed` (item click / item Enter select the row), restored -> 18 passed; full `npx vitest run` -> `Test Files 122 passed (122) Tests 1528 passed (1528)`; lint/typecheck clean

## 4. Login and Teams

- [ ] 4.1 LoginPage (D4): `Alert` error with a link-retry, `Separator` divider, and create-account as `Button outline asChild` keeping `BTN_CREATE`.
  - Test first: the error banner has `role="alert"` (one only), and `#login-btn-create-account` has `data-slot="button"` and is still an `<a>` with the same `href`.
  - Verify `LoginPage.test.tsx` and `contrastTokens.test.ts` pass.
- [ ] 4.2 Teams (D5): `Field`/`Input`, `Button` variants, `Badge`, `Empty`, `Alert` (the no-owner notice as `status`), `Spinner`, and the `Checkbox` picker.
  - Test first: in `TeamCard.test.tsx`, Remove, Delete team and Leave team are `destructive`; the role badge is `data-slot="badge"`; show checkboxes are `data-slot="checkbox"` and toggle. L270–271 move from `.checked` to `aria-checked`.
  - Verify `TeamsRoute`, `TeamCard` and `AppShell.onboarding` pass (exact alert text; buttonless owner row).

## 5. Integration: QA gate and checks

- [ ] 5.1 Copy the walk from the archived `shadcn-shared-wrappers/qa`, adding steps for:
  - the session `⋮` DropdownMenu
  - Teams with a card expanded
  - the login error (`127.0.0.1:8787/?login_error=state_invalid`)
  - route not-found (`/sessions/does-not-exist`)

  Run both width passes against the archived `after-wrappers` captures. Verify contrast is 0 failures apart from the user-data "Audio issue", and record per-screen diffs in `qa/README.md`.
- [ ] 5.2 The owner reviews the pairs and does a dev-stack pass: the rail at both widths, the session menu by keyboard, the Teams picker, the login error, and the rescue banner if triggerable. Verify the result is recorded in `qa/README.md`.
- [ ] 5.3 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh` and `openspec validate shadcn-port-shell --strict`. Verify every gate passes; the storage "8 contending" flake is re-run, not counted.
