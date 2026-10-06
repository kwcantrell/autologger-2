# shadcn port, shell: rail, home, recent sessions, login, teams, and rescue/route states on shadcn components

Tier: 1
Tier reason: web-only presentation port onto the shared shadcn layer, inside existing contracts. It touches no `high_risk_paths`, wire format, auth or data, and no spec-level behaviour changes.

Approved-by: Kalen 2026-10-06

## Why

Changes 1–2 (`shadcn-foundation`, `shadcn-shared-wrappers`) put the V5-themed shadcn primitives and the shared wrappers in place, but the app's own surfaces still hand-build their controls. They use legacy `.btn`/`.btn primary`/`.btn danger`, `label.field` + `input.profile-select`, `.modal-hint` text, hand-drawn SVG icons, and copy-pasted route-state panels. This change ports the app shell's surfaces onto the shared components, so they share one vocabulary and later legacy-CSS removal (3c) is possible.

## What Changes

**Rail and mobile nav** (`V6Rail.tsx`, `AppShell.tsx`)
- The 7 hand-drawn SVGs become lucide icons: `Menu`, `Plus`, `Upload`, `Search`, `X`, `Users`, `Settings`.
- The clear-search, search-toggle and mobile "Open navigation" controls become `Button`.
- The rail's bespoke chrome stays, by owner decision: the collapse tile, mixed-case nav buttons, off-canvas drawer and glass shelves.

**Home** (`HomeRoute.tsx`)
- New Session becomes `Button`: outline when there's a recent session, primary otherwise. Its icon becomes lucide `Plus`.
- The resume card's arrow becomes lucide `ArrowRight`.

**Recent sessions** (`RecentSessionsList.tsx`)
- The session-row `⋮` menu moves from `Popover` + `PopoverItem` to shadcn **`DropdownMenu`**, with a `MoreVertical` trigger. This adds real menu keyboard behaviour: arrow keys, typeahead and `role="menu"`.
- The rename dialog uses `Field`/`Input`/`Button`, which also gives the input an accessible name.

**Login** (`LoginPage.tsx`)
- The error banner becomes a destructive `Alert`, with a link-variant retry.
- The divider becomes `Separator`.
- Create-account becomes an outline `Button` around the existing link.
- The Google sign-in button is unchanged (Google branding).

**Teams** (`TeamsRoute.tsx`, `TeamCard.tsx`, `CreateTeamForm.tsx`, `OnboardingPanel.tsx`)
- Forms use `Field`/`Input`/`FieldDescription`. Errors render as a single destructive `Alert`.
- Actions use `Button` variants.
- RoleBadge becomes `Badge`.
- The empty state becomes `Empty`.
- Notices and errors become `Alert`. The no-owner notice keeps `role="status"`.
- Loading shows a `Spinner`.
- The show-access picker uses a new **`Checkbox`** primitive.

**Rescue and route states**
- `ChunkRescueBanner` becomes a destructive `Alert`. It stays persistent, recorder-owned and off the toast system.
- `ChunkLoadBoundary`: the overlay variant becomes `Alert` and the route variant `Empty`.
- `SessionRoute`'s not-found, error and archived states, and `RootGate`'s error, become one shared `RouteState` panel on `Empty` + `Button`. Each keeps its role: not-found and archived stay `status`, error stays `alert`.

**New primitive:** `shared/components/ui/checkbox.tsx`, normalized to V5 like the change 1 primitives.

Every existing element id, test id, label text, accessible name and live-region role is preserved.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This is a presentation port; every spec obligation on these surfaces holds unchanged. The `.openspec.yaml` declares `skip_specs: true`.

## Non-goals

- `/admin/users`: out of scope, because the owner is removing it.
- The workspace surfaces, their Event-feed menus and OverlayScrollbars. That's change 3b.
- Settings and modal forms. That's change 3c, which also removes the legacy `.btn`/`.field`/`.profile-select`/`.modal-hint` CSS once nothing uses it. This change deletes no CSS.
- Dashboards and charts. That's change 3d.
- Restyling the rail chrome, the session-row glass cards, the resume card, the Google button, or the brand loading video. AppLoadingSkeleton and RouteLoadingState stay unchanged (parity test and spec same-markup rule).
- The brand loading video's missing reduced-motion alternative: a pre-existing `web-ui-system` gap, recorded as a follow-up.

## Impact

- **Code:** the eleven surface files above, plus a new `checkbox.tsx` and a new shared `RouteState` component.
- **Tests:** existing suites keep their id, name and role queries. Four updates:
  - `RecentSessionsList.test.tsx` opens the menu with `pointerDown`. Radix DropdownMenu opens on pointer-down, not click; the change from Popover is the reason.
  - `V6Rail.test.tsx` checks the Batch Import icon is lucide `upload` instead of hand path values.
  - `TeamCard.test.tsx` L270–271 reads `aria-checked` instead of `.checked`, because the Radix Checkbox is a button.
  - New role/name tests are added for each port.
- **Dependencies:** none added. `radix-ui` already covers the Checkbox.
- **Visual:** small drift where hand-built controls become shared ones. The QA walk compares against the `shadcn-shared-wrappers` captures.
