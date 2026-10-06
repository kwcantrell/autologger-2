# Design: shadcn port, workspace

## Context

The motivation is in proposal.md. This is the state on 2026-10-06, taken from a three-agent read-only survey:

**Tabs.** `SessionWorkspace.tsx:527-578` renders a hand-built `role="tablist"` (`aria-label="Feed tabs"`) with six `<button role="tab">`s, and six `role="tabpanel"` divs that stay mounted and toggle the `hidden` attribute.
- There are no ids, no `aria-controls` and no arrow keys.
- The tab chrome is `feedTabButtonClassName(active)` in `feedTabStyles.ts`, which `HomeSettingsModal` also uses (it is ported in 3c).

**Tables.** `FeedTable.tsx` wraps a real `<table>` (with colgroup, a sticky `FEED_TH` header, and `aria-sort` header buttons) in `OverlayScrollbarsComponent`.
- It publishes the OverlayScrollbars viewport through `scrollRef`.
- `EventLogSheet` and `TranscribeFeed` hold that element in `useState` and pass it to `useVirtualizer`. Both use `ROW_HEIGHT = 31`, `overscan = 10`, and top and bottom spacer `<tr>`s.
- `TopicsFeed` is not virtualized.
- The rows are `EventLogRow` (`tr[data-event-id].group`, with its own `CELL_*` classes), `TranscribeRow` and `TopicsRow` (`FEED_ROW`/`FEED_CELL`).

**Scrolling.** Rail `#session-list` and `#archived-list` also use OverlayScrollbars, with `.os-rail-sessions` CSS for the flex-column gap. The dependency pair is imported in `FeedTable`, `RecentSessionsList` and both `layout.page.tsx` files.

**Menus.** The three feed menus are local components in `EventLogSheet.tsx` (`TimeDisplayDropdown` :189, `FilterDropdown` :241, `generateControl` :1031) on `Popover`/`PopoverItem`.
- Time display has no tests.
- The Filter tests (`EventLogSheet.test.tsx:246-268`) assert class strings and a `span.flex` inline colour.
- The Auto generate tests (`eventGenerateLatch.test.tsx`) use roles and `aria-disabled`.

**Glass buttons.** `FEED_GLASS_BTN`/`_PRIMARY` (`FeedTable.tsx:55,59`) are imported by `EventLogSheet`, `GenerateToolbar`, `AiV2Panel` and `useSseTurn`.

**Memo fence.** `web-ui-system` "The playback tick is fenced at named memo boundaries" requires the six panels to be `memo()`'d with `sessionId` as their only prop, and the panel map to be `useMemo`'d on `sessionId`. The tablist and the tabpanel wrappers re-render every frame by design.

## Goals / Non-Goals

**Goals:**
- Every listed surface renders through the shared shadcn layer, keeping the same ids, names, roles and V5 look.
- OverlayScrollbars is gone from the dependency graph.

**Non-Goals:** see proposal.md. The design adds two boundaries:
- No change to virtualization math or the row-height constant.
- No new props on any memo-fenced panel.

## Decisions

### D1. Primitives are themed by replacing their base strings (as in change 2 D1 and 3a D1)

**`tabs`**
- `TabsList` gets the tablist row classes (`flex min-w-0 flex-1 flex-nowrap items-end gap-[0.12rem]`).
- `TabsTrigger` gets the lid chrome from `feedTabButtonClassName`, with the `active` boolean branches rewritten as `data-[state=active]:` variants.
- `feedTabStyles.ts` stays for HomeSettingsModal until 3c.
- Its test asserts that an active trigger carries `data-state="active"`, not classes.

**`table`**
- `TableContainer` (`data-slot="table-container"`) becomes `relative w-full`, with **no `overflow-x-auto`**. An overflow container is a scroll container, so it would become the sticky `<th>`'s containing scrollport and the header would stop sticking to the ScrollArea viewport.
- Base strings:
  - `Table` = `w-full border-collapse text-[0.84rem]`;
  - `TableHead` = `FEED_TH` + `FEED_TH_BUTTON`. The app has one header vocabulary.
  - **`TableRow` and `TableCell` carry no visual base** (structure and `data-slot` only). The app has two cell vocabularies:
    - the transcript and topic rows use `FEED_ROW`/`FEED_CELL`;
    - the event rows use their own `CELL_*`, with a per-cell hover tint that edit cells must not take.

    A `FEED_CELL` base would leak `text-legacy-muted` into the event feed's jump, category and message cells. A `FEED_ROW` base would stack a row hover tint over `CELL_HOVER`. Each caller therefore keeps passing its own constants, as today (panel finding).
- `FeedTable` keeps exporting the `FEED_ROW`/`FEED_CELL*` constants.

**`scroll-area`**
- `ScrollArea` gains `viewportRef?: Ref<HTMLDivElement>` (Radix `ScrollAreaViewport` is a `forwardRef`) and `viewportClassName`.
- The viewport's direct child gets `[&>div]:!block`, overriding Radix's inline `display:table; min-width:100%` wrapper. A `display:table` wrapper sizes to content and defeats `w-full` tables and flex-column children.
- `type="hover"` with `scrollHideDelay={250}`, matching OverlayScrollbars' `autoHide:'leave', autoHideDelay:250`.
- The thumb is styled as a V5 light rail, approximating `os-theme-light`.
- **`ScrollBar` calls `preventDefault()` on `mousedown`, not `pointerdown`.** OverlayScrollbars' handle and track kept focus in an inline-edit input while the operator dragged the scrollbar. `EventLogSheet.tsx:527-594`'s abandonment logic is written around that behaviour. Radix's scrollbar doesn't keep focus, so dragging would blur the input.
  - Focus moves as the default action of `mousedown`. Preventing it there keeps focus where it is.
  - **It must not be `pointerdown`.** `composeEventHandlers(props.onPointerDown, radixHandler)` runs ours first and skips Radix's when `defaultPrevented` is set. That would cancel `setPointerCapture` and the drag (panel critical finding).
  - Radix composes no `onMouseDown` on the scrollbar, so the drag is unaffected.
  - Tests render with `type="always"` so the bar exists in jsdom:
    - (a) a `mousedown` on the scrollbar is `defaultPrevented`;
    - (b) a `pointerdown` still reaches Radix: `setPointerCapture` is stubbed and called once.

    jsdom doesn't move focus on mousedown, so the focus-kept half is checked in the browser instead: the owner's dev-stack pass (6.2) and a QA eval.
- **Sizing lives on the viewport.** Radix's viewport is `size-full` (`height:100%`). A percentage height doesn't resolve against an auto-height root that is only capped by `max-height`, so on mobile the viewport would grow to its content and never scroll. The virtualizer would then mount every row (panel finding).
  - Callers that cap height with `max-h` put it on the viewport via `viewportClassName`. The root keeps only its flex sizing.
  - FeedTable on mobile: root `max-md:flex-[0_0_auto]`, viewport `max-md:h-auto max-md:max-h-[70dvh]`.
  - QA at 390×844 asserts the event feed's viewport has `clientHeight < scrollHeight` and that fewer than all rows are mounted.

**`dropdown-menu`**
- `CheckboxItem` and `RadioItem` get the `DropdownMenuItem` V5 base, plus a left indicator slot: lucide `Check` for checkbox and a filled dot for radio.
- Checked items get **no** background or text tint, per the Event filter checkmarks delta.
- `Label`, `Separator`, `SubTrigger` and `SubContent` are themed the same way.

**`button`**
- New `glass` and `glass-primary` variants carry `FEED_GLASS_BTN` and `FEED_GLASS_BTN` + `_PRIMARY` verbatim, mobile sizing included.
- **The cva base string doesn't apply to them.** Its `disabled:pointer-events-none`, `disabled:text-muted-foreground` and `disabled:bg/border/shadow` utilities would survive the merge. They would restyle disabled glass buttons and kill the disabled Edit button's explanatory `title` and `cursor-not-allowed` (panel finding).
  - The cva base becomes empty, and the shared base moves into a `BUTTON_BASE` constant included in each non-glass variant string.
  - The size cva emits nothing for glass, because the variant owns its padding and height.
  - Test: a disabled `glass` button's class list has no `disabled:pointer-events-none` and keeps `disabled:cursor-not-allowed`, and existing variants still render the same class list as before (snapshot of `buttonVariants()` for every non-glass variant and size, taken before the refactor).
- The `FEED_GLASS_BTN*` constants are deleted once nothing imports them.

### D2. Feed tabs on controlled Radix Tabs

```tsx
<Tabs value={feedTab} onValueChange={(v) => setFeedTab(v as FeedTabId)}>
  <TabsList aria-label="Feed tabs">{FEED_TABS.map(t => <TabsTrigger value={t.id}>…)}</TabsList>
  {FEED_TABS.map(t => <TabsContent value={t.id} forceMount hidden={feedTab !== t.id}
       aria-label={t.label} className=…>{feedPanels[t.id]}</TabsContent>)}
</Tabs>
```

- **`forceMount` plus an explicit `hidden`.** With `forceMount`, Radix computes `present = true`, so it would set `hidden={false}` on every panel. Our `hidden` prop spreads after Radix's (see A2), which keeps "mounted, hidden via the `hidden` attribute". `scrollAndFlashEventRow`'s `closest('[hidden]')` guard depends on that attribute.
- **Panel children** are the existing memoised `feedPanels[id]` elements, so no panel gains a prop. The `Tabs` and `TabsContent` wrappers re-render every frame, as the tab strip already does.
- **Automatic activation.** Arrow-key focus activates a tab, the same as a click. The words-gate and Dashboards effects already key on `feedTab`, so keyboard activation counts like a click.
- `TabsContent` gets `tabIndex={0}` from Radix (WAI-ARIA tabs pattern).
- It also gets `aria-labelledby` pointing at its trigger. That supersedes `aria-label` for the accessible name, but the two strings are identical, so the name is unchanged.

### D3. FeedTable on ScrollArea and Table, rows on TableRow and TableCell

- `FeedTable` renders `<ScrollArea className="min-h-0 flex-[1_1_0] max-md:flex-[0_0_auto] max-md:max-h-[70dvh]" viewportRef={scrollRef}>`, holding `Table` > colgroup > `TableHeader` > `TableRow` > `TableHead`… > `TableBody`.
- Because `viewportRef` is a ref, a callback `scrollRef` (the `useState` setter) fires on mount. That replaces the OverlayScrollbars `initialized` event, so `handleOsInit` goes.
- **Rows.** `TranscribeRow` and `TopicsRow` keep passing `FEED_ROW`/`FEED_CELL` plus their alignment and time-column additions. `EventLogRow` keeps passing its `CELL_*` strings. The `TableRow`/`TableCell` base is visually empty (D1), so the class lists each cell ends up with are unchanged from today.
  - Test: for one representative cell per row component, the rendered `className` token set equals the pre-port token set.
  - The browser row-height check (A6) stays as a belt-and-braces measurement.
- **Spacer and sentinel rows** become `TableRow`/`TableCell` with inline `height`, `padding:0` and `border:none`, as today. The spacer `TableRow` gets `className="hover:bg-transparent"`, so a hover tint doesn't flash on the spacer.

### D4. Rail session lists on ScrollArea

`#session-list` and `#archived-list` become `ScrollArea` with the same `id` on the root, plus `viewportClassName="[&>div]:!flex [&>div]:flex-col [&>div]:gap-[0.45rem]"`, replacing `.os-rail-sessions > [data-overlayscrollbars-viewport]`. The test mocks for `overlayscrollbars-react` are deleted.

### D5. Feed menus on DropdownMenu

**Time display**
- `DropdownMenu` (controlled, as today), with the trigger `DropdownMenuTrigger asChild` around `Button variant="glass"`.
- The content is `aria-label="Time display"`, holding a `DropdownMenuRadioGroup` with value `'session' | 'world'` and `DropdownMenuRadioItem`s "Session Time" and "World Clock".
- This replaces the invalid `aria-haspopup="listbox"` dialog-of-options. `onValueChange` calls the existing `onChange`. Radix closes the menu on select.

**Filter**
- `DropdownMenuCheckboxItem` per category plus "Show internal events", with `checked` and `onCheckedChange` calling the existing toggle.
- `onSelect={(e) => e.preventDefault()}` keeps the menu open (A4). Today's Filter menu stays open while toggling.
- The label `<span>` keeps the category colour inline style. The indicator is lucide `Check` with `data-testid="filter-check"`, rendered only when checked.

**Auto generate**
- `DropdownMenu modal={false}` with controlled `open={generateMenuOpen}`. `onOpenChange` is ignored while `generateUnavailable || generatePending`, as today.
- Non-modal because Custom opens `EventGenerateCustomModal`. 3a D3 found that a modal Radix menu closing under a newly opened dialog leaves `pointer-events:none` on `<body>`.
- The trigger keeps `aria-disabled`, `aria-describedby="v5-event-feed-gen-reason"`, `disabled={generatePending}` and the `preventDefault` on activation while unavailable. That last one moves to `onPointerDown` and `onKeyDown`, because Radix opens on those events.
- Items are `DropdownMenuItem` "Generate All"/"Regenerate All" and "Custom".

**All three**
- `isOverlayOpen()` matches `[role="menu"]`, so the 1–9, Space and ? hotkeys still yield while a menu is open.
- **Added during implementation (task 4.1):** each menu is named by its trigger ("Time Display", "Filter", "Auto Generate"). Radix sets `aria-labelledby` to the trigger id on the content, and that wins over an `aria-label`. The `aria-label`s the Popovers carried ("Time display", "Filter events", "Auto Generate menu") were dropped rather than fighting the primitive. No test or spec referenced them except this change's own tests.
- **Added during implementation (task 4.2):** `DropdownMenuCheckboxItem` gained an optional `indicator` prop, which replaces the default check glyph. Filter uses it to put `data-testid="filter-check"` on the lucide `Check`.
- `EventLogSheet`'s batch-mode Escape handler already skips `defaultPrevented` events, and Radix's Escape handling prevents default on its dismissable layer, so Escape closes the menu without leaving batch mode (A5).

### D6. Toolbars and icons

- **`feedToolbarCaption.tsx`.** Its ten `Icon*` exports become one-line lucide aliases. For example, `export const IconSparkles = () => <Sparkles className="block size-[18px]" aria-hidden />`. Keeping the names leaves `AiV2Panel`'s imports unchanged. `IconKeep` maps to `Pin`.
- **`GenerateToolbar`, `EventLogSheet` toolbar buttons, `AiV2Panel` and `useSseTurn`** use `Button variant="glass"`/`"glass-primary"`. `aria-disabled` triggers keep their `aria-disabled:*` utilities through `className`.
- **`ExportFeed`.** The three primary actions are `Button` (default variant; `asChild` around the `<a download>`). The JSONL link is `Button variant="outline" asChild`. The legacy `tool-row export-row` wrapper becomes a flex row.
- **`EventLogRow`.** UNDELETE becomes `Button variant="outline" size="xs"`, and the trash glyph becomes lucide `Trash2`. The row icon-button chrome (`ROW_ICON_BTN`) is unchanged.
- **`JumpToTimeButton`.** Its play glyph becomes lucide `Play` (`fill="currentColor"`). It stays a native `<button type="button">` with `aria-disabled`, never `disabled` (`web-session-console` "Feed jump column"). The `h-6` box is unchanged, so `ROW_HEIGHT` holds.
- **`MaximizeLogStrip`.** The hamburger becomes lucide `Menu`.

### D7. OverlayScrollbars removal and guard

- `npm uninstall -w web overlayscrollbars overlayscrollbars-react`.
- Delete:
  - the `overlayscrollbars.css` imports in `app/(index)/layout.page.tsx` and `app/(admin)/layout.page.tsx`;
  - the `.os-rail-sessions` CSS;
  - the comment in `AppShell.tsx:71-74`.
- Update the `SessionRoute.tsx:14` comment.
- `shadcnHygiene.repo.test.ts` gains a case: no source file imports `overlayscrollbars*`, and `web/package.json` doesn't list it.

## Assumptions (tested)

**A1. Radix Tabs activate on mouse-down or focus, not click.** `fireEvent.click` tab tests must move to `fireEvent.mouseDown(tab, { button: 0 })`. `@testing-library/user-event` is not installed and isn't added (panel finding). Arrow-key activation runs through roving focus in a `setTimeout`, so keyboard assertions await a tick.
- `grep -n "onMouseDown\|onFocus" node_modules/@radix-ui/react-tabs/dist/index.mjs` → `127: onMouseDown: composeEventHandlers(...` and `143: onFocus: … isAutomaticActivation`.

**A2. With `forceMount`, an explicit `hidden` prop overrides Radix's `hidden: !present`.**
- `sed -n 166,185p node_modules/@radix-ui/react-tabs/dist/index.mjs` →
  - `present: forceMount || isSelected`
  - `hidden: !present,` `id: contentId,` `tabIndex: 0,` `...contentProps,`
  - `children: present && children`
- `contentProps` spreads after `hidden`, and forced children always render.

**A3. Radix ScrollArea's viewport accepts a forwarded ref and wraps its children in `display:table`. Its scrollbar doesn't preventDefault pointer-down, and composes no `onMouseDown`.**
- `grep -n "onMouseDown\|onPointerDown" …/react-scroll-area/dist/index.mjs` → `581: onPointerDown: composeEventHandlers(props.onPointerDown, …` and `659: onPointerDownCapture`, with no `onMouseDown`.
- `@radix-ui/primitive` `composeEventHandlers` runs the consumer handler first and skips Radix's when `defaultPrevented` (panel evidence). Hence D1 uses `mousedown`.
- `grep -n "ScrollAreaViewport = React\|display: \"table\"" …/react-scroll-area/dist/index.mjs` → `111: var ScrollAreaViewport = /* @__PURE__ */ React2.forwardRef(` and `210: style: { minWidth: "100%", display: "table", ...props.style }`.
- `sed -n 575,600p` → the scrollbar's `onPointerDown` does `setPointerCapture`, `webkitUserSelect = "none"` and `handleDragScroll`, with **no `preventDefault`**.
- Hence the D1 `ScrollBar` pointerdown parity.

**A4. A `DropdownMenuCheckboxItem` whose `onSelect` calls `preventDefault()` keeps the menu open.**
- `sed -n 403,416p node_modules/@radix-ui/react-menu/dist/index.mjs` → `if (itemSelectEvent.defaultPrevented) { isPointerDownRef.current = false; } else { rootContext.onClose(); }`.

**A5. Escape in an open menu doesn't also reach the batch-mode Escape handler.**
- Existing test `EventLogSheet.test.tsx:328` covers Escape with the Popover.
- The same test is re-run with the DropdownMenu. It is tested during implementation (task 4.2), not assumed.

**A6. Rows stay at 31px after the move to TableCell.**
- Today the spec's 30.44px row is measured in headless Chromium.
- After the port, the QA walk evaluates `document.querySelector('#v4-log-sheet tr[data-event-id]').getBoundingClientRect().height`, which must be ≤ 31 (task 6.1).
- jsdom can't measure layout, so this is a browser check.

**A7. Only these files import OverlayScrollbars.**
- `grep -rln overlayscrollbars web/src web/package.json` → `web/package.json`, `app/(admin)/layout.page.tsx`, `app/(index)/layout.page.tsx`, `AppShell.tsx` (comment), `FeedTable.tsx`, `RecentSessionsList.tsx`, `RecentSessionsList.test.tsx`, `SessionRoute.tsx` (comment), `V6Rail.test.tsx`, `shared/theme/tailwind.css`.

**A8. The glass-button constants have exactly four importers.**
- `grep -n "FEED_GLASS" web/src/pages/index/components/*.tsx | grep import` → `AiV2Panel.tsx:14`, `GenerateToolbar.tsx:2`, `EventLogSheet.tsx:39`, `useSseTurn.tsx:3`.

## Risks / Trade-offs

- **[Sticky header breaks inside ScrollArea]** → The container has no overflow (D1), and the viewport is the only scrollport. QA step: scroll the event feed and confirm the header is still visible.
- **[Primitive base classes leak into the event rows]** → `TableRow`/`TableCell` have no visual base (D1), and a token-set equality test runs per row component (D3).
- **[The Button base refactor shifts existing variants]** → A snapshot of every non-glass variant/size class list is taken before the refactor (D1).
- **[Arrow-key tab activation triggers the Dashboards fetch or the words gate]** → This is the same as clicking the tab, which already opens these gates. Both are sticky or idempotent per session.
- **[The Radix thumb looks slightly different from the OverlayScrollbars theme]** → Accepted visual drift, reviewed in the QA pairs.
- **[preventDefault on scrollbar pointer-down blocks text selection starting on the bar]** → It's harmless: OverlayScrollbars did the same.
- **[Removing the dependency breaks the dev image]** → Run `make dev-up` after the uninstall (task 1.1).

## Migration Plan

Web-only. Roll back by reverting the merge commit. Nothing is persisted and there is no server change.
