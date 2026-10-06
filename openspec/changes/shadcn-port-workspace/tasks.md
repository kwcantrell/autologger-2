# Tasks

## 1. Primitives

- [x] 1.1 Theme `scroll-area` (D1).
  - Changes: `viewportRef` and `viewportClassName` (merged last), a block content wrapper, `type="hover"` with a 250 ms hide delay, a V5 thumb, and `ScrollBar` calling `preventDefault` on **mousedown**.
  - Test first, in `primitives.smoke.test.tsx`, rendering with `type="always"`:
    - (a) `viewportRef` receives the `[data-slot=scroll-area-viewport]` element.
    - (b) A `mousedown` on the scrollbar is `defaultPrevented`.
    - (c) A `pointerdown` on the scrollbar still calls the stubbed `setPointerCapture` once, so the drag is not cancelled.
    - (d) `viewportClassName` `[&>div]:!flex` wins over the default `[&>div]:!block`.
  - Verify: `npx vitest run src/shared/components/ui src/shadcnHygiene.repo.test.ts` passes.
  - Evidence: test first: smoke "scroll-area publishes its viewport through viewportRef" / "viewportClassName wins…" / "scrollbar keeps focus on mousedown but still lets Radix drag on pointerdown" (type="always"; mousedown defaultPrevented; stubbed setPointerCapture called once) -> `7 failed | 23 passed (30)` with the rest of group 1; after scroll-area (viewportRef, viewportClassName merged last, [&>div]:!block, type hover 250ms, V5 thumb, ScrollBar onMouseDown preventDefault) -> `npx vitest run src/shared/components/ui/primitives.smoke.test.tsx -t scroll` 4 passed
- [x] 1.2 Theme `table` (D1).
  - Changes: the container has no overflow. `Table` and `TableHead` take the feed table and header chrome, and `TableRow`/`TableCell` have no visual base.
  - Test first: a smoke case checking that:
    - `[data-slot=table-container]` has no `overflow-x-auto` class;
    - the table is a real `<table>` with `columnheader`/`cell` roles;
    - a bare `TableRow`/`TableCell` renders with an empty class list.
  - Verify: the smoke and hygiene tests pass.
  - Evidence: test first: "table container does not scroll; row/cell carry no visual base" -> `expected 'relative w-full overflow-x-auto' not to contain 'overflow'`; after table.tsx (container relative w-full, Table border-collapse 0.84rem, TableHead = sticky feed header + sort-button reset, TableRow/TableCell className passthrough only) -> `-t table` 2 passed
- [x] 1.3 Theme `tabs` (D1).
  - Changes: the lid chrome keyed on `data-[state=active]`.
  - Test first: a smoke case where:
    - `fireEvent.mouseDown(trigger, { button: 0 })` on the second trigger gives it `data-state="active"` and `aria-selected="true"`;
    - ArrowRight, after an awaited tick, moves focus and activation.
  - Verify: the smoke tests pass.
  - Evidence: test first: "tabs activate on mouse-down and by arrow key" (mouseDown -> data-state active/aria-selected; ArrowRight + awaited tick -> focus+selection on C; no bg-input/30) failed on the stock trigger; after tabs.tsx (TabsList row, TabsTrigger lid chrome on data-[state=active|inactive], TabsContent focus outline; tabsListVariants dropped, no users) -> `-t tabs` 2 passed
- [x] 1.4 Theme the rest of `dropdown-menu` (D1): CheckboxItem, RadioItem, Label, Separator, SubTrigger and SubContent.
  - Test first: a smoke case where a checked `DropdownMenuCheckboxItem` has `aria-checked="true"` and an indicator, and its class list has no `bg-accent` or `focus:bg-accent`. A RadioGroup item gets `role="menuitemradio"`.
  - Verify: the smoke and hygiene tests pass.
  - Evidence: test first: "dropdown checkbox and radio items: indicator, aria state, no selected tint" -> failed (rounded-sm/text-sm/focus:bg-accent); after ITEM_BASE shared by Item/CheckboxItem/RadioItem/SubTrigger with INDICATOR_SLOT, V5 Label/Separator/Shortcut/SubContent -> `npx vitest run src/shared/components/ui` 33 passed, 1 failed (glass, task 1.5)
- [x] 1.5 Add `glass` and `glass-primary` Button variants without the cva base (D1).
  - Test first:
    - Snapshot `buttonVariants()` for every existing variant × size before the refactor, and assert it is unchanged after.
    - `<Button variant="glass" disabled>` has `data-variant="glass"`, is a `<button>`, has no `disabled:pointer-events-none` and keeps `disabled:cursor-not-allowed`.
  - Verify: the smoke tests pass.
  - Evidence: test first: snapshot of buttonVariants for 6 variants x 8 sizes written on the pre-refactor primitive (`Snapshots 1 written`); "glass Button variants skip the shared base" failed; after BUTTON_BASE moved into each non-glass variant, cva base empty, glass/glass-primary = former FEED_GLASS_BTN(+_PRIMARY), size null for glass -> `npx vitest run src/shared/components/ui src/shadcnHygiene.repo.test.ts` `Tests 39 passed (39)` (snapshot unchanged); `npx tsc --noEmit` clean; biome lint clean

## 2. Feed tabs

- [x] 2.1 Port SessionWorkspace's tablist to controlled `Tabs`, with `forceMount` plus an explicit `hidden` on each `TabsContent` (D2).
  - Test first, in `SessionWorkspace.test.tsx` and `SessionWorkspace.audioClipsSeam.test.tsx`:
    - tab switches move from `fireEvent.click` to `fireEvent.mouseDown(tab, { button: 0 })`, through one shared helper;
    - new cases:
      - ArrowRight from Event Feed activates Transcript, after an awaited tick;
      - each tab's `aria-controls` equals its panel's `id`;
      - inactive panels have the `hidden` attribute;
      - panel nodes keep their identity (`toBe`) across switches.
  - Verify: `npx vitest run src/pages/index/components/SessionWorkspace*` passes, including the words-gate and Dashboards cases.
  - Evidence: test first: 31 tab switches moved to a clickTab helper (fireEvent.mouseDown button 0) + new "feed tabs: arrow keys move activation, tabs control their panels, inactive panels are hidden" (aria-controls -> tabpanel, hidden iff unselected, ArrowRight activates+focuses Transcript, event panel same node and hidden) -> on the hand-built tablist `16 failed | 17 passed (33)`; after controlled Tabs/TabsList aria-label "Feed tabs"/TabsTrigger + TabsContent forceMount with explicit hidden, panels still the sessionId-memoised feedPanels -> `npx vitest run src/pages/index/components/SessionWorkspace` `Tests 33 passed (33)`; full `npx vitest run` `Test Files 122 passed (122) Tests 1540 passed (1540)`; tsc clean

## 3. Tables, scrolling and OverlayScrollbars removal

- [x] 3.1 Port `FeedTable` onto `ScrollArea` and the `Table` parts (D3).
  - Test first: a new `FeedTable.test.tsx` covering:
    - a callback `scrollRef` receives the scroll viewport element;
    - a `columnheader` with `aria-sort` is still sortable by its button;
    - the loading and empty rows render.
  - Verify: `npx vitest run src/pages/index/components/FeedTable.test.tsx src/pages/index/components/EventLogSheet* src/pages/index/components/TranscribeFeed* src/pages/index/components/TopicsFeed* src/pages/index/components/JumpToTimeButton.test.tsx src/pages/index/components/feedRowSeek* src/pages/index/utils/revealEventInFeed.test.ts` passes. The virtualization, reveal, drafts and jump suites stay unchanged.
  - Evidence: test first: new `FeedTable.test.tsx` (callback scrollRef receives [data-slot=scroll-area-viewport] containing the table; columnheader aria-sort descending + data-slot table-head, sort button calls onSort; loading row XOR empty row) -> on OverlayScrollbars `2 failed | 1 passed (3)`; after FeedTable on ScrollArea (viewportRef=scrollRef, mobile 70dvh cap on the viewport) + Table/TableHeader/TableRow/TableHead/TableBody/TableCell (FEED_TH chrome now the TableHead base) -> FeedTable + EventLogSheet* + TranscribeFeed* + TopicsFeed* + JumpToTimeButton + feedRowSeek* + revealEventInFeed + eventGenerateLatch + generateLatch + feedSortDefaults `Test Files 14 passed (14) Tests 93 passed (93)` (virtualization/reveal/drafts/jump suites unchanged); tsc clean
- [x] 3.2 Port `EventLogRow`, `TranscribeRow`, `TopicsRow` and the spacer and sentinel rows onto `TableRow`/`TableCell` (D3).
  - Test first:
    - row tests assert `data-slot="table-row"` on `tr[data-event-id]` and `data-slot="table-cell"` on the transcript and topic cells;
    - for one representative cell per row component, the rendered `className` token set equals the pre-port set, captured before the port.
  - Verify: the row suites and the 3.1 set pass. The row height is checked in 6.1.
  - Evidence: test first: EventLogRow/TranscribeRow/TopicsRow "is a table-row of table-cells with unchanged cell classes" (data-slot table-row/table-cell + snapshot of row+cell classNames written against the raw <tr>/<td> markup) -> `3 failed | 73 passed (76)`, `Snapshots 3 written`; after the three rows plus the EventLogSheet spacer/sentinel and TranscribeFeed spacer rows on TableRow/TableCell (21+10+12 tags; primitives have no visual base) -> snapshots unchanged; full `npx vitest run` `Test Files 123 passed (123) Tests 1546 passed (1546)`; tsc clean. Row height is measured in 6.1
- [x] 3.3 Port `#session-list` and `#archived-list` to `ScrollArea` (D4), uninstall `overlayscrollbars` and `overlayscrollbars-react`, and remove their CSS imports, the `.os-rail-sessions` CSS, the test mocks and stale comments (D7).
  - Test first: a `shadcnHygiene.repo.test.ts` case where no file imports `overlayscrollbars` and `web/package.json` doesn't list it. It fails before the removal.
  - Also update the stale OverlayScrollbars comments in `EventLogSheet.tsx`, `TranscribeFeed.tsx` and `EventLogSheet.virtualization.test.tsx`.
  - Verify: `RecentSessionsList`, `V6Rail` and hygiene pass, `grep -rni overlayscrollbars web/src web/package.json` prints nothing, and `make dev-up` rebuilds the image.
  - Evidence: test first: hygiene "OverlayScrollbars stays removed" (no import of overlayscrollbars*, not in web/package.json deps) -> `1 failed` (`app/(admin)/layout.page.tsx:4 import 'overlayscrollbars/overlayscrollbars.css'`); after #session-list/#archived-list on ScrollArea (ids kept, viewportClassName [&>div]:!flex flex-col gap-[0.45rem]), `npm uninstall -w web overlayscrollbars overlayscrollbars-react`, both layout CSS imports + .os-rail-sessions CSS + RecentSessionsList/V6Rail mocks removed, stale comments in AppShell/SessionRoute/EventLogSheet/TranscribeFeed/virtualization test updated -> full `npx vitest run` `Test Files 123 passed (123) Tests 1547 passed (1547)`; `grep -c overlayscrollbars package-lock.json` -> 0; `grep -rni overlayscrollbars web/src web/package.json` -> only the hygiene guard and two explanatory comments (scroll-area.tsx history, (index) layout note); tsc clean; `make dev-up` -> containers Healthy, `dev app: http://127.0.0.1:8787`

## 4. Feed menus

- [x] 4.1 Time display becomes a `DropdownMenu` with a `RadioGroup` (D5).
  - Test first: new `EventLogSheet.test.tsx` cases:
    - opening the "Time Display" trigger by keyboard shows a `menu` named "Time display" with `menuitemradio`s "Session Time" (checked) and "World Clock";
    - choosing World Clock closes the menu and checks `#view-utc-log`.
  - Verify: `npx vitest run src/pages/index/components/EventLogSheet.test.tsx` passes.
  - Evidence: test first: "opens by keyboard as a radio menu and switches the time display" (trigger aria-haspopup menu; Enter opens role=menu; menuitemradio Session Time checked / World Clock unchecked; choosing World Clock closes the menu and checks #view-utc-log) -> on the Popover `Unable to find role="menu"`; after TimeDisplayDropdown = DropdownMenu + RadioGroup (value session|world) on a glass Button trigger -> passes; menus are named by their trigger (Radix aria-labelledby; design D5 note)
- [x] 4.2 Filter becomes a `DropdownMenu` with `CheckboxItem`s that stay open (D5).
  - Test first: rewrite `EventLogSheet.test.tsx:246-268`'s class and `span.flex` assertions as behaviour:
    - `menuitemcheckbox` with `aria-checked`;
    - `filter-check` only when checked;
    - the menu is still open after a toggle;
    - the label keeps the category colour.
  - Keep the hide-rows cases (:270-326) and the batch-mode Escape case (:328, A5).
  - Verify: the EventLogSheet suites pass.
  - Evidence: test first: filter test rewritten to behaviour (menuitemcheckbox aria-checked, filter-check only when checked, menu still open after a toggle, label color rgb(68, 136, 255), Internal toggles #show-internal-log) + "Escape in an open menu closes the menu without arming the discard dialog" (A5) -> `4 failed | 5 passed (9)`; after FilterDropdown = DropdownMenuCheckboxItem (onSelect preventDefault, new primitive `indicator` prop -> lucide Check data-testid filter-check) -> `npx vitest run src/pages/index/components/EventLogSheet.test.tsx` passes incl. hide-rows and batch-mode Escape cases
- [x] 4.3 Auto generate becomes a non-modal `DropdownMenu` (D5).
  - Test first: `eventGenerateLatch.test.tsx`'s `startGenerate` opens with `pointerDown`/keyboard. New: while unavailable, pointer-down and Enter on the trigger don't open a `menu`.
  - Verify: `npx vitest run src/pages/index/components/eventGenerateLatch.test.tsx src/pages/index/components/generateLatch.test.tsx` passes, including Custom → the "Custom event generation" dialog.
  - Evidence: test first: eventGenerateLatch open helper -> pointerDown (7 call sites) + latched case "openMenu(latched); keyDown Enter -> no role=menu" -> all failing on the Popover trigger; after generateControl = DropdownMenu modal={false}, controlled open gated on !unavailable && !pending, glass Button trigger with aria-disabled/aria-describedby + preventDefault on pointerdown/keydown/click while unavailable, DropdownMenuItem onSelect -> `npx vitest run eventGenerateLatch generateLatch EventLogSheet.test` `Tests 27 passed (27)` (incl. Custom -> "Custom event generation" dialog); full `npx vitest run` `Test Files 123 passed (123) Tests 1549 passed (1549)`; tsc clean

## 5. Toolbars and icons

- [x] 5.1 Change `feedToolbarCaption` icons to lucide aliases, and move `GenerateToolbar`, the EventLogSheet toolbar, `AiV2Panel` and `useSseTurn` to `Button variant="glass"`/`"glass-primary"` (D1, D6). Delete `FEED_GLASS_BTN*`.
  - Test first: a `GenerateToolbar` case where the default trigger has `data-variant="glass"` and its icon is `svg.lucide-sparkles`, and `grep -rn FEED_GLASS_BTN web/src` returns 0 lines.
  - Verify: the generate, AiV2Panel and Assistant suites pass.
  - Evidence: test first: generateLatch "toolbar buttons are glass Buttons with lucide icons" (Auto Generate + Insert data-variant glass, svg.lucide-sparkles / svg.lucide-plus) for transcribe + topics -> `2 failed | 5 passed (7)`; after feedToolbarCaption Icon* = lucide aliases (Sparkles/Plus/Pencil/Check/X/Clock/Filter/Download/Pin/Trash2) and every FEED_GLASS_BTN(+_PRIMARY) button in GenerateToolbar, EventLogSheet, AiV2Panel, useSseTurn -> Button variant glass/glass-primary; constants deleted from FeedTable -> full `npx vitest run` `Test Files 123 passed (123) Tests 1551 passed (1551)`; `grep -rn FEED_GLASS_BTN web/src` -> 1 line (the history comment in button.tsx); tsc + biome clean
- [x] 5.2 `ExportFeed` uses `Button`/`Button asChild` (D6).
  - Test first: in `ExportFeed.test.tsx`, the CSV link is still an `<a>` with `download` and `data-slot="button"`.
  - Verify: `ExportFeed.test.tsx` passes.
  - Evidence: test first: ExportFeed "server-side exports stay links" extended (Event feed CSV is an <a download> with data-slot button + data-variant default; JSONL outline; Transcript/Topics buttons data-slot button / default) -> `1 failed | 2 passed (3)`; after Button (default) for the three CSVs, Button asChild around both <a download>, JSONL variant outline, legacy `tool-row export-row` -> `mt-3 flex max-w-md flex-col items-stretch gap-2` (export-row margin-top 0.75rem kept) -> `npx vitest run src/pages/index/components/ExportFeed.test.tsx` `Tests 3 passed (3)`; tsc clean
- [x] 5.3 `EventLogRow` UNDELETE becomes `Button` and trash becomes `Trash2`; `JumpToTimeButton` play becomes `Play`; `MaximizeLogStrip` hamburger becomes `Menu` (D6).
  - Test first:
    - `JumpToTimeButton.test.tsx` asserts `svg.lucide-play`, and keeps its native-button and `aria-disabled`-without-`disabled` cases;
    - `EventLogRow.test.tsx` asserts UNDELETE has `data-slot="button"`.
  - Verify: those suites and `MaximizeLogStrip.test.tsx` pass.
  - Evidence: test first: JumpToTimeButton "draws the lucide play glyph" (svg.lucide-play aria-hidden inside the native button), MaximizeLogStrip "Open navigation draws the lucide menu glyph", EventLogRow "Delete row draws the lucide trash glyph" + "UNDELETE is an outline Button named Restore row" (data-variant outline, data-size xs; data-slot is the Tooltip trigger's) -> `4 failed | 43 passed (47)`; after lucide Play (fill currentColor, size-3; button stays native aria-disabled), Menu (size-5), Trash2 (size-3), UNDELETE -> Button outline xs -> those suites `Tests 47 passed (47)` incl. the native-button / aria-disabled-without-disabled / shared reason id cases; full `npx vitest run` `Test Files 123 passed (123) Tests 1555 passed (1555)`; tsc clean

## 5b. Internal-event colour (added after the QA walk; re-panelled)

- [x] 5.4 Add `shared/utils/categoryColor.ts` `resolveCategoryColor` and route every `category_color` reader through it: EventLogRow, TimelineMarkers, Timeline (×3), MarkerNav (D8).
  - Test first:
    - `categoryColor.test.ts`: the three bare tokens map to `--legacy-*`, whitespace-tolerant; hex and other `var()`s pass through; empty and null give `undefined`;
    - EventLogRow: an internal row with `category_color: 'var(--muted)'` renders its category cell with inline `color: var(--legacy-muted)`;
    - TimelineMarkers: that event's marker has `--mcol: var(--legacy-muted)`.
  - Verify: those suites and `src/shadcnHygiene.repo.test.ts` pass (the helper holds no literal bare-token `var()` string), and `grep -rn "category_color" web/src --include=*.tsx | grep -v test` shows every read wrapped.
  - Evidence: test first: new categoryColor.test.ts (3 bare tokens -> --legacy-*, whitespace-tolerant, hex/other var() pass through, empty/null -> undefined), new timeline/TimelineMarkers.test.tsx (internal --mcol var(--legacy-muted), hex passthrough), EventLogRow internal row colour -> `Cannot find module './categoryColor'` + `2 failed | 34 passed (36)`; after shared/utils/categoryColor.ts (pattern match, template-built replacement, no literal) routed through EventLogRow, TimelineMarkers, Timeline x3, MarkerNav -> those + shadcnHygiene + MarkerNav + Timeline* `Tests 54 passed (54)`; full `npx vitest run` `Test Files 125 passed (125) Tests 1561 passed (1561)`; every non-test `category_color` read wrapped (grep: MarkerNav:125, EventLogRow:317, Timeline:409/705/766, TimelineMarkers:66); live dev stack internal-row computed colour `rgb(154, 160, 166)` (was rgba(255,255,255,0.06))

## 6. Integration: QA gate and checks

- [ ] 6.1 Copy the walk from `openspec/changes/archive/2026-10-06-shadcn-port-shell/qa/` and add steps for:
  - feed tabs by keyboard;
  - the Time display, Filter and Auto generate menus open;
  - Transcript, Topics and Export tabs;
  - a scrolled event feed with the sticky header visible;
  - reveal-in-feed from a timeline marker;
  - an eval of event-row height (A6, must be ≤ 31px);
  - the `reveal-in-feed` screen on a session with internal events, with 0 contrast failures on the Internal rows (D8);
  - at 390×844, an eval that the event feed viewport scrolls (`clientHeight < scrollHeight`) and mounts fewer than all rows;
  - an eval that focusing an inline-edit input and dispatching a real mousedown on the feed scrollbar leaves the input focused.

  Run the 1440×900 and 390×844 passes against the archived `after-shell` captures.
  - Verify: contrast shows 0 failures apart from the user-data "Audio issue", and the row height and per-screen diffs are recorded in `qa/README.md`.
- [ ] 6.2 The owner reviews the pairs and does a dev-stack pass:
  - drag the feed scrollbar during an inline edit (the caret stays);
  - the Filter menu by keyboard;
  - Auto generate → Custom;
  - the rail lists scroll.
  - Verify: the result is recorded in `qa/README.md`.
- [ ] 6.3 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh` and `openspec validate shadcn-port-workspace --strict`.
  - Verify: every gate passes. The storage "8 contending" flake is re-run, not counted.
