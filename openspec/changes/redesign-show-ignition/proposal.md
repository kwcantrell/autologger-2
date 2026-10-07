# Show Ignition: a flat dark redesign of the console, rail and Settings

Tier: 1
Tier reason: a web-only redesign inside existing contracts. It touches no `high_risk_paths`. Every action uses an existing endpoint, no client route is added or removed, and no wire format, auth or data handling changes. The spec deltas rewrite UI requirements that name the V5 glass vocabulary, the Settings modal and the `/teams` page.

Approved-by: Kalen 2026-10-07

## Why

The V5 dark-glass UI has drifted.
- **Team and show switching** lives only in the Settings modal header, so the console never says whose session you are in.
- **Team management** is a separate, sparse `/teams` page that duplicates parts of Settings.
- **Settings** is one long modal of tabs, two of them empty (Auto Sync is a placeholder and Debug is an unused mount).
- **The event feed header miscounts:** "2 events" over 10 rows, because it counts non-internal events while listing internal ones too.

PRODUCT.md now lists production companies as the primary users: producers move across teams and shows, and loggers need recording state to be unmistakable. The owner iterated a replacement in an interactive preview, called Show Ignition, and chose it.

## What Changes

**Look (whole app)**
- The V5 glass vocabulary is replaced by **Show Ignition**:
  - flat dark surfaces;
  - one accent (`#5b7cff`);
  - one control height and one corner radius for controls, another for cards;
  - one selected state: an accent tint with a 1px inset line;
  - sentence-case buttons, with uppercase kept for labels, tabs and status only.
- **Ignition.** While the session is live (recording audio, or timecode rolling), the top bar, rail and transport tint deeper toward the accent and carry a soft glow. Playback uses a softer tint, and stopped is muted. A REC / ROLLING / PLAY / STOPPED label is always shown, so colour is never the only channel. Reduced motion removes the blinking and the transitions.

**Shell**
- **New top bar:** `Team ▾ › Show ▾ › status`.
  - The team and show menus switch the active team and show directly, replacing the Settings-header selects. The show menu lists names only; per-show session counts would need a new endpoint.
  - The status names the open session and returns to it.
  - There is no wordmark and no Team/Show labels.
- **Collapsible rail.**
  - Toggled from the top bar or with `[`; the state is remembered per browser.
  - Collapsed, it shows icons for New session, Import, Search and Settings.
  - Search is scoped to the active show.
  - The rail's Teams button is removed.

**Console**
- The transport, logging strip, tabs and event feed are restyled with no behaviour change.
- **Fix:** the feed heading counts every event the active filters select (not just the internal-excluding `logged_event_count`, and not just the rows paged in so far), with a trailing `+` when the session has more events than the workspace fetches.

**Settings**
- **One full-screen Settings view** replaces both the Settings modal and the `/teams` page.
  - Its navigation is grouped by what you are editing: **You** › Account; **Team** › Members, Shows, Team details; **Show** › Show details, Event buttons.
  - Every setting is one labelled row, with the control on the right.
  - Account, Team details and Show details edit inline under a page-level save bar.
  - Members, Shows and Event buttons edit in a **right-side panel** with Cancel / Save.
- **`/teams` still serves the app.** It opens the Settings view on Members.
- **Removed:** the Auto Sync tab (placeholder text only) and the Debug tab (an empty mount). The floating performance-debug tool is unchanged.
- **Kept, but moved into the new layout:**
  - **Account:** names, sign out.
  - **Members:** role, show access, remove; invite and revoke invites.
  - **Shows:** add a show; edit name, code, title suffix and member access.
  - **Team details:** rename, default frame rate (a team setting, moved here from the modal's account area), transfer ownership, leave, delete team, create team.
  - **Event buttons:** name, type, colour, options and needs-context, on/off labels, instructions, order, add, delete, palette preset, copy from another show.
  - **Unchanged:** the honest save model, the member view and the orphaned-team notice.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-ui-system`:
  - New: the top bar, a shell-level `[` sidebar shortcut, and the Settings view as a modal dialog to the console (console hotkeys stay inert while it is open).
  - Removed: "Event-button rows defer their type control" (type moves into the panel).
  - The single component vocabulary becomes Show Ignition.
  - The AA contrast scenarios drop the sky-tint and table references.
  - The honest save model covers page save bars and side panels.
  - Generation instructions move to the event-button panel.
  - The deferral and closed-cost requirements now describe the Settings view and its sections.
  - The shows-section states apply to the view.
- `team-management`:
  - The Teams management page becomes the Settings view's Team section, which `/teams` opens.
  - Zero-membership onboarding and member content access are reworded for the view.
- `session-title-suffix`: the Suffix control moves from the General tab to Show details and the show panel.
- `web-session-routing`: `/teams` renders the home view with Settings open on Members and has no chunk of its own; the studio-switch close path is triggered by the top-bar team menu.
- `web-frontend-platform`: the route split goes from six surfaces to five, and the critical-path fonts change from Inter to Barlow (400/600 preloaded from fixed `/static/fonts/` URLs beside League Gothic). The Settings view replaces the Settings modal and teams route boundaries; `/teams` is still a router-known shell path.
- `web-coordination-seam`: the `LazyChunk` inventory follows the five-surface split, and the session-list refetch scenario names the top-bar switch and Settings saves instead of the deleted modal.
- `web-session-console`:
  - The AUTO GENERATE "no instructions" reason points at Settings › Event buttons.
  - The transport state now tints the shell with a label.
  - The feed count matches the rows shown.

## Non-goals

- **Managing a team other than the active one without switching.** The old `/teams` page showed every team at once. Here Settings › Team always shows the active team, and the top bar is the only control that changes it. So managing another team means switching to it, which closes an open session. The owner chose this on 2026-10-07 as the simpler model while the migration lands, and a drill-in teams list is the noted follow-up.

- **Team title format.** No UI edits `show_title_format` today; adding it is new behaviour for a later change.
- **A `/settings` URL.** Settings opens over the current route. A real URL would amend the frozen route inventory; that is a separate change.
- **Deleting a show.** There is no endpoint. This is a separate tier-2 change.
- **An AI page, provider sign-in or API-key management.** These need new endpoints and secret storage. That is a separate tier-2 change, with its design decisions owned by the human.
- **Light mode.**
- **Changes to any HTTP or WebSocket contract**, to `logged_event_count`, to session behaviour, to the Companion module, or to AI dashboard rendering.
- **Moving or removing the floating performance-debug tool.**

## Impact

- **Code:** `web/src` only.
  - New, composed from shadcn components (the repo's UI layer): `TopBar`, the `SettingsView` and its sections, `SidePanel`. New shadcn primitives: `sidebar`, `sheet`, `toggle-group`, `item`, `kbd`, `avatar`.
  - Reworked: `V6Rail`, `AppShell`, `EventLogSheet` (the count), and the theme tokens in `shared/theme/tailwind.css`.
  - Retired: `HomeSettingsModal`, `TeamsRoute` and `TeamCard`. Their logic is reused in the new sections.
- **APIs:** none. The view uses the existing endpoints:
  - `PUT /api/profile`;
  - `GET`/`POST /api/shows`;
  - `/api/teams/*`, covering members, roles, grants, invites, owner, leave, rename and delete.
- **Tests:** the existing Settings modal and teams route tests are rewritten for the view, and new tests cover the top bar, rail collapse, ignition state and feed count.
- **Design records:** DESIGN.md (from the built UI) and an impeccable surface brief with the direction contract.
- **Reference:** the interactive preview approved by the owner, https://claude.ai/artifact/AsDEXErbeEtQm2EyYKzab2.
