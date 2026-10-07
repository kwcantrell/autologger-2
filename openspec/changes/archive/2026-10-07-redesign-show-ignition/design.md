# Design: Show Ignition

## Context

The motivation is in proposal.md and the requirements are in the spec deltas. This is the current state on 2026-10-07, from two read-only surveys and the commands under Assumptions.

**Shell**
- `AppShell.tsx` renders `V6Rail` and `<main>`.
- Routes are `useRoute` booleans: `/sessions/:id`, then `/teams`, which swaps `TeamsRoute` in for `SessionRoute`.
- `HomeSettingsModal` mounts only while `showSettings` is true.
- There is no top bar. The active team and show are changed only by the Settings modal's save (`active_studio_id`, `active_show_id` on `PUT /api/profile`).

**Transport state** lives inside `SessionWorkspace`:
- `isPlaying` (local state);
- `isRolling` (`status.is_rolling`);
- `isRecording` (`status.audio_recording_lease_alive`);
- a perf-debug `debugOverride`.

These combine as `intrinsicState` (`audio-recording` > `rolling` > `play` > `stop`). Nothing outside the workspace can see it.

**Settings**
- `HomeSettingsModal.tsx` (about 1,220 lines) has four tabs: General, Event Buttons, Auto Sync and Debug.
  - It owns the account and shows scopes, the snapshot dirtiness and the shows-section states.
  - Auto Sync is placeholder text. Debug is an empty mount div (the Perf tool attaches to `document.body`).
- `TeamsRoute`/`TeamCard` (about 630 lines) render the role views. Their mutations go through the existing `/api/teams/*` hooks.
- `EventButtonsTable` plus two modals edit `EventButtonDraft[]`.

**Theme:** `shared/theme/tailwind.css` holds `--v5-*` glass tokens, the shadcn variable mapping and legacy `--color-*`. Fonts are self-hosted (Inter body, Poppins, League Gothic wordmark).

**Feed count:** `EventLogSheet` labels the feed with `logged_event_count`, which excludes internal events, while `showInternal` defaults to true.

## Goals / Non-Goals

**Goals**
- Ship the approved preview's world faithfully: tokens, top bar, ignition, Settings view, panels.
- Reuse the existing data hooks and draft logic rather than rewriting them.
- Keep every endpoint and wire shape as it is.

**Non-Goals** (design level; product non-goals are in proposal.md)
- No change to `SessionWorkspace`'s transport logic, timeline, hotkeys or virtualised feed.
- No new state library.
- No removal of legacy class hooks that e2e or perf tooling still reads. They are re-skinned, not deleted, and deletion is a later cleanup.

## Decisions

**D1. Re-skin through tokens, then port surfaces.**
- Show Ignition tokens go into `tailwind.css`:
  - surfaces: `--si-bg`, `--si-panel`, `--si-line`;
  - text: `--si-fg`, `--si-muted`;
  - accent: `--si-accent: #5b7cff`;
  - sizes: `--r-ctl: 8px`, `--r-card: 12px`, `--h-ctl: 36px`, `--h-sm: 30px`;
  - selection: `--sel-bg`, `--sel-line`;
  - the four transport mixes.
- The shadcn variables and the `--v5-*` names are re-pointed at them, so every untouched consumer changes look at once. The glass gradient utilities resolve to flat surfaces.
- New and restyled components use the `--si-*` names directly.
- **Alternative rejected:** renaming every consumer in one pass. It is a huge, risky diff with no user-visible gain over aliasing.

**D2. A shell-level transport-status store.**
- `pages/index/coordination/transportStatus.ts` is a tiny external store with `{ state: 'stopped'|'rolling'|'recording'|'playback', sessionId, title }`.
- `SessionWorkspace` publishes `effectiveTransport`, mapped to that state, from an effect, and clears it on unmount. Teardown is identity-scoped, matching the coordination seam (web-coordination-seam "Handler ownership is identity-scoped at teardown").
- `AppShell` subscribes with `useSyncExternalStore` and sets `data-transport` on the app root. The tints are pure CSS on that attribute.
- `TopBar` reads the same store for the label and session name.
- The store changes only on state transitions, never on the playback tick, so the tick's memo fences hold.
- **Alternatives rejected:**
  - Lifting the state into AppShell re-renders the shell on workspace state changes and inverts ownership.
  - Writing `document.documentElement.dataset` from the workspace is untestable through React and echoes the retired `body.dataset.sessionId` spine.

**D3. Settings is an overlay view gated by shell state.**
- `showSettings: boolean` becomes `settings: { section } | null`.
- `SettingsView` is a full-screen overlay inside `<main>` whose grouped nav is a vertical shadcn `Tabs` (D10). The rail and top bar stay visible.
- Its root is `role="dialog"` with `aria-modal="true"`, labelled by its heading. The workspace stays mounted beneath it, and its hotkeys already yield to any open `[role=dialog]` through `isOverlayOpen` (`shared/ui/overlayOpen.ts`), so logging, Space and zoom are inert while Settings is open (panel finding, critical).
- It keeps the lazy overlay boundary with a `null` fallback and the idle prefetch.
- `/teams`:
  - opens it with `{ section: 'members' }` and renders the home route underneath;
  - closing the view while on `/teams` navigates to `/` through the shared navigation wrapper;
  - `TeamsRoute` and its lazy boundary are deleted, which takes the split from six surfaces to five.
- **Alternatives rejected:**
  - A `/settings` route amends the frozen route inventory (a non-goal).
  - Keeping `/teams` as its own route surface duplicates the Members UI.

**D4. Two save patterns, one dirtiness mechanism.** The side panels are shadcn `Sheet`s and the save bars are `Card` footers (D10).
- **Every profile write from Settings** carries `active_studio_id` and echoes the current `active_show_id`, porting the modal's `activeShowIdForSave` rule. `PUT /api/profile` 400s without the team and treats an absent show as "pick the first", so a partial body would reset the active show.
- **Team settings** (the default frame rate) merge into the existing `settings` blob as the modal does (`{ ...existingSettings, default_frame_rate }`), since the server replaces it wholesale.
- **Inline sections (Account, Team details, Show details, Event buttons' palette):**
  - each owns a slice of the existing snapshot and shows a sticky save bar while dirty;
  - Save calls the same `PUT /api/profile` builder as today, restricted to that section's fields;
  - switching section or closing with a dirty slice goes through `ConfirmDialog`.
- **Side panels:**
  - draft locally;
  - Save runs the needed calls in order: role, then grants (PUT/DELETE per changed show), then removal, or `show_updates` for show and button panels;
  - a failure stops the sequence, keeps the panel open, names the call that failed, and invalidates the affected queries so applied parts show.
- **Alternatives rejected:**
  - One global Save, as today, cannot express per-panel edits clearly.
  - Immediate-apply checkboxes, as on the old Teams page, break the Cancel the user asked for.

**D5. Top-bar switching writes immediately.**
- Choosing a team sends `PUT /api/profile { active_studio_id }` with `active_show_id` omitted, so the server picks the new team's first show, exactly as the modal's mid-switch save does.
  - On success it runs the close-session path if a session is open.
  - It then invalidates the same set the modal's save did: `['sessions']`, `['events']`, `sessionStatusKeys.all()` and `['show-categories']`.
- Choosing a show sends `{ active_show_id }`.
- **Alternative rejected:** a "pending switch" committed later by Settings' Save. That is the old buried flow.

**D6. Event buttons are a list plus a panel.**
- The page lists buttons as rows, with key, name, summary, colour and Edit. Palette and Colours sit as the first two rows of the same card, and Copy from another show is its own card.
- The panel edits one `EventButtonDraft`, reusing the draft mapping, type-switch rules, option pass-through and instruction rules.
- Reordering moves from drag to Move up / Move down in the panel. This is keyboard-equivalent by construction (PRODUCT.md accessibility), and the drag handle is removed.
- Saving a panel writes `show_updates` with the whole category array for that show, which is the existing shape.
- **Alternative rejected:** keeping the table with modals, which the owner found cluttered in review.

**D7. Feed count from the filtered fetched set.**
- The heading counts the filtered events before the `loadedLimit` slice (the windowed list sees at most 200 at first, of up to `WORKSPACE_EVENTS_LIMIT` = 2,000 fetched). When the fetch was capped, the count gets a trailing `+`.
- The workspace tab strip gets no count, so no value crosses the "Mounted-hidden SHALL NOT mean re-rendered" fence.
- `logged_event_count` stays unchanged for any other consumer.

**D8. The rail becomes a shadcn `Sidebar`; behaviour is preserved.**
- `V6Rail` is rebuilt on `Sidebar collapsible="icon"` (D10). Its collapsed-search behaviour is kept: activating the collapsed search expands the sidebar and focuses the input (web-home-launch "Real rail session search"). So are the session cards and their access rules.
- The toggle is a `SidebarTrigger` at the top bar's leading edge. There is no shared shortcut layer today (each component registers its own `keydown`), so `AppShell` gets one new listener for `[` that reuses `isTypingTarget` and `isOverlayOpen` and is mounted on every signed-in route.
- The Teams button is removed from the rail.

**D9. Faces.**
- Body and UI: Barlow 400–700, OFL. The latin 400 and 600 files are critical-path faces: they live at stable `web/public/static/fonts/` URLs and are preloaded from the root layout with `crossorigin`, beside League Gothic, replacing the Inter preload. Barlow 500/700 stay bundler-emitted in `assets/fonts` (web-frontend-platform deltas).
- Labels, tabs and status: Barlow Condensed 500–700.
- Timecode and measured values only: JetBrains Mono 500–600.
- The home wordmark keeps League Gothic (non-normative brand). Inter and Poppins are retired once no consumer remains.
- **Alternative rejected:** keeping Inter. The preview the owner approved is set in Barlow.

**D10. Every piece is a shadcn component; custom markup only where none exists.**
- The repo's shadcn setup is the vocabulary layer: new-york style, `radix-ui` base, lucide icons, `shared/components/ui`, guarded by `shadcnHygiene.repo.test.ts`. The Show Ignition look lives in the CSS variables the primitives already read (`--background`, `--card`, `--primary`, `--ring`, `--sidebar-*`; D1), not in per-component overrides. `className` is used for layout only.
- **Already installed:** `button`, `dropdown-menu`, `tabs`, `field`, `input`, `textarea`, `select`, `checkbox`, `radio-group`, `card`, `badge`, `alert`, `alert-dialog`, `empty`, `separator`, `skeleton`, `spinner`, `tooltip`, `scroll-area`.
- **To add** with `npx shadcn@latest add sidebar sheet toggle-group item kbd avatar`, then the hygiene rewrite (local `cn`, no `dark:` variants).

| Piece | shadcn composition |
| --- | --- |
| App rail | `Sidebar collapsible="icon"` inside `SidebarProvider`, with `SidebarHeader` (New session, Import), `SidebarInput`-based search, `SidebarContent`/`SidebarMenu` (session cards as `SidebarMenuButton` with `tooltip`, `isActive`) and `SidebarFooter` (Settings). On mobile it becomes the built-in `Sheet`. |
| Rail toggle | `SidebarTrigger` at the top bar's leading edge. The built-in Ctrl/⌘+B stays, and `[` calls `toggleSidebar()` through the existing shortcut layer. |
| Top bar team and show menus | `DropdownMenu` with `DropdownMenuTrigger asChild` on a ghost `Button`, and `DropdownMenuRadioGroup` (team: label, role `Badge`, show count). |
| Status | `Button` (ghost) containing a `Badge` for STOPPED / ROLLING / REC / PLAY, coloured from the `data-transport` variables. |
| Settings view nav | vertical `Tabs` (`orientation="vertical"`), with `TabsTrigger`s grouped under You / Team / Show labels and `TabsContent forceMount` + `hidden` for the mount-on-first-visit rule (the existing deferral pattern from the modal). |
| Section cards | `Card` + `CardHeader`/`CardTitle`/`CardContent`. |
| Setting rows (label left, control right) | `FieldGroup` of `Field orientation="horizontal"` with `FieldContent` (`FieldLabel` + `FieldDescription`) and the control, separated by `FieldSeparator`. |
| Section save bar | `Card` footer with `Button` (Save, a `Spinner` while saving) and the existing `ConfirmDialog` (`AlertDialog`) for discards. |
| Side panels (member, show, event button) | `Sheet side="right"` with `SheetHeader`/`SheetTitle`/`SheetDescription` and `SheetFooter` (Cancel / Save). |
| Members and shows lists | `Item` rows (`ItemMedia` with `Avatar` + `AvatarFallback` initials, `ItemContent`, `ItemActions`) inside `ItemGroup`. |
| Segmented choices (role, button type, palette preset, suffix) | `ToggleGroup type="single"`. |
| Show access and option needs-context | `Checkbox` inside `FieldSet` + `FieldLegend`. |
| Colour swatches | `RadioGroup` with custom-rendered items. |
| Lock and no-owner notices | `Alert`. |
| Empty and failed shows states | `Empty` (with Retry `Button` on error only). |
| Logging-strip hotkeys and the shortcut reference | `Kbd`. |
| Instruction text | `Textarea`. |

- **Local edits to generated files,** kept minimal and commented:
  - `sidebar.tsx` persists its open state in `localStorage` (try/catch, default expanded) instead of `document.cookie`, because the shell must set and read no cookies;
  - widths are tuned to the approved preview (272px expanded, 68px icon).
- **Alternative rejected:** keeping the bespoke `V6Rail` and hand-built panels. They duplicate behaviour shadcn already ships (collapse, mobile sheet, tooltips, focus trapping) and drift from the shared vocabulary.

## Assumptions

Panel-confirmed facts (2026-10-07), each with the reviewer's evidence:
- Hotkeys yield to dialogs only: `cat web/src/shared/ui/overlayOpen.ts` -> `OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"]'`.
- The profile write needs the team and resets an absent show: `sed -n 57p server/src/routers/profile.ts` -> `'active_studio_id is required.' 400`; `sed -n 140,142p` -> `nextShow = showsNow.length ? String(showsNow[0].id) : ''`.
- The default frame rate is a team setting: `sed -n 63,67p server/src/routers/profile.ts` -> `body.settings … role !== 'owner' && role !== 'admin' → 403`.
- There are no per-show session counts: `grep -rn "session_count\|show_count" packages/contract/src server/src` -> none.
- The feed pages 200 of up to 2,000: `sed -n 399,403p EventLogSheet.tsx` -> `fetchedEvents.slice(0, loadedLimit)`.


Each assumption is listed with the command that tests it and what it returned.

1. **No delete-show endpoint exists**, so the panel offers none.
   - **Command:** `grep -nE "\.(get|post|put|patch|delete)\(\s*['\"]/" server/src/routers/shows.ts`
   - **Output:** only `get('/api/shows'`, `get('/api/shows/:showId'`, `post('/api/shows'`.
2. **`/teams` is router-known and stays so.**
   - **Command:** `sed -n 80,100p web/src/shared/utils/loginReturnPath.ts`
   - **Output:** `if (segments.length === 1) return segments[0] === 'teams';`
3. **The feed label reads `logged_event_count`.**
   - **Command:** `grep -n logged_event_count web/src/pages/index/components/EventLogSheet.tsx`
   - **Output:** `405:  const loggedTotal = data?.logged_event_count ?? 0;`
4. **The Auto Sync and Debug tabs carry nothing.**
   - **Command:** `grep -n "Coming soon\|v6-settings-perf-debug-mount" web/src/pages/index/components/HomeSettingsModal.tsx`
   - **Output:** `1148: …Coming soon.` and `1174: <div id="v6-settings-perf-debug-mount" …/>`
   - `initPerfDebugUI()` is called with no mount target (AppShell.tsx:151).
5. **The profile write accepts the active team and show.**
   - **Command:** `grep -n "active_studio_id\|active_show_id" packages/contract/src/schemas.ts`
   - **Output:** `363: active_studio_id: z.string().max(120).nullish(),` and `364: active_show_id: z.string().min(1).max(120).nullish(),`
6. **Deleting a team with shows is refused.**
   - **Command:** `grep -n "400" openspec/specs/api-contract-freeze/spec.md | grep -i show`
   - **Output:** `274: | DELETE /api/teams/:id | owner | delete; 400 while shows exist |`
7. **The transport state has four intrinsic values in the workspace.**
   - **Command:** `sed -n 95,118p web/src/pages/index/components/SessionWorkspace.tsx`
   - **Output:** `const intrinsicState = isRecording ? 'audio-recording' : isRolling ? 'rolling' : isPlaying ? 'play' : 'stop';` and `const effectiveTransport = debugOverride ?? intrinsicState;`

## Risks / Trade-offs

- **[Risk] Large rewrite of Settings regresses a subtle save rule** (mid-switch `active_show_id`, member saves carrying no team/show settings, shows-section states).
  → Port those rules as functions with their existing tests moved over first. Each section's tests are written before the section is built.
- **[Risk] Re-pointing `--v5-*` changes surfaces nobody reviews.**
  → One batched desktop and mobile screenshot round across the console, home, login, every modal and every Settings section; the AA contrast scenarios are checked with the contrast test.
- **[Risk] The transport store leaks a stale state after a fast session switch.**
  → Identity-scoped clear on unmount, plus a test that switches sessions while recording and asserts the shell reads the new session's state.
- **[Trade-off] Settings has no URL.** Back does not close it; Esc and the back control do. This is unchanged from today and recorded in the non-goals.
- **[Trade-off] Drag reorder is gone.** Move up and Move down are slower for long lists but accessible. Revisit if users ask.
- **[Risk] The dev stack on :8787 mounts a different checkout (`/home/spark/autologger-2`).**
  → Visual verification runs only after the stack is pointed at this checkout, with the owner's go-ahead.

## Migration Plan

This is web-only and needs no data migration. It deploys with the web build; rollback is reverting the merge. Browser-stored rail state is a per-viewer convenience, and an absent or unreadable value means expanded.
