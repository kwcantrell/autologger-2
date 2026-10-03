## ADDED Requirements

### Requirement: Policy outcomes keep each route's status
Row-level policies (catalog-database "User policies enforce the team permission model") SHALL
NOT change any status, body or message a route returns for a request that a serial order of
requests can produce. The app's gates decide first. Where a policy can hide a row or refuse a
write, the route SHALL answer as follows.

**Existence probes.** A route whose status distinguishes a missing entity from another team's
entity SHALL ask an existence check that sees every row, not a user-scoped read:
- `POST /api/shows` SHALL answer `404 Unknown studio id.` for a team that exists but in which the
  caller has no membership. It SHALL answer `400 Unknown studio id.` for a team that does not
  exist. That includes a team whose deletion commits while the create is in flight.
- `POST /api/sessions` SHALL answer `400 Show does not belong to the active team.` for a show
  that exists in a team other than the caller's active team, member or not. It SHALL answer
  `400 Unknown show_id.` for a show that does not exist.

**Writes refused in a race.** A write whose access is revoked after the route's early gate and
before the write SHALL be answered with the status the route already gives for missing access,
and SHALL leave the row unchanged:
- `PUT /api/sessions/:id`, `POST /api/sessions/:id/archive`, `POST …/restore` and
  `DELETE /api/sessions/:id` SHALL answer `404 Session not found` when the write changed no row.
- `PUT /api/profile` with team settings or show updates SHALL re-check the caller's role, with
  the membership row locked `FOR SHARE`, in the same transaction as those writes and before the
  first of them. A caller who is no longer `owner` or `admin` there SHALL get
  `403 Admin role required.` with nothing written, prefs and names included. Outcomes for
  requests no demotion races stay as before, including the `400` for a show entry outside the
  selected team after the earlier entries were saved.
- The ownership transfer SHALL answer `404 Member not found` when the target's user row cannot be
  read.

**A refusal after an in-transaction gate is a bug.** Where the route checked the caller's role or
access inside the same transaction, with the rows read `FOR SHARE`, a `42501` cannot come from a
concurrent change. These routes are:
- the team writes;
- `PUT /api/profile`'s settings and show writes;
- `POST /api/shows`;
- `POST /api/sessions`;
- the grant writes.

On any of them, a `42501` SHALL stay the generic `500` `{"detail": "Internal Server Error"}`, with
a log line naming `CatalogForbiddenError`, its table and its binding. Elsewhere, an unmapped
`42501` SHALL be answered the same way.

**Multi-statement writes run in an order the policies admit.** A store method that removes a
team SHALL delete the team's memberships last, after its invites, definition and settings. While
the caller is still a member, each of those deletes passes the member-team rules.

#### Scenario: A foreign team stays 404 on show create
- **WHEN** a signed-in user who is not a member of existing team U sends `POST /api/shows` with
  `studio_id` U
- **THEN** the response is `404` `{"detail": "Unknown studio id."}`, as before row-level policies

#### Scenario: A team deleted during show create stays 400
- **WHEN** a show create for team T has passed its existence read, and the deletion of T commits
  before the show is inserted
- **THEN** the create gets `400 Unknown studio id.`, and no show references T

#### Scenario: Another team's show on session create stays the team error
- **WHEN** a signed-in user sends `POST /api/sessions` for a show of a team they are not a member
  of, and separately for a show id that does not exist
- **THEN** the first gets `400 Show does not belong to the active team.` and the second
  `400 Unknown show_id.`

#### Scenario: A session update racing a revoke changes nothing
- **WHEN** a granted member's `PUT /api/sessions/:id` has passed `requireSession`, and the
  revocation of the member's grant commits before the update runs
- **THEN** the response is `404 Session not found` and the session row is unchanged

#### Scenario: A settings save racing a demotion is refused
- **WHEN** an admin's `PUT /api/profile` with team settings and a show update has passed its
  early role check, and the admin's demotion to member commits before the request's transaction
- **THEN** the response is `403 Admin role required.`, and the stored settings, the show, the
  admin's prefs and names are unchanged

#### Scenario: A team delete removes every row under policies
- **WHEN** the owner of a team with no shows deletes it through `DELETE /api/teams/:id`
- **THEN** the response is `200`, and the team's invites, definition, settings and memberships
  are all gone

#### Scenario: A forbidden error after an in-transaction gate is a 500
- **WHEN** a statement in a team write's transaction is refused with `42501` after the caller's
  role was read `FOR SHARE`
- **THEN** the response is `500` `{"detail": "Internal Server Error"}`, and the log line names
  `CatalogForbiddenError`, the table and the binding `user`, but not the user id
