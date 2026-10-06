# shadcn shared wrappers: rebuild the overlay, select and toast wrappers on the shadcn primitives

Tier: 1
Tier reason: web-only refactor of shared UI wrappers behind unchanged public APIs. It touches no `high_risk_paths`, wire contract, auth or data. The destructive-confirm decline semantics are preserved and test-pinned.

Approved-by: Kalen 2026-10-06

## Why

`shadcn-foundation` installed the shadcn primitives, but nothing uses them yet. Every dialog, confirm, popover, tooltip, select and toast in the app still goes through hand-built wrappers on five individual `@radix-ui/react-*` packages, including a hand-rolled mobile sheet drag and a hand-rolled toast store. This change moves those wrappers onto the primitives so that later surface ports (change 3) and Supabase slice 7c-2's overwrite dialog build on one component system.

## What Changes

**V5 overlay styling, moved into our copies of the primitives** (`shared/components/ui/{dialog,alert-dialog,drawer,popover,tooltip,select}.tsx`):
- the app's z-index scale, glass surfaces and fade keyframes
- the legacy `transform` centring, which consumers override
- no default close button

**The ten wrappers rebuilt on those primitives, with unchanged public APIs:**
- `shared/ui/Dialog.tsx`: shadcn Dialog on desktop, vaul Drawer on mobile. This replaces the hand-built sheet drag.
- `shared/ui/ConfirmDialog.tsx` / `useConfirm`: AlertDialog on desktop, Drawer on mobile.
  - `danger` maps to the destructive Button.
  - Escape, overlay click and drag decline.
  - The replace and unmount decline semantics are unchanged.
- `shared/ui/Popover.tsx`: rebuilt on the shadcn Popover. `PopoverItem` is unchanged; moving menus to DropdownMenu is change 3.
- `shared/ui/Tooltip.tsx`, `shared/ui/RadioGroup.tsx`: rebuilt on the shadcn primitives.
- `pages/index/components/Select.tsx`: rebuilt on the shadcn Select. `LazySelect.tsx` keeps its inert-trigger contract; `FpsSelect.tsx` is untouched.
- `shared/components/Toast.tsx`: `showToast`/`hideToast`/`toast.*` become a facade over sonner.
  - Same signatures, a 3.2s duration, error toasts in V5 red.
  - Persistent toasts never time out, and `hideToast()` dismisses the newest one.
  - Older toasts collapse into sonner's standard stack.

**Global single-key shortcuts** (Space, `+`/`−`, `1–9`, `?`):
- They yield to any open dialog, alert dialog or menu through one shared `isOverlayOpen()` helper. Today they check only `[role="dialog"]`, which an AlertDialog (`role="alertdialog"`) wouldn't match.

**Shared text-input prompt:** a new `useTextPrompt()` hook (`shared/ui/PromptDialog.tsx`) on the same Dialog/Drawer, with `useConfirm`'s decline semantics: cancel, Escape, replace or unmount resolve `null`. `BatchImportModal` switches its Google Sheets URL entry from `window.prompt` to it. That's a live violation of the existing no-browser-prompt rule, which the panel found.

**New repo guards:**
- browser `window.confirm`/`window.prompt` and the bare `confirm()`/`prompt()` globals are banned. The spec already forbids them, but nothing enforced it.
- importing the retired `@radix-ui/react-*` packages is banned.

**Dependencies:** `@radix-ui/react-{dialog,popover,radio-group,select,tooltip}` are removed. The `radix-ui` package covers them.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-ui-system`:
  - **"Themed confirmations replace browser chrome":** the confirm is described as "alert dialog on desktop, bottom sheet on mobile" instead of "built on the app's Radix Dialog vocabulary". The no-browser-confirm scenario now names the enforcing repo test.
  - **"Global single-key handlers yield to dialogs and interactive targets":** "any `[role="dialog"]`" becomes "any open dialog, alert dialog, or menu". Adds a scenario for an open alert dialog.
- `web-session-console`:
  - **"Logging hotkeys 1–9":** the same rewording of the open-dialog suppression.

## Non-goals

- Moving `PopoverItem` menus to DropdownMenu, or porting any consumer surface. That's change 3.
- Any change to consumer call sites, except `BatchImportModal`'s `window.prompt` (above). The others keep the same imports and props. Settings' existing Add-Show dialog stays as it is until change 3.
- Restyling ChunkRescueBanner, which stays off the toast system per `live-recording-chunks`.
- Slice 7c-2's overwrite dialog itself.
- Server, contract or AI work.

## Impact

- **Wrappers:** `web/src/shared/ui/{Dialog,ConfirmDialog,Popover,Tooltip,RadioGroup}.tsx`, plus the new `overlayOpen.ts` and `PromptDialog.tsx`.
- **The one consumer change:** `web/src/pages/index/components/BatchImportModal.tsx` and its test.
- **Select, toast and the four shortcut handlers:**
  - `web/src/pages/index/components/{Select,LazySelect}.tsx`
  - `web/src/shared/components/Toast.tsx`
  - the handlers in `AudioPlayer.tsx`, `useZoomRail.ts`, `CategoryButtonStrip.tsx` and `SessionWorkspace.tsx`
- **Primitives:** `web/src/shared/components/ui/{dialog,alert-dialog,drawer,popover,tooltip,select}.tsx`.
- **Tests:**
  - updated to query roles: `ChunkRescueBanner.test.tsx` (alertdialog), `Toast.test.tsx` (sonner DOM)
  - mount spy re-pointed: `EventButtonsTable.lazyTypeSelect.test.tsx`
  - new: `overlayOpen.test.ts`, `noBrowserDialogs.repo.test.ts`, and mobile-path tests for Dialog and useConfirm
- **Visual:** every dialog, popover, tooltip, select listbox and toast in the app now renders through the new primitives. The QA walk compares against the `shadcn-foundation` `after-foundation` captures.
- **Dependencies:** five packages removed, none added.
