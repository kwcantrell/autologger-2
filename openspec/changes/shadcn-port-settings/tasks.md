# Tasks

## 1. Shared pieces

- [x] 1.1 Add `DialogActions` to `shared/ui/Dialog.tsx` (D2), and export `TOUCH_TARGET` from `shared/components/ui/button.tsx` (D2b).
  - Test first: `shared/ui/Dialog.test.tsx` checks that `DialogActions` renders `data-slot="dialog-actions"` with its children, in order.
  - Verify: `npx vitest run src/shared/ui/Dialog.test.tsx` passes.
  - Evidence: test first: Dialog.test "DialogActions renders a dialog-actions row with its children in order" + "TOUCH_TARGET is the 44px mobile floor (D2b)" -> `2 failed | 8 passed (10)`; after DialogActions (data-slot dialog-actions, mt-5 flex justify-end gap-[0.6rem]) in shared/ui/Dialog.tsx and TOUCH_TARGET = max-md:min-h-11 exported from button.tsx -> `npx vitest run src/shared/ui/Dialog.test.tsx src/shared/components/ui` `Tests 45 passed (45)` (button variant snapshot unchanged); tsc clean

## 2. Settings modal

- [ ] 2.1 Settings tabs on controlled shadcn `Tabs`, with explicit ids, `forceMount` plus `hidden`, and the `visitedTabs` gate. Delete `feedTabStyles.ts` (D1).
  - Test first, in `HomeSettingsModal.test.tsx`:
    - tab switches use `fireEvent.mouseDown` through one helper;
    - new: ArrowRight from General activates Event Buttons after an awaited tick;
    - each trigger's `aria-controls` resolves to a `tabpanel` before its first visit;
    - an unvisited panel has no children;
    - a visited panel's content survives switching away.
  - Verify: `npx vitest run src/pages/index/components/HomeSettingsModal.test.tsx` passes, and `grep -rn feedTabStyles web/src` prints nothing.
- [ ] 2.2 Port the fields, hints, section blocks, buttons and Add-Show dialog to `Field`/`FieldLabel`/`Input`/`FieldDescription`/`Button`/`DialogActions` (D2).
  - Test first:
    - rewrite the `label > span` order check (:733) as label-text order inside `#profile-show-fields`;
    - new: Save is `data-variant="default"` and disabled with label "Saved" when clean, and its wrapping element carries `title="No unsaved changes"`; every ported button carries `max-md:min-h-11` (D2b); Close is `outline`; Log out is an `<a>` with `data-variant="destructive"`; the Add-Show input is labelled and its actions sit in `[data-slot=dialog-actions]`.
  - Verify: the HomeSettingsModal suite passes (all `getByLabelText` queries, the member view, the shows states, the save model), and `grep -nE "\b(btn|field|profile-select|modal-hint|modal-actions|admin-settings-block|settings-subheading|settings-actions|muted)\b" HomeSettingsModal.tsx` finds no className uses.

## 3. Event-buttons table and its modals

- [ ] 3.1 Port the `EventButtonsTable` controls (D3).
  - Test first, in `EventButtonsTable.test.tsx`:
    - "Remove event" is `data-variant="destructive"` with `svg.lucide-trash-2`;
    - "Drag to reorder" has `svg.lucide-grip-vertical` and is still `draggable`;
    - AI Rules is `data-slot="button"`, with its name unchanged for both states;
    - Copy and Add are `data-variant="default"`;
    - every ported table button carries `max-md:min-h-11` (D2b).
  - Verify: `npx vitest run src/pages/index/components/EventButtonsTable src/shared/theme/contrastTokens.test.ts` passes. The lazy-type-select parity test and the AI Rules contrast regex stay green.
- [ ] 3.2 Port `EventInstructionModal` and `EventOptionsModal` (D4).
  - Test first:
    - both modals: every action button carries `max-md:min-h-11` (D2b);
    - EventOptionsModal: "Needs context" is `role="checkbox"` and toggles `aria-checked`; Remove is `destructive`; Done/Close sit in `[data-slot=dialog-actions]`; `getAllByLabelText('Option instruction')` still resolves, with `maxLength` 2000;
    - EventButtonsTable (AI Rules flow): "Generation instruction" still resolves, and Save/Cancel are in `[data-slot=dialog-actions]`.
  - Verify: `npx vitest run src/pages/index/components/EventOptionsModal.test.tsx src/pages/index/components/EventButtonsTable` passes.

## 4. Integration: QA gate and checks

- [ ] 4.1 Before the port, capture a **before** baseline on `supabase-migration` HEAD.
  - The walk is copied from `openspec/changes/archive/2026-10-06-shadcn-port-workspace/qa/`. Its Settings section gains a step that switches the header Team picker to Test Team (owner view) before the General and Event Buttons captures, and keeps the member view (Youtube Studio).
  - New captures:
    - Settings tabs by keyboard;
    - the Add-Show dialog;
    - AI Rules and options modals;
    - the colour popover.
  - After the port, run the same walk at 1440×900 and 390×844 against `before-settings`.
  - Verify: contrast shows 0 failures apart from "Audio issue"; at 390 an eval measures Save and a row "Remove event" button at ≥ 44px tall (D2b); per-screen diffs are recorded in `qa/README.md`.
- [ ] 4.2 The owner reviews the pairs and does a dev-stack pass:
  - tabs by keyboard;
  - edit a field (Save arms), then close (the discard confirm appears);
  - AI Rules and options modals (Needs context);
  - colour picker;
  - Add show (cancel).
  - Verify: the result is recorded in `qa/README.md`.
- [ ] 4.3 Run the full suite, typecheck, lint and `openspec validate --all --strict`. Run `scripts/check-change.sh` if the owner asks.
