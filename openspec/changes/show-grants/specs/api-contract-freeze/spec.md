## MODIFIED Requirements

### Requirement: Session detail endpoint
`GET /api/sessions/:id` SHALL respond `200` with a JSON object carrying exactly the
same field set and value semantics as one element of the `active`/`archived` arrays in
the `GET /api/sessions` response (produced by the same serialization, so the shapes
cannot drift), for any session the requester is authorized to access under the same
authorization rule the existing per-session routes use (show access: the requester is the
owner or an admin of the session's team, or a member holding a grant for the session's show;
team-management "Member content access"), regardless of the requester's active-show or active-studio
preferences and regardless of the session's archived state. It SHALL respond `404` —
indistinguishable across the cases — for a nonexistent id, a deleted (`ui_hidden`)
session, and a session the requester is not authorized to access (a non-member of the team, or
a member without a grant for the session's show), preserving the existing 404-masking posture. Authentication requirements match the other
`/api/sessions/*` routes. This endpoint is additive: the `GET /api/sessions` list
response keeps its scope and shape; for a caller without access to the listed show its values
follow "Session list entries for a show without access".

#### Scenario: Authorized fetch regardless of active scope
- **WHEN** an authenticated requester who can access the session's show (owner, admin, or a
  member with a grant for it) requests `GET /api/sessions/<id>` while their active show or active studio preference points
  elsewhere
- **THEN** the server responds `200` with the session object, field-for-field the
  shape of a `GET /api/sessions` list entry

#### Scenario: Archived session still resolves
- **WHEN** the session exists, the requester is authorized, and the session is
  archived
- **THEN** the server responds `200` with the session object reflecting its archived
  state

#### Scenario: Masked 404 across all denial causes
- **WHEN** `GET /api/sessions/<id>` is requested for an id that never existed, for a
  deleted (`ui_hidden`) session, for a session in a studio the requester is not a
  member of, or for a session of a show the requester, a member of its team, holds no grant for
- **THEN** every case responds with the same `404` (same shape), with no signal
  distinguishing them

#### Scenario: A member without a grant gets the masked 404
- **WHEN** a member of the session's team who holds no grant for the session's show requests
  `GET /api/sessions/<id>`, and an admin of the same team requests it with no grant
- **THEN** the member gets the same `404` as for a nonexistent id, and the admin gets `200`

### Requirement: Team management endpoint family
The server SHALL expose the following authenticated team-management routes, which
become frozen surface on shipping. All are JSON; all require a logged-in user
(`401` otherwise); team-scoped routes respond with a masked `404` for teams the
caller is not a member of (nonexistent and foreign teams indistinguishable) and
`403` for a member without the required role where noted. Response objects are
additive-open (clients tolerate unknown fields). Every `role` value in a response is `"owner"`,
`"admin"` or `"member"`.

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/teams` `{id, display_name}` | any user | create team, caller becomes `owner`: `200 {id, name, role: "owner"}`; validation errors `400` |
| `GET /api/teams/:id` | member | team detail: `{id, name, role, enabled_admin_count, members: [{id, email, given_name, family_name, role}]}`; for an `admin` or `owner` caller each `members[]` entry also carries `show_ids` (string array: the shows of this team the member holds a grant for, sorted; `[]` for owner and admin entries, whose role gives access to every show) (`enabled_admin_count` = members whose role is `admin` and whose accounts are not disabled — the owner is not counted, so a new team reports `0`; per-member disabled status is deliberately not exposed; `members` lists the owner first, then admins, then members); `invites: [{email, invited_at_utc}]` present only when the caller is `admin` or `owner` |
| `PATCH /api/teams/:id` `{display_name}` | admin or owner | rename (display name only) |
| `DELETE /api/teams/:id` | owner | delete; `400` while shows exist |
| `POST /api/teams/:id/invites` `{email}` | admin or owner | immediate membership for existing users, else pending invite; idempotent per team+email |
| `DELETE /api/teams/:id/invites/:email` | admin or owner | revoke pending invite |
| `POST /api/teams/:id/members/:userId/role` `{role}` | owner | promote/demote between `admin` and `member`; `409` when the target is the owner |
| `DELETE /api/teams/:id/members/:userId` | admin or owner | remove member; removing an `admin` needs the owner (`403` for an admin caller); `409` when the target is the owner |
| `POST /api/teams/:id/leave` | member | caller leaves; `409` for the owner |
| `PUT /api/teams/:id/shows/:showId/grants/:userId` | admin or owner | grant the show to a member: `200 {ok: true}`; no body (any body is ignored); a `:userId` that is not a member of the team → `404` (`Member not found`); the owner or an admin as target → `200`, nothing stored; an existing grant → `200`, unchanged; a `:showId` that is not a show of this team → `404` (`Show not found.`) |
| `DELETE /api/teams/:id/shows/:showId/grants/:userId` | admin or owner | revoke: `200 {ok: true}` whether or not the grant existed (including a `:userId` that is not a member); a `:showId` that is not a show of this team → `404` (`Show not found.`) |
| `POST /api/teams/:id/owner` `{user_id}` | owner | transfer: `user_id` becomes `owner` and the caller becomes `admin`, in one transaction: `200 {ok: true}`; a `user_id` that is not a member of the team → `404` (`Member not found`); a member whose account is disabled → `400`; the caller's own id → `200`, no change |

**Default behaviors (frozen with the family):** every team id, including `test-studios` and
`test-studio-2`, is handled by the rules above (no id is rejected as built-in); a `:userId` that
is not a member of the team →
`404` (`Member not found` — the caller is a team admin or owner, membership of their own team
is not masked from them); role change to the already-held role → `200` idempotent;
invite revocation → `200` idempotent whether or not the invite existed; the
`:email` path segment is percent-decoded, then normalized identically to invite-time
(JS lowercase/trim) before matching; rename shares create's display-name validation
(non-empty, ≤200); invite emails are validated (plausible shape, ≤254 chars);
creation and pending-invite caps reject with `400` and an actionable message. Role-change body
values outside `admin`|`member` (`owner` included: ownership moves only by transfer) are
schema-rejected `400`; a transfer body without a non-empty string `user_id` is rejected `400`.
The owner `409` has the detail `Transfer ownership first.`. Statuses are decided in this order:
`401`, the masked `404`, the caller's role `403`, body validation `400`, the grant routes' show
`404`, then the target's `404`, `409` or owner-only `403`. Leaving the team or being removed from it
(team plane or support plane) deletes the member's grants for the team's shows in the same
transaction.

#### Scenario: Family is authenticated and masked
- **WHEN** an anonymous client calls any `/api/teams/*` route, and an authenticated
  non-member calls a team-scoped route for a real team and for a nonexistent id
- **THEN** the anonymous call gets `401`, and the two non-member calls get the same
  masked `404`

#### Scenario: Role gate distinguishes 403 from 404
- **WHEN** a plain `member` of a team calls an admin-only route on that team, and an `admin`
  calls an owner-only route on it
- **THEN** both responses are `403` (they may know the team exists; they may not manage
  it)

#### Scenario: Creation returns the owner role
- **WHEN** a signed-in user creates a team
- **THEN** the response is `200 {id, name, role: "owner"}`

#### Scenario: Transfer route
- **WHEN** the owner posts `{user_id}` naming a current enabled member to
  `POST /api/teams/:id/owner`
- **THEN** the response is `200 {ok: true}`, and the team detail then lists that member with
  `role: "owner"` and the caller with `role: "admin"`

#### Scenario: The owner is never a target
- **WHEN** any caller removes the owner, changes the owner's role, or the owner leaves
- **THEN** the response is `409` with the detail `Transfer ownership first.`

#### Scenario: Former built-in ids are not rejected
- **WHEN** a member of `test-studios` calls `GET /api/teams/test-studios`
- **THEN** the response is `200` with the team detail, not the former built-in `400`

#### Scenario: Grant routes
- **WHEN** an admin `PUT`s a grant of show S to member M, reads the team detail, and `DELETE`s the
  grant twice
- **THEN** the `PUT` is `200 {ok: true}`, the team detail lists M with `show_ids` containing S,
  both `DELETE`s are `200 {ok: true}`, and the team detail then lists M with `show_ids: []`

#### Scenario: Grant routes keep the family's statuses
- **WHEN** a plain member calls a grant route on their team, a non-member calls it, and an admin
  calls it with a show of another team
- **THEN** the member gets `403`, the non-member gets the masked `404`, and the admin gets `404`
  with `Show not found.`

#### Scenario: show_ids is for managers only
- **WHEN** an admin and a plain member of the same team fetch `GET /api/teams/:id`
- **THEN** every `members[]` entry in the admin's response carries `show_ids`, and no entry in the
  member's response does

### Requirement: Transcript generation lock status endpoint
`GET /api/transcript-generation/status` SHALL be frozen surface with:

| Condition | Response |
|---|---|
| No generation run in flight | `200 { "in_flight": false }` |
| Generation run in flight | `200 { "in_flight": true, "session_id": string\|null, "session_title": string\|null, "started_at": string }` |

`started_at` SHALL be ISO-8601 UTC. For a requester permitted to view the holding
session (one who can access its show — the same access rule sibling routes enforce by
404), `session_id` SHALL be the holder's id and `session_title` SHALL be the catalog
title at read time or `null` if the session row is absent. For a requester lacking that
access, `session_id` and
`session_title` SHALL both be `null` — same key set, never absent keys, `in_flight`
still `true`. The route MUST NOT mutate generation state. Auth SHALL match sibling
transcript list routes.

#### Scenario: Idle response shape
- **WHEN** the slot is free
- **THEN** the response is `200` with `in_flight` false

#### Scenario: Busy response shape
- **WHEN** the slot is held
- **THEN** the response is `200` with `in_flight` true and the busy fields populated as
  specified — identifiers for permitted requesters, `session_id`/`session_title` nulled
  (same key set) for requesters without access to the holding session (non-members, and
  members without a grant for its show)

### Requirement: Transcript generation endpoint behavior
`POST /api/sessions/:sessionId/transcript-words/generate` SHALL move from unconditional
`503` to configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `DEEPGRAM_API_KEY` unset/blank | `503 {detail}` — identical to the current unavailable response |
| configured, success | `200 {words: [...]}` — each word in the same trimmed wire shape `GET …/transcript-words` returns, namely exactly the seven keys `{id, session_time, speaker, word, start_sec, end_sec, ordinal}`; `start_sec`/`end_sec` carry remapped session-timeline seconds (`0` for anchorless words) rounded to 3 decimals; the array is the complete post-replace list in ordinal order |
| configured, session has no audio segments | `400 {detail}` |
| configured, segments exist but none is readable | `400 {detail}` (distinct detail) |
| configured, provider succeeds but returns zero words | `400 {detail}` (no-speech detail); existing words preserved |
| configured, another generation run in flight | `409 {detail}`; the detail names the busy session (title preferred, else id) when the requester may view it (can access the holder's show), and falls back to the identifier-free generic in-flight detail for requesters without that access or when the holder released in the race; no provider request issued |
| configured, request aborted before any provider call | `400 {detail}` — a distinct aborted detail, not `200`/`503`; no provider request issued |
| configured, upstream STT failure/timeout, or a group file over the provider size limit | `502 {detail}` |

`session_id` and `created_at_utc` SHALL NOT appear on any transcript-word wire object: the
former was redundant with the path parameter the caller already holds, the latter is
server-internal bookkeeping. The store and the per-session database keep both, so
server-internal consumers that read the hub directly are unaffected. Full float precision
for `start_sec`/`end_sec` likewise stays in the store; the rounding is a wire-only
projection.

Existing route semantics are otherwise unchanged: unknown session → the existing
`requireSession` behavior; the request body remains ignored/empty. Every transcript-word
response emits that one trimmed shape — the `GET …/transcript-words` list, the generate
`200`, the create `201`, and the `PATCH` response — and no other transcription surface
changes: `DELETE …/transcript-words/:wordId`, `…/topics` CRUD, and `transcribe.csv` (`503`)
keep their current frozen behavior, except that `GET /api/transcript-generation/status` is
an additional authorized surface (see above).

#### Scenario: Unconfigured deployments are byte-for-byte unchanged
- **WHEN** a deployment without `DEEPGRAM_API_KEY` receives `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly

#### Scenario: Configured success returns the list shape
- **WHEN** a configured deployment successfully generates a transcript
- **THEN** the response is `200` with `{words}` whose entries match the shape of
  `GET /api/sessions/:id/transcript-words` entries

#### Scenario: Every transcript-word response carries the trimmed seven-key shape
- **WHEN** a client reads `GET …/transcript-words`, generates words, creates a word
  (`201`), or patches one
- **THEN** each returned word object has exactly the keys `id`, `session_time`, `speaker`,
  `word`, `start_sec`, `end_sec`, and `ordinal`, with `start_sec`/`end_sec` rounded to 3
  decimals and neither `session_id` nor `created_at_utc` present

#### Scenario: Concurrent run maps to 409 naming the holder
- **WHEN** a generate request arrives while another run is already in flight and the
  requester can access the holder's show
- **THEN** the response is `409 {detail}` that identifies the busy session, and no
  provider spend occurs for it

#### Scenario: Concurrent run 409 is identifier-free for non-members
- **WHEN** a generate request from a requester without access to the holder's show (not a
  member of its studio, or a member without a grant for it) arrives while another run is in flight
- **THEN** the response is `409` with the generic in-flight `{detail}` naming no session,
  and no provider spend occurs for it

#### Scenario: Pre-provider-call abort maps to 400, not a new status code
- **WHEN** the originating HTTP request is already aborted before any DeepGram request
  would be issued
- **THEN** the response is `400 {detail}` with a detail distinct from the no-audio and
  all-unreadable `400` details, and no provider spend occurs

#### Scenario: Sibling stubs stay frozen
- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`

### Requirement: Show-scoped log-import job endpoints

The published HTTP contract SHALL include:

- `POST /api/shows/:showId/log-import` — body `{ spreadsheet_url: string }`;
  success `200 { job_id: string }`; validation/authorization failures use
  `{ detail }` with appropriate 4xx. Missing show AND an authenticated
  requester without access to the show (not a member of the show's studio, or a
  member without a grant for the show) get the uniform
  `404 { detail: "Show not found." }` (no existence oracle). The route is
  configuration-gated: unless `SHEETS_LOG_IMPORT_ENABLED` is `1`/`true`/`yes`
  (trimmed, case-insensitive) it responds `503 { detail }` with detail
  "Google Sheets log import is not configured on this deployment. Set
  SHEETS_LOG_IMPORT_ENABLED=1 to enable it."; the checks run in the order
  access 404 → config gate → body validation.
- `GET /api/log-import/:jobId` — success `200` with a JSON job status object
  including at least `status` (`queued`|`running`|`completed`|`failed`),
  `lines` (string array progress), and `error` (string or null). The route is
  creator-scoped: unknown job ids and jobs created by a different user both
  get the uniform
  `404 { detail: "Log import job not found." }`. It is NOT egress-gated
  (local in-process state only). Terminal jobs are prunable one hour after
  finishing and the in-memory job map is capped at 200 entries (oldest
  terminal evicted first; queued/running jobs never evicted), so a terminal
  job's status is only promised for about an hour after it finishes.

These endpoints are additive. Existing event POST/PUT shapes remain unchanged;
imported events are created server-side by the job (not via a new public
create-at-arbitrary-timecode client endpoint in this change).

#### Scenario: POST accepts a spreadsheet URL and returns a job id

- **WHEN** an authorized client POSTs a non-empty `spreadsheet_url` for an
  existing show on a configured deployment
- **THEN** the response is `200 { job_id }` and a subsequent GET for that id by
  the same requester is not `404`

#### Scenario: Unconfigured deployment is 503

- **WHEN** `SHEETS_LOG_IMPORT_ENABLED` is unset/blank and an authorized client
  POSTs to log-import for an existing show
- **THEN** the response is `503 { detail }` naming `SHEETS_LOG_IMPORT_ENABLED`
  and no job is created

#### Scenario: Non-creator status read is a uniform 404

- **WHEN** an authenticated user GETs a log-import job created by another user
- **THEN** the response is `404 { detail: "Log import job not found." }`,
  byte-identical to the unknown-id response

#### Scenario: A member without a grant gets the show 404
- **WHEN** a member of the show's studio who holds no grant for the show POSTs a log import, on a
  configured or an unconfigured deployment
- **THEN** the response is `404 { detail: "Show not found." }`, byte-identical to the unknown-show
  response, and no job is created

### Requirement: Show title_suffix on show wire; next_episode omitted

Show objects are emitted through **two** serializers, and both SHALL include `title_suffix`
as either `"date"` or `"episode"` and SHALL NOT include `next_episode`:

- The **brief** serializer, used for profile `shows[]`, emits exactly
  `{id, studio_id, name, show_code, title_suffix}`, plus `can_access` in the profile.
- The **full** serializer, used by `GET /api/shows`, `GET /api/shows/:showId`, and
  `POST /api/shows` create responses, emits those five fields plus `categories`,
  `event_palette`, `event_palette_preset`, and `event_palette_custom`.

`can_access` (boolean, additive) SHALL be on every profile `shows[]` entry, and only there:
`true` when the caller can access the show (owner or admin of its team, or a member holding a
grant for it; team-management "Member content access"), else `false`. The full serializer's
shape is unchanged.

The two shapes differ deliberately: profile is fetched on every page load and fans out over
every show in every studio the caller can reach, so the per-show configuration it does not
need is served on demand by the `/api/shows` routes instead.

Profile `show_updates[]` entries SHALL accept `title_suffix` with the same two values.
Legacy `next_episode` keys on profile/show update bodies SHALL be ignored (not persisted)
and SHALL NOT cause `400` solely due to that key. Catalog persistence SHALL store
`title_suffix` on `shows`. The SQLite column `shows.next_episode` MAY remain for rollback
safety but SHALL NOT be bumped on session create and SHALL NOT appear on the show wire.

#### Scenario: Profile show carries title_suffix

- **WHEN** a client reads profile after migration
- **THEN** each `shows[]` entry includes `title_suffix` of `"date"` or
  `"episode"` and omits `next_episode`

#### Scenario: Profile shows[] carries the brief shape

- **WHEN** a client reads `GET /api/profile`
- **THEN** each `shows[]` entry carries exactly `id`, `studio_id`, `name`, `show_code`,
  `title_suffix` and `can_access` — no `categories`, no palette fields, and no `next_episode`

#### Scenario: The /api/shows routes carry the full shape

- **WHEN** a client reads `GET /api/shows?studio_id=…` or `GET /api/shows/:showId`
- **THEN** each show object includes `title_suffix`, `categories`, `event_palette`,
  `event_palette_preset`, and `event_palette_custom`, and omits `next_episode`

#### Scenario: Profile update persists title_suffix

- **WHEN** a client PUTs profile with `show_updates[].title_suffix` set to
  `"episode"`
- **THEN** a subsequent profile read returns that show with
  `title_suffix: "episode"`

#### Scenario: Legacy next_episode on update is ignored

- **WHEN** a client PUTs profile with `show_updates[].next_episode` set
- **THEN** the update succeeds without failing solely due to that key and no
  next-episode counter is written as a live product field

#### Scenario: can_access reflects the caller's access
- **WHEN** a member holding a grant for show A but not show B of the same team reads
  `GET /api/profile`, and an admin of that team reads the same
- **THEN** the member's `shows[]` has A with `can_access: true` and B with `can_access: false`,
  the admin's has both with `can_access: true`, and `GET /api/shows` carries no `can_access`

### Requirement: Login is required on every API route
Login SHALL always be required; there is no setting that turns it off. A `/api/*` request
without a valid session cookie SHALL get `401` with `{"detail": "Login required."}`, except:
- `GET /api/profile` and `HEAD /api/profile` (HEAD is served by the GET handler), which answer
  signed-out callers with the frozen profile response;
- `/api/admin/*`, which authenticates with `ADMIN_TOKEN`;
- `/api/companion/*` with a valid `API_TOKEN` bearer, as "API_TOKEN authenticates only the
  Companion surface" specifies (no studio-membership or show-access scoping).

The decision uses the percent-decoded request path the router matches, as defined in "API_TOKEN
authenticates only the Companion surface". `/auth/*` is unchanged. The `/api/sessions/:id/ws`
upgrade SHALL be refused for a caller without a valid session cookie. Every access check (studio
membership, team role, show access) SHALL apply to the signed-in user; the only caller with no
user is `API_TOKEN` on `/api/companion/*`. In the `GET /api/profile` response, `auth.oauth_configured` SHALL always be
`true`.

#### Scenario: Signed-out session list is refused
- **WHEN** `GET /api/sessions` is sent with no session cookie and no other credential
- **THEN** the response is `401` `{"detail": "Login required."}`

#### Scenario: Signed-out profile keeps its shape
- **WHEN** `GET /api/profile` is sent with no session cookie
- **THEN** the response is `200` with its frozen shape, `auth.logged_in` false and
  `auth.oauth_configured` true

#### Scenario: Signed-out HEAD of the profile is exempt
- **WHEN** `HEAD /api/profile` is sent with no session cookie and no other credential
- **THEN** the response is `200` with no body, not `401`

#### Scenario: Signed-out profile update is refused
- **WHEN** `PUT /api/profile` is sent with no session cookie
- **THEN** the response is `401` `{"detail": "Login required."}` and nothing is written

#### Scenario: The access check applies to the signed-in user
- **WHEN** a signed-in member without a grant for show S requests a session of S
- **THEN** the response is the masked `404`, decided for that user; no request on this surface
  is authorized by `API_TOKEN` outside `/api/companion/*`

## ADDED Requirements

### Requirement: Show creation and team settings need owner or admin
`POST /api/shows` SHALL require the caller to be the `owner` or an `admin` of the target team. A
member of the team SHALL get `403 {"detail": "Admin role required."}` and no show SHALL be
created; the role SHALL be checked inside the creating transaction. The existing statuses keep
their order: body validation, `400 Unknown studio id.` for a team that does not exist, the masked
`404` for a non-member, then the role `403`.

`PUT /api/profile` with a non-null `settings` or a non-empty `show_updates` SHALL require the
caller to be the `owner` or an `admin` of the selected team (`active_studio_id`). A member SHALL
get `403 {"detail": "Admin role required."}` and nothing SHALL be written, including the body's
active team and show and names. The check runs after the existing `403 No access to that team.`
and before any write. A body without `settings` and `show_updates` (switching the active team or
show, editing names) SHALL behave as before for members. The zero-membership branch is unchanged.

#### Scenario: A member cannot create a show
- **WHEN** a plain member of team T posts `POST /api/shows` for T
- **THEN** the response is `403 {"detail": "Admin role required."}` and T has no new show, while
  the same request by an admin of T is `200 {show}`

#### Scenario: A member cannot save team or show settings
- **WHEN** a plain member puts `PUT /api/profile` with `settings` for their active team, and then
  with `show_updates` for one of its shows
- **THEN** both responses are `403 {"detail": "Admin role required."}` and neither the settings
  nor the show changes, nor the member's active team and show

#### Scenario: A member still switches teams and edits names
- **WHEN** a plain member puts `PUT /api/profile` with only `active_studio_id`, `active_show_id`,
  `given_name` and `family_name`
- **THEN** the response is `200` with the updated profile

### Requirement: Session creation needs show access
`POST /api/sessions` SHALL require the caller to be able to access the requested show (the owner
or an admin of its team, or a member holding a grant for it). A caller who can see the show (a
member of its team) but cannot access it SHALL get `403 {"detail": "No access to this show."}`
and no session SHALL be created. The show is visible to members, so this denial is not masked.
The existing checks keep their order and statuses (`403 No team access.`, `400 Unknown
show_id.`, `400 Show does not belong to the active team.`), then this `403`, then title
validation. The access check SHALL be made inside the transaction that creates the session, so a
grant revoked before that transaction commits refuses the create.

#### Scenario: A member without a grant cannot create a session
- **WHEN** a member whose active team is T posts `POST /api/sessions` for a show of T they hold no
  grant for
- **THEN** the response is `403 {"detail": "No access to this show."}` and no session is created

#### Scenario: A granted member creates a session
- **WHEN** the same member, after an admin grants them the show, repeats the request
- **THEN** the response is `200` with the created session, in the frozen create shape

### Requirement: Companion routes check a signed-in caller's session access
Every access check on `/api/companion/*` SHALL apply to the signed-in user when there is one.
A request authenticated only by `API_TOKEN` (no signed-in user) is the system caller and SHALL
behave as before this change (owner decision 6, 2026-10-02; a device credential comes in slice 9).

- **Presence.** `POST /api/companion/presence` from a signed-in user with a non-empty
  `session_id` SHALL require that user to be able to access that session (team-management "Member
  content access"). A session that does not exist, is deleted, or that the user cannot access
  SHALL get the masked `404 {"detail": "Session not found"}` and SHALL store no presence; the
  client's earlier presence row is left to expire. The existing NUL check (`400`) runs first. A
  post with `closing: true` or with an empty or absent `session_id` SHALL behave as before.
- **Reads and writes on the active session.** For a signed-in caller, `GET /api/companion/state`,
  `GET /api/companion/categories`, `POST /api/companion/log`, `POST /api/companion/transport` and
  `POST /api/companion/command` SHALL resolve the active session as before (the freshest
  presence) and then check the caller's access to it. When the caller cannot access it, each
  route SHALL answer exactly as it does when there is no active session, so the session's
  existence does not leak: `state` returns `active_session_id: null` and `session: null` (and
  `last_command: null` when the stored command names a session the caller cannot access), with
  `connected_clients` unchanged; `categories`, `log`, `transport` and `command` return the
  existing `409 {"detail": "No active session — open AutoLogger in a browser and open a
  session."}` and change nothing.
- `GET /api/companion/commands/wait` and `POST /api/companion/commands/:commandId/ack` read no
  session and are unchanged.

#### Scenario: Presence for a session the user cannot open
- **WHEN** a signed-in member with no grant for show S posts presence naming a session of S, and
  then a session id that does not exist
- **THEN** both responses are the same `404`, and `GET /api/companion/state` answers as if neither
  presence had been posted

#### Scenario: Presence for an accessible session is stored
- **WHEN** a signed-in member holding a grant for show S posts presence naming a session of S
- **THEN** the response is `200 {ok: true}`, and `GET /api/companion/state` reports that session

#### Scenario: A signed-in caller cannot drive a session they cannot open
- **WHEN** a granted teammate's presence makes a session of show S active, and a signed-in member
  with no grant for S calls `state`, `categories`, `log`, `transport` and `command`
- **THEN** `state` reports no active session and no session-naming `last_command`, the other four
  respond with the no-active-session `409`, and no event, take or command is written; the same
  holds when the active session belongs to another team

#### Scenario: Token-only callers are unchanged
- **WHEN** a client authenticated only by `API_TOKEN` posts presence naming any existing session
  and then calls `state` and `log`
- **THEN** the responses are as before this change

### Requirement: Session list entries for a show without access
`GET /api/sessions` SHALL keep its scope (the caller's active show) and its entry shape for every
caller. When the caller cannot access the listed show (a member of its team without a grant), each
entry SHALL keep `id`, `title`, `deck_title`, `show_id`, `show_code`, `show_name`, `episode`,
`session_status`, `frame_rate`, `start_offset_frames`, `created_at_utc`, `episode_date` and
`archived` as today, and SHALL blank every field that carries content or live state:
- `notes` SHALL be `""`;
- `event_count` SHALL be `0`;
- `is_rolling` SHALL be `false`;
- `current_take` SHALL be `0`;
- `rolling_timecode` SHALL be `null`;
- `total_runtime_hms` SHALL be `"00:00:00"` (the value for a session with nothing logged).

The list's split into `active` and `archived` and its order are unchanged. For a caller who can
access the show the entries are unchanged.

#### Scenario: Titles and dates only
- **WHEN** a member with no grant for their active show S, which has a rolling session with notes
  and events, requests `GET /api/sessions`
- **THEN** each entry carries its id, title, show identity and dates, with `notes: ""`,
  `event_count: 0`, `is_rolling: false`, `current_take: 0`, `rolling_timecode: null` and
  `total_runtime_hms: "00:00:00"`

#### Scenario: A granted caller sees full entries
- **WHEN** a member holding a grant for S, or an admin, requests the same list
- **THEN** the entries are identical to the pre-change entries

### Requirement: Session sockets close when access is lost
When a grant revoke, a member removal, a leave, a demotion to `member` (team plane or support
plane) or a support-plane membership delete commits, the server SHALL close every
`/api/sessions/:id/ws` socket the affected user holds in this process on a session that user can
no longer access, with close code `4403` (owner decision E, 2026-10-02). No other message is sent
on these sockets. A reconnect is refused like any upgrade for a session the caller cannot access
(the masked `404`). Sockets of other users, and the affected user's sockets on sessions they can
still access, SHALL stay open. This is new WebSocket emission semantics, authorized here.

#### Scenario: A revoked member's socket closes
- **WHEN** member M has a socket open on a session of show S and an admin revokes M's grant for S
- **THEN** M's socket closes with code `4403`, and M's next upgrade for that session is refused

#### Scenario: Other sockets stay open
- **WHEN** the same revoke commits while another member granted S and an admin have sockets open on
  that session
- **THEN** both stay open and keep receiving broadcasts

### Requirement: Imports re-check show access as they run
A log-import job SHALL re-check its creator's access to the show before each sheet it imports.
When the creator has lost access, the job SHALL stop: it appends the progress line `Access
revoked; stopping.`, ends with status `failed` and error `Access revoked.`, and imports no further
sheet. Events already written by earlier sheets stay. A YouTube import
(`POST /api/sessions/:id/youtube-import`) SHALL re-check the caller's access after the download
and before writing any segment or take; when access was lost meanwhile it SHALL respond with the
masked `404 {"detail": "Session not found"}` and write nothing.

#### Scenario: A log import stops when access is revoked
- **WHEN** a member's log import is between two sheets and an admin revokes the member's grant
- **THEN** the job's lines end with `Access revoked; stopping.`, its status is `failed` with error
  `Access revoked.`, the first sheet's events remain, and the second sheet's are not written

#### Scenario: A YouTube import after a revoke writes nothing
- **WHEN** a member's YouTube import is downloading and an admin revokes the member's grant
- **THEN** the response is the masked `404` and the session has no new segment or take
