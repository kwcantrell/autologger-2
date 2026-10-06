# Tasks

## 1. Text prompt and guards

- [x] 1.1 `shared/ui/PromptDialog.tsx` exports `useTextPrompt()` (design D3b), built on the existing `Dialog` API. Switch `BatchImportModal.handleImportLogs` from `window.prompt` to it.
  - Test first, `shared/ui/PromptDialog.test.tsx`:
    - `requestText` shows a named `dialog` with a labelled textbox
    - Submit and Enter resolve the typed string
    - Cancel and Escape resolve `null`
    - a replaced request resolves `null`
    - unmounting resolves `null`
  - Rewrite `BatchImportModal.test.tsx`'s two `window.prompt` spies so they type the URL into the dialog and submit, then `await` the stored URL, since it now arrives after the promise resolves. They fail until the modal uses the hook.
  - Verify with `npx vitest run src/shared/ui/PromptDialog.test.tsx src/pages/index/components/BatchImportModal.test.tsx`.
  - Evidence: test first: `npx vitest run src/shared/ui/PromptDialog.test.tsx` -> `Failed to resolve import "./PromptDialog"`; rewritten BatchImportModal tests -> `× Import Logs prompts … × Start Import is enabled …` (2 failed); after `useTextPrompt` + BatchImportModal switch -> `Tests 19 passed (19)` (7 prompt + 12 BatchImportModal; `window.prompt` spy not called)
- [x] 1.2 Test first: `web/src/noBrowserDialogs.repo.test.ts` (D7).
  - Fixtures that must be flagged: `window.confirm(`, `window.prompt(`, `prompt(`, and a bare `confirm(` in a file without `useConfirm`.
  - Fixtures that must not be flagged: comments, and a file with `const { confirm, confirmElement } = useConfirm()`.
  - The real tree must pass, which relies on 1.1.
  - Verify the fixture assertions fail before the detector exists, then pass: `npx vitest run src/noBrowserDialogs.repo.test.ts`.
  - Evidence: test first: `npx vitest run src/noBrowserDialogs.repo.test.ts` -> `Cannot find module ./test/browserDialogCalls`; with the detector -> `Tests 4 passed (4)`; with the BatchImportModal fix stashed -> `+ "pages/index/components/BatchImportModal.tsx:106"`, `1 failed | 3 passed` (guard catches the old window.prompt)
- [ ] 1.3 Test first: `web/src/shared/ui/overlayOpen.test.ts` (D4) covers an open `dialog`, `alertdialog` and `menu` (each true), and an empty document (false). It fails on the missing module. Then add `overlayOpen.ts`. Verify with `npx vitest run src/shared/ui/overlayOpen.test.ts`.
- [ ] 1.4 Test first: add an `alertdialog` case to each handler test:
  - `CategoryButtonStrip.test.tsx` (digits)
  - `AudioPlayer.test.tsx` (Space)
  - `useZoomRail.test.tsx` (`+`/`−`)
  - a new `SessionWorkspace` `?` case (no test exists today)

  These fail because the handlers only check `role="dialog"`. Then switch the four handlers to `isOverlayOpen()`. Verify those four tests pass.

## 2. V5 primitives

- [ ] 2.1 Restyle `shared/components/ui/{dialog,alert-dialog,drawer}.tsx` to V5 (D1): overlay and content z-index variables, glass surface, the legacy `transform` centring with `translate-none`, the legacy keyframes, and `showCloseButton` defaulting to `false`.
  - Base class strings are **replaced**, not appended to (D1).
  - Test first: `primitives.smoke.test.tsx` gains two cases:
    - "dialog renders no Close button by default"
    - "DialogContent with a consumer `md:!w-…` keeps no `max-w-`, `bg-background` or `zoom-in` class"
  - Both fail on the current primitive.
  - Verify with `npx vitest run src/shared/components/ui` and `src/shadcnHygiene.repo.test.ts`.
- [ ] 2.2 Restyle `shared/components/ui/{popover,tooltip,select}.tsx` to V5 (D1), replacing the base strings with the legacy wrapper classes. `select.tsx` exports `SELECT_TRIGGER_CLASSNAME` and `SelectTriggerIcon` as the single trigger source (D5).
  - Test first: the smoke test asserts each content carries its `data-slot` and stays role-correct after the restyle (`tooltip`, labelled `dialog`, `listbox` opened with `defaultOpen`).
  - Verify with `npx vitest run src/shared/components/ui`.

## 3. Wrappers (public APIs unchanged)

- [ ] 3.1 `shared/ui/Dialog.tsx` on Dialog (desktop) and Drawer (mobile) (D2).
  - Test first: `shared/ui/Dialog.test.tsx`:
    - desktop: named `dialog`; `hideTitle` keeps the accessible name; `closeOnOverlayClick={false}` ignores outside pointer-down
    - mobile (`matchMedia` matches): named `dialog` from the vaul drawer
    - Escape calls `onOpenChange(false)`
    - on open, focus moves inside the dialog, not left on the trigger (`autoFocus`)
    - the drawer is `handleOnly`, and the handle has `data-vaul-handle`
    - a vetoed close (the parent keeps `open`) leaves the content mounted: same node, child state kept, and the inline transform reset to `translate3d(0,0,0)`
  - Verify that test passes, plus `BatchImportModal`, `EventOptionsModal`, `EventGenerateCustomModal` and `eventGenerateLatch`.
- [ ] 3.2 `shared/ui/ConfirmDialog.tsx` on AlertDialog (desktop) and Drawer (mobile) (D3).
  - Test first: extend `ConfirmDialog.test.tsx`:
    - desktop: `alertdialog` named by the title; Escape and an overlay click each resolve `false`; a `danger` action has `data-variant="destructive"`
    - mobile: drawer `dialog`; Escape resolves `false`
  - The existing replace and unmount cases stay unchanged. Update `ChunkRescueBanner.test.tsx` to query `alertdialog`.
  - `alert-dialog.tsx` gains an `onOverlayClick` prop on `AlertDialogContent` (D3). The mobile test also asserts focus lands inside the drawer.
  - Verify with those tests plus `EventLogSheet`, `RecentSessionsList`, `eventGenerateLatch`, `TeamCard`, `AdminUsersPage` and `HomeSettingsModal`.
- [ ] 3.3 `shared/ui/Popover.tsx` on the shadcn Popover. Keep `PopoverItem` verbatim (D5).
  - Test first: `shared/ui/Popover.test.tsx`:
    - an open popover is a `dialog` named by `ariaLabel`
    - `PopoverItem` roles and ARIA (`menuitemcheckbox` uses `aria-checked`, `option` uses `aria-selected`)
    - `danger` text wins over `selected`
  - Verify that test passes, plus `EventLogSheet`, `AdminUsersPage`, `RecentSessionsList` and `EventButtonsTable`.
- [ ] 3.4 `shared/ui/Tooltip.tsx` and `shared/ui/RadioGroup.tsx` on the shadcn primitives (D5).
  - Test first: `Tooltip.test.tsx` (opens on keyboard focus showing `content`; `disabled` renders the children bare) and `RadioGroup.test.tsx` (`radiogroup` named by `ariaLabel`; arrow keys loop; `onChange` fires with the value).
  - Verify those tests plus `TransportControls`, `EventButtonsTable` and `ExportFeed`.
- [ ] 3.5 `pages/index/components/Select.tsx` on the shadcn Select. `LazySelect` keeps its contract and the shared trigger classes (D5).
  - Test first: re-point the mount spy in `EventButtonsTable.lazyTypeSelect.test.tsx` to `@/shared/components/ui/select`'s `Select`. It fails while `Select.tsx` still uses `@radix-ui/react-select` (no mounts counted). It passes after the switch.
  - Add a parity case (R13): the inert trigger and the upgraded trigger have equal `className`, role, name, `aria-expanded` and `data-state`, and exactly one `svg` each.
  - Verify `lazyTypeSelect`, `BatchImportModal` (real options), `EventButtonsTable`, `EventLogRow`-based tests and `HomeSettingsModal`.
- [ ] 3.6 `shared/components/Toast.tsx` as a sonner facade with an unchanged API (D6).
  - Test first: rewrite `Toast.test.tsx` against the sonner DOM:
    - a toast queued before the host mounts shows
    - `hideToast` removes the newest persistent toast and keeps an error toast
    - `hideToast` with no persistent toast is a no-op
    - `toast.persistent` returns a number that `toast.dismiss` removes
    - a persistent toast created after other plain toasts isn't overwritten, and `hideToast` removes the right one (the panel's id-collision case)
  - Verify that test plus every suite that mocks `Toast` or `utils/toast` (they keep mocking the same module API).

## 4. Cleanup

- [ ] 4.1 Test first: `shadcnHygiene.repo.test.ts` bans `@radix-ui/react-*` imports. This fails until nothing imports them.
  - Remove `@radix-ui/react-{dialog,popover,radio-group,select,tooltip}` with `npm uninstall -w web …`.
  - Verify the hygiene test passes, `grep -c '@radix-ui/react-' web/package.json` prints `0`, and `npx vitest run`, `npm run lint` and `npm run typecheck` are green.

## 5. Integration: QA gate and checks

- [ ] 5.1 Copy the walk (`screens.sh`, `cap.sh`, `contrast.js`, `.gitignore`) from the archived `shadcn-foundation/qa`. Add these steps:
  - Settings → open the Suffix select listbox
  - hover the transport Roll tile for its tooltip

  Then run `QA_BASELINE=<archived>/qa/after-foundation ./screens.sh qa/after-wrappers` after `make dev-up`. Verify every `*.contrast.json` has `fails: 0` except the user-data "Audio issue", and record the per-screen diffs in `qa/README.md`.
- [ ] 5.2 The owner reviews the before/after pairs and does a dev-stack pass:
  - the mobile (390) Dialog drawer: drag-to-dismiss and its handle
  - a destructive confirm: AlertDialog on desktop, drawer on mobile; Escape, overlay and drag decline
  - Space, `+` and `1–9` yielding while a confirm is open
  - toast stacking

  Verify the result is recorded in `qa/README.md`.
- [ ] 5.3 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh` and `openspec validate shadcn-shared-wrappers --strict`. Verify every gate passes. The known storage "8 contending" flake is re-run, not counted.
