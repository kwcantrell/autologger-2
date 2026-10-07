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
- [x] 1.3 Self-host the fonts (D9).
  - Barlow latin 400 and 600 go in `web/public/static/fonts/` and are preloaded in `app/(index)/layout.page.tsx` with `crossorigin`, replacing the Inter preload.
  - Barlow 500/700, Barlow Condensed and JetBrains Mono go in `assets/fonts`.
  - Set the body, label and timecode font tokens, and retire the Inter face and its file. League Gothic stays for the home wordmark.
  - Test first:
    - the document has three font preloads whose `href`s equal the `@font-face` `src:` URLs;
    - no `@font-face` references Inter or `fonts.googleapis.com`;
    - every declared family is referenced in `web/src`.
  - Verify: the test passes and `npm run typecheck` is clean.
  - Evidence: test first, new `src/shared/theme/fonts.repo.test.ts`; `npx vitest run src/shared/theme/fonts.repo.test.ts` -> `Tests  4 failed | 2 passed (6)` (no Barlow faces, Inter preload and face present, no font tokens). Files from the Google Fonts CSS2 API (latin, woff2): `barlow-{400,600}-latin.woff2` in `web/public/static/fonts/`, Barlow 500/700, Barlow Condensed 500/600/700 and `jetbrains-mono-latin-var.woff2` in `assets/fonts` (Google serves byte-identical JetBrains Mono 500 and 600, so one `font-weight: 500 600` face, and the test's weight expectation was corrected to match). Inter (face and file) and Poppins (12 faces and files) deleted after their five consumers' `"Inter",var(--font-poppins)` stacks became `font-ui`; Badge takes `font-label`. Then `npx vitest run src/shared/theme/` -> `Tests  25 passed (25)`; full `npx vitest run` -> `Tests  1708 passed (1708)`; `npm run typecheck` -> exit 0, 0 `error TS`.
- [x] 1.4 Add the missing shadcn components (D10).
  - Run `npx shadcn@latest add sidebar sheet toggle-group item kbd avatar` from `web/`, read every generated file, and apply the hygiene rewrite (local `cn`, no `dark:` variants).
  - In `sidebar.tsx`, replace the `document.cookie` persistence with try/catch `localStorage`, and set the preview's widths (272px expanded, 68px icon).
  - Test first: extend `primitives.smoke.test.tsx` to render each new primitive. Add a `sidebar` test asserting that toggling writes `localStorage`, never `document.cookie`, and that storage throwing defaults to expanded.
  - Verify: those tests pass, and `shadcnHygiene.repo.test.ts` passes.
  - Evidence: test first, `npx vitest run src/shared/components/ui/primitives.smoke.test.tsx src/shared/components/ui/sidebar.test.tsx` -> both files `FAIL … Failed to resolve import "./avatar"` / `"./sidebar"`. `npx shadcn@latest add sidebar sheet toggle-group item kbd avatar --yes` (answering N to the five overwrite prompts: button, separator, tooltip, input, skeleton kept) -> created sheet, kbd, avatar, toggle, toggle-group, item, sidebar and `hooks/use-mobile.ts`; it also added the npm `cn` dependency and light/`.dark` sidebar CSS vars, all reverted (`git checkout web/package.json package-lock.json web/src/shared/theme/tailwind.css`, `node_modules/cn` removed; the 1.2 sidebar tokens stand). Hygiene rewrite: local `cn` in all seven, `dark:` folded in kbd and toggle, sheet on the `--z-dialog-*` layer, sidebar persisted via try/catch `localStorage` (`autologger:sidebar`) with 272px/68px widths and the shared `useIsMobile` (generated `use-mobile.ts` deleted). Then the same command -> `Tests  51 passed (51)` together with `src/shadcnHygiene.repo.test.ts`; `npm run typecheck` -> exit 0; `npx biome check src/shared` -> `No fixes applied`.
- [x] 1.5 Restyle the shared layer (`shared/components/ui/*` and `shared/ui/*`): sentence-case button labels, the control height and radius, flat surfaces, and the single selected state.
  - Test first: rewrite the shared-button vocabulary test. Default, primary and destructive variants carry the control radius and height classes, no `uppercase` class, and no glass utility. The disabled state has no hover change.
  - Verify: `npx vitest run src/shared` passes, and `shadcnHygiene.repo.test.ts` passes.
  - Evidence: test first, `button.test.tsx` gains the Show Ignition vocabulary block (default/outline/secondary/destructive carry `rounded-ctl` and `h-(--h-ctl)`, no `uppercase`, no glass/gradient, primary tint and red tint; `sm` at `h-(--h-sm)`; the feed-toolbar pair flat and sentence case; disabled has `disabled:pointer-events-none`/`opacity-45`/muted text and only `not-disabled:` hovers) -> `npx vitest run src/shared/components/ui/button.test.tsx` -> `Tests  7 failed | 4 passed (11)`; a smoke test for the one selected state (toggle item, menu radio item, active sidebar row; checkbox items untinted) -> `2 failed | 34 passed (36)` with the button snapshot. Restyled button, tabs, badge, card, input, textarea, select, checkbox, dropdown-menu (checked radio = selected state), toggle, sidebar menu buttons, scroll-area and `shared/ui/Popover` items onto the tokens; the button class-list snapshot was updated deliberately (`-u`, it pinned the V5 look), and the smoke test that pinned "no selected tint" on radio items was renamed to what it checks (no shadcn leftovers). Then `npx vitest run src/shared src/shadcnHygiene.repo.test.ts` -> `Test Files  26 passed (26)`, `Tests  416 passed (416)`; full `npx vitest run` -> `Test Files  135 passed (135)`, `Tests  1725 passed (1725)`; `npm run typecheck` -> exit 0; agent-browser 1440x960 capture `.impeccable/review/1/home.png`: body `Barlow`, bg `rgb(16, 18, 22)`, three preloads (Barlow 400/600, League Gothic) and Barlow, JetBrains Mono and League Gothic loaded.

## 2. Transport status and ignition (D2)

- [x] 2.1 Add the `pages/index/coordination/transportStatus.ts` store: publish, identity-scoped clear, subscribe.
  - Test first: `transportStatus.test.ts`.
    - Publish then read.
    - A stale owner's clear does not clear a newer publish.
    - A clear by the current owner resets to stopped.
  - Verify: the test passes.
  - Evidence: test first, new `src/pages/index/coordination/transportStatus.test.ts` -> `npx vitest run src/pages/index/coordination/transportStatus.test.ts` -> `Test Files  1 failed (1)` (`Cannot find module './transportStatus'`). After the import-free store (owner-token publish, identity-scoped `clearTransportStatus`, `subscribeTransportStatus`/`getTransportStatus` for `useSyncExternalStore`, equal-content publishes keep the snapshot and notify nobody; `resetTransportStatus` wired into `src/test/setup.ts` `afterEach`): same command -> `Tests  6 passed (6)`.
- [x] 2.2 `SessionWorkspace` publishes its `effectiveTransport`, mapped `audio-recording→recording`, `rolling→rolling`, `play→playback`, `stop→stopped`, with the session id and title, and clears on unmount.
  - Test first, in `SessionWorkspace.test.tsx`:
    - a lease-alive status publishes `recording`;
    - `is_rolling` without a lease publishes `rolling`;
    - unmount clears;
    - switching session ids while recording leaves the store on the new session's state.
  - Verify: the tests pass.
  - Evidence: test first, `SessionWorkspace.test.tsx` gains the "shell transport status" block (the `useSessionStatus` mock now reads a per-id map) -> `npx vitest run src/pages/index/components/SessionWorkspace.test.tsx` -> `Tests  5 failed | 21 passed (26)`. After the publish effect (deps: mapped state, `sessionId`, `status.title`; per-run owner token cleared on cleanup): same command -> `Tests  26 passed (26)`.
- [x] 2.3 `AppShell` sets `data-transport` on the app root from the store. Add the CSS tints for the top bar, rail and transport strip, the glow, and the reduced-motion rules.
  - Test first, in `AppShell.test.tsx`: the root's `data-transport` follows the store's four states, and the attribute is `stopped` with no session open.
  - Verify: the test passes. A `grep` of `tailwind.css` shows the `prefers-reduced-motion` block covers the tint transition and the blink.
  - Evidence: test first, `AppShell.test.tsx` gains "AppShell transport tint (data-transport)" -> `npx vitest run src/pages/index/AppShell.test.tsx` -> `Tests  2 failed | 32 passed (34)`. After `useSyncExternalStore` on the store's state and `data-transport` on the `.shell` root, plus the unlayered ignition block in `tailwind.css` (`#v6-rail`, `[data-slot='topbar']` for group 3, `#v5-maximize-log-strip`, `[data-slot='live-dot']` blink): same command -> `Tests  34 passed (34)`. `grep -n` of the block -> line 614 `@media (prefers-reduced-motion: reduce)` with the rail's tint transitions dropped (`width, padding` only), topbar/strip `transition: none` and live-dot `animation: none`, plus the 390 variant at line 628. Full `npx vitest run` -> `Test Files  136 passed (136)`, `Tests  1738 passed (1738)`; `npm run typecheck` -> exit 0.
- [x] 2.4 Browser check: agent-browser captures of the console in all four transport states (stopped, rolling, recording, playback), including with reduced motion emulated, at 1440 and 390, saved under `.impeccable/review/2/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.
  - Evidence: states driven through the perf-debug override (`autologger:debugSessionTransport` + its event) on session `0c8aaf43…`; `.impeccable/review/2/console-{stop,rolling,audio-recording,play}-{1440,390}.png`: root `data-transport` read `stopped`/`rolling`/`recording`/`playback`, `scrollWidth` equal to the viewport (1440, 390) in every state; stopped muted, rolling and recording with the full rail and strip tint and glow, playback the softer strip edge. `console-audio-recording-{1440,390}-reduced-motion.png` (`set media dark reduced-motion`, captured with no wait): full tint at once, computed strip `transition: none/0s`, rail `width, padding` (390: `transform`). `console-{stop,audio-recording}-390-rail-open.png`: the drawer tints; fixed here, the first cut's `box-shadow: none` dropped the stopped drawer's drop shadow (now kept). `console-rolling-1440-settings-open.png`: `data-transport` stays `rolling` with Settings open (the legacy modal covers the shell until group 6). The strip's status text stays the session status ("Stopped" under a play override, "Recording" on the lease), unchanged. Seen at 390 and not caused here (this group changes colour, shadow and transition only): the strip's marker-nav dot after `»` sits at the viewport edge, with no page scroll; left to the 5.2 strip restyle.

## 3. Top bar (D5)

- [x] 3.1 Build `TopBar` from shadcn parts (D10).
  - Layout: `SidebarTrigger`, then the team `DropdownMenu` (`DropdownMenuRadioGroup`, role `Badge`), then the show `DropdownMenu`, then the status `Button` with a `Badge`. One line, truncating names. No wordmark or labels.
  - Test first: `TopBar.test.tsx`.
    - It renders the team and show names.
    - The team menu lists each team with its role and show count.
    - The menus are keyboard-operable (open, arrows, Enter, Escape).
    - The status reads STOPPED, ROLLING, REC or PLAY from the store, with the session title.
    - With no session it is not actionable.
  - Verify: the tests pass.
  - Evidence: test first, new `src/pages/index/components/TopBar.test.tsx` -> `npx vitest run src/pages/index/components/TopBar.test.tsx` -> `Test Files  1 failed (1)`, `Tests  no tests` (no `./TopBar` module). After `TopBar.tsx` (sidebar control, team and show `DropdownMenu`s with `DropdownMenuRadioGroup` inside `DropdownMenuGroup` and `asChild` ghost `Button` triggers, role `Badge` and "N shows" from the profile's `shows[]`, status `Button` + a new `transport` `Badge` variant on `--tx-pill-*`, `data-slot='topbar'`/`'live-dot'`), the bar mounted by `AppShell` above the rail row (`--topbar-h: 52px`; rail stretches to its row; the workspace, home and loading min-heights subtract the bar): same command -> `Tests  16 passed (16)` (names with no wordmark/labels/role on the trigger; team entries with role and show count; Enter opens, ArrowDown moves, Enter chooses, Escape dismisses; STOPPED/ROLLING/REC/PLAY + title; no session reads "No session open" and is no button). Interim sidebar control: no `SidebarProvider` yet, so `TopBar` renders `SidebarTrigger` only when `useOptionalSidebar()` (a commented local addition to `sidebar.tsx`) finds one, else a ghost `PanelLeftIcon` button wired by AppShell to the existing rail (desktop: the `v6-app--rail-collapsed` body-class toggle, moved to `components/railCollapse.ts` and shared with the rail's own menu button; phones: the drawer); group 4 drops the fallback, `onToggleSidebar` and `railCollapse.ts`. The no-session phone hamburger in AppShell is removed (the top bar replaces it).
- [x] 3.2 Team and show switching writes `PUT /api/profile` immediately, follows the close-session path when a session is open, and invalidates `['sessions']`, `['events']`, `sessionStatusKeys.all()` and `['show-categories']`.
  - Test first:
    - choosing a team sends `{active_studio_id}` with no `active_show_id`;
    - after a switch, the four query keys are invalidated (asserted on the shared query client);
    - the show menu lists names only;
    - on `/sessions/:id` it navigates to `/`;
    - on `/teams` it does not navigate;
    - choosing a show sends `{active_show_id}`;
    - a failed write keeps the previous selection and shows the error.
  - Verify: the tests pass.
  - Evidence: test first, the TopBar switching block (real query client seeded with the profile, `apiFetch` mocked) plus AppShell "top bar" tests -> `npx vitest run src/pages/index/AppShell.test.tsx` -> `Tests  5 failed | 34 passed (39)` before the AppShell wiring. Team choice sends `PUT profile {"active_studio_id":"team-north"}` (no `active_show_id`) then `onCloseSession`; show choice sends `{active_studio_id: current, active_show_id}` (the server 400s without the team: `server/src/routers/profile.ts` L57 `'active_studio_id is required.'`) and does not close; `invalidateQueries` on the shared client gets `['sessions']`, `['events']`, `sessionStatusKeys.all()`, `['show-categories']`; the show menu lists names only (inaccessible shows kept); a rejected write toasts "Couldn't switch the team: …" and leaves both names and the cache unchanged. After: `npx vitest run src/pages/index/components/TopBar.test.tsx src/pages/index/AppShell.test.tsx` -> `Test Files  2 passed (2)`, `Tests  55 passed (55)` (on `/sessions/sess-1` history `['/sessions/sess-1', '/']` with the originated roll stopped once; on `/teams` history stays `['/teams']`). Full `npx vitest run` -> `Test Files  137 passed (137)`, `Tests  1759 passed (1759)` (`departureWatcher.test.tsx`'s profile mock gained `useProfileMutation`; `TopBar` keeps no bare `'show'` literal for `queryKeyFactories.repo.test.ts`); `npm run typecheck` -> exit 0.
- [x] 3.3 The status control returns to the open session's console, closing Settings if it is open.
  - Test first: with Settings open over a recording session, activating the status closes Settings and the console is shown.
  - Verify: the test passes.
  - Evidence: test first, AppShell "with Settings open over a recording session, the status closes Settings and shows the console" failed in the 5-failure run above; after `handleReturnToSession` (closes `showSettings`, navigates only when not already on that session) it passes in the 55-test run, with history unchanged at `['/sessions/sess-1']`. Note: in the browser the legacy `HomeSettingsModal` is a full-screen modal Radix `Dialog` whose overlay covers the top bar (`.impeccable/review/3/settings-open-rec-1440.png`), so the status is reachable over Settings only once group 6's `SettingsView` keeps the top bar outside its modal surface.
- [x] 3.4 Browser check: agent-browser captures of the top bar on `/` and on a session, both menus open, and the status in each state, at 1440 and 390, saved under `.impeccable/review/3/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.
  - Evidence: agent-browser `shadcn-qa` against `http://localhost:8787`, `.impeccable/review/3/`: `topbar-home-{1440,390}.png` (Team › Show › STOPPED + "No session open"; at 390 the names truncate to about 8ch and the no-session line is screen-reader only), `session-{stop,rolling,audio-recording,play}-{1440,390}.png` on `0c8aaf43…` via the perf-debug override (`data-transport` read stopped/rolling/recording/playback, pill STOPPED/ROLLING/REC/PLAY + `ATS_youtube`, bar height 52, `scrollWidth` 1440/390 in every state), `team-menu-{1440,390}.png` (Youtube Studio · 1 show · MEMBER checked, My Awesome Studio · 0 shows · OWNER, Test Team · 1 show · OWNER), `show-menu-{1440,390}.png` (names only), `sidebar-collapsed-1440.png` (rail 260 -> 64 -> 260 px from the top bar control) and `sidebar-drawer-390.png`. Keyboard in the browser: Enter on the team trigger focuses the first entry, ArrowDown moves to the next, Escape closes and refocuses the trigger. A real switch to Test Team (`team-switched-1440.png`: Test Team › Test show, the rail refetched to its sessions) was switched back; `GET /api/profile` -> `Youtube Studio` / `Autolog Test Show`. Fixed in this group: the first cut capped the trigger at 22ch of the button's 13px type, truncating "Autolog Test S…" at 1440 (now 22ch of the 15px name); at 390 the names read "Y…"/"A…" until the separators shrank to 14px, the crumb gap dropped and the no-session line went screen-reader only. Seen, not fixed here: on a session at 390 the strip's own "Open navigation" button (group 5) duplicates the top bar's control.

## 4. Rail (D8)

- [x] 4.1 Rebuild `V6Rail` on `Sidebar collapsible="icon"`: `SidebarHeader` (New session, Import), the search, `SidebarMenu` session cards with tooltips and `isActive`, and `SidebarFooter` (Settings). Remove its Teams button. A new `AppShell` listener toggles on `[`, reusing `isTypingTarget` and `isOverlayOpen` (D8, D10).
  - Test first, in `V6Rail.test.tsx`:
    - there is no Teams control;
    - on `/` with no session, `[` toggles collapsed, and it does nothing while focus is in the search input or a dialog is open;
    - the collapsed state persists across remounts, and storage that throws defaults to expanded;
    - activating collapsed search expands the rail and focuses the input (existing scenario).
  - Verify: the tests pass.
  - Evidence: test first, `V6Rail.test.tsx` rewritten for the sidebar (no Teams control, no `#v6-rail-toggle`, `#v6-rail` is the `sidebar-container`, New session/Import in `SidebarHeader`, Settings in `SidebarFooter`, cards as `SidebarMenuButton` with `data-active`/`aria-current`, persistence across remounts, throwing storage -> expanded, collapsed search expands + focuses) and `AppShell.test.tsx` gains "AppShell sidebar shortcut" (`[` on `/` with no session toggles and toggles back, with a session too, ignored in the search input, while a dialog is open and with Ctrl/⌘/Alt, persists across a remount, throwing storage -> expanded) with the rail mock reading `useSidebar()` -> `npx vitest run src/pages/index/components/V6Rail.test.tsx` -> `Tests  10 failed | 5 passed (15)`; `npx vitest run src/pages/index/AppShell.test.tsx` -> `Failed Tests 46` (`useSidebar must be used within a SidebarProvider.`). After: `SidebarProvider` is the shell root (`data-transport` on it), `SidebarShortcut` in `AppShell.tsx` (one `keydown` listener, `isTypingTarget` + `isOverlayOpen`), `V6Rail` on `Sidebar collapsible="icon"` (`id="v6-rail"`, under `--topbar-h`), `RecentSessionsList` cards as `SidebarMenuItem`/`SidebarMenuButton size="lg"`/`SidebarMenuAction` (rename, archive, restore, delete, Close session, no-access rows, live outline and status polling unchanged), `TopBar` renders `SidebarTrigger` only; `onToggleSidebar`, `handleToggleSidebar`, `railCollapse.ts`, `#v6-rail-toggle`, the Teams button and the strip's phone "Open navigation" button (purely a rail opener) with its `onOpenMobileNav` prop chain are deleted; the ignition CSS targets `#v6-rail` (border, glow) and the phone Sheet via `:root:has([data-transport=…])`. Same commands -> `Tests  15 passed (15)` and `Tests  46 passed (46)`. Found in the browser (4.2) and fixed here: the generated `hidden md:block` sidebar never showed, because the app's legacy `.hidden` is `display: none !important` (now `max-md:hidden`, commented in `sidebar.tsx`); an invisible focused tooltip swallowed the first Escape in the phone sheet (tooltips now held shut outside the icon strip) — test first: "a focused control in the expanded sidebar opens no tooltip layer" -> `Tests  1 failed | 15 skipped (16)` with the fix reverted, `Tests  16 passed (16)` with it. Test updates for removed chrome: `RecentSessionsList.test.tsx` renders in a `SidebarProvider` and pins `aria-current="page"` on the active card's button (was `aria-disabled` on the title); `TopBar.test.tsx` asserts the real trigger; the strip tests assert no "Open navigation"; the boundary-props test toggles the sidebar trigger. Full `npx vitest run` -> `Test Files  137 passed (137)`, `Tests  1771 passed (1771)`; `npm run typecheck` -> exit 0.
- [x] 4.2 Browser check: agent-browser captures of the sidebar expanded and collapsed, collapsed search focusing the input, and the mobile sheet at 390, at 1440 and 390, saved under `.impeccable/review/4/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.
  - Evidence: agent-browser `shadcn-qa` against `http://localhost:8787`, `.impeccable/review/4/`: `home-expanded-1440.png` and `session-expanded-1440.png` (rail 272px from y=52 under the top bar, main from x=272; New session + Import, search, RECENT SESSIONS cards with mono runtimes, `ATS_youtube` selected on `0c8aaf43…`, Settings + version in the footer), `home-collapsed-1440.png` / `session-collapsed-1440.png` / `session-collapsed-settings-tooltip-1440.png` (68px icon strip after a real `[` keypress, `localStorage['autologger:sidebar']` = `collapsed`; tooltips "New session", "Import", "Settings" on hover), `collapsed-search-focuses-input-1440.png` (Enter on the strip's search button -> width 272, `document.activeElement.id` = `top-bar-search`, typing filters to `ATS_youtube`; a typed `[` stays in the input and does not toggle; Escape clears), `home-card-menu-1440.png` (⋮ Rename/Archive/Delete), `session-recording-{expanded,collapsed}-1440.png` (perf-debug `audio-recording`: `data-transport` = `recording`, sidebar-inner `oklab(0.27 … -0.054)`, `#v6-rail` glow `12px 0 36px -18px`), and at 390 `home-390.png`, `home-sheet-open-390.png`, `session-390.png`, `session-sheet-open-390.png` (the top bar trigger opens the 288px Sheet; choosing a session navigates and closes it; no strip "Open navigation"), `session-recording-sheet-390.png` (the portaled Sheet takes the recording tint). `scrollWidth` = 1440 / 390 in every capture. Fixed here: the invisible desktop sidebar and the Escape-eating tooltip (see 4.1); the footer separator overran the rail by 7px (now edge to edge); the collapsed Settings icon sat left of the strip's axis (now centred). Seen, not caused here: at 390 the strip's transport row still ends at the viewport edge and the feed table scrolls inside its card (group 5). Left expanded (`autologger:sidebar` = `expanded`, perf-debug override cleared).

## 5. Console restyle and feed count (D7)

- [x] 5.1 Derive the feed heading count from the filtered fetched set (before the `loadedLimit` slice), with a trailing `+` when the fetch was capped (D7). There is no tab count.
  - Test first: 2 logged + 8 internal reads 10, and hiding internal reads 2 in the same render; 450 events with only 200 paged in reads 450; a capped fetch reads "2000+".
  - Verify: `EventLogSheet` tests pass.
  - Evidence: test first, `EventLogSheet.test.tsx` "EventLogSheet feed count" (four cases, plus the singular) -> `npx vitest run src/pages/index/components/EventLogSheet.test.tsx -t "feed count"` -> `expected '2 Events' to be '10 events'`, `expected '450 Events' to be '450 events'`, `expected '2600 Events' to be '2000+ events'`, `Tests 4 failed | 18 skipped`. One predicate (`isShown`) now feeds both the rows and `feedCount`, counted over `fetchedEvents`; "capped" is `total > fetchedEvents.length`, because `total` is the session's whole event count (`eventStore.listEvents` counts every row regardless of limit/offset), not a guess from the length. Copy is "N event(s)". -> `npx vitest run src/pages/index/components/EventLogSheet` -> `Test Files 3 passed (3)`, `Tests 66 passed (66)`; `npm run typecheck` clean. Commit `3db4d67c`.
- [x] 5.2 Restyle `MaximizeLogStrip`, `TransportControls`, `CategoryButtonStrip`, the workspace tabs and the feed toolbar into the new vocabulary, with no behaviour change. Filter, Time display and Edit become sentence case. The AUTO GENERATE no-instructions reason names "Settings › Event buttons".
  - Test first: update the AUTO GENERATE reason assertion to the new copy.
  - Verify: `npx vitest run src/pages/index` passes, with existing behaviour tests unchanged.
  - Evidence: test first, `eventGenerateLatch.test.tsx` asserts `/Settings › Event buttons/`, and the copy pins move to sentence case (`'Auto generate'` in `eventGenerateLatch`/`generateLatch`, `'Time display'` in `EventLogSheet.test.tsx`) -> `npx vitest run …eventGenerateLatch.test.tsx …generateLatch.test.tsx …EventLogSheet.test.tsx` -> `Tests 21 failed | 21 passed (42)`; after the copy change -> `Tests 42 passed (42)`. Restyle: `transport` and `log` Button variants (live action fills from `--tx-pill-*`; category colour only on the swatch, hover edge and latched/pressed tint), Kbd as the mono key cap, flat mono `TimecodeDisplay` with the live glow, flat Timeline track/zoom/marker chip and mono ticks, `TabsList variant="line"`, label-face `TableHead`, a 1.25rem count heading. At 390 the transport row wraps inside the card, the marker colour hint sits inside its button, and the feed table fits its card (12px sheet inset, no message floor). Only look pins changed: the `EventLogRow` snapshot (`max-md:max-w-[28vw]` on the message cell) and the `contrastTokens` readout locator. -> `npx vitest run src/pages/index` -> `Test Files 93 passed (93)`, `Tests 1004 passed (1004)`; full `npx vitest run` -> `Test Files 137 passed (137)`, `Tests 1775 passed (1775)`; `npx biome check web/src` clean. Commit `0b177d4e`.
- [x] 5.3 Browser check: agent-browser captures of the transport strip, logging strip, tabs and feed, and a long session showing the full count, at 1440 and 390, saved under `.impeccable/review/5/`.
  - Verify: each capture shows the intended state with no clipping, overflow or horizontal scroll, and anything wrong is fixed in this group before it is ticked.
  - Evidence: agent-browser `shadcn-qa` against `http://localhost:8787` on `0c8aaf43…`, `.impeccable/review/5/`: `console-{stopped,rolling,recording,playback}-{1440,390}.png` via the perf-debug override (`data-transport` / strip status read `stopped|Stopped`, `rolling|Rolling`, `recording|Recording`, `playback|Stopped` — the strip keeps the session truth while the top bar says PLAY), `logging-strip-recording-1440.png` and `strip-playback-1440.png` (element captures), `filter-menu-open-{1440,390}.png`, `filter-internal-hidden-menu-{1440,390}.png`, `count-internal-hidden-{1440,390}.png` ("2 events", 2 rows) and `count-internal-shown-{1440,390}.png` ("10 events", 10 rows). `scrollWidth` = 1440 / 390 in every capture; the strip ends at x=378 at 390. Fixed here before ticking: the category tiles took the control height and spilled their labels (now no size, filling the grid row), the live lane showed a scrollbar (now `overflow-visible`), and the feed table was 417px in a 293px card at 390 (now 340 in 340). Long session: no dev session in this account has more than 10 events, so the full-count case rests on the 450-row and capped unit tests (5.1); no data was created. Perf-debug override cleared (`localStorage` value `null`).

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
