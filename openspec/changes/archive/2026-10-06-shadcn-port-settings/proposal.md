# shadcn port, Settings: the Settings modal, the event-buttons table, and its AI Rules and options modals

Tier: 1
Tier reason: a web-only presentation port onto the shared shadcn layer, inside existing contracts. It touches no `high_risk_paths`, wire format, auth or data. The spec delta only rewrites three passages that contradict other specs; no obligation changes.

Approved-by: Kalen 2026-10-06

## Why

Changes 1–3b put the V5-themed shadcn primitives and wrappers in place and ported the shell and the workspace. The Settings modal is the largest surface still on the legacy chrome classes:
- a hand-built tablist;
- `label.field` + `input.profile-select` fields;
- `.btn`, `.modal-hint`, `.admin-settings-block`, `.settings-subheading`;
- a hand-built Add-Show dialog.

The event-buttons table inside it and its two modals use the same vocabulary, plus hand-drawn SVGs and native checkboxes and textareas. Porting them is the first half of change 3. 3c-2 then ports the remaining modals and deletes the legacy chrome CSS along with the `/admin/users` page.

## What Changes

**Settings modal** (`HomeSettingsModal.tsx`)
- **Tabs:** the four tabs (General, Event Buttons, Auto Sync, Debug) move onto shadcn **`Tabs`**.
  - They keep their `v6-settings-tab-*` and `v6-settings-section-*` ids, `aria-controls` and `aria-labelledby`.
  - Each tab's content still mounts on first visit and is never unmounted.
  - New for users: arrow, Home and End keys.
- **Fields:** Name, Code, the three account fields and the Add-Show name become `Field` + `FieldLabel` + `Input`, keeping their ids and label text. Hints become `FieldDescription` or muted text.
- **Buttons:**
  - Save: default `Button`, still "Saved" and disabled when clean.
  - Close, Retry and Add show: `outline`.
  - Log out: `destructive`, wrapping the existing link.
- **Add-Show dialog:** uses `Field`, `Input`, `Button` and a new shared **`DialogActions`** row (the `.modal-actions` look, exported from `shared/ui/Dialog`).
- **Unchanged:** the Team, Show, Suffix and frame-rate pickers, the shows-section copy and states, the honest save model, and the member view.
- `feedTabStyles.ts` is deleted; this was its last consumer.

**Event-buttons table** (`EventButtonsTable.tsx`)
- **Buttons:** Copy and Add are `Button`; row delete is a destructive icon `Button` with lucide `Trash2`; the drag handle is a ghost icon `Button` with lucide `GripVertical`; N/A, ON/OFF and AI Rules are outline `xs` `Button`s.
- **Inputs:** the name input becomes `Input`.
- **Unchanged:** the lazy type select, the preset radio group, the copy-from select, the colour swatches and the drag behaviour.

**AI Rules modal** (`EventInstructionModal`): `Field`, `Textarea` and `DialogActions`.

**Options modal** (`EventOptionsModal`): `Field`, `Input` and `Textarea`; "Needs context" becomes the shadcn **`Checkbox`**; Remove is `destructive`, Add option `outline`, and Close/Done sit in `DialogActions`.

Every existing element id, label text, accessible name and role is preserved.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

Three existing passages contradict other specs. They're rewritten here, and no behaviour changes:
- **`web-ui-system` "New Session progressive disclosure":** drop the "pressed-state bonus toggle". session-title-suffix already says the modal has no Bonus control.
- **`batch-audio-import` "Batch Import modal chrome and actions":** it said Import Logs is a no-op, but sheets-log-import ships the log import from that control. The requirement is replaced by "Batch Import modal layout and actions", which states what Import Logs does today: it collects the Sheets URL, and Start Import runs the import.
- **`web-session-routing` "Legacy selection spine retired":** the studio-switch scenario cited `window.V3_closeSession` as having a caller, but the same requirement retires that global.

## Non-goals

- The session modals: New Session, Batch Import, YouTube error, Transcribe, Custom generate, and the category text/dropdown modals. ConfirmDialog and PromptDialog. These are 3c-2.
- Removing `/admin/users` and deleting the legacy chrome CSS (`.btn`, `.field`, `.profile-select`, `.modal-*`, `.settings-*`, the page chrome). Also 3c-2. This change deletes no shared CSS.
- The Select/LazySelect-based pickers (Team, Show, Suffix, frame rate, button type), which are already shadcn.
- Restyling the event-buttons grid, the colour swatches or the tab lid look.
- Dashboards (3d) and the Assistant (4).

## Impact

- **Code:**
  - `HomeSettingsModal.tsx`, `EventButtonsTable.tsx`, `EventInstructionModal.tsx`, `EventOptionsModal.tsx`;
  - `shared/ui/Dialog.tsx` (new `DialogActions`);
  - `feedTabStyles.ts` deleted.
- **Tests:**
  - HomeSettingsModal tab switches move to `fireEvent.mouseDown`, because Radix tabs activate on mouse-down.
  - The `label > span` order check becomes a label-text order check.
  - New cases cover tab keyboard navigation and linking, lazy panels, Button variants, Checkbox, and `DialogActions`.
  - The lazy-type-select parity test is untouched.
- **Dependencies:** none.
- **Visual:**
  - small drift where `.btn` and `.profile-select` controls become the shared Button and Input;
  - the Save button uses the shared sky primary instead of the `BTN_PRIMARY_SKY` override.

  The QA walk compares against a fresh **before** baseline that switches Settings to the owner (Test Team) view.
