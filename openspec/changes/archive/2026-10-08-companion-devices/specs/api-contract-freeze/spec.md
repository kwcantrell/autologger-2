## REMOVED Requirements

### Requirement: API_TOKEN authenticates only the Companion surface

**Reason**: `API_TOKEN` is retired (companion-devices owner decision 4, ADR 0021 slice 9d): the server no longer reads it and a stale `API_TOKEN` Bearer gets `401`, so the title and its "Companion routes still accept the token" scenario would state the opposite of the behaviour. Restated under "Companion device tokens authenticate only the Companion surface".

### Requirement: Companion routes check a signed-in caller's session access

**Reason**: The token-only system caller it preserved is deleted (companion-devices owner decisions 1, 2, 6, 7): every Companion call now runs as a user, so its "Token-only callers are unchanged" scenario would state the opposite of the behaviour. Restated, with per-user active-session selection for device and cookie callers alike (owner decision 9, an intentional change for cookie readers of `state`), per-device last command and the device `403` on presence, under "Companion routes run as the caller's user".

## MODIFIED Requirements

### Requirement: Login is required on every API route
Login SHALL always be required; there is no setting that turns it off. A `/api/*` request
without a valid session cookie SHALL get `401` with `{"detail": "Login required."}`, except:
- `GET /api/profile` and `HEAD /api/profile` (HEAD is served by the GET handler), which answer
  signed-out callers with the frozen profile response;
- `/api/admin/*`, which authenticates with `ADMIN_TOKEN`;
- `/api/companion/*` with a valid Companion device token as a `Bearer`, as "Companion device
  tokens authenticate only the Companion surface" specifies; such a request runs as the
  device's user, with that user's access checks.

The decision uses the percent-decoded request path the router matches, as defined in "Companion device
tokens authenticate only the Companion surface". `/auth/*` is unchanged. The `/api/sessions/:id/ws`
upgrade SHALL be refused for a caller without a valid session cookie. Every access check (studio
membership, team role, show access) SHALL apply to the signed-in user, or, for a device call, to the device's user; no request on
`/api/companion/*` runs without a user, and `API_TOKEN` is not read (ADR 0021 slice 9d). In the `GET /api/profile` response, `auth.oauth_configured` SHALL always be
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
  is authorized by a Companion device token outside `/api/companion/*`

### Requirement: Text containing NUL is refused
The catalog cannot store the character U+0000 (NUL). A request value containing NUL that would
reach a catalog statement, whether from a path segment, a query value or a body field, SHALL be
refused with status `400` and a JSON body `{"detail": "<message>"}`. The statement carrying it
SHALL NOT be sent, and a catalog transaction it belongs to SHALL write nothing.

Session content is catalog content (ADR 0021 slice 7b-1), so this covers it too: an event's
category, message or metadata, a transcript word, a topic, a dashboard and every other value a
session write stores. A session write carrying NUL SHALL save nothing and send no `*.changed`
broadcast, whether the value came from the request or from a server-side source (a transcription
provider, an AI tool call, an imported sheet); such a source's run reports the failure through
its existing failure path.

These cases are handled explicitly:
- `POST /api/companion/presence` from a signed-in (cookie) caller with a `session_id` or a
  `client_id` containing NUL, or a `client_id` that is blank after trimming, SHALL be refused with
  `400` before any write, and SHALL store or remove no presence. A Companion device caller gets
  the `403` of "Companion routes run as the caller's user" before this check.
- An OAuth callback whose `state` contains NUL SHALL be treated as an invalid state, with the
  existing `state_invalid` redirect.
- A sign-in whose identity token has a subject or email claim containing NUL SHALL be refused
  with the existing `token_invalid` redirect.
- NUL SHALL be removed from the given-name, family-name and picture claims before they are
  stored.

Values without NUL SHALL behave as before.

#### Scenario: NUL in a show name is a 400
- **WHEN** a client creates a show whose `name` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, and no show is created

#### Scenario: NUL in a team display name is a 400
- **WHEN** a team admin creates a team whose `display_name` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, as for the family's other validation errors, and no team is created

#### Scenario: NUL in a path segment is a 400
- **WHEN** a client requests a team-scoped route whose team id path segment contains a percent-encoded NUL
- **THEN** the response is `400` with a JSON `detail`, not `500`

#### Scenario: NUL in a presence session id is refused
- **WHEN** a signed-in browser client posts presence with a `session_id` containing NUL
- **THEN** the response is `400`, and a later `GET /api/companion/state` answers as if that presence had never been posted

#### Scenario: A NUL or blank presence client id is refused
- **WHEN** a signed-in browser client posts presence with a `client_id` containing NUL, and again
  with a `client_id` of only spaces
- **THEN** both responses are `400` with a JSON `detail`, not `500`, and no presence row is
  written or removed

#### Scenario: NUL in the OAuth state is an invalid state
- **WHEN** the OAuth callback receives a `state` containing a percent-encoded NUL
- **THEN** it redirects with `login_error=state_invalid`

#### Scenario: NUL in the email claim refuses sign-in
- **WHEN** a first Google sign-in carries an `email` containing NUL
- **THEN** it redirects with `login_error=token_invalid` and creates no user

#### Scenario: NUL in a name claim is stripped
- **WHEN** a first Google sign-in carries a `given_name` containing NUL and valid other claims
- **THEN** the user is created, and the stored given name is the claim with NUL removed

#### Scenario: NUL in an event message is a 400
- **WHEN** a client logs an event whose `message` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, the session has no new event, and no
  `event.changed` frame is sent

## ADDED Requirements

### Requirement: Companion device tokens authenticate only the Companion surface
The server SHALL NOT read `API_TOKEN`; there is no shared Companion secret (ADR 0021 slice 9d,
owner decision 4). A Companion authenticates with a per-device token issued by "Companion device
management routes".

On a request whose path is under `/api/companion/`, an `Authorization: Bearer <token>` header
SHALL decide the caller, and a session cookie on the same request SHALL be ignored:
- The token SHALL be hashed with SHA-256 and looked up among the stored devices. When it names a
  device whose user is not disabled and which is not expired, the request SHALL run as that user,
  with the catalog bound to that user, and SHALL be marked as a device call carrying the device's
  id.
- **Idle expiry** (owner decision 8). A device SHALL be expired when its last use, or its creation
  when it has never been used (`coalesce(last_used_at, created_at)`), is 90 days or more before
  now. Any authenticated use SHALL renew it through its last-used time. An expired device SHALL
  stay listed, marked `expired: true`, until its user revokes it.
- Any other Bearer value (unknown, revoked, expired, belonging to a disabled user, or the retired
  `API_TOKEN` value) SHALL get `401` with `{"detail": "Login required."}`, and no handler SHALL
  run.

A request under `/api/companion/` with no Bearer header SHALL be authenticated by its session
cookie, as before.

Here and in the login gate, "the request path" is the percent-decoded path the router matches, so
an encoded spelling of a path (for example `/%61pi/companion/state` or `/%61pi/sessions`) is
treated exactly as its literal form. On every other path, including every other `/api/*` route,
`/api/companion-devices`, the `/api/sessions/:id/ws` upgrade (any `role`), `/auth/*` and
`/api/admin/*`, a Bearer header SHALL be ignored: a request that carries a device token and no
other credential SHALL be handled exactly as a request that carries no credential. `ADMIN_TOKEN`
handling on `/api/admin/*` is unchanged.

The lookup SHALL run on every request, so a revoked device or a disabled user is refused on its
next request. A device's last-used time SHALL be updated at most once a minute per device, after
the lookup, and its failure SHALL only log a warning; it SHALL NOT delay or fail the request.

**Audit lines** (owner decision 8). Creating a device, revoking a device, and a device's first use
after creation SHALL each write one server log line carrying the user id and the device id. No
log line SHALL carry a device token or its hash.

This requirement authorizes a breaking change to fielded Companion installs: one configured with
`API_TOKEN` gets `401` until it is given a device token. The five paths the module calls
(`/api/companion/{state,categories,log,transport,command}`) and the `Bearer` header are
unchanged.

#### Scenario: A device token opens the Companion routes
- **WHEN** `GET /api/companion/state` is sent with a live device's token as a `Bearer` and no
  session cookie
- **THEN** the response is `200` with the frozen state shape, answered for the device's user

#### Scenario: The retired API_TOKEN is refused
- **WHEN** `GET /api/companion/state` is sent with the value the deployment formerly used as
  `API_TOKEN` as a `Bearer`
- **THEN** the response is `401` `{"detail": "Login required."}`

#### Scenario: Unknown, revoked and disabled-user tokens are refused
- **WHEN** `GET /api/companion/state` is sent with a token no device has, with the token of a
  device its user revoked, and with the token of a device whose user is disabled
- **THEN** each response is `401` `{"detail": "Login required."}` and no handler runs

#### Scenario: An idle device expires and stays listed
- **WHEN** a device was created, never used, and the clock advances 90 days; then its token is
  sent to `GET /api/companion/state`, and its user lists their devices
- **THEN** the state request answers `401` `{"detail": "Login required."}`, and the list still has
  the device with `expired: true` until the user revokes it

#### Scenario: Use renews a device
- **WHEN** a device is used on day 80 after its creation, and then again on day 120
- **THEN** both requests are answered for the device's user, and its listing shows
  `expired: false` with `last_used_at` at the latest use

#### Scenario: Device lifecycle is audited without secrets
- **WHEN** a user creates a device, the device is used twice, and the user revokes it
- **THEN** the server log has one line each for the create, the first use and the revoke, each
  naming the user id and the device id, and no log line contains the token or its SHA-256

#### Scenario: A device token opens nothing outside the Companion surface
- **WHEN** `GET /api/sessions`, `GET /api/companion-devices`, `GET /api/admin/users`,
  `GET /api/sessions/<id>/ai/v2/dashboard` and `POST /auth/logout` are each sent with a live
  device's token as a `Bearer` and no session cookie
- **THEN** each response is identical to the same request sent with no `Authorization` header

#### Scenario: A device token does not open the session WebSocket
- **WHEN** `/api/sessions/<id>/ws?role=companion` is opened with a live device's token as a
  `Bearer` and no session cookie
- **THEN** the upgrade is refused exactly as for an unauthenticated client

#### Scenario: Encoded spellings get the literal path's answer
- **WHEN** with no session cookie, `GET /%61pi/sessions` is sent with no credential,
  `GET /%61pi/companion/state` is sent with no credential, and `GET /api/%63ompanion/state` is
  sent with a live device's token as a `Bearer`
- **THEN** the first two get `401` `{"detail": "Login required."}` and the third gets `200`
  with the frozen state shape, exactly as `/api/sessions` and `/api/companion/state` do

#### Scenario: A Bearer decides the Companion caller even with a cookie
- **WHEN** `GET /api/companion/state` is sent with a valid session cookie and a `Bearer` that no
  device has
- **THEN** the response is `401` `{"detail": "Login required."}`

### Requirement: Companion routes run as the caller's user
Every route under `/api/companion/` SHALL run as a user: the signed-in user for a cookie caller,
or the device's user for a device call. There SHALL be no system caller on these routes. Every
access check SHALL be team-management "Member content access" for that user.

- **Active session.** The active session SHALL be chosen from the fresh presence rows
  (core-ports-architecture "Companion presence is shared by every process"), visible rows first,
  then the most recently updated:
  - for a device call, only rows posted by the device's user (owner decision 2);
  - for a cookie caller, only rows posted by that signed-in user, the same rule as a device
    (owner decision 9). This intentionally replaces the former view, in which a cookie caller saw
    the deployment-wide pick masked to their access; no other user's row SHALL be used.

  The chosen session SHALL still be checked with team-management "Member content access" for the
  caller.

  A row posted through any server process sharing the database SHALL count. When no row
  qualifies, or the chosen session no longer exists or the caller cannot access it, each route
  SHALL answer exactly as when there is no active session, so the session's existence does not
  leak: `GET /api/companion/state` returns `active_session_id: null` and `session: null`, and
  `GET /api/companion/categories`, `POST /api/companion/log`, `POST /api/companion/transport` and
  `POST /api/companion/command` return the existing `409 {"detail": "No active session — open
  AutoLogger in a browser and open a session."}` and change nothing.
- **Connected clients and playing.** `state`'s `connected_clients` SHALL count the caller's own
  fresh presence rows (device or cookie caller alike), and `session.is_playing` SHALL be true when
  any of the caller's own fresh rows on that session reports playing.
- **Last command, per device** (owner decision 6). `POST /api/companion/command` from a device
  call SHALL record the command as that device's last command before broadcasting it. `state`'s
  `last_command` SHALL be the calling device's last command, or `null` when it names a session the
  caller cannot access. `POST /api/companion/commands/:commandId/ack` SHALL match the id only
  against the calling device's last command. A cookie caller has no device: its `last_command`
  SHALL be `null`, its `ack` SHALL answer `{ok: false}`, and a command it sends SHALL be
  delivered to the session's sockets without being recorded as any device's last command. The
  former single deployment-wide last-command entry SHALL NOT be read, and the migration SHALL
  delete it.
- **Presence** (owner decision 7). `POST /api/companion/presence` from a device call SHALL get
  `403 {"detail": "Presence is posted by the AutoLogger browser app, not by a Companion
  device."}` before any other check, and SHALL store nothing. From a cookie caller:
  - the `400` checks of "Text containing NUL is refused" (a NUL in `session_id` or `client_id`,
    or a `client_id` blank after trimming) run first, before any write;
  - a non-empty `session_id` SHALL require the caller to be able to access that session; a
    session that does not exist, is deleted, or the caller cannot access SHALL get the masked
    `404 {"detail": "Session not found"}` and SHALL store no presence, and the client's earlier
    row is left to expire;
  - an absent, `null` or blank `session_id` SHALL be stored as no session (SQL `NULL`);
  - a post with `closing: true` SHALL delete the row for that client id only when it belongs to
    the caller, and otherwise SHALL behave as before;
  - **ownership:** a stored row SHALL record the caller's user, and it belongs to that user. A
    post for a client id whose row belongs to another user SHALL change nothing unless that row
    was last updated more than `PRESENCE_FRESH_MS` (15 s) ago, in which case the row SHALL become
    the caller's; either way the response SHALL be `200 {ok: true}`, so the answer reveals nothing
    about other users' rows.
- `GET /api/companion/commands/wait` reads no session and is unchanged.

The response shapes of `state`, `categories`, `log`, `transport`, `command`, `commands/wait` and
`ack`, and the `409` detail, are unchanged.

#### Scenario: Presence for a session the user cannot open
- **WHEN** a signed-in member with no grant for show S posts presence naming a session of S, and
  then a session id that does not exist
- **THEN** both responses are the same `404`, and `GET /api/companion/state` answers as if neither
  presence had been posted

#### Scenario: Presence for an accessible session is stored
- **WHEN** a signed-in member holding a grant for show S posts presence naming a session of S
- **THEN** the response is `200 {ok: true}`, and `GET /api/companion/state` reports that session

#### Scenario: A cookie caller follows only their own browsers
- **WHEN** user A's browser posts presence on session S1, then user B's browser posts fresher
  presence on session S2, both sessions accessible to both users, and A calls `state` with A's
  session cookie
- **THEN** `state` names S1, and `connected_clients` counts only A's fresh rows

#### Scenario: A cookie caller who lost access gets the no-active-session answer
- **WHEN** user A's browser posts presence on a session of show S, A's grant for S is then
  revoked, and A calls `state` and `log` with A's session cookie
- **THEN** `state` reports `active_session_id: null` and `session: null`, and `log` responds with
  the no-active-session `409` and stores nothing

#### Scenario: Another user's live presence row is not moved or deleted
- **WHEN** user A's browser posts presence with client id C on session S1, and within 15 s user B
  posts presence with client id C on session S2 and then posts `closing: true` for C
- **THEN** both of B's posts answer `200 {ok: true}`, and A's `state` still names S1 with
  `connected_clients` counting C

#### Scenario: A stale presence row is taken over
- **WHEN** user A's browser posts presence with client id C, more than 15 s pass with no post for
  C, and user B posts presence with client id C on session S2
- **THEN** the response is `200 {ok: true}`, B's `state` names S2, and A's `state` no longer
  counts C

#### Scenario: A presence post with no session stores no session
- **WHEN** a signed-in browser client posts presence with `session_id` absent, then `null`, then
  `""`
- **THEN** each response is `200 {ok: true}`, and the stored row names no session, so the caller's
  `state` reports no active session from it

#### Scenario: A signed-in caller cannot drive a session they cannot open
- **WHEN** a granted teammate's presence is the only fresh presence, on a session of show S, and
  a signed-in member with no grant for S calls `state`, `categories`, `log`, `transport` and
  `command`
- **THEN** `state` reports no active session and no session-naming `last_command`, the other four
  respond with the no-active-session `409`, and no event, take or command is written; the same
  holds when the presence names a session of another team

#### Scenario: A device follows only its own user's browsers
- **WHEN** user A's browser posts presence on session S1, then user B's browser posts fresher
  presence on session S2, both sessions accessible to both users, and a device of A calls `state`
  and `log`
- **THEN** `state` names S1, the event is logged in S1, and `connected_clients` counts only A's
  fresh rows

#### Scenario: A device whose user lost access gets the no-active-session answer
- **WHEN** user A's browser posts presence on a session of show S, A's grant for S is then
  revoked, and a device of A calls `state` and `log`
- **THEN** `state` reports `active_session_id: null` and `session: null`, and `log` responds with
  the no-active-session `409` and stores nothing

#### Scenario: Each device has its own last command
- **WHEN** devices D1 and D2 of the same user each have the active session, D1 sends a command,
  and then D2 and D1 each call `state` and acknowledge D1's command id
- **THEN** D1's `state` reports that command and its acknowledgement answers `{ok: true}`, while
  D2's `state` does not report it and its acknowledgement answers `{ok: false}`

#### Scenario: A device cannot post presence
- **WHEN** a device posts `POST /api/companion/presence` naming a session its user can access
- **THEN** the response is `403` with the browser-app detail, and `GET /api/companion/state`
  answers as if that presence had never been posted

#### Scenario: Presence posted through one process is seen by another
- **WHEN** a browser posts presence on session S through server process A, and a device of the
  same user calls `GET /api/companion/state` through process B sharing the database
- **THEN** process B's response names S as the active session

### Requirement: Companion device management routes
Each user SHALL manage their own Companion devices through three routes (owner decisions 1, 4, 5).
They SHALL be listed in the README endpoint table and in `packages/contract`. They are outside
`/api/companion/`, so they SHALL accept only a session cookie: a device token is never a credential
for them, and a request without a valid session cookie SHALL get `401 {"detail": "Login
required."}`. A user SHALL see, create and revoke only their own devices; there is no
administrator management of other users' devices. The routes use the system device store
(catalog-database "Companion devices and presence are stored in the catalog": the table has no
user policies), and every statement SHALL carry the caller's user id: the list selects only rows
with that user id, the revoke deletes only a row with that id and that user id, and the create
inserts that user id. These predicates are the only isolation between users.

- **`GET /api/companion-devices`** SHALL return `200 {devices: [{id, name, created_at,
  last_used_at, expired}]}` with the caller's devices, newest first. `created_at` SHALL be
  ISO-8601 UTC, `last_used_at` SHALL be ISO-8601 UTC or `null` when the device has never been
  used, and `expired` SHALL be a boolean, true when the device is past the 90-day idle window of
  "Companion device tokens authenticate only the Companion surface". The token and its hash SHALL
  never be returned.
- **`POST /api/companion-devices`** with body `{name}` SHALL create a device for the caller:
  - `name` SHALL be trimmed and SHALL then be 1 to 80 characters; an invalid name SHALL get `422`
    with the existing validation-error body, and a name containing NUL SHALL get the existing NUL
    `400`;
  - a user SHALL hold at most 10 devices; a create that would make an 11th SHALL get
    `409 {"detail": "You already have 10 Companion devices; revoke one first."}` and create
    nothing, and the count and the insert SHALL be serialized per user, so concurrent creates
    never leave more than 10;
  - the token SHALL be `ald_` followed by the base64url encoding of 32 random bytes, and only its
    SHA-256 (hex) SHALL be stored;
  - the response SHALL be `201 {id, name, created_at, token}`; this is the only response that ever
    carries the token.
- **`DELETE /api/companion-devices/:id`** SHALL revoke the caller's device and answer `204` with
  no body. An id that does not exist or names another user's device SHALL get
  `404 {"detail": "Companion device not found."}` (the owner predicate matches no row) and change
  nothing. A revoked device's token
  SHALL be refused from the next request on.

#### Scenario: Create, list and revoke a device
- **WHEN** a signed-in user creates a device named `Booth A`, lists their devices, revokes it,
  and lists again
- **THEN** the create answers `201` with `id`, `name` `Booth A`, `created_at` and a `token`
  starting `ald_`; the first list has that device with `last_used_at: null`, `expired: false`
  and no token; the
  revoke answers `204`; and the second list has no such device

#### Scenario: The token is shown once and stored only as a hash
- **WHEN** a device is created and its row is read from the catalog
- **THEN** no list response carries the token, and the stored row holds the token's SHA-256 hex
  and not the token

#### Scenario: The eleventh device is refused, even concurrently
- **WHEN** a user holding 9 devices sends two creates at the same time, and then one more
- **THEN** exactly one of the concurrent creates answers `201` and the other, like the last one,
  answers `409` with the revoke-one-first detail, and the user holds 10 devices

#### Scenario: Another user's device is not found
- **WHEN** user B deletes the id of user A's device, and lists their own devices
- **THEN** the delete answers `404 {"detail": "Companion device not found."}`, A's device still
  works, and B's list does not include it

#### Scenario: An invalid name is refused
- **WHEN** a user creates a device whose name is only spaces, one whose name is 81 characters, and
  one whose name contains NUL
- **THEN** the first two answer `422` and the third `400`, and no device is created

#### Scenario: Signed-out and device callers cannot manage devices
- **WHEN** `GET /api/companion-devices` is sent with no session cookie, and again with only a live
  device's token as a `Bearer`
- **THEN** both answer `401` `{"detail": "Login required."}`
