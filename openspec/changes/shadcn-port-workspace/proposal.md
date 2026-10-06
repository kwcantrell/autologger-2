# shadcn port, workspace: feed tabs, feed tables, feed menus, toolbars, and OverlayScrollbars removal

Tier: 1
Tier reason: a web-only presentation port onto the shared shadcn layer, inside existing contracts. It touches no `high_risk_paths`, wire format, auth or data. One dependency pair is removed. The spec delta only restates two requirements in implementation-neutral terms; the obligations are unchanged.

Approved-by: Kalen 2026-10-06

## Why

Changes 1, 2 and 3a put V5-themed shadcn primitives and wrappers in place and ported the app shell. The session workspace is the last large surface still on hand-built widgets:

- **Feed tabs:** a button row with no arrow-key support.
- **Feed menus:** the three event-feed menus (Time display, Filter, Auto generate) are `Popover` + `PopoverItem`, with no menu keyboard model. Time display's ARIA is invalid: `option`s inside a dialog.
- **Scrolling:** the feeds and the rail's session lists scroll through OverlayScrollbars, a second scrollbar system beside shadcn.
- **Icons:** the toolbars draw ten hand-made SVG icons.

## What Changes

**Primitives** (V5 base strings replaced, as in changes 1, 2 and 3a)
- `tabs`: TabsTrigger takes the feed-tab "lid" chrome, keyed on `data-state`.
- `table`: the feed table chrome (sticky header, feed row and cell). Its container no longer scrolls on its own.
- `scroll-area`:
  - a `viewportRef` and a `viewportClassName`;
  - a block content wrapper;
  - a hover-revealed V5 thumb;
  - a scrollbar that keeps focus where it is on pointer-down, as OverlayScrollbars did.
- `dropdown-menu`: CheckboxItem, RadioItem, Label, Separator and the Sub parts get V5 styling. Checked state is shown by an indicator, never a tint.
- `button`: new `glass` and `glass-primary` variants, carrying the feed toolbar button chrome unchanged.

**Feed tabs** (`SessionWorkspace.tsx`)
- The six tabs become shadcn `Tabs`, still labelled "Feed tabs".
- All six panels stay mounted and are hidden through the `hidden` attribute.
- New: arrow, Home and End keys, and linking between each tab and its panel.

**Feed tables** (`FeedTable.tsx`, `EventLogRow`, `TranscribeRow`, `TopicsRow`, `EventLogSheet`, `TranscribeFeed`, `TopicsFeed`)
- The tables render through `Table`/`TableRow`/`TableCell`, and scroll in `ScrollArea`.
- Virtualization, the 31px row height, the spacer rows, reveal-in-feed, inline editing and the pagination sentinel are unchanged.

**Rail session lists** (`RecentSessionsList.tsx`): `#session-list` and `#archived-list` scroll in `ScrollArea`.

**OverlayScrollbars removed:**
- the `overlayscrollbars` and `overlayscrollbars-react` dependencies;
- their CSS imports and the `.os-rail-sessions` CSS;
- their test mocks.

A hygiene guard bans any reintroduction.

**Feed menus** (`EventLogSheet.tsx`) move to shadcn **`DropdownMenu`**:
- **Time display:** a radio group.
- **Filter:** checkbox items that stay open while toggling, with a lucide checkmark and no tint.
- **Auto generate:** non-modal, because Custom opens a dialog. Its latch, `aria-disabled` and reason linking are unchanged.

**Toolbars and icons**
- The feed toolbar icons become lucide icons: Sparkles, Plus, Pencil, Check, X, Clock, Filter, Download, Pin, Trash2.
- Every feed glass button becomes `Button variant="glass"` or `"glass-primary"`: EventLogSheet, GenerateToolbar, AiV2Panel and useSseTurn.
- ExportFeed's `.btn` links and buttons become `Button`.
- EventLogRow's undelete and trash controls become `Button` and lucide `Trash2`.
- The jump-to-time play glyph becomes lucide `Play`. It is still a native `aria-disabled` button.
- The maximize-log strip's hamburger becomes lucide `Menu`.

Every existing element id, test id, label, accessible name and live-region role is preserved.

**Internal-event colour fix** (added 2026-10-06 after the QA walk; owner chose to fold it in).
- The server sends `category_color: 'var(--muted)'` for internal events (`packages/domain/src/studio.ts:490`).
- Since change 1 renamed the legacy `--muted` token to `--legacy-muted`, that value resolves to shadcn's `--muted`, a 6% white tint. So the event feed's Internal rows ("Recording 1 Started/Stopped") render at about 1.14:1, and timeline markers and MarkerNav hints for internal events take the same tint.
- The web now resolves a category colour through one helper. It maps the legacy bare token names (`var(--muted)`, `var(--border)`, `var(--accent)`) to their `--legacy-*` names, at every place a category colour is read: EventLogRow, TimelineMarkers, Timeline (×3) and MarkerNav.
- The server's wire value is unchanged (frozen contract).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-session-console`: two requirements are restated without naming the replaced implementation. Their obligations are unchanged.
  - **"The event feed renders a windowed row set"** names the OverlayScrollbars viewport as the virtualizer's scroll element.
  - **"Event filter checkmarks"** names the "Filter popover" and the `PopoverItem selected` tint.

## Non-goals

- Settings and modal forms, the HomeSettingsModal tablist, CategoryButtonStrip's two small modals, and removing the legacy `.btn`/`.field`/`.profile-select`/`.modal-hint` CSS. These are change 3c. This change deletes only the `.os-rail-sessions` CSS.
- Dashboards and charts: change 3d. The Assistant chat on the AI SDK: change 4.
- `/admin/users`, which is being removed, and its menu.
- Glyphs and chrome left bespoke by owner decision:
  - the transport tiles and timecode glyphs;
  - the marker previous/next glyphs and tiles;
  - the category tiles, whose 1–9 hotkeys depend on `data-category-id`;
  - the feed-tab lid look, re-expressed in the Tabs primitive but not redesigned.
- Any change to virtualization tuning, row height, column widths, or the playback-tick memo fences.

## Impact

- **Code:**
  - five primitives in `web/src/shared/components/ui/`;
  - `SessionWorkspace`, `FeedTable`, the three feeds and their row components;
  - `EventLogSheet`, `GenerateToolbar`, `ExportFeed`, `feedToolbarCaption`;
  - `JumpToTimeButton`, `MaximizeLogStrip`, `RecentSessionsList`, `AiV2Panel`, `useSseTurn`;
  - both `layout.page.tsx` files and `tailwind.css`.
- **Tests:**
  - Tab tests switch from `fireEvent.click` to `fireEvent.mouseDown`, because Radix Tabs activate on mouse-down. `user-event` is not added.
  - The Filter tests' class and DOM assertions become role and `aria-checked` assertions.
  - New tests:
    - the Time display menu, which has no tests today;
    - tab keyboard and linking;
    - publishing the ScrollArea viewport;
    - scroll-drag focus parity;
    - smoke tests for the primitives;
    - the hygiene guard.
- **Dependencies:** `overlayscrollbars` and `overlayscrollbars-react` are removed, and none are added. The dev image needs `make dev-up`.
- **Internal rows:** visible again, at the legacy muted grey they had before change 1.
- **Visual:** small drift on the scrollbars (Radix thumb against the OverlayScrollbars theme). The menus now show radio and checkbox indicators. The QA walk compares against the `after-shell` captures.
