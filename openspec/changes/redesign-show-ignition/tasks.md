# Tasks

Every task names the test written first. A task is ticked only with an `Evidence:` line giving the command run and a short excerpt of its output. Unless a task says otherwise, test commands run from `web/` with `npx vitest run <path>`.

**Browser checks.** From group 2 on, each UI group ends with an agent-browser look at what it changed, at 1440 and 390 wide, logged in through the `shadcn-qa` session against `http://localhost:8787` (the only origin the browser here may open). Captures go in `.impeccable/review/<group>/`, and the Evidence line names them. This needs task 1.0 first.

## 1. Direction record and design foundations (D1, D9)

- [x] 1.0 Point the dev stack at this checkout, with the owner's go-ahead (`:8787` mounts `/home/spark/autologger-2` today).
  - Run `make dev-up` from `autologger-ui`.
  - Verify: `docker inspect autologger-dev-app --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}'` lists `/home/spark/autologger-ui/web/src`, and agent-browser opens `http://localhost:8787/` logged in with the current UI.
  - Evidence: owner go-ahead ("lets go with option 1"); `make dev-up` -> `dev app: http://127.0.0.1:8787` with all services Started or Healthy, after copying the gitignored `.env.openbao.dev` from autologger-2 with mode 600. `docker inspect autologger-dev-app …` -> `/home/spark/autologger-ui/web/src`; `curl -o /dev/null -w %{http_code} http://localhost:8787/` -> `200`; `agent-browser --session-name shadcn-qa open http://localhost:8787/` -> title `AutoLogger`, a logged-in home with the V5 rail and sessions.

- [x] 1.1 Record the direction contract for the console surface.
  - Run `impeccable surface-brief write web/src/pages/index/AppShell.tsx <brief>` with THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, FORM and FINISH, using the approved preview as the critique reference.
  - Verify: `impeccable surface-brief read web/src/pages/index/AppShell.tsx` prints all six blocks.
  - Evidence: `impeccable surface-brief write web/src/pages/index/AppShell.tsx brief.md` -> `web/.impeccable/surfaces/web-src-pages-index-appshell-tsx.md`; `impeccable surface-brief read … | grep -E "THESIS|OWN-WORLD|STORY|FIRST VIEWPORT|FORM|FINISH"` -> lines 27, 29, 43, 48, 58 and 60, all six blocks present.
- [x] 1.2 Add the Show Ignition tokens to `shared/theme/tailwind.css`, and point the shadcn variables and the `--v5-*` names at them (D1).
  - Tokens: `--si-*`, `--r-ctl`, `--r-card`, `--h-ctl`, `--h-sm`, `--sel-bg`, `--sel-line`, and the four transport mixes.
  - Test first: extend `contrastTokens.test.ts`. Primary label on accent, muted text on panel, and each status label (STOPPED, ROLLING, REC, PLAY) on its pill all compute to ≥4.5:1.
  - Verify: that test passes, and the full `npx vitest run` passes.
  - Evidence: test first, `npx vitest run src/shared/theme/contrastTokens.test.ts` -> `Tests  11 failed | 8 passed (19)` (no `--si-*` tokens, no `[data-transport='stopped']` rule). After the `tailwind.css` token, transport and re-pointing blocks: same command -> `Tests  19 passed (19)` (primary label on accent and on the primary tint, muted on panel/panel-2/bg and every rail mix, STOPPED/ROLLING/REC/PLAY each on its pill, all ≥4.5:1 via an OKLab `color-mix` evaluator). Full `npx vitest run` -> `Test Files  133 passed (133)`, `Tests  1702 passed (1702)`.
- [ ] 1.3 Self-host the fonts (D9).
  - Barlow latin 400 and 600 go in `web/public/static/fonts/` and are preloaded in `app/(index)/layout.page.tsx` with `crossorigin`, replacing the Inter preload.
  - Barlow 500/700, Barlow Condensed and JetBrains Mono go in `assets/fonts`.
  - Set the body, label and timecode font tokens, and retire the Inter face and its file. League Gothic stays for the home wordmark.
  - Test first:
    - the document has three font preloads whose `href`s equal the `@font-face` `src:` URLs;
    - no `@font-face` references Inter or `fonts.googleapis.com`;
    - every declared family is referenced in `web/src`.
  - Verify: the test passes and `npm run typecheck` is clean.
- [ ] 1.4 Add the missing shadcn components (D10).
  - Run `npx shadcn@latest add sidebar sheet toggle-group item kbd avatar` from `web/`, read every generated file, and apply the hygiene rewrite (local `cn`, no `dark:` variants).
  - In `sidebar.tsx`, replace the `document.cookie` persistence with try/catch `localStorage`, and set the preview's widths (272px expanded, 68px icon).
  - Test first: extend `primitives.smoke.test.tsx` to render each new primitive. Add a `sidebar` test asserting that toggling writes `localStorage`, never `document.cookie`, and that storage throwing defaults to expanded.
  - Verify: those tests pass, and `shadcnHygiene.repo.test.ts` passes.
- [ ] 1.5 Restyle the shared layer (`shared/components/ui/*` and `shared/ui/*`): sentence-case button labels, the control height and radius, flat surfaces, and the single selected state.
  - Test first: rewrite the shared-button vocabulary test. Default, primary and destructive variants carry the control radius and height classes, no `uppercase` class, and no glass utility. The disabled state has no hover change.
  - Verify: `npx vitest run src/shared` passes, and `shadcnHygiene.repo.test.ts` passes.

## 2. Transport status and ignition (D2)

- [ ] 2.1 Add the `pages/index/coordination/transportStatus.ts` store: publish, identity-scoped clear, subscribe.
  - Test first: `transportStatus.test.ts`.
    - Publish then read.
    - A stale owner's clear does not clear a newer publish.
    - A clear by the current owner resets to stopped.
  - Verify: the test passes.
- [ ] 2.2 `SessionWorkspace` publishes its `effectiveTransport`, mapped `audio-recording→recording`, `rolling→rolling`, `play→playback`, `stop→stopped`, with the session id and title, and clears on unmount.
  - Test first, in `SessionWorkspace.test.tsx`:
    - a lease-alive status publishes `recording`;
    - `is_rolling` without a lease publishes `rolling`;
    - unmount clears;
    - switching session ids while recording leaves the store on the new session's state.
  - Verify: the tests pass.
- [ ] 2.3 `AppShell` sets `data-transport` on the app root from the store. Add the CSS tints for the top bar, rail and transport strip, the glow, and the reduced-motion rules.
  - Test first, in `AppShell.test.tsx`: the root's `data-transport` follows the store's four states, and the attribute is `stopped` with no session open.
  - Verify: the test passes. A `grep` of `tailwind.css` shows the `prefers-reduced-motion` block covers the tint transition and the blink.
- [ ] 2.4 Browser check: agent-browser captures of the console in all four transport states (stopped, rolling, recording, playback), including with reduced motion emulated, at 1440 and 390, saved under `.impeccable/review/2/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.

## 3. Top bar (D5)

- [ ] 3.1 Build `TopBar` from shadcn parts (D10).
  - Layout: `SidebarTrigger`, then the team `DropdownMenu` (`DropdownMenuRadioGroup`, role `Badge`), then the show `DropdownMenu`, then the status `Button` with a `Badge`. One line, truncating names. No wordmark or labels.
  - Test first: `TopBar.test.tsx`.
    - It renders the team and show names.
    - The team menu lists each team with its role and show count.
    - The menus are keyboard-operable (open, arrows, Enter, Escape).
    - The status reads STOPPED, ROLLING, REC or PLAY from the store, with the session title.
    - With no session it is not actionable.
  - Verify: the tests pass.
- [ ] 3.2 Team and show switching writes `PUT /api/profile` immediately, follows the close-session path when a session is open, and invalidates `['sessions']`, `['events']`, `sessionStatusKeys.all()` and `['show-categories']`.
  - Test first:
    - choosing a team sends `{active_studio_id}` with no `active_show_id`;
    - after a switch, the four query keys are invalidated (asserted on the shared query client);
    - the show menu lists names only;
    - on `/sessions/:id` it navigates to `/`;
    - on `/teams` it does not navigate;
    - choosing a show sends `{active_show_id}`;
    - a failed write keeps the previous selection and shows the error.
  - Verify: the tests pass.
- [ ] 3.3 The status control returns to the open session's console, closing Settings if it is open.
  - Test first: with Settings open over a recording session, activating the status closes Settings and the console is shown.
  - Verify: the test passes.
- [ ] 3.4 Browser check: agent-browser captures of the top bar on `/` and on a session, both menus open, and the status in each state, at 1440 and 390, saved under `.impeccable/review/3/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.

## 4. Rail (D8)

- [ ] 4.1 Rebuild `V6Rail` on `Sidebar collapsible="icon"`: `SidebarHeader` (New session, Import), the search, `SidebarMenu` session cards with tooltips and `isActive`, and `SidebarFooter` (Settings). Remove its Teams button. A new `AppShell` listener toggles on `[`, reusing `isTypingTarget` and `isOverlayOpen` (D8, D10).
  - Test first, in `V6Rail.test.tsx`:
    - there is no Teams control;
    - on `/` with no session, `[` toggles collapsed, and it does nothing while focus is in the search input or a dialog is open;
    - the collapsed state persists across remounts, and storage that throws defaults to expanded;
    - activating collapsed search expands the rail and focuses the input (existing scenario).
  - Verify: the tests pass.
- [ ] 4.2 Browser check: agent-browser captures of the sidebar expanded and collapsed, collapsed search focusing the input, and the mobile sheet at 390, at 1440 and 390, saved under `.impeccable/review/4/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.

## 5. Console restyle and feed count (D7)

- [ ] 5.1 Derive the feed heading count from the filtered fetched set (before the `loadedLimit` slice), with a trailing `+` when the fetch was capped (D7). There is no tab count.
  - Test first: 2 logged + 8 internal reads 10, and hiding internal reads 2 in the same render; 450 events with only 200 paged in reads 450; a capped fetch reads "2000+".
  - Verify: `EventLogSheet` tests pass.
- [ ] 5.2 Restyle `MaximizeLogStrip`, `TransportControls`, `CategoryButtonStrip`, the workspace tabs and the feed toolbar into the new vocabulary, with no behaviour change. Filter, Time display and Edit become sentence case. The AUTO GENERATE no-instructions reason names "Settings › Event buttons".
  - Test first: update the AUTO GENERATE reason assertion to the new copy.
  - Verify: `npx vitest run src/pages/index` passes, with existing behaviour tests unchanged.
- [ ] 5.3 Browser check: agent-browser captures of the transport strip, logging strip, tabs and feed, and a long session showing the full count, at 1440 and 390, saved under `.impeccable/review/5/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.

## 6. Settings view shell (D3)

- [ ] 6.1 Replace `showSettings` with `settings: {section} | null` in `AppShell`.
  - Build `SettingsView` as one lazy overlay boundary with a `null` fallback and the idle prefetch. The nav is a vertical shadcn `Tabs` with `TabsContent forceMount` and `hidden`; sections are `Card`s of `Field orientation="horizontal"` rows (D10).
  - Nav groups: You › Account; Team › Members, Shows, Team details; Show › Show details, Event buttons. There is no Auto Sync or Debug.
  - Sections mount on first visit and stay mounted while open.
  - Back, Escape and the status control close it.
  - Test first: rewrite the closed-cost and deferral tests (from the `HomeSettingsModal` tests) against `SettingsView`, keeping every scenario name in the web-ui-system delta:
    - closed means not mounted and the module not fetched;
    - only the named section mounts on open;
    - reopen never mounts the previous section;
    - no Auto Sync or Debug control exists;
    - mounting a section does not arm the guard;
    - the view root is `role="dialog"` with `aria-modal="true"`, and with it open over a rolling session, pressing 1 and Space logs nothing and leaves the transport unchanged (panel critical).
  - Verify: the tests pass.
- [ ] 6.2 Route `/teams`: open Settings on Members over the home route, navigate to `/` when Settings closes on `/teams`, and delete `TeamsRoute` and its lazy boundary.
  - Test first:
    - loading `/teams` shows Settings › Members;
    - closing it lands on `/`;
    - a route change with Settings open never desynchronises;
    - a signed-out `/teams` renders login with no `/api/teams` request.
  - Verify: the tests pass, `grep -rn TeamsRoute web/src` finds no production import, and `webBoundaries.repo.test.ts` passes.
- [ ] 6.3 Build the shared `SidePanel` on shadcn `Sheet side="right"` (`SheetHeader`/`SheetTitle`/`SheetFooter`): focus-trapped, with sticky Cancel/Save, snapshot dirtiness, a `ConfirmDialog` discard guard on Cancel, Escape, the close control and a scrim click, and an error line naming a failed step.
  - Test first, in `SidePanel.test.tsx`:
    - Save is disabled until a change;
    - a dirty close prompts, and declining keeps the edits;
    - a clean close does not prompt;
    - an error stays open with the message.
  - Verify: the tests pass, and `noBrowserDialogs.repo.test.ts` passes.
- [ ] 6.4 Browser check: agent-browser captures of Settings opened from the sidebar and from `/teams`, each navigation section, and a side panel open, at 1440 and 390, saved under `.impeccable/review/6/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.

## 7. Inline sections (D4)

- [ ] 7.1 Account: first and last name and sign out, under a section save bar.
  - Test first:
    - an edit arms Save;
    - saving sends the names plus `active_studio_id` and the current `active_show_id`, and the active show is unchanged afterwards;
    - a dirty section switch prompts;
    - a member's save carries no team or show settings (team-management scenario).
  - Verify: the tests pass.
- [ ] 7.2 Show details: name, code, Suffix (Date / Episode Number, after Code) and no Next Ep, plus the shows-section loading, failed and offline states with Retry on error only. Owners and admins edit; members see disabled controls under a role notice.
  - Test first: port the suffix tests and the three shows-section state tests. Add "saving a show-detail edit without visiting Event buttons submits the same show update".
  - Verify: the tests pass.
- [ ] 7.3 Team details: rename (`PATCH /api/teams/:id`), default frame rate (merged into the team's `settings` blob, owners and admins only), create team, transfer ownership, leave, and delete team (unavailable with a reason while shows exist), each by role. Includes the no-owner notice. When rename and frame rate are both dirty, Save sends rename first, then the profile write, and stops on a failure, naming it.
  - Test first: port the owner, admin and member view assertions from the `TeamCard` tests to the role matrix in the team-management delta. Add "delete team is unavailable while the team has shows", "a frame-rate save keeps the other settings keys", and "a member sees frame rate disabled".
  - Verify: the tests pass.
- [ ] 7.4 Browser check: agent-browser captures of Account, Show details (including the failed-shows state) and Team details as owner and as member, at 1440 and 390, saved under `.impeccable/review/7/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.

## 8. Members and Shows panels (D4)

- [ ] 8.1 Members section:
  - the list is `Item` rows (`Avatar` initials, name, email, role `Badge`, access summary);
  - in the panel, role is a `ToggleGroup` and show access is `Checkbox`es in a `FieldSet`;
  - invite by email, and pending invites with revoke (owners and admins);
  - activating a member opens their panel: role (owner only, not for the owner), show access (`member` rows), remove;
  - Save sends role, then grant PUT/DELETE per changed show, then remove, and stops on a failure, naming it.
  - Test first:
    - the invite round-trip;
    - grant then revoke through the panel;
    - admin panels offer no role choice;
    - a member's view is read-only;
    - a failed grant keeps the panel open, and the role change already applied is shown.
  - Verify: the tests pass.
- [ ] 8.2 Shows section:
  - the list, with Add show opening an empty panel (`POST /api/shows`);
  - the show panel holds name, code, Suffix and who can open it (member checkboxes), saved through `show_updates` plus grant calls;
  - there is no delete control.
  - Test first: add a show; edit name and suffix; toggle a member's access; the panel has no delete; members have disabled Edit.
  - Verify: the tests pass.
- [ ] 8.3 Browser check: agent-browser captures of the Members list, a member panel, the Shows list and a show panel, as owner, admin and member, at 1440 and 390, saved under `.impeccable/review/8/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.

## 9. Event buttons (D6)

- [ ] 9.1 Event buttons section:
  - one card whose first two rows are Palette (presets) and Colours, followed by one row per button (key, name, summary, colour, Edit, instruction-bearing indicator) and Add button;
  - a "Copy from another show" card.
  - Test first:
    - the row order;
    - an option-only DROPDOWN lights the indicator;
    - a preset change arms the section save bar;
    - copy-from carries the instruction fields.
  - Verify: the tests pass.
- [ ] 9.2 Event-button panel, reusing the `EventButtonDraft` mapping:
  - name, type as a `ToggleGroup` (Button / Dropdown / Text / On-Off), colour as a `RadioGroup` of swatches from the palette;
  - Dropdown: options with needs-context and per-option instructions;
  - On/Off: labels;
  - the whole-button instruction (absent for On/Off);
  - Move up / Move down, and delete with an in-panel confirm;
  - Save writes the show's whole category array.
  - Test first: port the instruction-field scenarios from web-ui-system ("Editing an instruction arms Save", "Dropdown options carry their own instructions", "ON_OFF buttons offer no instruction field"), plus "Move up changes the key number" and "Delete needs a second click".
  - Verify: the tests pass, and `contrastTokens.test.ts` no longer regex-reads `EventButtonsTable.tsx`.
- [ ] 9.3 Browser check: agent-browser captures of the Event buttons page, a Dropdown button panel and an On/Off button panel, at 1440 and 390, saved under `.impeccable/review/9/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.

## 10. Retire the old surfaces

- [ ] 10.1 Delete `HomeSettingsModal.tsx`, `TeamCard.tsx`, the table-and-modals UI in `EventButtonsTable.tsx`, and the now-unused `EventInstructionModal` and `EventOptionsModal`. Keep any draft-mapping functions the panels reuse. Remove their tests, or move them to the new sections.
  - Test first: none new. The ported tests in groups 6 to 9 cover the behaviour.
  - Verify: `grep -rn "HomeSettingsModal\|TeamCard\|EventInstructionModal\|EventOptionsModal" web/src` finds no production reference, and the full `npx vitest run` and `npm run typecheck` pass.

## 11. Integration checks

- [ ] 11.1 Run `scripts/check-change.sh --stage hook --base origin/supabase-migration`, then the full `scripts/check-change.sh --base origin/supabase-migration`.
  - Verify: every gate reports PASS, or a SKIP the script explains.
- [ ] 11.2 Re-measure the homepage island chunk set from `react-loadable-manifest` after `npm run build -w web` (web-frontend-platform's instrument).
  - Verify: the recorded figure is no larger than the 218,401 B baseline, or the difference is explained in Evidence.
- [ ] 11.3 Visual verification on a dev stack running this checkout. This needs the owner's go-ahead to run `make dev-up` from `autologger-ui`, since `:8787` currently mounts `autologger-2`.
  - Capture desktop (1440) and mobile (390) shots into `.impeccable/review/`:
    - console in all four transport states;
    - home and login;
    - each Settings section and panel;
    - the collapsed rail.
  - Fix in one batch, then confirm with one more round.
  - Verify: the captures exist, and `impeccable detect --json` on the changed targets reports no unresolved findings.
- [ ] 11.4 Finish review and design record.
  - Run the `impeccable-finish-reviewer` with the direction contract, the captures and the preview as the critique reference, and act on its disposition.
  - Then the `impeccable-documenter` writes `DESIGN.md` and `.impeccable/design.json` from the built UI.
  - Verify: both files exist and carry the token values from `tailwind.css`.
