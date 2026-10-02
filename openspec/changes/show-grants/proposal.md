# Per-show grants: members see the show list, grants give session access

Tier: 2
Tier reason: authorization (every session-scoped route, the WebSocket upgrade, log-import,
Companion presence and show/team-settings writes change who is allowed), a catalog migration (a
new table with two cascading foreign keys), concurrency (grant and revoke race membership
removal and session creation), and changes to the frozen HTTP contract; touches
`server/src/routers/**` and `supabase/migrations/**`.

Approved-by: Kalen 2026-10-02

## Why

ADR 0021's permission model says owners and admins see and edit every show in their team, while
members see the show list only, and that show access comes from a per-show grant with
`can_write`. Today content is role-blind: any team member reads and writes every session in the
team, and `requireSession` (`server/src/routers/_helpers.ts:45-61`) checks membership only.
team-management even pins that ("`requireSession` SHALL NOT consult roles"). Slice 5c gave every
team an owner, so the model now has the roles it needs. Slice 6 is "RLS for the permission
model"; the owner split it so the rule lands in the app first (6a, this change) and Postgres
row-level security mirrors it next (6b). Session content (events, takes, topics, transcripts,
audio) stays in per-session SQLite until slice 7, so the app gate is the only protection for it
either way.

## Owner decisions (owner, 2026-10-02)

These are the human owner's binding decisions for this slice:
1. **Split 6a / 6b.** 6a `show-grants` is the permission model in the app; 6b `catalog-rls` is
   Postgres row-level security that mirrors it.
2. **6b uses a dedicated NOLOGIN catalog role** that only `autologger_app` can `SET ROLE` to. The
   bare `authenticated` role gets nothing, and the catalog stays invisible to PostgREST. Recorded
   now, applied in 6b (context only for this change).
3. **Member view:**
   - a member without a grant sees the show list and each show's session list (titles), but
     can't open a session: masked `404`, like a non-member today;
   - only owners and admins create shows and change team or show settings (`403`).
4. **A grant means full access.** A `(user, show)` row gives full session access in that show:
   open, record, edit, create sessions, imports. `can_write` is stored and always true for now.
   The web app gets no read-only mode.
5. **Owners and admins manage grants on the team page**, through new routes under
   `/api/teams/:id/shows/:showId/grants`. A member's grants are deleted when they leave or are
   removed, or the show is deleted.
6. **Companion:**
   - posting presence requires access to that session, which closes today's gap;
   - the other Companion routes keep acting as a system caller on the session its presence
     holder can access;
   - a real device credential comes in slice 9.

After the adversarial panel (owner, 2026-10-02):

E. **Open WebSockets close when access is lost.** Revoking a grant, removing a member (or the
   member leaving), or demoting an admin to member closes that user's sockets on the affected
   sessions. In-process: the hub records the user id per socket at attach, and the
   revoke/remove/demote paths close the matching sockets after their transaction commits; the
   client reconnects and gets the masked `404`. Follow-up for slices 8/9: with several processes
   or Realtime, drive this from the database (a row trigger with `pg_notify`/`LISTEN`, or Realtime
   RLS authorization; spike how promptly Realtime re-checks policies on a joined channel).
F. **Imports re-check access.** The log-import job re-checks its creator's show access before each
   sheet; on loss it stops with an "Access revoked" progress line, and events already written
   stay. The YouTube import re-checks before it writes (design D19).
G. **The session list for a caller without access** keeps its shape but carries titles and dates
   only: `notes` is `""`, `is_rolling` false, `rolling_timecode` null, `event_count` 0, and the
   other content and live-state fields are blanked (api-contract-freeze "Session list entries for
   a show without access").
H. **Cuts.** No `GET …/grants` route (PUT and DELETE stay). `can_access` is on profile `shows[]`
   only, not on the `/api/shows` routes; the web reads it through a `ProfileShow` type.

## For the approver

Design proposes these; the owner confirms them at approval:
- **Member Settings view** (D13): Settings stays reachable for members (team switch, names); a
  member's view hides team defaults and show editing, and its save omits `settings` and
  `show_updates`. The plan said to hide Settings.
- **`show_ids` for owner and admin callers only** (D6), like `invites`.
- **Token-only presence stays unchecked until slice 9** (D10); every cookie caller on
  `/api/companion/*` is checked.
- **Grants survive role changes** (D11): dormant while the holder is an admin, applied again
  after a demotion.

## What Changes

- **One access rule.** A user can access a show when they are the owner or an admin of its team,
  or a member of its team with a grant for that show. They can access a session when they can
  access its show; a session with no show is denied, as today. One catalog query answers it
  (`authCanAccessShow`).
- **Database (migration `supabase/migrations/20261005000000_show_grants.sql`):**
  `catalog.show_grants (user_id, show_id, can_write, granted_by_user_id, granted_at_utc)`, primary
  key `(user_id, show_id)`, foreign keys to `users` and `shows` with `on delete cascade`, and an
  index on `show_id`. Memberships have no foreign key to shows, so the app revokes a member's
  grants in the team inside the same transaction as the membership delete.
- **BREAKING (contract): session content needs show access.** `requireSession` checks show access
  instead of membership; the denial stays the masked `404 Session not found`. That covers every
  `/api/sessions/:sessionId/*` route, `GET /api/sessions/:id` and the WebSocket upgrade with no
  per-route change. `POST /api/shows/:showId/log-import` uses the same rule (masked `404 Show not
  found.`), and so does the transcript-generation lock's "may view the holder" check.
- **BREAKING (contract): members' writes.**
  - `POST /api/shows` is owner or admin only (`403 Admin role required.`);
  - `PUT /api/profile` with `settings` or `show_updates` is owner or admin only (`403`);
    `active_studio_id`, `active_show_id` and names stay open to members;
  - `POST /api/sessions` for a show the caller can't access gets `403 No access to this show.`
    (the show is visible, so it isn't masked), decided inside the create's transaction.
- **BREAKING (contract): the session list for a show without access** (owner decision G):
  `GET /api/sessions` keeps its scope and shape, but for a caller without access to the listed
  show each entry keeps identity, titles and dates and blanks `notes`, `event_count`,
  `is_rolling`, `current_take`, `rolling_timecode` and `total_runtime_hms`. `GET /api/shows`,
  `GET /api/shows/:showId`, `GET /api/studio` and the team detail stay open to members.
- **New routes (contract, additive):** `PUT /api/teams/:id/shows/:showId/grants/:userId` (no
  body; a non-member target `404`; an owner or admin target is a `200` no-op) and `DELETE
  …/grants/:userId` (idempotent), owner or admin, re-checked inside the write's transaction.
- **Additive fields:** team detail `members[].show_ids` (for owner and admin callers), and
  `can_access` on profile `shows[]` only.
- **BREAKING (contract): Companion for signed-in callers.** `POST /api/companion/presence` from a
  signed-in browser with a `session_id` it can't access (or that doesn't exist) gets the masked
  `404` and stores nothing. `state`, `categories`, `log`, `transport` and `command` called with a
  cookie answer as if there were no active session when the caller can't access it. Token-only
  calls are unchanged.
- **BREAKING (contract): sockets close** (owner decision E). A revoke, removal, leave or demotion
  to member closes the user's session sockets on sessions they no longer reach (close code
  `4403`), in this process.
- **Imports re-check access** (owner decision F): the log-import job before each sheet, the
  YouTube import before it writes.
- **Revocation.** Team leave, team remove and the support-plane membership delete revoke the
  member's grants in that team in the same transaction. Grants survive role changes.
- **Web.**
  - `/teams`: the owner and admin views get a per-member show picker (a checkbox per team show)
    on `member` rows.
  - The rail and home hide New Session and Batch Import when the active team has no show the
    user can access, and their show pickers list only accessible shows.
  - Session cards of a show the user can't access render as non-openable rows with "No access —
    ask a team admin" and no card menu; the home resume card skips them. `SessionRoute`'s not-found
    copy stays.
  - Settings stays reachable for members (team switch and name edits), but a member's view hides
    the team defaults and show editing, and its save omits `settings` and `show_updates` (design
    D13; this deviates from the plan, see "For the approver").
- **Docs:** the README endpoint table (the two grant routes), and ADR 0021's slice 6a entry with
  these owner decisions and the 6b dedicated-role decision.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-management`: REMOVED "Team roles: owner, admin and member" (its "Content access is
  role-blind" scenario and the "`requireSession` SHALL NOT consult roles" rule no longer hold) and
  "Owner-anchored team lifecycle" (its "not severed mid-flight" scenario no longer holds); ADDED
  "Team roles, owner anchor and show access" and "Owner-anchored team lifecycle and access
  revocation" in their place; ADDED "Show grants" and "Member content access"; MODIFIED "Teams
  management page" (the grant picker).
- `api-contract-freeze`: MODIFIED "Session detail endpoint", "Team management endpoint family"
  (the grant rows and `show_ids`), "Show-scoped log-import job endpoints", "Show title_suffix on
  show wire; next_episode omitted" (profile `can_access`), "Transcript generation lock status
  endpoint" and "Transcript generation endpoint behavior" (the view rule), "Login is required on
  every API route" (access checks, not membership checks); ADDED "Show creation and team settings
  need owner or admin", "Session creation needs show access", "Companion routes check a signed-in
  caller's session access", "Session list entries for a show without access", "Session sockets
  close when access is lost" and "Imports re-check show access as they run".
- `transcript-generation`: MODIFIED "Generation lock status is observable" and "Single-flight
  generation" (the redaction follows show access).
- `sheets-log-import`: MODIFIED "Job authorization and lifecycle" (show access, the per-sheet
  re-check).
- `topic-generation`: MODIFIED "Topic generation is configuration-gated" (its scenario names a
  caller with access).
- `catalog-database`: MODIFIED "The catalog schema lives in Postgres schema `catalog`"
  (`show_grants` joins the tables and the recorded expectation).
- `core-ports-architecture`: MODIFIED "Authentication and authorization are distinct, single
  seams" (authorization is existence plus show access).
- `web-home-launch`: MODIFIED "Branded home launch surface" (New Session and the resume card
  follow access); ADDED "Session actions follow show access".
- `batch-audio-import`: MODIFIED "Rail Batch Import control" (shown only with an accessible show).

`youtube-audio-import`, `auto-event-generation` and `local-container-environments` stay literally
true and need no delta (design D16). `web-ui-system`, `web-session-routing` and
`web-login-experience` name no access rule (design D16).

## Non-goals

- **Postgres RLS** and the dedicated catalog role (slice 6b `catalog-rls`). This change creates no
  role, no policy and no `SET ROLE`.
- **A read-only mode** or any use of `can_write = false` (owner decision 4).
- **Access requests**, finer-grained permissions, or grants for non-members (ADR 0021).
- **Hiding the show list or session titles from members** (owner decision 3).
- **Closing sockets across processes** (owner decision E): this change closes sockets in the one
  server process; slices 8/9 drive it from the database.
- **Interrupting in-flight HTTP requests** when access is lost.
- **Companion device credentials** (slice 9); token-only Companion calls stay a system caller.
- **A show delete route.** None exists; the `on delete cascade` covers a future one and manual
  deletes.
- **Moving session content to Postgres** (slice 7) and importing data (slice 11).

## Impact

- **Database:** one migration; `server/src/test/pg/catalogSchema.pg.test.ts`'s recorded
  expectation gains the table, its foreign keys and `idx_show_grants_show`.
- **Packages:** `catalog` (`authStore`: grant methods, `authCanAccessShow`, the access set for
  the profile, grant revocation inside `authRemoveMembership`; `profileAssembler`: `can_access`;
  `showsStore`: no change to the serializers' own fields).
- **Server:** `_helpers.ts` (`requireSession`, new `requireShowAccess`), routers `shows`,
  `profile`, `sessions`, `logImport`, `transcribe`, `companion`, `teams`, `admin`, `sessionWs`;
  `packages/session-core` (the socket's user id, closing a user's sockets); the test harness and
  helpers; fixtures.
- **Web:** `api/types.ts`, `useTeams.ts`, `TeamCard.tsx`, an access helper, `V6Rail.tsx`,
  `RecentSessionsList.tsx`, `HomeRoute.tsx`, `NewSessionModal.tsx`, `BatchImportModal.tsx`,
  `HomeSettingsModal.tsx` and their tests.
- **Contract:** see "What Changes"; the two grant routes join the README endpoint table.
- **Operators:** none. No new env var, no compose change. Existing members of real teams lose
  session access until an owner or admin grants it (design Risks).

## After merge

These are outside tasks.md, because they need the merged branch or `make stage-up` permission:
- **Dev live check** (`make dev-up`):
  - the migration applied: `catalog.show_grants` exists;
  - the owner sees and opens every show's sessions;
  - a member with no grants sees the session titles but gets "not found" on opening one, and
    New Session and Batch Import are hidden;
  - after the owner ticks a show for that member on `/teams`, opening, recording and New Session
    work;
  - a signed-in presence post for an ungranted session gets `404`, and a signed-in
    `GET /api/companion/state` while a teammate holds an ungranted session reports none;
  - with the member's session open in a tab, revoking the grant closes the socket and the tab
    lands on "not found" after its reconnect;
  - the member's session list shows titles with no notes or counts;
  - removing the member from the team and re-inviting them leaves no grant.
- **Stage live check**, with the owner's permission for `make stage-up`: the same probes, plus
  `k50633376@…` (an admin of `my-studio` on stage) opens every `my-studio` show without a grant.
- **Prod:** prod runs `main` until slice 11's cutover, so no prod step here. At cutover the
  catalog is created empty, and members start with no grants: the owner grants shows after the
  import (ADR 0021 cutover notes).
