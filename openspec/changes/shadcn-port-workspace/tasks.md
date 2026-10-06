# Tasks

## 1. Primitives

- [ ] 1.1 Theme `scroll-area` (D1).
  - Changes: `viewportRef` and `viewportClassName` (merged last), a block content wrapper, `type="hover"` with a 250 ms hide delay, a V5 thumb, and `ScrollBar` calling `preventDefault` on **mousedown**.
  - Test first, in `primitives.smoke.test.tsx`, rendering with `type="always"`:
    - (a) `viewportRef` receives the `[data-slot=scroll-area-viewport]` element.
    - (b) A `mousedown` on the scrollbar is `defaultPrevented`.
    - (c) A `pointerdown` on the scrollbar still calls the stubbed `setPointerCapture` once, so the drag is not cancelled.
    - (d) `viewportClassName` `[&>div]:!flex` wins over the default `[&>div]:!block`.
  - Verify: `npx vitest run src/shared/components/ui src/shadcnHygiene.repo.test.ts` passes.
- [ ] 1.2 Theme `table` (D1).
  - Changes: the container has no overflow. `Table` and `TableHead` take the feed table and header chrome, and `TableRow`/`TableCell` have no visual base.
  - Test first: a smoke case checking that:
    - `[data-slot=table-container]` has no `overflow-x-auto` class;
    - the table is a real `<table>` with `columnheader`/`cell` roles;
    - a bare `TableRow`/`TableCell` renders with an empty class list.
  - Verify: the smoke and hygiene tests pass.
- [ ] 1.3 Theme `tabs` (D1).
  - Changes: the lid chrome keyed on `data-[state=active]`.
  - Test first: a smoke case where:
    - `fireEvent.mouseDown(trigger, { button: 0 })` on the second trigger gives it `data-state="active"` and `aria-selected="true"`;
    - ArrowRight, after an awaited tick, moves focus and activation.
  - Verify: the smoke tests pass.
- [ ] 1.4 Theme the rest of `dropdown-menu` (D1): CheckboxItem, RadioItem, Label, Separator, SubTrigger and SubContent.
  - Test first: a smoke case where a checked `DropdownMenuCheckboxItem` has `aria-checked="true"` and an indicator, and its class list has no `bg-accent` or `focus:bg-accent`. A RadioGroup item gets `role="menuitemradio"`.
  - Verify: the smoke and hygiene tests pass.
- [ ] 1.5 Add `glass` and `glass-primary` Button variants without the cva base (D1).
  - Test first:
    - Snapshot `buttonVariants()` for every existing variant × size before the refactor, and assert it is unchanged after.
    - `<Button variant="glass" disabled>` has `data-variant="glass"`, is a `<button>`, has no `disabled:pointer-events-none` and keeps `disabled:cursor-not-allowed`.
  - Verify: the smoke tests pass.

## 2. Feed tabs

- [ ] 2.1 Port SessionWorkspace's tablist to controlled `Tabs`, with `forceMount` plus an explicit `hidden` on each `TabsContent` (D2).
  - Test first, in `SessionWorkspace.test.tsx` and `SessionWorkspace.audioClipsSeam.test.tsx`:
    - tab switches move from `fireEvent.click` to `fireEvent.mouseDown(tab, { button: 0 })`, through one shared helper;
    - new cases:
      - ArrowRight from Event Feed activates Transcript, after an awaited tick;
      - each tab's `aria-controls` equals its panel's `id`;
      - inactive panels have the `hidden` attribute;
      - panel nodes keep their identity (`toBe`) across switches.
  - Verify: `npx vitest run src/pages/index/components/SessionWorkspace*` passes, including the words-gate and Dashboards cases.

## 3. Tables, scrolling and OverlayScrollbars removal

- [ ] 3.1 Port `FeedTable` onto `ScrollArea` and the `Table` parts (D3).
  - Test first: a new `FeedTable.test.tsx` covering:
    - a callback `scrollRef` receives the scroll viewport element;
    - a `columnheader` with `aria-sort` is still sortable by its button;
    - the loading and empty rows render.
  - Verify: `npx vitest run src/pages/index/components/FeedTable.test.tsx src/pages/index/components/EventLogSheet* src/pages/index/components/TranscribeFeed* src/pages/index/components/TopicsFeed* src/pages/index/components/JumpToTimeButton.test.tsx src/pages/index/components/feedRowSeek* src/pages/index/utils/revealEventInFeed.test.ts` passes. The virtualization, reveal, drafts and jump suites stay unchanged.
- [ ] 3.2 Port `EventLogRow`, `TranscribeRow`, `TopicsRow` and the spacer and sentinel rows onto `TableRow`/`TableCell` (D3).
  - Test first:
    - row tests assert `data-slot="table-row"` on `tr[data-event-id]` and `data-slot="table-cell"` on the transcript and topic cells;
    - for one representative cell per row component, the rendered `className` token set equals the pre-port set, captured before the port.
  - Verify: the row suites and the 3.1 set pass. The row height is checked in 6.1.
- [ ] 3.3 Port `#session-list` and `#archived-list` to `ScrollArea` (D4), uninstall `overlayscrollbars` and `overlayscrollbars-react`, and remove their CSS imports, the `.os-rail-sessions` CSS, the test mocks and stale comments (D7).
  - Test first: a `shadcnHygiene.repo.test.ts` case where no file imports `overlayscrollbars` and `web/package.json` doesn't list it. It fails before the removal.
  - Also update the stale OverlayScrollbars comments in `EventLogSheet.tsx`, `TranscribeFeed.tsx` and `EventLogSheet.virtualization.test.tsx`.
  - Verify: `RecentSessionsList`, `V6Rail` and hygiene pass, `grep -rni overlayscrollbars web/src web/package.json` prints nothing, and `make dev-up` rebuilds the image.

## 4. Feed menus

- [ ] 4.1 Time display becomes a `DropdownMenu` with a `RadioGroup` (D5).
  - Test first: new `EventLogSheet.test.tsx` cases:
    - opening the "Time Display" trigger by keyboard shows a `menu` named "Time display" with `menuitemradio`s "Session Time" (checked) and "World Clock";
    - choosing World Clock closes the menu and checks `#view-utc-log`.
  - Verify: `npx vitest run src/pages/index/components/EventLogSheet.test.tsx` passes.
- [ ] 4.2 Filter becomes a `DropdownMenu` with `CheckboxItem`s that stay open (D5).
  - Test first: rewrite `EventLogSheet.test.tsx:246-268`'s class and `span.flex` assertions as behaviour:
    - `menuitemcheckbox` with `aria-checked`;
    - `filter-check` only when checked;
    - the menu is still open after a toggle;
    - the label keeps the category colour.
  - Keep the hide-rows cases (:270-326) and the batch-mode Escape case (:328, A5).
  - Verify: the EventLogSheet suites pass.
- [ ] 4.3 Auto generate becomes a non-modal `DropdownMenu` (D5).
  - Test first: `eventGenerateLatch.test.tsx`'s `startGenerate` opens with `pointerDown`/keyboard. New: while unavailable, pointer-down and Enter on the trigger don't open a `menu`.
  - Verify: `npx vitest run src/pages/index/components/eventGenerateLatch.test.tsx src/pages/index/components/generateLatch.test.tsx` passes, including Custom → the "Custom event generation" dialog.

## 5. Toolbars and icons

- [ ] 5.1 Change `feedToolbarCaption` icons to lucide aliases, and move `GenerateToolbar`, the EventLogSheet toolbar, `AiV2Panel` and `useSseTurn` to `Button variant="glass"`/`"glass-primary"` (D1, D6). Delete `FEED_GLASS_BTN*`.
  - Test first: a `GenerateToolbar` case where the default trigger has `data-variant="glass"` and its icon is `svg.lucide-sparkles`, and `grep -rn FEED_GLASS_BTN web/src` returns 0 lines.
  - Verify: the generate, AiV2Panel and Assistant suites pass.
- [ ] 5.2 `ExportFeed` uses `Button`/`Button asChild` (D6).
  - Test first: in `ExportFeed.test.tsx`, the CSV link is still an `<a>` with `download` and `data-slot="button"`.
  - Verify: `ExportFeed.test.tsx` passes.
- [ ] 5.3 `EventLogRow` UNDELETE becomes `Button` and trash becomes `Trash2`; `JumpToTimeButton` play becomes `Play`; `MaximizeLogStrip` hamburger becomes `Menu` (D6).
  - Test first:
    - `JumpToTimeButton.test.tsx` asserts `svg.lucide-play`, and keeps its native-button and `aria-disabled`-without-`disabled` cases;
    - `EventLogRow.test.tsx` asserts UNDELETE has `data-slot="button"`.
  - Verify: those suites and `MaximizeLogStrip.test.tsx` pass.

## 6. Integration: QA gate and checks

- [ ] 6.1 Copy the walk from `openspec/changes/archive/2026-10-06-shadcn-port-shell/qa/` and add steps for:
  - feed tabs by keyboard;
  - the Time display, Filter and Auto generate menus open;
  - Transcript, Topics and Export tabs;
  - a scrolled event feed with the sticky header visible;
  - reveal-in-feed from a timeline marker;
  - an eval of event-row height (A6, must be ≤ 31px);
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
