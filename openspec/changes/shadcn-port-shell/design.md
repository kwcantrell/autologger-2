# Design: shadcn port, shell

## Context

See proposal.md for the motivation. State as of 2026-10-06, from a three-agent read-only survey:

**What's already in place**
- Changes 1–2 themed `button` and the overlay primitives (dialog, alert-dialog, drawer, popover, tooltip, select) to V5 by replacing their base strings.
- The content primitives this change needs are still shadcn defaults: `input`, `textarea`, `label`, `field`, `alert`, `badge`, `empty`, `spinner` and `separator`. Examples are `rounded-md`, `bg-input/30`, `text-sm`, `border-dashed` on Empty, and `AlertTitle`'s `line-clamp-1`. `checkbox` doesn't exist yet.

**Legacy form vocabulary these surfaces use, from `tailwind.css`**
- `.profile-select`: `rgba(7,11,20,0.6)` background, a `--v5-border-strong` border, radius `0.6rem`, padding `0.5rem 0.65rem`, `margin-bottom: 1rem`. On focus the border is sky `0.55` and the background `0.75`.
- `.field`: a flex column with `gap: 0.35rem`. `.field span` is `0.8rem` in `--legacy-muted`.
- `.modal-hint`: `0.78rem`, line-height `1.45`, `--legacy-muted`, `margin-bottom: 0.65rem`.

**Constraints the surveys found**
- Load-bearing ids are everywhere: `v6-*`, `top-bar-search`, `home-*`, `login-*`, `team-*`, `session-route-*`, `root-gate-*`, `chunk-load-*`.
- Tests query those ids, plus role and name. A few also check class strings:
  - the live session row: `border-[#ef4444]!`, `text-[#ef4444]!`
  - the rail footer: `[.v6-app--rail-collapsed_&]:flex-col`
  - the Batch Import icon's path `d` values
- `contrastTokens.test.ts` regex-reads `const BTN_CREATE` from `LoginPage.tsx`.
- Two DOM shapes are pinned by tests:
  - The Teams error must be the only `role="alert"`, and its `textContent` must equal the error text exactly.
  - A no-access session row and the team owner row must contain **no** buttons.
- ARIA roles must hold. Not-found and archived states are polite `role="status"`; error states are `role="alert"`; the transcript-lock indicator is a polite status with an `aria-label`. shadcn `Alert` defaults to `role="alert"`, so using it on a status surface would make it assertive.

## Goals / Non-Goals

**Goals:**
- Every listed surface renders its controls through the shared layer, with the same ids, names, roles and V5 look.
- The content primitives are themed to V5 once, so 3b and 3c inherit that.

**Non-Goals:** see proposal.md.

## Decisions

**D1. Theme the content primitives to V5 first, replacing base strings as change 2 D1 did.**

| Primitive | V5 classes |
| --- | --- |
| `input`, `textarea` | the `.profile-select` look: `w-full rounded-[0.6rem] border border-v5-border-strong bg-[rgba(7,11,20,0.6)] px-[0.65rem] py-2 text-v5-text placeholder:text-[rgba(229,238,252,0.62)] focus-visible:border-[rgba(56,189,248,0.55)] focus-visible:bg-[rgba(7,11,20,0.75)] outline-none disabled:opacity-50`, plus `aria-invalid:border-destructive` |
| `label` and `FieldLabel` | `.field span`: `text-[0.8rem] text-v5-muted`. This uses muted 0.62 rather than `--legacy-muted` #9aa0a6, which fixes the AA floor as a side benefit. |
| `Field` | `flex flex-col gap-[0.35rem]`. Horizontal orientation is a row with `items-center gap-2`. |
| `FieldDescription` | `.modal-hint`: `text-[0.78rem] leading-[1.45] text-v5-muted` |
| `FieldError` | `text-[0.78rem] text-[#ff8a8a]`, the legacy error tint |
| `alert` | a glass surface (`glass-face-strong rounded-v5-md border border-v5-border-strong p-3 text-v5-text`). The destructive variant has a `border-danger` border and `#ffb4b4` text. `AlertTitle` drops `line-clamp-1`. |
| `badge` | outline: an uppercase `0.62rem` tracked pill, `border-v5-border-strong text-v5-muted`, matching the legacy RoleBadge |
| `empty` | no dashed border; centered, transparent; the caller supplies the surface |
| `spinner` | gains `motion-reduce:animate-none` (`web-ui-system` "Reduced-motion alternatives") |
| `separator` | `bg-v5-border-strong` |

- `checkbox` is added with `shadcn add checkbox`, then normalized: local `cn`, no `dark:`, and a V5 base with a sky checked state and a `--v5-border-strong` border.
- **Test:** the smoke test checks that none of these contents keep shadcn's leftover classes (`bg-input/30`, `rounded-md`, `border-dashed`, `line-clamp-1`), and that Checkbox is `role="checkbox"`, named by its label, and toggles.

**D2. One shared `RouteState` panel for SessionRoute and RootGate states (`pages/index/components/RouteState.tsx`).**
- Props: `id`, `role: 'status' | 'alert'`, `title`, `badge?`, `children` (the copy), `actions`, and **`frame: 'route' | 'gate'`**. The remaining props (`data-testid`, `data-variant`) pass through to the panel, because the tests query `chunk-load-error` and `data-variant="route"`.
- **It keeps the page frame.** `web-session-routing` "Deep-link resolution states" requires every resolution state to render inside the shared page frame, which reserves the height (CLS went from 0.123 to 0.001).
  - `frame="route"` wraps the panel in `ROUTE_STATE_PAGE`, which is exported from `RouteLoadingState.tsx`, the single source.
  - `frame="gate"` wraps it in RootGate's `GATE_PAGE`.
  - Test: the wrapper's `className` equals the exported constant for each frame. This is a deliberate class check, because nothing else pins the frame.
- It renders `Empty` with the given `role` and `id`, holding an `<h1 data-slot="empty-title">` with the League Gothic title classes. `EmptyTitle` is a `<div>`, but these titles are page headings.
- Actions are `Button`: primary for Try again or Restore, outline for Back to sessions.
- **The roles stay explicit.** Not-found and archived stay `status`, which is polite. Error stays `alert`. The panel is never shadcn `Alert`, so not-found stays "semantically distinct" from error, as `web-session-routing` "Deep-link resolution states" requires.
- **Imports:** `ChunkLoadBoundary`'s route variant also uses `RouteState`, which removes the copy-pasted `STATE_*` constants. Its comment explains the copy as avoiding an import cycle with SessionRoute. `RouteState` is a leaf module importing only `shared/*` and `RouteLoadingState`, so there's no cycle. `webBoundaries` checks the layering, not cycles; the leaf shape is what avoids one.
- **RootGate** lives in `pages/index` and uses `RouteState` the same way.

**D3. The session-row menu becomes DropdownMenu.**
- The trigger is `DropdownMenuTrigger asChild` around a `Button variant="ghost" size="icon-xs"` with lucide `MoreVertical`. It keeps `aria-label="Session options"`, the reveal classes and `data-open`, and its `stopPropagation` (the row is clickable).
- Items are `DropdownMenuItem`, with `variant="destructive"` on Delete. Their `onSelect` runs the existing handlers (`useConfirm` flows unchanged).
- **The row must ignore menu interactions.** Radix `DropdownMenuItem` renders a `<div role="menuitem">`, not a `<button>`. React events bubble through the portal to the row's `onClick`, whose guard is `target.closest('button, a, input, select, textarea')`. That guard doesn't match a div, so choosing Rename, Archive, Delete or Close session would *also* select the row and navigate; on mobile it would close the rail too. Today's `PopoverItem` is a `<button>`, so the guard catches it (panel critical finding).
  - The fix has two layers. `DropdownMenuContent` stops click and keydown propagation. The row's click and keydown guards also skip targets inside `[role="menu"], [role="menuitem"]` and any `button`, which covers Enter or Space on the trigger.
  - Tests: choosing an item by click and by keyboard, and pressing Enter on the trigger, must never call `onSelectSession`.
- **Added during implementation (task 3.3):**
  - The `dropdown-menu` primitive is themed to V5 the change-2 way. Its content and item base strings are replaced with the legacy Popover/PopoverItem classes (glass panel, `z-(--z-popover)`, item tints, destructive in red).
  - The row menu is **non-modal** (`modal={false}`). Its items open dialogs (rename and the themed confirms), and a modal Radix menu closing underneath a just-opened dialog leaves `pointer-events: none` stuck on `<body>`, a known Radix interaction. It is still `role="menu"`, with keyboard navigation and Escape, so `isOverlayOpen()` still sees it.
  - Proof that the guard matters: with it removed, the item-click and item-Enter tests fail (`2 failed`).
- Radix DropdownMenu opens on `pointerdown` or the keyboard, not on `click` (assumption B1). `RecentSessionsList.test.tsx`'s single open helper (L187) switches to `pointerDown`, and a new test opens the menu with Enter and checks `role="menu"`.
- `isOverlayOpen()` (change 2) already covers `role="menu"`, so shortcuts yield while it's open.

**D4. Login keeps its links and the Google branding.**
- The error banner becomes `Alert variant="destructive"` with `role="alert"`, the default, unchanged.
- Retry is `Button variant="link" asChild` around the existing `<a id="login-error-retry">`.
- Create-account is `Button variant="outline" asChild` around `<a id="login-btn-create-account">`, with `className={BTN_CREATE}`. The constant stays, because `contrastTokens.test.ts` reads it, and twMerge keeps its 0.78 label over the outline label colour (assumption B4).
- The Google `<a id="login-btn-google">` is untouched.
- The divider is two `Separator`s plus the label.

**D5. Teams.**
- `CreateTeamForm` and TeamCard's rename and invite forms use `Field`/`FieldLabel`/`Input`/`FieldDescription`, keeping the label texts the tests query.
- Errors render through `Alert variant="destructive"` with **no `AlertTitle`**, never `FieldError` alongside it, because `FieldError` is also `role="alert"` and the tests require exactly one, as `<Alert>{text}</Alert>`. The test's `getByRole('alert').textContent` equality then still holds, and there's only one alert.
- The orphaned notice is `<Alert role="status">` with its exact text.
- RoleBadge is `Badge variant="outline"`. It isn't a button, so the owner row stays buttonless.
- Actions:
  - Make admin, Make member, Transfer ownership, Invite, Revoke and Show access are outline.
  - Save name and Create team are default.
  - Remove, Delete team and Leave team are destructive.
- The show-access picker is `FieldSet` with an `sr-only` `FieldLegend`, holding `Field orientation="horizontal"` with `Checkbox` + `FieldLabel` per show. The name is the show name, as the tests require.
  - The Radix Checkbox is a `<button role="checkbox">` with no `.checked` property. `TeamCard.test.tsx` L270–271 asserts `(el as HTMLInputElement).checked`, so those assertions become `aria-checked`.
  - The owner and admin rows have no checkboxes, so their "no buttons" checks are unaffected (panel scratch: `CB buttons in row 0`).
- Loading is `<Spinner aria-hidden />` plus the existing text, so no second `role="status"`.

**D6. Rail, home and the rescue banner.**
- **Icons:** lucide replaces the inline SVGs. Batch Import is `Upload`, which keeps the spec's "up-arrow (upload) affordance", and the test checks `svg.lucide-upload`.
- **Controls:** the clear-search and search-toggle buttons are `Button variant="ghost"` at icon sizes, keeping the `<button>` element. The mobile hamburger (`AppShell`) is `Button variant="outline" size="icon-lg" className="md:hidden size-11"`.
- **Untouched:** the rail chrome, the footer layout classes, and the resume card.
- **ChunkRescueBanner:** `Alert variant="destructive"` with fixed positioning via `className`, keeping `role="alert"` and `aria-live="assertive"`.
  - The headline is `AlertDescription`, not `AlertTitle`, so the long sentence isn't clamped.
  - Row buttons are `Button size="sm"`: outline for Retry, Download and Retry all; destructive for Discard and Discard remaining.
  - It stays off the toast system.

## Assumptions (each tested)

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| B1 | Radix DropdownMenu does **not** open on a `click` in jsdom | scratch `assume/a3.test.tsx` with `--disableConsoleIntercept` | `B1 click opens: false` |
| B2 | It opens on `pointerDown` (button 0) and on Enter, rendering `role="menu"` | same | `B2 pointerdown opens: true`; `B2b Enter opens: true menu role: true` |
| B3 | `Alert role="status"` overrides the default alert role | same | test passed: `getByRole('status')`, no `alert` |
| B4 | `cn(buttonVariants({variant:'outline'}), BTN_CREATE-colour)` keeps the 0.78 label | same | `B4 has 0.78: true has 0.92: false` |
| B5 | `shadcn add checkbox` creates one file and needs no new package beyond `radix-ui` (`cn` is stripped as in change 1) | `npx shadcn@latest add checkbox --dry-run` | `+ src/shared/components/ui/checkbox.tsx`; deps `cn radix-ui` |
| B6 | The menu tests open the row menu through one helper | `grep -n "Session options" RecentSessionsList.test.tsx` | only L187 clicks it |
| B7 | `EmptyTitle` is a `<div>`, so the route titles need an explicit `<h1>` | `grep -n "function EmptyTitle" -A8 empty.tsx` | `<div data-slot="empty-title" …>` |

## Risks / Trade-offs

- **[Theming Input/Field changes every future form's look, not just these surfaces]** → D1 copies the legacy `.profile-select`/`.field` values, so ported forms match unported ones. The QA walk covers New Session, Settings and Teams.
- **[DropdownMenu traps focus and is modal]** → that's standard menu behaviour, and shortcuts already yield to `role="menu"`. Escape returns focus to the trigger.
- **[Merging route states into `RouteState` changes DOM structure]** → ids, roles, headings and button names are preserved, and the SessionRoute, RootGate and ChunkLoadBoundary suites stay green.
- **[The rescue banner can only be checked by hand]** → it can't be triggered in the dev stack without a failed upload. Its unit suite (11 cases) stays green, and the owner checks it only if a failure can be forced.

## Migration Plan

Web only. Rollback is reverting the branch.
