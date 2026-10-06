# Tasks

## 1. Shared wrappers

- [x] 1.1 ConfirmDialog and PromptDialog: `LEAD` utility and `DialogActions` (D7).
  - Test first: `ConfirmDialog.test.tsx` (desktop alertdialog and mobile drawer) and `PromptDialog.test.tsx` assert that Cancel and the confirm/submit button sit inside `[data-slot="dialog-actions"]`.
  - Verify: `npx vitest run src/shared/ui` passes, including every existing case.
  - Evidence: test first: ConfirmDialog "mobile=false|true: Cancel and Delete sit in [data-slot=dialog-actions]" (+ max-md:min-h-11) and PromptDialog "Cancel and OK sit in [data-slot=dialog-actions]" -> `3 failed | 45 passed (48)`; after LEAD utility (former .modal-lead values) + DialogActions on both ConfirmDialog paths (AlertDialogCancel/Action and the Drawer Buttons with TOUCH_TARGET) and PromptDialog -> `npx vitest run src/shared/ui` `Tests 48 passed (48)` (resolve-false, one-decision, Escape/overlay, mobile focus cases unchanged); tsc clean

## 2. New Session and Batch Import

- [x] 2.1 NewSessionModal on Field/Input/Select/Checkbox/Button, lucide icons and `DialogActions` (D1, D2). Add the guarded global `ResizeObserver` stub to `web/src/test/setup.ts` (A7).
  - Test first, in `NewSessionModal.test.tsx`:
    - labels resolve: Show, Episode (episode show), Notes (optional), and, after opening the disclosures, YouTube video link, Frame rate, Custom fps (after choosing Other…) and Start offset (frames);
    - the publish-date control is `role="checkbox"` and toggles `aria-checked`;
    - both disclosures toggle `aria-expanded`;
    - "Create & open" is `data-variant="default"` inside `[data-slot=dialog-actions]` and carries `max-md:min-h-11`;
    - exactly one button is named Close.
  - Verify: `npx vitest run src/pages/index/components/NewSessionModal.test.tsx` passes, with the existing bonus, episode and submit cases.
  - Evidence: test first: "fields are labelled, disclosures toggle, publish date is a checkbox, Create & open is the primary action" (Episode/Notes/YouTube video link/Start offset/Custom fps labels -> ids, one Close, both disclosures aria-expanded, publish date role=checkbox toggling aria-checked, Create & open default in dialog-actions with max-md:min-h-11); Dialog mock gains DialogActions; guarded global ResizeObserver stub in test/setup.ts (A7) -> `1 failed | 8 passed (9)` (`expected null to be false` on the native checkbox); after Field/FieldLabel/Input/Select, Checkbox, ghost-Button disclosures with lucide ChevronRight, labelled number Inputs + FieldDescription hint (.fps-*/.inline/.num dropped), lucide Plus header, outline icon Close with X, Create & open Button in DialogActions, BTN_PRIMARY_SKY dropped -> NewSessionModal suite `Tests 9 passed (9)`; full `npx vitest run` `Test Files 125 passed (125) Tests 1578 passed (1578)`; tsc clean
- [x] 2.2 BatchImportModal on Field/Button, lucide `Upload` and `DialogActions` (D1, D3).
  - Test first: Start Import is `data-variant="default"` inside `[data-slot=dialog-actions]`; Import Audio and Import Logs are `outline`; exactly one Close.
  - Verify: `npx vitest run src/pages/index/components/BatchImportModal.test.tsx` passes, with the existing order, prompt and progress cases.
  - Evidence: test first: "actions are shadcn Buttons: outline imports, Start Import primary in the actions row" (exactly one Close, Import Audio/Logs outline, Start Import default in dialog-actions with max-md:min-h-11) -> `1 failed | 12 passed (13)`; after lucide Upload header icon, outline icon Close with X, Field/FieldLabel Show, outline Import Audio/Logs, Start Import Button in DialogActions above the progress region, BTN_PRIMARY_SKY dropped -> BatchImportModal + V6Rail `Tests 24 passed (24)` (order, prompt, folder, progress, show-grants cases unchanged); tsc clean

## 3. Smaller modals

- [x] 3.1 YouTubeImportErrorModal and TranscribeModal (D4).
  - Test first, in the new `YouTubeImportErrorModal.test.tsx`: the four actions with their variants; the retry input is named "YouTube video link" once "Try a different link" is chosen.
  - Test first, in the new `TranscribeModal.test.tsx` (`fetch` stubbed): when done, "Download CSV" is an `<a download>` with `data-slot="button"`; Close is in the dialog-actions row.
  - Verify: both suites pass, and `npx vitest run src/apiResponseShapes.repo.test.ts` passes (the pinned call shapes and lines are untouched).
  - Evidence: test first: new YouTubeImportErrorModal.test.tsx ("offers the three choices with their Button variants"; "Try a different link shows a named link input whose Import retries with the trimmed URL") and TranscribeModal.test.tsx ("Download CSV is an <a download> Button and Close is in the actions row", fetch stubbed) -> `3 failed` (`expected null to be default` / `button`); after YouTube error on Button default/outline/destructive + Input aria-label "YouTube video link" + ROW flex (gap-x-4 gap-y-3 = .tool-row) and Transcribe on Button asChild download + DialogActions -> those + apiResponseShapes.repo `Tests 46 passed (46)`; `git diff -U0 TranscribeModal.tsx | grep -E "transcribe.csv|JSON.parse"` -> nothing (pinned lines untouched); tsc clean
- [x] 3.2 EventGenerateCustomModal (D5).
  - Test first: Generate and Cancel are in `[data-slot=dialog-actions]`; Retry is `outline`.
  - Verify: `npx vitest run src/pages/index/components/EventGenerateCustomModal.test.tsx` passes, with the checkbox counts, the `/Cam A/` name and the exact hint copy.
  - Evidence: test first: existing suite extended (Cam A is a Radix checkbox toggling aria-checked; Generate disabled until a selection, default variant, in dialog-actions; Retry outline) -> `2 failed | 7 passed (9)`; after HINT utility (exact curly-apostrophe copy), Checkbox + FieldLabel htmlFor per candidate inside the fieldset/legend, outline Retry, Cancel/Generate Buttons in DialogActions -> EventGenerateCustomModal + eventGenerateLatch `Tests 22 passed (22)` (checkbox counts, /Cam A/ name, offline/error copy unchanged); tsc clean
- [ ] 3.3 CategoryButtonStrip TextModal and DropdownModal (D6).
  - Test first, in `CategoryButtonStrip.test.tsx` with TEXT and DROPDOWN fixtures:
    - TextModal: "Log note", a labelled Note input, Enter logs the trimmed note, actions in the row.
    - DropdownModal: the options are Buttons; choosing a needs-context option shows the labelled Context input; Escape returns to the options; Log sends `label || context`.
  - Verify: `npx vitest run src/pages/index/components/CategoryButtonStrip.test.tsx` passes, including the hotkey cases.

## 4. Legacy CSS and BTN_PRIMARY_SKY

- [ ] 4.1 Delete the listed rules from `tailwind.css` and `shared/theme/classnames.ts`, drop the redundant contrast block, and add the `DELETED_LEGACY_CLASSES` guard to `shadcnHygiene.repo.test.ts` (D8).
  - Test first: the attribute-aware guard (class arguments only, distinctive names only) fails while any ported file still uses one of the classes (run before the ports land, or against a temporarily reverted file), and does not flag `id="new-session-form"`.
  - Verify:
    - `npx vitest run src/shadcnHygiene.repo.test.ts src/shared/theme/contrastTokens.test.ts` passes;
    - `grep -rn "classnames'" web/src` prints nothing;
    - the full `npx vitest run` passes.

## 5. Integration: QA gate and checks

- [ ] 5.1 Copy the walk from the archived `shadcn-port-settings/qa`.
  - Add steps:
    - `new-session-advanced`: both disclosures open, with "Other…" fps;
    - `import-logs-prompt`: Batch Import → Import Logs, the PromptDialog;
    - `settings-discard-confirm`: Settings → switch team → Close shows the ConfirmDialog, declined with Escape;
    - a 390 touch probe for Create & open, Start Import and the confirm action.
  - Capture `before-modals` on HEAD before the port, and `after-modals` after it, at 1440 and 390.
  - Verify: contrast shows 0 failures apart from "Audio issue"; untouched screens are 0%; the touch probe is ≥ 44px; results are recorded in `qa/README.md`.
- [ ] 5.2 The owner's dev-stack pass:
  - category note and dropdown modals (while rolling);
  - Custom generate;
  - Transcribe;
  - a session-row Delete confirm;
  - a YouTube import failure, if reproducible.
  - Verify: the result is recorded in `qa/README.md`.
- [ ] 5.3 Run the full suite, typecheck, lint and `openspec validate --all --strict`.
