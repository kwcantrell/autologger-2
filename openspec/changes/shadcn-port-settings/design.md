# Design: shadcn port, Settings

## Context

The motivation is in proposal.md. This is the state on 2026-10-06, from a three-agent read-only survey.

**`HomeSettingsModal.tsx` (1226 lines)**
- **Tabs:** the four tabs are a hand-built `role="tablist"` (`aria-label="Settings sections"`) of `<button role="tab">`s.
  - Each tab has `id="v6-settings-tab-*"`, `aria-controls="v6-settings-section-*"`, a roving `tabIndex`, and `feedTabButtonClassName(isActive)`.
  - Its panel is a `<div role="tabpanel" hidden>` with the same ids. Panel content mounts on first visit (`visitedTabs`) and then stays mounted (web-ui-system "Settings modal defers inactive tab content").
- **Fields:** `label.field > span + input.profile-select` (+`HS_INPUT_OVERRIDE`) for Name, Code, the account email, First/Last name and the Add-Show name.
- **Hints:** `.modal-hint` (10 uses, some with ids that tests read).
- **Buttons:** `.btn` / `.btn primary` + `BTN_PRIMARY_SKY` for Save, Close, Retry, Add show and Log out (an `<a>`).
- **Sections:** `.admin-settings-block` / `.settings-subheading` / `.settings-actions` wrap them.
- **Pickers:** Team, Show and Suffix are `LazySelect`; the frame rate is `FpsSelect`.

**`EventButtonsTable.tsx`**
- `ROW_ICON_BTN = 'btn btn-icon …'` for the drag and delete buttons, with hand-drawn SVGs.
- `btn` with heavy `!` resets for the options chip button, N/A / ON-OFF and AI Rules.
- `profile-select` on the name input.
- `btn primary` + `BTN_PRIMARY_SKY` for Copy and Add.
- The colour picker is a Popover over native swatch buttons.

**The two modals**
- `EventInstructionModal`: `label.field` + a native auto-grow textarea, `.modal-hint` and `.modal-actions`.
- `EventOptionsModal`: wrapping `label.field`s, `input.profile-select`, a native checkbox, two native textareas, and `.btn danger` / `.modal-actions`.

**Tests**
- No test asserts on a legacy class.
- HomeSettingsModal tests mock `Dialog` as a plain `role="dialog"` div, and `Select`/`LazySelect` as a native `<select aria-label>`. They resolve fields by `getByLabelText` ("Name:", "First name", "Team", …), switch tabs with `fireEvent.click`, and check the `label > span` text order inside `#profile-show-fields` (:733).
- `contrastTokens.test.ts` regex-reads `bearing ? 'text-v5-primary' : '<class>'` from `EventButtonsTable.tsx`, and `BTN_PRIMARY_SKY` from `shared/theme/classnames.ts`.

## Goals / Non-Goals

**Goals:** the four files and the Add-Show dialog render through the shared layer with the same ids, names, roles, tab behaviour and V5 look; `feedTabStyles.ts` is retired.

**Non-Goals:** see proposal.md. At the design level:
- no shared CSS is deleted (admin and the 3c-2 surfaces still use it);
- no change to the save model, dirtiness or the shows-section states.

## Decisions

### D1. Settings tabs on controlled Radix Tabs, keeping explicit ids and lazy content

```tsx
<Tabs value={activeTab} onValueChange={selectTab}>
  <TabsList aria-label="Settings sections" className={TABLIST_LAYOUT}>
    {tabs.map(t => <TabsTrigger value={t.id} id={`v6-settings-tab-${t.id}`}
                     aria-controls={`v6-settings-section-${t.id}`}>{t.label}</TabsTrigger>)}
  </TabsList>
  {tabs.map(t => <TabsContent value={t.id} forceMount hidden={activeTab !== t.id}
       id={`v6-settings-section-${t.id}`} aria-labelledby={`v6-settings-tab-${t.id}`}
       className={SECTION_CLASS}>{visitedTabs.has(t.id) && content[t.id]}</TabsContent>)}
</Tabs>
```

- **Ids.** Radix spreads the consumer's props after its own `id`/`aria-controls` (trigger) and `id`/`aria-labelledby`/`hidden` (content), so the explicit values win (A1, A2). The `v6-settings-*` ids and their pairing are unchanged.
- **Lazy content.** `forceMount` keeps every panel element present, so every `aria-controls` target resolves. The children stay gated on `visitedTabs`, so content mounts on first visit and never unmounts.
- **Activation.** `selectTab(id)` sets the active tab and adds it to `visitedTabs` in one handler, the same as today's `onClick`. Arrow keys use Radix automatic activation, so focusing a tab activates and visits it, exactly as a click does.
- **Reset on reopen.** Reopening still resets to General, through two paths that both stay as they are: AppShell unmounts the modal when it closes (web-ui-system "The Settings modal costs nothing while closed"), and the in-render `prevOpen` reset (HomeSettingsModal.tsx ~:234-252) covers an `isOpen` rerender. The `prevOpen` block is kept unchanged (panel note).
- **Layout.** The tablist row keeps its layout classes (`-mb-2`, `pt-[14px]`, the mobile horizontal scroll). The lid chrome now comes from the themed `TabsTrigger` (identical strings, keyed on `data-state`). `feedTabStyles.ts` is deleted.

### D2. Fields, hints, section blocks and buttons

- **Fields.**
  - Each of Name, Code, account email, First name, Last name and the Add-Show name becomes `Field` + `FieldLabel htmlFor` + `Input id`.
  - Ids and label text are unchanged ("Name:", "Code:", "First name", …), so every `getByLabelText` keeps resolving (A3).
  - The width wrappers (`FIELD_BASE` / `FIELD_CODE` / …) move onto `Field`.
  - Suffix and frame rate keep their `LazySelect` / `FpsSelect` controls, with a `FieldLabel htmlFor` pointing at the trigger id. The test stub renders a native `<select aria-label>`, so their label queries are unaffected.
- **Hints.** `.modal-hint` becomes `FieldDescription` where it describes a field (the acronym tip), and a local `HINT` class string (`text-[0.78rem] leading-[1.45] text-v5-muted`, the `.modal-hint` look on the AA-safe muted token) otherwise. Ids and text are unchanged; `.muted` uses become `text-v5-muted`.
- **Section blocks.** `.admin-settings-block` / `.settings-subheading` / `.settings-actions` become local `SETTINGS_BLOCK` / `SETTINGS_SUBHEAD` / `SETTINGS_ACTIONS` utility strings that copy today's computed CSS. The elements are unchanged (`<h2>` and `<h3>` headings stay). The CSS rules stay for admin until 3c-2.
- **Buttons.**
  - Save `#profile-save`: `Button` (default sky primary). It is still disabled when clean and still reads "Save" / "Saving…" / "Saved". It drops `BTN_PRIMARY_SKY`, which stays in `classnames.ts` for its other importers and the contrast test.
  - Close (`aria-label="Close"`), Retry `#profile-shows-retry` and Add show `#profile-show-add`: `outline`.
  - Log out `#profile-account-logout`: `Button variant="destructive" asChild` around the existing `<a>`, keeping `href`.
- **Disabled Save keeps its tooltip (panel finding).** Save's `title` ("No unsaved changes" while clean) moves onto a wrapping `<span className="inline-flex">`. `Button` sets `disabled:pointer-events-none`, so a `title` on the disabled button itself would never show. The span still receives hover, while the button keeps web-ui-system's "disabled buttons show no hover response".
- **`DialogActions`.** A new `DialogActions` is exported from `shared/ui/Dialog.tsx`: `<div data-slot="dialog-actions" className="mt-5 flex justify-end gap-[0.6rem]">`, the `.modal-actions` look. The Add-Show dialog and both table modals use it, and 3c-2 adopts it for the rest.

### D2b. Mobile touch-target floor (panel finding)

The legacy `.btn` gets `min-height: 2.75rem` below 767px (`tailwind.css` ~:1647, "touch-target floor for the app-wide button"). The shared `Button` sizes have no mobile floor; only the glass variants do.

- **New constant.** `button.tsx` exports `TOUCH_TARGET = 'max-md:min-h-11'` (44px).
- **Where it applies.** Every button this change ports from `.btn` passes it in `className`, so phone sizes stay as they are today:
  - Settings: Save, Close, Retry, Add show, Log out, and Add-Show Cancel/Create;
  - table: Copy, Add, drag, delete, N/A / ON-OFF and AI Rules;
  - modals: every action.
- **Row icons.** The drag and delete icon buttons are 44px tall on mobile today, because the `.btn` floor beats their `max-h-6`. They keep that.
- **Existing uses unchanged.** `Button` instances from 3a and 3b are not changed. Adding a floor to the primitive would alter those surfaces and the variant snapshot, which is outside this change.
- **Test:** every ported button carries `max-md:min-h-11`. QA at 390 measures Save and a row delete button at ≥ 44px.

### D3. Event-buttons table controls

- **Copy and Add:** `Button` (default).
- **Drag handle:** `Button variant="ghost" size="icon-xs"` with lucide `GripVertical`. It keeps `aria-label="Drag to reorder"`, `draggable`, `onDragStart` and its `cursor-grab` classes.
- **Delete:** `Button variant="destructive" size="icon-xs"` with lucide `Trash2`, keeping `aria-label="Remove event"`.
- **N/A / ON-OFF summary:** `Button variant="outline" size="xs"` with the row-height overrides; disabled when it can't edit options.
- **AI Rules:** `Button variant="outline" size="xs"` with its overrides.
  - The aria-label is unchanged: "AI Rules" / "AI Rules (has instructions)".
  - The expression `bearing ? 'text-v5-primary' : 'text-v5-muted'` stays **verbatim**, because `contrastTokens.test.ts` regex-reads it. It is merged last, so it wins over the outline text colour.
- **Options chip button:** this is a chip container, not a styled button. It becomes a plain `<button>` with explicit utilities replacing the `btn` + `!` resets, and keeps `aria-label="Edit dropdown options"`.
- **Name input:** `Input` with the `ROW_FIELD` overrides.
- **Colour picker:** the trigger and the nine palette buttons stay native `<button>`s, because they are colour swatches whose look is their background colour. The existing comment explains why the trigger is a bare button.
- **Unchanged:** the `pal-slot` colour inputs, the type `LazySelect` (its lazy-upgrade parity test must stay green), the preset `RadioGroup`, the copy-from `Select`, and the grid.

### D4. AI Rules and options modals

- **`EventInstructionModal`:**
  - `FieldDescription` for the hint;
  - `Field` + `FieldLabel htmlFor="event-instruction-input"`;
  - `AutoGrowTextarea` rendered with the shadcn `Textarea` styling. It keeps its own auto-grow and passes the themed class: `Textarea`'s base string plus `TEXTAREA_CLASS`, with `maxLength` 2000;
  - Cancel `outline` and Save default in `DialogActions`.
- **`EventOptionsModal`:**
  - The whole-button instruction and each per-option instruction become `Textarea`, with `FieldLabel htmlFor` and ids `event-options-instruction` and `event-option-${uid}-instruction`. The labels stay "Generation instruction" and "Option instruction", so `getByLabelText` / `getAllByLabelText` still resolve.
  - Option labels and ON/OFF labels become `Input` with ids, keeping `firstRef` focus (React 19 passes `ref` through).
  - "Needs context" becomes `Checkbox` + `FieldLabel` in `Field orientation="horizontal"`, with `onCheckedChange={(v) => … v === true}`.
  - Remove is `destructive`, Add option `outline`, Close `outline` and Done default, in `DialogActions`.
  - `<span className="mono">` in the hint becomes `font-mono`.

### D5. Spec delta (wording only)

See `specs/`.
- **web-ui-system "New Session progressive disclosure":** drop the bonus toggle (session-title-suffix: no Bonus control).
- **batch-audio-import:** replace "Batch Import modal chrome and actions" with "Batch Import modal layout and actions" (REMOVED + ADDED, because the validator won't let a MODIFIED block drop the old no-op scenario). It states today's behaviour, checked in `BatchImportModal.tsx:108-118`: Import Logs collects the Sheets URL through the themed prompt, and Start Import runs the import.
- **web-session-routing "Legacy selection spine retired":** the studio-switch scenario no longer calls the retired `window.V3_closeSession` "today's sole caller".

## Assumptions (tested)

- **A1. A consumer's `id` and `aria-controls` on `TabsTrigger` override Radix's.** `sed -n 100,140p node_modules/@radix-ui/react-tabs/dist/index.mjs` → `"aria-controls": contentId, … id: triggerId, ...triggerProps,`. The consumer's props spread last.
- **A2. A consumer's `id`, `aria-labelledby` and `hidden` on a force-mounted `TabsContent` override Radix's, and forced children always render.** Same file, `sed -n 166,185p` → `hidden: !present, id: contentId, tabIndex: 0, ...contentProps,` and `children: present && children`. This was also verified in change 3b, where SessionWorkspace uses the same pattern.
- **A3. The label queries the tests rely on.** `grep -ohn "getByLabelText(…)" HomeSettingsModal.test.tsx EventOptionsModal.test.tsx EventButtonsTable.test.tsx` → "Name:" ×10, "Suffix" ×3, "Team" ×3, "Show to edit" ×2, "First name", "Generation instruction", "Option instruction" (getAll). An explicit `htmlFor`/`id` keeps each resolving.
- **A4. The test stubs stay in force.** `grep -n "vi.mock('./Select'\|LazySelect\|FpsSelect\|shared/ui/Dialog'" HomeSettingsModal.test.tsx EventButtonsTable*.test.tsx` → `HomeSettingsModal.test.tsx:80` (Dialog), `:107` (Select), `:111` (LazySelect), `:140` (FpsSelect); `EventButtonsTable.test.tsx:30` (Select). The components keep importing `./Select`, `./LazySelect`, `./FpsSelect` and `shared/ui/Dialog`, so those stubs still apply.
- **A5. `feedTabStyles.ts` has one consumer.** `grep -rn "feedTabStyles\|feedTabButtonClassName" web/src` → only `HomeSettingsModal.tsx:17,812,813` and a comment in `tabs.tsx:6`.
- **A6. The contrast test reads two literals.** `sed -n 122,142p web/src/shared/theme/contrastTokens.test.ts` → `classConst('shared/theme/classnames.ts', 'BTN_PRIMARY_SKY')` and `/bearing \? 'text-v5-primary' : '([^']+)'/` in `EventButtonsTable.tsx`. Both must survive (D2, D3).
- **A7. `BTN_PRIMARY_SKY` has other importers.** `grep -rln BTN_PRIMARY_SKY web/src` → BatchImportModal, EventButtonsTable, NewSessionModal, HomeSettingsModal, classnames.ts and contrastTokens.test.ts. It stays until 3c-2.

## Risks / Trade-offs

- **[A legacy `label.field span` rule or bare `input[type=text]` rule leaks into the new Field/Input]** → No `.field` wrapper remains in the ported files, so `.field span` can't match. The bare `input[type='text']` rule sets the same values shadcn `Input` copies, and utilities win by layer. QA compares field rendering.
- **[Arrow-key automatic activation mounts a tab's content by focus alone]** → Same as clicking, and permitted: the spec's obligation is "mount on first activation, never unmount".
- **[Save and Copy/Add drift from the `BTN_PRIMARY_SKY` tint to the shared primary]** → An accepted vocabulary unification. The primary label contrast is covered by the existing shadcn-token test (`primary-foreground`), and QA reviews it.
- **[Ported buttons shrink on phones]** → D2b keeps the 44px floor on every ported button, and QA measures it.
- **[A disabled button's explanatory `title` is lost]** → D2: it moves to a wrapping span. A grep in task 2.2 confirms no other ported disabled button carries a `title`.
- **[The AI Rules contrast regex breaks if the expression is reformatted]** → D3 keeps it verbatim, and `contrastTokens.test.ts` runs in the suite.

## Migration Plan

Web-only. Roll back by reverting the merge commit.
