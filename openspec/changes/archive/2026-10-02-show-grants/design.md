# Design

## Context

See proposal.md for the why and the owner decisions (owner, 2026-10-02). The current state:

- **One gate, membership only.** `requireSession` (`server/src/routers/_helpers.ts:45-61`) reads
  the session row (masked `404 Session not found` when absent), then `getSessionStudioId` and
  `authUserHasStudio` (`404` again when the user isn't a member). 43 router routes under
  `/api/sessions/:sessionId…` plus the WebSocket upgrade (`sessionWs.ts:13`) call it, all before
  reading a body (A2-A4). The AI v2 routes call it through `guardAiV2Route`.
- **Three hand-copied membership checks** outside the gate: `logImport.ts:135` (show-scoped,
  masked `404 Show not found.`), `transcribe.ts:111-116` (`requesterCanViewSession`, the lock's
  identifier redaction), and `shows.ts`/`profile.ts` (team scope: list, detail, create, settings).
- **Writes members make today:** `POST /api/shows` (`shows.ts:57-94`, membership checked inside
  its transaction), `PUT /api/profile` `settings` and `show_updates` (`profile.ts:61-99`, applied
  one by one, not in a transaction), `POST /api/sessions` (`sessions.ts:142-200`; the create runs
  in `createSessionForShow`'s own transaction).
- **Session list.** `GET /api/sessions` lists only the caller's active show
  (`sessions.ts:112-140`), in the serializer shared with the detail route.
- **Companion.** `POST /api/companion/presence` (`companion.ts:100-120`) stores any `session_id`
  with no lookup. `/api/companion/*` accepts a session cookie or `API_TOKEN`
  (`middleware/auth.ts:33-36`); the web posts presence with its cookie
  (`useCompanionPresence.ts:68`), the Companion module with the token.
- **Membership deletes** are three call sites of `authRemoveMembership`: team remove
  (`teams.ts:297`), team leave (`teams.ts:314`) and the support plane (`admin.ts:119`, not in a
  transaction). There is no show delete anywhere (A8).
- **Catalog.** Transactions are `SERIALIZABLE` with jittered retry (A13); 5c re-checks roles under
  `FOR SHARE` (`authGetMembershipRoleForShare`). Memberships have no foreign key to shows; `shows`
  has none to `studio_definitions`.
- **Web.** `HomeSettingsModal` always sends `settings` (the team's default frame rate) and sends
  `show_updates` for every drafted show (`HomeSettingsModal.tsx:569-574`); it is also the only
  place to switch the active team and edit one's name. `NewSessionModal` and the Batch Import
  picker list `profile.shows`.
- **Tests.** The harness's default signed-in user is a plain `member` of `test-studios` and
  `test-studio-2` (`harness.ts:110-112`); `seededSession()` and `seedMemberStudio()` add it as a
  `member` of their fresh team (`helpers.ts:28,115`). Six fixture captures run as that user in
  `test-studios` (A10).

## Owner decisions after the panel (owner, 2026-10-02)

The proposal's decisions 1-6 stand. After the adversarial panel the owner added E-H, which this
design implements:
- **E. Open WebSockets close when access is lost** (D20): revoke, removal, leave and demotion to
  member close the user's sockets on sessions they no longer reach, in-process, after the commit.
  Slices 8/9 drive it from the database (trigger + `pg_notify`/`LISTEN`, or Realtime RLS; spike
  how promptly Realtime re-checks policies on a joined channel).
- **F. Imports re-check access** (D19): the log-import job before each sheet ("Access revoked"
  line; written events stay); the YouTube import before it writes.
- **G. The session list for a caller without access** blanks content and live state, same shape
  (D21).
- **H. Cuts:** no `GET …/grants` route; `can_access` on profile `shows[]` only, with a web
  `ProfileShow` type (D5, D7).

Decisions marked **(proposed; owner confirmed at approval, 2026-10-02)** are listed in proposal.md "For the
approver": D6, D10's token-only presence, D11 and D13's member Settings view.

## Goals / Non-Goals

**Goals:**
- One access rule, one catalog query, and one server gate per scope (session, show); every
  session-scoped route reaches it, proven by a route-table test.
- Every grant write and every access-dependent create decides from the state it commits against.
- No grant outlives its membership, show or user.
- Members keep what owner decision 3 promises (show list, session titles, team switch).

**Non-Goals:** see proposal.md. Design-level: no change to how roles are checked on the team
plane (5c's `requireTeamRole`/`requireTeamRoleIn` are reused), and no change to the session list
query or shape.

## Decisions

### D1. Migration `20261005000000_show_grants.sql`
```sql
create table catalog.show_grants (
  user_id text collate "C" not null references catalog.users (id) on delete cascade,
  show_id text collate "C" not null references catalog.shows (id) on delete cascade,
  can_write bigint not null default 1,
  granted_by_user_id text collate "C",
  granted_at_utc text collate "C" not null,
  primary key (user_id, show_id)
);
create index idx_show_grants_show on catalog.show_grants (show_id);
```
- `can_write` is a 0/1 `bigint`, not the plan's `boolean`: catalog-database says flags are 0/1
  integers until the typed-schema follow-up, and the adapter already maps those (OQ7). The wire
  reports `can_write: true`.
- No foreign key on `granted_by_user_id`, so a grant outlives the admin who made it.
- The `idx_` name puts the index in `catalogSchema.pg.test.ts`'s record (A11); `TABLES` gains
  `show_grants`, which also extends the "no API role holds a catalog privilege" loop to it. The
  existing `alter default privileges for role postgres` grants it to `autologger_app` (A12).
- No transaction-control lines (`migrate.sh` refuses them); no seed grants.

### D2. Catalog: the access query and the grant store
In `packages/catalog/src/authStore.ts` (facade and class):
- `authCanAccessShow(userId, showId): Promise<boolean>`, one statement:
  ```sql
  SELECT 1 FROM shows s
  JOIN user_studio_memberships m ON m.studio_id = s.studio_id AND m.user_id = ?
  WHERE s.id = ?
    AND (m.role IN ('owner', 'admin')
         OR EXISTS (SELECT 1 FROM show_grants g WHERE g.user_id = m.user_id AND g.show_id = s.id))
  ```
  An unknown show, a non-member and an ungranted member all return `false`.
- `authCanAccessShowForShare(userId, showId)`: the same answer, for use inside a write's
  transaction. It reads the membership with `authGetMembershipRoleForShare` (5c), then, for a
  `member`, `SELECT 1 FROM show_grants WHERE user_id = ? AND show_id = ? FOR SHARE`. A revoke or
  removal that commits meanwhile waits for, or fails, the reader, and the retry sees it.
- `authListAccessibleShowIds(userId): Promise<Set<string>>`: the D2 predicate over every show of
  every team the user belongs to, one statement, for the profile and the shows routes (D7).
- `authListShowGrants(showId)`, `authListShowGrantsInStudio(studioId)` (`user_id, show_id` pairs
  for the team detail), `authGrantShow(userId, showId, grantedBy, nowIso)` (`INSERT … ON CONFLICT
  DO NOTHING`), `authRevokeShow(userId, showId)` and `authRevokeGrantsInStudio(userId, studioId)`
  (`DELETE FROM show_grants g USING shows s WHERE g.show_id = s.id AND s.studio_id = ? AND
  g.user_id = ?`).
- **`authRemoveMembership` revokes too:** it runs `authRevokeGrantsInStudio` and the membership
  delete in one `tx` (which joins a caller's transaction). The three call sites need no change, so
  a future caller can't forget the revoke. This refines the plan, which called
  `authRevokeGrantsInStudio` from each route (OQ8).
- `sessionIndexStore`: no change. The list stays visible to members.

*Alternative:* a trigger or a foreign key from grants to memberships. Rejected: memberships are
keyed `(user_id, studio_id)` and grants `(user_id, show_id)`, so a key would need a denormalized
`studio_id` on grants that must follow the show; and 6b wants the rule in policies, not triggers.

### D3. The server gates
`_helpers.ts`:
- `requireSession(c, sessionId, opts)`: after the existence check, `row.show_id` (already on the
  row) goes to `authCanAccessShow(user.id, showId)`; a null show or `false` throws the same
  `404 Session not found`. `getSessionStudioId` is no longer called here.
- New `requireShowAccess(c, showId, notFoundDetail = 'Show not found.')`: `getShowRow`, then
  `authCanAccessShow`; both failures throw the same `404`.
- `canAccessSession(c, sessionId): Promise<boolean>`: the non-throwing form, for the lock's
  redaction (D12).

All denials stay masked `404`s: nonexistent, foreign team and ungranted member are
indistinguishable, so the existence oracle stays closed. Every session-scoped route, the
WebSocket upgrade and the AI v2 prologue get the rule with no per-route edit (A2-A4).

### D4. Route behavior and check order

| Route | Check (in order) | Denial |
| --- | --- | --- |
| every `/api/sessions/:sessionId…` route, `…/ws` | `requireSession` before body | masked `404 Session not found` |
| `POST /api/shows/:showId/log-import` | `requireShowAccess`, then config `503`, then body | masked `404 Show not found.` |
| `POST /api/shows` | body, code `400`; in the transaction: team exists `400`, member `404`, role `403` | `403 Admin role required.` |
| `PUT /api/profile` | body; zero-membership branch; `active_studio_id` `400`s; `403 No access to that team.`; then, if `settings != null` or `show_updates` non-empty, role (owner or admin) | `403 Admin role required.`, before any write |
| `POST /api/sessions` | body; `403 No team access.`; `400 Unknown show_id.`; `400 Show does not belong…`; in the create's transaction: `authCanAccessShowForShare` | `403 No access to this show.` |
| `POST /api/companion/presence` | body; `closing`; NUL `400`; then, if a user is signed in and `session_id` is non-empty, `requireSession(…, {includeHidden: true})` | masked `404 Session not found`, nothing stored |
| `GET /api/companion/state`, `GET …/categories`, `POST …/log`, `…/transport`, `…/command` | resolve the active session as today; then, if a user is signed in, `canAccessSession` | the route's own no-active-session answer (D10) |
| `GET /api/sessions` | unchanged scope; `canAccessShow(activeShowId)` decides the entry values | blanked entries (D21) |
| `GET /api/shows`, `GET /api/shows/:showId`, `GET /api/studio`, team detail | unchanged (membership) | unchanged |

`POST /api/sessions` answers `403`, not `404`, because the caller can already see the show in
`GET /api/shows` (owner decision 3). The profile role gate runs before the settings write, so a
member's request writes nothing at all (today `settings` is written before `show_updates` is
validated; the admin path keeps that order, out of scope).

### D5. Grant routes
In `teams.ts`, both use `requireTeamRole(c, teamId, OWNER_OR_ADMIN)` early (`401`, masked
`404 Team not found`, `403 Admin role required.`) and `requireTeamRoleIn` inside the
transaction, like the other 5c writes. Then:
- the show: `getShowRow(showId)`; absent or `studio_id !== teamId` → `404 Show not found.`;
- there is no `GET …/grants` route (owner decision H); managers read grants from the team
  detail's `show_ids` (D6);
- **PUT** `…/grants/:userId` (no body; a body is ignored, so the contract package gets no schema),
  in one `catalog.tx`: re-check the caller; the target's role under `FOR SHARE`
  (`authGetMembershipRoleForShare`): none → `404 Member not found`; `owner`/`admin` → `200
  {ok: true}` with no write; `member` → `authGrantShow(…, caller.id, now)`, then `200 {ok:
  true}`. A disabled member is grantable (their membership is inert; owner decision 5 doesn't
  exclude them).
- **DELETE** `…/grants/:userId`: re-check the caller, `authRevokeShow`, `200 {ok: true}` always
  (also for a non-member target: revoke is idempotent, like invite revocation); after the commit,
  close the target's sockets on the show's sessions (D20).

Status order: `401`, masked `404`, role `403`, show `404`, target `404`. A grant racing the
target's leave: the leave's membership delete conflicts with the grant's `FOR SHARE` read, so
either the leave commits first (grant `404`) or the grant commits first and the leave's
`authRemoveMembership` deletes it (D2). Under `SERIALIZABLE` both orders are retried as today.

### D6. Team detail `members[].show_ids` (proposed; owner confirmed at approval, 2026-10-02)
`GET /api/teams/:id`, when the caller is `owner` or `admin` (the same gate as `invites`,
`teams.ts:157`), adds `show_ids` to each member entry from one
`authListShowGrantsInStudio(teamId)` query: the member's granted show ids, sorted; `[]` for owner
and admin entries even when stored grants exist (their role gives access; the picker isn't shown
for them). A `member` caller's response is unchanged, so `teamDetailMember` keeps its bytes.
*Alternative:* every caller sees `show_ids`. Rejected: members have no use for teammates' grants,
and `invites` sets the precedent.

### D7. `can_access` on profile `shows[]` only (owner decision H)
Profile `shows[]` entries gain `can_access: boolean` (`profileAssembler`, from one
`authListAccessibleShowIds` call, spread over `showBriefApiDict`'s output). The `/api/shows`
routes are unchanged. `showBriefApiDict` and `showApiDict` stay pure functions of the row. On the
web, `ShowBrief` is unchanged and `ProfilePayload.shows` becomes `ProfileShow[]` with `type
ProfileShow = ShowBrief & { can_access: boolean }`, so the conformance check that `Show` is
assignable to `ShowBrief` (A14) still holds and the profile capture is checked against
`ProfileShow`. The signed-out profile's `shows` is `[]`, unchanged.

### D8. Session create decides access in its transaction
`POST /api/sessions` wraps the create: `catalog.tx(async (cat) => { if (!(await
cat.auth.authCanAccessShowForShare(user.id, showId))) return 403; return
cat.sessions.createSessionForShow(…) })`. `createSessionForShow`'s own `tx` joins the route's
(core-ports-architecture "A store transaction composes inside a route transaction"). A revoke that
commits first conflicts with the `FOR SHARE` read, the re-run sees no grant and returns `403`, and
no session row exists. The hub is created after the commit, as today.

### D9. Show create and team settings
- `POST /api/shows`: inside the existing transaction, after `studioExists` and before
  `createShow`, `authGetMembershipRoleForShare(user.id, studio_id)`: `null` → today's `404`,
  `member` → `403 Admin role required.`.
- `PUT /api/profile`: after `403 No access to that team.` and before the `settings` write,
  `authGetMembershipRole(user.id, rawSid)`; `member` with `settings != null` or a non-empty
  `show_updates` → `403 Admin role required.`. Not transactional, like the rest of this route
  (a demotion racing a settings save may land either way; revocation latency, team-management).

### D10. Companion routes for a signed-in caller (owner decision 6; panel)
`POST /api/companion/presence` calls `requireSession(c, sid, { includeHidden: true })` when
`c.get('user')` is non-null and the trimmed `session_id` is non-empty, after the NUL check and
before `presence.upsert`. `includeHidden` matches what the Companion routes resolve
(`companion.ts:92`), so only access, or a session that doesn't exist at all, changes the answer.
A nonexistent id now gets `404` too, because masking needs it (OQ10). The client's previous
presence row is not deleted on a `404`; it expires with its short TTL. The web swallows presence
errors (`useCompanionPresence.ts:76`), so no web change.

The panel found the gap this leaves: a cookie caller could read or drive a teammate's active
session through the other routes. So when `c.get('user')` is non-null, `state`, `categories`,
`log`, `transport` and `command` check `canAccessSession(c, sid)` after resolving the active
session and answer exactly as when there is none, so existence doesn't leak:
- `state`: `active_session_id: null`, `session: null` (the `row === null` branch), and
  `last_command: null` when its `session_id` is a session the caller can't access;
  `connected_clients` is unchanged (a count, no identity);
- `categories`, `log`, `transport`, `command`: `requireActiveSession` throws its existing
  `409 No active session — open AutoLogger in a browser and open a session.` (one change in that
  helper, which all four call).

`commands/wait` and `commands/:id/ack` read no session and are unchanged. **Token-only callers
(no user) are unchanged (proposed; owner confirmed at approval, 2026-10-02):** they are the Companion's device
credential, the system caller until slice 9.

### D11. Grants and role changes (proposed; owner confirmed at approval, 2026-10-02)
Promote, demote and transfer don't touch grants (team-management "Show grants"). The access query
ignores grants for owners and admins, so a stored grant is inert while its holder is a manager
and applies again after a demotion. *Alternative:* delete on promotion. Rejected: it would make a
demotion silently strip access the admin had set up before, and it adds a write to 5c's role
change.

### D12. Transcript-generation lock redaction
`requesterCanViewSession` (`transcribe.ts:111`) becomes `canAccessSession` (D3), so a member
without a grant gets the identifier-free busy response, as a non-member does.

### D13. Web
- **Types.** `ProfileShow = ShowBrief & { can_access: boolean }` for `ProfilePayload.shows` (D7);
  `TeamMember.show_ids?: string[]`; the grant `PUT`/`DELETE` response `{ok: true}`. `useTeams.ts`:
  `useSetShowGrant(teamId)` (`{showId, userId, granted}` → `PUT` or `DELETE`), invalidating the
  team detail; the grantee's own profile refetches on its next focus/poll as today.
- **Access helper** `web/src/api/hooks/useShowAccess.ts`: `useShowAccess()` from the profile:
  `canAccessShow(showId)` (`shows[].can_access === true`), `accessibleShows(studioId)`,
  `teamRole(studioId)` (`auth.user.teams[].role`), `isTeamManager(studioId)`.
- **Rail and home** (`V6Rail.tsx`, `HomeRoute.tsx`): New Session and Batch Import render only when
  `accessibleShows(activeStudio)` is non-empty; the home resume card renders only for an openable
  session.
- **Pickers** (`NewSessionModal.tsx`, `BatchImportModal.tsx`): list `accessibleShows` of the
  active team.
- **Session cards** (`RecentSessionsList.tsx`): a card whose `show_id` the user can't access
  renders as a plain-text title with "No access — ask a team admin", no ⋮ menu and no navigation;
  archived cards likewise.
- **Settings** (`HomeSettingsModal.tsx`) **(proposed; owner confirmed at approval, 2026-10-02)**: stays on
  the rail for everyone. When the selected team's
  role is `member`, the team defaults (frame rate) and show editing sections are not rendered,
  "Add show" is hidden, and `handleSave` omits `settings` and `show_updates`. This deviates from
  the plan's "hide Settings": hiding it would remove members' only way to switch team or edit
  their name, and its save would `403` anyway because it always sends `settings` (A6).
- **TeamCard** (`TeamCard.tsx`): in the owner and admin views, each `member` row gets a "Show
  access" disclosure with one checkbox per team show (from `useStudioShows(teamId)`), checked from
  `show_ids`; toggling calls `useSetShowGrant`; errors surface like the other team mutations.
- **SessionRoute**: unchanged; an ungranted deep link already resolves to its not-found state.

### D14. Test harness: the default user becomes an admin
The narrowest change that keeps the existing integration tests meaningful: the default signed-in
user is an **`admin`** (not `member`) of `test-studios` and `test-studio-2` (`harness.ts:111`),
and `seededSession()` / `seedMemberStudio()` add it as `admin` (`helpers.ts:28,115`;
`seedMemberStudio` keeps its name, its comment says "admin").
- Why: the existing suites test content behavior (events, exports, audio, AI, show and session
  creation), not authorization. Six fixture captures and several suites create shows and sessions
  in `test-studios` as that user (A10); as a `member` every one of them would `403` or `404`.
- Why not `owner`: the bootstrap-claim tests (`teams.int`, `auth.int`) claim ownerless
  `test-studios`; an owner default user would make it owned. An admin is left alone by the claim.
- Why not grants via `seededSession`: shows seeded with `seedShow` in `test-studios` and in
  `seedMemberStudio` teams (27 calls in `sessions.int` alone) would each need a grant, which
  spreads the change over many suites.
- The member path gets its own coverage: a new `seedAccessMatrix()` helper returns a team with a
  show and a session, and cookies for an owner, an admin, a granted member, an ungranted member
  and a non-member. The access suites (task groups 3-8) use it.
- Suites that assert the default user's role, if any, are updated and named in their task
  (`grep` finds none today outside `teams.int`'s explicit users; A15).

### D15. Route-table access test
`server/src/routers/access.int.test.ts`, modeled on `gate.int.test.ts`'s 401 table: enumerate
`app.routes` for paths containing `:sessionId` (plus `GET /api/sessions/:sessionId` and the WS
path) and `/api/shows/:showId/log-import`; substitute the matrix's real session and show ids;
request each as the ungranted member (expect the masked `404` with `Session not found` /
`Show not found.`, byte-identical to a nonexistent id) and as the granted member and the admin
(expect anything but that `404`). `expect(routes.length).toBeGreaterThan(40)` guards the
enumeration, and a route added without the gate fails here. A second table covers the five
Companion routes of D10: with a granted teammate's presence on the matrix session, the ungranted
member's cookie gets the no-active-session answer (`state` with nulls, `409` for the others)
byte-identical to the answer with no presence at all, and the granted member gets the session.

### D16. Spec deltas
- `team-management`: "Team roles: owner, admin and member" carries the scenario "Content access
  is role-blind", which no longer holds, so it is REMOVED and restated as "Team roles, owner
  anchor and show access" (5c's D14 pattern). The Purpose says content stays role-agnostic; a
  delta can't change a Purpose, so archive edits it (task 13.4).
- `team-management`: "Owner-anchored team lifecycle" carries the scenario "Removed member's live
  session is not severed mid-flight", which owner decision E reverses, so it is REMOVED and
  restated as "Owner-anchored team lifecycle and access revocation".
- `api-contract-freeze`: each changed requirement is MODIFIED in full; the new behaviors are
  ADDED requirements so no frozen scenario is renamed.
- `transcript-generation` ("Generation lock status is observable", "Single-flight generation"),
  `sheets-log-import` ("Job authorization and lifecycle") and `topic-generation` ("Topic generation
  is configuration-gated") say "member of the studio" where the rule is now show access; each is
  MODIFIED in full (panel).
- Left unchanged because they stay literally true: `auto-event-generation`'s guard-ladder scenario
  says "the guard ladder above applies", and the ladder's step 1 (session resolution, masked
  `404`) is where an ungranted member stops; `local-container-environments`' "Every gated feature is
  available" says none of the calls gets a "not configured" `503`, which still holds for an
  ungranted member (who gets `404`); `youtube-audio-import` defers to "the existing
  `requireSession` behavior", which D3 redefines in one place (the D19 re-check answers with the
  same masked `404`).
- `web-home-launch` owns the rail's session cards and the home launch surface; `batch-audio-import`
  owns the rail's Batch Import control. `web-ui-system` (New Session progressive disclosure,
  Settings save state), `web-session-routing` (the not-found state) and `web-login-experience` name
  no access rule (`grep -n -i "member\|access" …` → no access rule), so they don't change.

### D17. 6b context (owner decision 2), not applied here
6b `catalog-rls` adds a NOLOGIN role that only `autologger_app` can `SET ROLE` to, with policies
that mirror D2's predicate; the bare `authenticated` role gets nothing. This change creates no
role or policy. D2 keeps the rule in one SQL predicate so 6b can copy it into a policy.

### D18. Fixtures and conformance
Recaptured: `profileAuthenticated` (`shows[].can_access`), `teamDetailAdmin` and
`teamDetailOwner` (`members[].show_ids`). New: `showGrantPut` (`PUT …/grants/:userId`) and
`sessionsListNoAccess` (`GET /api/sessions` as an ungranted member, D21). `showsList`,
`showDetail`, `showCreate`, `sessionsList` and `teamDetailMember` must not change. `web/src/api/types.conformance.test.ts` and
`web/src/apiResponseShapes.repo.test.ts` check them.

### D19. Imports re-check access (owner decision F)
- **Log import** (`logImport.ts:161`, a detached job with its own catalog): before each sheet's
  import, `catalog.auth.authCanAccessShow(job.userId, showId)`. On `false`: append `Access
  revoked; stopping.`, set status `failed` with error `Access revoked.`, and return; sheets
  already imported keep their events. The `Done.` summary is not appended.
- **YouTube import** is not a detached job (A21): the request awaits the download
  (`sessions.ts:489`). The plan's "detached jobs" wording doesn't fit it, so the re-check runs
  once, after the download and before the first segment or take write: `canAccessSession`; on
  `false` the route answers the masked `404 Session not found` (its existing denial) and writes
  nothing, then removes its temp dir as on any failure.
- Batch Import and local audio import are client-driven request by request, so the per-request
  gate already re-checks them.

### D20. Closing sockets when access is lost (owner decision E)
- **Record the user.** `sessionWs.ts` passes `requireUser(c).id` to `hub.attachSocket(ws, role,
  userId)` (`SessionHub.ts:385` gains the parameter; `AttachedSocket` keeps it).
- **Close.** `SessionHubRegistry` gains `closeUserSockets(userId, sessionIds: Set<string>, code)`,
  which walks only hubs already live in this process (it never instantiates a hub) and calls
  `close(4403)` on that user's sockets there; `detachSocket` runs from `onClose` as today.
- **Which sessions.** A helper `closeSocketsAfterAccessLoss(c, userId, showIds)` runs after the
  write's transaction commits: it keeps the shows in `showIds` the user can no longer access
  (`authCanAccessShow`), lists their session ids (`SELECT id FROM sessions WHERE show_id = ANY
  (…)`, including hidden ones), and calls `closeUserSockets`. Callers and their `showIds`:
  grant revoke (that show); team remove, leave and the support membership delete (every show of
  the team); a team-plane demotion to `member` and a support-plane upsert that leaves `member`
  (every show of the team, filtered by the access check, so granted shows keep their sockets).
- **Client.** `useSessionSocket` reconnects with backoff on any close (A20); the upgrade then gets
  the masked `404`, and the session's next HTTP read resolves to the not-found state.
- **Limits.** In-process only; a second process, Realtime (slice 9) or leases (slice 8) need the
  database to drive it (owner decision E's follow-up, recorded in ADR 0021 by task 11.3). A
  disabled account's sockets are out of scope (unchanged).

### D21. The session list for a caller without access (owner decision G)
`GET /api/sessions` computes `authCanAccessShow(user.id, activeShowId)` once. When `false`,
`serializeSessionEntry` is followed by a redaction that sets `notes: ""`, `event_count: 0`,
`is_rolling: false`, `current_take: 0`, `rolling_timecode: null` and `total_runtime_hms:
"00:00:00"` (`formatRuntimeHms`'s zero, A22), and keeps `id`, `title`, `deck_title`, `show_id`,
`show_code`, `show_name`, `episode`, `session_status`, `frame_rate`, `start_offset_frames`,
`created_at_utc`, `episode_date` and `archived` (`sessions.ts:89-108`). The web type already allows
`rolling_timecode: string | null`. The detail route never redacts: it is gated by `requireSession`.

## Assumptions (each with the command that tests it)

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | `requireSession` checks membership only | `grep -n authUserHasStudio server/src/routers/_helpers.ts` | `57:  if (!studioId \|\| !(await catalog.auth.authUserHasStudio(user.id, studioId))) {` |
| A2 | The session routes call `requireSession` directly | `grep -c "await requireSession(c" server/src/routers/*.ts \| grep -v ":0"` | `aiV2.ts:1 sessions.ts:7 audio.ts:5 ai.ts:1 events.ts:12 sessionWs.ts:1 exports.ts:2 transcribe.ts:11` |
| A3 | The AI v2 routes reach it through one prologue | `grep -n "guardAiV2Route(c" server/src/routers/aiV2.ts \| wc -l` | `5` |
| A4 | No session route reads its body before the gate | an `awk` scan of each router for `req.json(` between a `/api/sessions/:sessionId` route line and its `requireSession`/`guardAiV2Route` | no output |
| A5 | Log import and the lock redaction copy the membership check | `grep -n authUserHasStudio server/src/routers/logImport.ts server/src/routers/transcribe.ts` | `transcribe.ts:115`, `logImport.ts:135` |
| A6 | The Settings save always sends `settings` | `grep -n "settings,$" web/src/pages/index/components/HomeSettingsModal.tsx` | `572:      settings,` |
| A7 | Presence stores any session id without a lookup | `grep -n "body.session_id\|presence.upsert" server/src/routers/companion.ts` | `109:` (NUL check), `113:` (trim), `118: await c.env.ports.presence.upsert(cid, meta);` |
| A8 | No code deletes a show | `grep -rn -i "DELETE FROM shows" packages server/src --include=*.ts \| grep -v test \| wc -l` | `0` |
| A9 | Three membership deletes, the support one outside a transaction | `grep -n authRemoveMembership server/src/routers/*.ts \| grep -v test` | `admin.ts:119`, `teams.ts:297`, `teams.ts:314` |
| A10 | Fixture captures run as the default user in its seed team | `grep -c "activeStudioId()" server/src/routers/apiResponseFixtures.int.test.ts` | `6` |
| A11 | The schema record captures `idx_%` indexes and a fixed table list | `grep -n "indexname like\|^const TABLES" server/src/test/pg/catalogSchema.pg.test.ts` | `16:const TABLES = [`, `94: … indexname like 'idx\\_%'` |
| A12 | New catalog tables are granted to the app role automatically | `grep -n "alter default privileges" -A1 supabase/migrations/20261001000000_catalog_schema.sql` | `154: alter default privileges for role postgres in schema catalog` / `155: grant select, insert, update, delete on tables to autologger_app;` |
| A13 | Catalog transactions are SERIALIZABLE | `grep -n "ISOLATION LEVEL SERIALIZABLE" packages/storage/src/postgresCatalogStore.ts` | `405: slot.client.unsafe('BEGIN ISOLATION LEVEL SERIALIZABLE'),` |
| A14 | The web checks `Show` assignable to `ShowBrief` | `grep -n ": ShowBrief =" web/src/api/types.conformance.test.ts` | `455: const brief: ShowBrief = profileAuthenticated.shows[0];`, `544: const brief: ShowBrief = showsList.shows[0];` |
| A15 | The default user is added as `member` in three places | `grep -n "'member')" server/src/test/harness.ts server/src/test/helpers.ts` | `helpers.ts:28`, `helpers.ts:115`, `harness.ts:111` |
| A16 | The team detail already gates `invites` on owner or admin | `grep -n "role === 'admin' \|\| role === 'owner'" server/src/routers/teams.ts` | `157:  if (role === 'admin' \|\| role === 'owner') {` |
| A17 | The token scope is decided only for `/api/companion/` | `grep -n "path.startsWith('/api/companion/')" server/src/middleware/auth.ts` | `34:    path.startsWith('/api/companion/') &&` |
| A18 | The session list reads the active show only | `grep -n "listSessionsForShow(activeShowId)" server/src/routers/sessions.ts` | `134:  for (const s of await catalog.sessions.listSessionsForShow(activeShowId)) {` |
| A19 | The Companion's no-active-session answer is one helper's `409` | `grep -n "No active session" server/src/routers/companion.ts` | `95: throw new ApiError(409, 'No active session — open AutoLogger in a browser and open a session.');` |
| A20 | The web session socket reconnects after any close | `grep -n "reconnectTimer = setTimeout" web/src/api/hooks/useSessionSocket.ts` | `207: reconnectTimer = setTimeout(connect, wait);` |
| A21 | Log import is detached; YouTube import awaits its download | `grep -n "void (async" server/src/routers/logImport.ts server/src/routers/sessions.ts; grep -n "fetchYoutubeAudio(" server/src/routers/sessions.ts` | `logImport.ts:161: void (async () => {` only; `489: const fetched = await fetchYoutubeAudio(…)` |
| A22 | A zero runtime formats as `00:00:00` | `grep -n "if (tf <= 0) return" packages/domain/src/timecode.ts` | `118: if (tf <= 0) return '00:00:00';` |
| A23 | Sockets attach with no user id today | `grep -n "attachSocket(ws" packages/session-core/src/SessionHub.ts` | `385: attachSocket(ws: { send(data: string): void }, role: 'browser' \| 'companion'): void {` |

## Risks / Trade-offs

- **[Existing members lose session access at deploy]** → Intended (owner decision 3). On dev and
  stage every plain member of a real team loses access until an owner or admin grants shows;
  owners and admins (the bootstrap owner, `k50633376@…` on `my-studio`) keep everything. The
  live check in proposal "After merge" covers it. Prod starts empty at cutover.
- **[Rollback opens access]** → dev and stage only. The 5c image over this catalog ignores
  `show_grants`, so members regain full access until roll-forward (fail-open). The migration is
  forward-only, like the others; dropping the table is not needed to roll back.
- **[Revocation reaches HTTP and sockets, not in-flight requests]** → A request already past its
  gate finishes; sockets close after the commit (D20), in this process only. Slices 8/9 move
  the close to the database.
- **[A log import keeps one sheet after a revoke]** → The re-check runs between sheets (D19), so
  the sheet in progress when the revoke commits completes; its events stay (owner decision F).
- **[A stale presence row]** → A presence posted before a revoke keeps the Companion pointed at
  that session until its TTL expires; the Companion routes are the system caller (owner decision
  6). Slice 9 replaces this.
- **[Token-only Companion calls still reach any session]** → Kept (D10, proposed); the token is
  the Companion's device credential until slice 9. Cookie callers are checked on every route.
- **[SERIALIZABLE retries]** → The `FOR SHARE` reads in D5 and D8 add read locks to hot paths
  (session create). 5c measured the retry budget; task 10.1's races run 5 times.
- **[Harness change hides a regression for members]** → The access matrix suites and the route
  table test cover every route as a member; D14.
- **[Cutover]** → prod's catalog is created at cutover with no grants; after the slice 11 import
  the owner grants shows to members. ADR 0021's cutover notes record it.

## Open Questions

Plan contradictions and gaps found while grounding the plan, each resolved by the decision named.
The owner-level choices from the first draft are now decisions marked "proposed; owner confirms at
approval" (D6, D10, D11, D13) and listed in proposal.md "For the approver"; the panel's owner
decisions E-H settled the rest.

- **OQ7 (plan contradiction).** The plan's `can_write boolean`; catalog-database keeps flags as
  0/1 integers until the typed-schema follow-up. Resolved: `bigint not null default 1` (D1).
- **OQ8 (plan refinement).** The plan revokes grants from each route; D2 puts the revoke inside
  `authRemoveMembership`, so all three paths (and any later one) revoke in the delete's
  transaction. Each path still has its own test.
- **OQ9 (ADR refinement).** ADR 0021 says "Members see the show list only"; owner decision 3 adds
  each show's session titles. The slice 6a ADR entry records the refinement.
- **OQ10 (plan gap).** Masking makes presence for a nonexistent session a `404` too (today it is
  stored and ignored). The web ignores presence errors.
- **OQ11 (owner decision F wording).** F names "YouTube import detached jobs", but the YouTube
  import is synchronous (A21). Resolved: one re-check after the download, before any write (D19).
