# Design: shadcn shared wrappers

## Context

See proposal.md for the motivation. The current state, from the exploration on 2026-10-06:

**Wrappers and consumers**
- The five legacy Radix packages are imported only by the wrappers: `shared/ui/{Dialog,Popover,Tooltip,RadioGroup}.tsx` and `pages/index/components/Select.tsx`. One test also imports one of them, `EventButtonsTable.lazyTypeSelect.test.tsx:44`, which mocks `@radix-ui/react-select` to count mounts.
- Consumers: `Dialog` has 11 files and 12 instances. `useConfirm` has 7 files and 16 `confirm()` calls, plus one direct `<ConfirmDialog>` in `SessionWorkspace.tsx:406` for orphan recovery. There are 6 Popovers across 4 files and 5 Tooltip files; RadioGroup has one consumer. `Select` is used directly in 4 files and `LazySelect` in 2 files. `showToast` is called 42 times and `toast.error` 6 times, with one persistent toast and its `hideToast()` (AudioSaveOverlay). The toast host is mounted 3 times (AppShell ×2, AdminUsersPage).
- `Dialog.tsx` builds the mobile sheet by hand (`useSheetDrag`). It dismisses at 100px, or at 48px with velocity above 0.6px/ms. It centres the desktop card with the `transform` property, because consumers override that with `md:![transform:…]` and the `content-fade-in` keyframe animates `transform`.
- `useConfirm` resolves a replaced or unmounted pending confirm as `false` (`ConfirmDialog.tsx:81-105`, tested in `ConfirmDialog.test.tsx:56-78`).

**Shortcut handlers**
- All four detect an open dialog with exactly `document.querySelector('[role="dialog"]')`: `AudioPlayer.tsx:367`, `useZoomRail.ts:792`, `CategoryButtonStrip.tsx:292` and `SessionWorkspace.tsx:137`.
- The handler tests append a fake `div[role=dialog]`: `CategoryButtonStrip.test.tsx:111`, `AudioPlayer.test.tsx:194`, `useZoomRail.test.tsx:85`. The `?` handler has no test.

**shadcn primitives (`shared/components/ui`)**
- Their defaults are `z-50`, `translate-x/y-[-50%]` centring and tw-animate `zoom-in`, and `DialogContent` adds a "Close" button by default. A second "Close" button would break `BatchImportModal.test.tsx:91`.

## Goals / Non-Goals

**Goals:**
- Every overlay renders through a shadcn primitive.
- Consumer call sites and tests stay unchanged, except for the few tests named in tasks.md that assert on a role or a mocked package.
- The legacy Radix packages are removed.

**Non-Goals:** see proposal.md. In particular, menus stay as `Popover` plus `PopoverItem` until change 3.

## Decisions

**D1. The V5 look lives in the primitives, not the wrappers.**
- We own the copies in `shared/components/ui`, so the overlay styling moves into them:

  | Primitive | V5 classes |
  | --- | --- |
  | dialog and alert-dialog overlay | `z-(--z-dialog-overlay) bg-[rgba(8,10,14,0.72)] data-[state=open]:animate-overlay-fade-in` |
  | dialog and alert-dialog content | `glass-panel z-(--z-dialog-content) rounded-v5-lg w-[min(100%,32rem)] max-h-[90vh] translate-none [transform:translate(-50%,-50%)] data-[state=open]:animate-content-fade-in` |
  | drawer | `glass-face-strong panel-elevate`, the V5 handle, safe-area padding |
  | popover | `glass-panel z-(--z-popover) rounded-v5-md p-[0.35rem] animate-popover-fade-in` |
  | tooltip | `glass-panel z-(--z-top-float) max-w-[22rem] rounded-v5-sm animate-tooltip-fade-in`, with the arrow fill and stroke from the legacy Tooltip |
  | select | content `glass-panel z-(--z-top-float)`; trigger and item states from the legacy `SELECT_TRIGGER_CLASSNAME` and item classes |

- `showCloseButton` defaults to `false`.
- **Each primitive's base class string is replaced, not appended to.** The panel showed that twMerge keeps shadcn's `sm:max-w-lg`, `max-w-[calc(100%-2rem)]`, `grid gap-4 p-6`, `bg-background border rounded-lg` and `zoom-in-95` next to the V5 classes. `sm:max-w-lg` would cap `EventGenerateCustomModal`'s and `EventOptionsModal`'s `md:!w-…`, and `bg-background` would race `glass-panel`. The replacement strings carry only the legacy wrapper classes. The legacy dialog had no max-width; it was `w-[min(100%,32rem)]` with no cap.
- **Test:** the smoke test renders `DialogContent` with `className="md:!w-[min(38rem,96vw)]"` and asserts that no `max-w-` and no `bg-background` class remains. This is a deliberate class assertion, guarding one specific regression.
- Wrappers only map their props.
- Alternative rejected: keeping the shadcn defaults and overriding them in every wrapper. That means fighting `translate` against `transform` and `z-50` against the z-index variables in every wrapper, and every future direct use of the primitive (change 3) would need the same overrides.

**D2. Dialog: shadcn Dialog on desktop, vaul Drawer on mobile.**
- `useIsMobile()` picks `Drawer` (`direction="bottom"`) or `Dialog`. vaul handles drag-to-dismiss, replacing `useSheetDrag` and its tuned thresholds.
- Prop mapping:

  | Prop | Desktop | Mobile |
  | --- | --- | --- |
  | `title` | `DialogTitle`; `hideTitle` makes it `sr-only` | `DrawerTitle`; `hideTitle` makes it `sr-only` |
  | `description` | `DialogDescription`; when absent, `aria-describedby={undefined}` | `DrawerDescription`; same |
  | `closeOnOverlayClick={false}` | `onPointerDownOutside`/`onInteractOutside` call `preventDefault` | `dismissible={false}` |

- The only `closeOnOverlayClick={false}` user is YouTubeImportErrorModal, whose `onOpenChange` is already a no-op, so vaul also blocking Escape when not dismissible changes nothing.
- `className` passes through to the content, so the consumers' `md:!` and `max-md:!` overrides still apply.
- **Focus:** `autoFocus` is set on the Drawer root. vaul defaults it to `false` and calls `preventDefault` on `onOpenAutoFocus`, which leaves focus on the trigger behind the sheet. Enter or Space would then re-fire it, for example opening a second confirm that replaces the first. With `autoFocus` on, mobile behaves like the legacy Radix sheet: focus moves into the dialog.
- **Handle-only drag:** `handleOnly` is set and the drag handle is vaul's `Drawer.Handle`. This matches the legacy `useSheetDrag`, which only listened on the handle; vaul's default would make the whole sheet draggable. Scrollable sheets such as HomeSettingsModal keep their content scrolling.
- **Vetoed close resets the sheet in place, with no remount.** If a consumer vetoes `onOpenChange(false)` (HomeSettingsModal's dirty → "Keep editing"), vaul's `closeDrawer()` leaves the sheet at its dragged translate without calling its private `resetDrawer()`. The wrapper does what `resetDrawer()` does: when the drawer reports a close but `open` stays `true`, it sets `transform: translate3d(0,0,0)` with vaul's settle transition on the content ref, then clears it once the transition ends.
  - It does **not** re-key or remount the content. The re-panel showed a remount discards child state, including the open confirm inside Settings, resets scroll, and replays vaul's `slideFromBottom` entry animation.
  - When nothing was dragged (an Escape veto), the reset is a no-op.
- **Known behaviour:**
  - On a non-dismissible drawer, tapping the handle still calls `onOpenChange(false)`. vaul does this; its code is `if (!dismissible) closeDrawer()`. The only user, YouTubeImportErrorModal, ignores it.
  - After a nested sheet closes, vaul sets `body.style.pointerEvents='auto'` while the outer modal is still open. The outer overlay still covers the page, so this is accepted.
- **Trade-off:** vaul's drag feel differs slightly from the hand-tuned one. The owner checks it in the dev-stack pass.

**D3. ConfirmDialog: AlertDialog on desktop, Drawer on mobile, same `useConfirm`.**
- On desktop it uses `AlertDialog`: `AlertDialogTitle`, `AlertDialogDescription` (the message, inside the existing `modal-lead` markup), `AlertDialogCancel` and `AlertDialogAction`.
- The buttons use the shared `Button` (`variant="outline"` for cancel; `variant="destructive"` when `danger`, otherwise `"default"`).
- `onOpenChange(false)` calls `onCancel`, so Escape declines. Radix AlertDialog doesn't dismiss on an overlay click, but the spec says overlay dismissal declines. So the overlay gets an `onClick` that calls `onCancel`, which keeps today's behaviour. shadcn's `AlertDialogContent` renders its own overlay with no handler hook, so `alert-dialog.tsx` gains an `onOverlayClick` prop on `AlertDialogContent`, passed to its overlay. The panel verified that the overlay click fires (`pointer-events: auto` on the overlay).
- On mobile it uses the D2 Drawer with the same body. Drag or Escape calls `onCancel`, which satisfies R2's "mobile sheet drag-dismiss resolves as decline".
- The `useConfirm` hook body is untouched.

**D3b. `useTextPrompt()`, a shared themed text input.**
- `shared/ui/PromptDialog.tsx` exports `useTextPrompt()`, which returns `{ requestText(opts): Promise<string | null>, promptElement }`. The options are `{ title, label, placeholder?, initialValue?, submitLabel = 'OK', cancelLabel = 'Cancel', description? }`.
- It renders through the D2 `Dialog` (Dialog on desktop, Drawer on mobile), with a labelled `<input>` and Cancel/Submit buttons. Enter submits.
- It copies `useConfirm`'s semantics: Cancel, Escape, overlay, drag, replacement by a newer request, or unmount all resolve `null`. Submit resolves the raw string, and the caller trims it.
- The name avoids `prompt(`, so the D7 guard needs no exception.
- Nesting is fine: the prompt opens inside BatchImportModal's own Dialog or Drawer. The re-panel verified that Escape closes only the inner dialog, the outer stays open, and focus lands in the input; `Drawer.NestedRoot` isn't needed. When the prompt closes, focus goes to `body`, as with `useConfirm` today, because neither has a Radix trigger to return focus to.
- `BatchImportModal.handleImportLogs` becomes `const raw = await requestText({ title: 'Import logs', label: 'Public Google Sheets URL (anyone with the link can view)' })` with the same `null`/trim handling. Its test drives the dialog instead of spying on `window.prompt`.
- Alternative rejected: keeping the confirm on Dialog (`role="dialog"`). It avoids the guard change, but screen readers lose the alert-dialog semantics. The owner chose the shared guard instead.

**D4. One shared overlay guard.**
- `shared/ui/overlayOpen.ts` exports `isOverlayOpen(root: ParentNode = document): boolean`, which returns `root.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]') !== null`.
- Radix renders `role="menu"` content only while a menu is open, so a closed menu never matches. Legacy `PopoverItem`s live in a Popover, which is `role="dialog"`, so open popover menus keep blocking shortcuts as they do today.
- The four handlers call `isOverlayOpen()` instead of their inline selector.
- The hand-built `role="dialog"` in `AudioSaveOverlay` and `CatalogPicker` still match.

**D5. Popover, Tooltip, RadioGroup and Select keep their exact props.**
- **Popover:** `PopoverPrimitive` Root, Trigger (`asChild={triggerAsChild}`) and Content, with `side`, `align`, `sideOffset` and `collisionPadding={8}`, and `aria-label={ariaLabel}`.
  - `PopoverItem` is copied verbatim, keeping its class order (danger beats selected, `aria-checked:` tints). `EventLogSheet.test.tsx:316-322` asserts that order.
- **Tooltip:** shadcn `Tooltip`, `TooltipTrigger asChild` and `TooltipContent`.
  - Keeps `disabled` (renders the children bare) and `delayDuration`.
  - `TooltipProvider` is re-exported from the primitive.
  - Opening on focus is Radix behaviour (assumption A5).
- **RadioGroup:** the shadcn `RadioGroup` root (`loop`), with `RadioGroupPrimitive.Item` carrying the label text and `itemClassName(value, checked)`. There's no indicator circle, so the pill look is unchanged.
- **Select:** built from the shadcn `Select`, `SelectTrigger` (`ref` forwarded), `SelectValue`, `SelectContent` (`position="popper"`, `sideOffset={4}`, `collisionPadding={8}`) and `SelectItem`.
  - Keeps `defaultOpen` and `onOpenChange`; EventLogRow pins its virtual row with `onOpenChange`.
  - `SELECT_TRIGGER_CLASSNAME` and `SELECT_ICON_CLASSNAME` stay exported, now matching the primitive's trigger.
  - `SelectChevronIcon` becomes lucide `ChevronDownIcon`, still `aria-hidden`.
- **LazySelect:** logic unchanged.
- **Inert and mounted triggers are identical** (R13). `select.tsx`'s `SelectTrigger` base string is replaced with the V5 trigger classes, and it's exported as `SELECT_TRIGGER_CLASSNAME`, the single source. Its built-in chevron is the only icon, exported as `SelectTriggerIcon`. `Select.tsx` re-exports both under the legacy names and doesn't add its own icon. `LazySelect`'s inert button renders the same class string and the same `SelectTriggerIcon`.
- **Test:** the inert trigger and the upgraded trigger have equal `className`, equal role, name, `aria-expanded` and `data-state`, and exactly one `svg` each.

**D6. Toast facade over sonner.**
- `Toast.tsx` keeps every export:

  | Export | sonner call |
  | --- | --- |
  | `showToast(msg, isError, { persistent })` | `isError` → `toast.error(msg, { duration: 3200 })`; persistent → `toast(msg, { duration: Infinity })`, pushing the id that sonner **returns** onto a module stack (custom ids would collide with sonner's own counter, which starts at 1, as the panel showed); otherwise `toast(msg, { duration: 3200 })` |
  | `hideToast()` | pops the newest persistent id and calls `toast.dismiss(id)`; does nothing if the stack is empty |
  | `toast.success`, `toast.error` | the same calls |
  | `toast.persistent` | still returns a `number`: the facade's own counter, mapped to the id sonner returned (sonner's ids are never chosen by us, so nothing collides) |
  | `toast.dismiss(id)` | looks up sonner's id through the map, calls `toast.dismiss` with it, and removes the entry from the stack |

- The `<Toast/>` host renders the shared dark `<Toaster position="bottom-right" toastOptions={{ classNames }} />`. The V5 classes are `glass-face-strong`, a `--v5-border` border, and error `border-danger text-[#ffb4b4]`, with the container at `z-(--z-toast)`.
- sonner keeps toasts created before the host mounts (assumption A1), so the old "queued before mount" behaviour holds.
- The `id="toast-queue"` `<output>` goes away, and sonner's own live region replaces it. No test or CSS targets `#toast-queue`.

**D7. Guards.**
- **`noBrowserDialogs.repo.test.ts`** scans `web/src` source files (not tests), with comment lines stripped. It fails on:
  - `\bwindow\.(confirm|prompt)\s*\(`
  - a bare `(?<![\w.])(confirm|prompt)\s*\(`, unless `confirm` is the local returned by `useConfirm()`

  The local-`confirm` exception: a file that destructures `confirm` from `useConfirm()` (for example `const { confirm, confirmElement } = useConfirm()`), or defines `confirm` in `ConfirmDialog.tsx`, is allowed bare `confirm(` calls. The `prompt(` ban has no exception. The detector is unit-tested on fixture strings, as `noAgentAuthoredMarkup` does.
- **`shadcnHygiene.repo.test.ts`** gains: no import from `@radix-ui/react-*` anywhere in `web/src`.

## Assumptions (each tested)

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | sonner shows a toast created before `<Toaster/>` mounts | scratch vitest (`scratchpad/assume/assume.test.tsx`): `toast('early bird')`, then render `Toaster` | `✓ A1 …`, `Tests 4 passed (4)` |
| A2 | the id sonner **returns** for a `duration: Infinity` toast survives other auto-id toasts, and `toast.dismiss(thatId)` removes only it. Custom numeric ids collide with sonner's counter (panel finding). | scratch `assume/a2.test.tsx`: `toast('auto one')`, then the persistent toast, `toast('auto two')`, `toast.error(…)`, then `dismiss(returned)` | `Tests 1 passed (1)`: all present, then only the persistent toast removed |
| A3 | vaul Drawer renders `role="dialog"` named by its title | `npx vitest run src/shared/components/ui/primitives.smoke.test.tsx` (change 1) | `✓ drawer opens with an accessible name` |
| A4 | shadcn AlertDialog renders `role="alertdialog"` | same smoke test | `✓ alert-dialog opens as an alertdialog with an accessible name` |
| A5 | the shadcn Tooltip opens on keyboard focus | scratch vitest A5 | `✓ A5` |
| A6 | Escape on a vaul Drawer calls `onOpenChange(false)` | scratch vitest A9 | `✓ A9` |
| A7 | only the wrappers and one test import the legacy packages | `grep -rln "@radix-ui/react-" web/src` | `Select.tsx`, `Tooltip.tsx`, `RadioGroup.tsx`, `Dialog.tsx`, `Popover.tsx`, `lazyTypeSelect.test.tsx` (plus a comment in `EventLogSheet.test.tsx`) |
| A8 | the four handlers use the inline `[role="dialog"]` selector | exploration (`AudioPlayer.tsx:367`, `useZoomRail.ts:792`, `CategoryButtonStrip.tsx:292`, `SessionWorkspace.tsx:137`) | `document.querySelector('[role="dialog"]')` in each |
| A10 | the AlertDialog overlay click fires, `danger` maps to destructive, and vaul `dismissible={false}` blocks Escape/overlay while a vetoed close keeps it open | panel scratch `alert.test.tsx` / `vaul.test.tsx` | `overlay style: pointer-events: auto`; `action data-variant: destructive`; `dismissible=false calls: []`; veto `data-state: open` |
| A9 | only two specs name `[role="dialog"]` | `grep -n 'role="dialog"' openspec/specs/*/spec.md` | `web-ui-system/spec.md:82`, `web-session-console/spec.md:106` |

## Risks / Trade-offs

- **[A primitive restyle changes every dialog's look slightly]** → QA walk against the `after-foundation` captures, with a diff per screen, then the owner's review.
- **[vaul drag feels different, or `dismissible={false}` blocks Escape]** → the owner's dev-stack pass at 390. The only non-dismissible user already ignores close.
- **[ConfirmDialog tests that mock `Dialog` no longer mock the confirm]** (`HomeSettingsModal.test.tsx:80`, `NewSessionModal.test.tsx:29`) → those tests only assert that the confirm text is absent, so they keep passing. The full suite runs per task.
- **[sonner collapses toasts after 3, unlike the legacy stack that showed all of them]** → the owner accepted this.
- **[Radix `DismissableLayer` Escape handling]** (`EventLogSheet.test.tsx:16-20`, `EventLogSheet.tsx:840-848`) → AlertDialog uses the same layer. The existing Escape-guard test must stay green.

## Migration Plan

Web only. The legacy packages are removed in the last task, after nothing imports them. Rollback is reverting the branch.
