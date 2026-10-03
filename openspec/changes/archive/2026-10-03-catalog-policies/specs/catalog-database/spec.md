## MODIFIED Requirements

### Requirement: Catalog roles for user and system callers
The migrations SHALL create two roles, `catalog_user` (statements made for a signed-in user) and
`catalog_system` (statements made for a named system task). Each SHALL be `NOLOGIN`, without
`BYPASSRLS`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or superuser, and a member of no role.
Creating them SHALL be safe when they already exist in the cluster, and SHALL reset those
attributes.

Each SHALL hold `USAGE` on schema `catalog`. `catalog_system` SHALL hold `SELECT`, `INSERT`,
`UPDATE` and `DELETE` on every catalog table. `catalog_user` SHALL hold the same, except:
- on `kv`, no privilege;
- on `users`, `SELECT`, and `UPDATE` of `given_name` and `family_name` only (no `INSERT`, no
  `DELETE`, no update of any other column);
- on `user_studio_memberships` and `team_invites`, no `INSERT`.

Both grants SHALL cover tables that later migrations create in the schema. Neither role SHALL hold anything else in the catalog except
`EXECUTE` on the functions named for it:
- `catalog.app_user_id()`, for both roles;
- the policy helpers (see "Policy helpers are reviewed definer functions"), for `catalog_user`
  only.

The function `catalog.app_user_id()` SHALL return the user id the current transaction set
(`app.user_id`), or null when none is set or it is empty. Only the two catalog roles SHALL be
able to execute it.

A role switch and a user id SHALL hold for one transaction only: after the transaction commits,
rolls back or fails, the connection is back to `autologger_app` with no user id.

#### Scenario: The roles exist as designed
- **WHEN** the catalog migrations have been applied
- **THEN** `catalog_user` and `catalog_system` exist with `rolcanlogin`, `rolbypassrls`,
  `rolsuper`, `rolcreatedb`, `rolcreaterole` and `rolreplication` all false, and neither is a
  member of any role

#### Scenario: The user id is read per transaction
- **WHEN** `autologger_app` begins a transaction, switches to `catalog_user` for that
  transaction, sets the transaction's user id to `u-1`, and calls `catalog.app_user_id()`, then
  commits and calls nothing else
- **THEN** the call returns `u-1`, and after the commit `current_user` is `autologger_app` and
  the transaction's user id is no longer set

#### Scenario: A failed transaction does not leak its role
- **WHEN** a transaction switches to `catalog_system` and then fails with an error, and the same
  connection runs a new statement without switching
- **THEN** `current_user` is `autologger_app`, and a catalog table read is refused with `42501`

#### Scenario: The user role's narrowed privileges
- **WHEN** a transaction switched to `catalog_user` with user id `u-1`:
  - updates `email`, `google_sub`, `picture_url` or `disabled_at_utc` of `u-1`'s own `users`
    row;
  - inserts or deletes a `users` row;
  - inserts into `user_studio_memberships` or `team_invites` for a team in which `u-1` is the
    owner
- **THEN** each statement is refused with `42501`, while an update of `u-1`'s own `given_name`
  and `family_name` succeeds

#### Scenario: Key/value is closed to the user role
- **WHEN** a transaction switched to `catalog_user` with a user id selects from, inserts into,
  updates or deletes from `catalog.kv`
- **THEN** each statement is refused with `42501`, and the same statements as `catalog_system`
  succeed

### Requirement: Row-level security is enabled on every catalog table
Every table in schema `catalog` SHALL have row-level security enabled. Every catalog table SHALL
have at least one policy for `catalog_system`. Every table except `kv` SHALL also have at least
one policy for `catalog_user`.

The `catalog_system` policies SHALL be permissive and allow every row for reading and writing.

The `catalog_user` policies SHALL be the ones "User policies enforce the team permission model"
defines; no `catalog_user` policy SHALL allow every row.

A migration that creates a catalog table SHALL, in the same migration:
- enable row-level security on it;
- give it a `catalog_system` policy;
- give it `catalog_user` policies, or revoke `catalog_user`'s privileges on it.

#### Scenario: No catalog table is left without row-level security
- **WHEN** the tables of schema `catalog` are listed with their row-level security flag and the
  roles their policies apply to
- **THEN** every table has row-level security enabled and a policy for `catalog_system`, and
  every table other than `kv` has at least one policy for `catalog_user`

#### Scenario: No user policy allows everything
- **WHEN** the `catalog_user` policies of schema `catalog` are listed with their `USING` and
  `WITH CHECK` expressions
- **THEN** none of them is the constant `true`

#### Scenario: Allow-all policies change nothing
- **WHEN** `catalog_system` inserts, selects, updates and deletes rows of every catalog table,
  including rows that name another user and rows of teams no user is a member of
- **THEN** every statement affects the same rows it would without row-level security

### Requirement: Settings defaults are race-free and never recreate a deleted team
Reading a team's settings SHALL NOT write anything: no insert, update or delete of any settings
row, whether the stored blob is present, missing or corrupt.
- A missing blob SHALL read as the default settings.
- A corrupt blob (not JSON, or not an object) SHALL read as the default settings and stay
  stored as it is.
- Reading the settings of a team that does not exist SHALL return the defaults.

Creating a team (the self-serve and the admin plane alike) SHALL store the team's default
settings in the same transaction that inserts the team definition. That row SHALL replace any
settings left under a reused id (team-management "Concurrent team writes"). Saving settings SHALL
store the saved blob, as before.

The migration that introduces this rule SHALL store default settings for every existing team that
has no settings row, and SHALL leave stored rows untouched. Those defaults SHALL have the shape
the server's own defaults have, with freshly generated category ids.

#### Scenario: Concurrent first loads
- **WHEN** five profile loads for a newly created team run at the same time
- **THEN** all succeed, every load returns the same category ids, and the team's one settings
  row is the row its creation stored

#### Scenario: A read writes nothing
- **WHEN** a team's settings row is missing, and a plain member loads `GET /api/profile`
- **THEN** the response is `200` with default settings for the team, and the team still has no
  settings row

#### Scenario: A corrupt blob is left as it is
- **WHEN** a team's stored settings are not valid JSON, and the settings are read
- **THEN** the read returns the default settings, and the stored value is unchanged

#### Scenario: A deleted team stays deleted
- **WHEN** a request reads team T's settings after T's deletion has committed
- **THEN** no settings row for T is written

#### Scenario: Team creation stores defaults
- **WHEN** a user creates team T, or the support plane creates it
- **THEN** exactly one settings row for T exists when the create commits, holding default
  settings

#### Scenario: Existing teams are backfilled
- **WHEN** the migration runs on a catalog where team A has no settings row and team B has one
- **THEN** A gets a default settings row whose shape matches the server's defaults, and B's row
  is unchanged

## ADDED Requirements

### Requirement: User policies enforce the team permission model
For a statement run as `catalog_user`, the database SHALL decide row by row from the
transaction's user id (`catalog.app_user_id()`), the user's memberships and roles, and the show
grants, as committed or as written earlier in the same transaction. A statement with no user id
SHALL see no row and write none. The app's gates stay the precise check (the 6a rules), and these
policies are the backstop behind them.

In the table below:
- a *member team* is a team in which the user has a membership of any role;
- a *managed team* is one in which the user is `owner` or `admin`;
- an *accessible show* is a show of a managed team, or a show of a member team for which the user
  holds a grant.

| table | read | insert | update | delete |
| --- | --- | --- | --- | --- |
| `users` | own row, and users with a membership in a member team | refused | own row, name columns only | refused |
| `user_studio_memberships` | rows of member teams | refused | rows of member teams | rows of member teams |
| `user_prefs` | own row | own row | own row | own row |
| `studio_definitions` | member teams | none | member teams | member teams |
| `shows` | shows of member teams | shows of managed teams | shows of managed teams | none |
| `sessions` | sessions of shows of member teams | sessions of accessible shows | sessions of accessible shows | none |
| `app_settings` | `studio_config:<id>` of member teams | `studio_config:<id>` of managed teams | `studio_config:<id>` of managed teams | `studio_config:<id>` of managed teams |
| `team_invites` | invites of member teams | refused | invites of member teams | invites of member teams |
| `show_grants` | grants on shows of member teams | grants on shows of member teams | grants on shows of member teams | grants on shows of member teams |
| `kv` | refused | refused | refused | refused |

The rules work as follows:
- An update SHALL require the rule both for the row as it was and for the row as written.
- A `SELECT … FOR SHARE` of a row SHALL succeed wherever the row's read and update rules both
  hold. In particular, it SHALL succeed on the user's own membership, on another membership row
  in a member team, and on the user's own grant in a member team.
- A read the rules refuse SHALL behave as if the row did not exist.
- An update or delete of a refused row SHALL affect no row and raise no error.
- An insert, or the inserted or updated row of an update, that the rules refuse SHALL fail with
  `42501`. This includes an insert with `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE`.

The rules hold the team boundary; they do not hold the role inside a team. Within a member team,
the rules let a user update or delete membership, invite and grant rows whatever their role. That
precision belongs to the app's in-transaction role checks. The database adds one guard: at most
one `owner` per team.

New memberships and invites are added only through system bindings (team creation, invites,
sign-in, the bootstrap claim, the support plane).

The following SHALL succeed under these rules, as each user-bound path performs them:
- an ownership transfer, which demotes the caller and then promotes the target in one
  transaction;
- a team delete;
- a leave or a removal, which deletes the member's grants in the team and then the membership.

#### Scenario: The allow/deny matrix
- **WHEN** each table is read, inserted into, updated and deleted from as `catalog_user` by:
  - a team T's owner;
  - an admin of T;
  - a member of T with a grant on show S1;
  - a member of T without grants;
  - the owner of another team U who is not a member of T;
  - a transaction with no user id;

  on rows of T, of U and of the user's own
- **THEN** each read returns exactly the rows the table above allows, and each write affects the
  rows the table allows. A refused update or delete affects no row; a refused insert, or a
  refused new row of an update, fails with `42501`

#### Scenario: A member reads titles of an ungranted show's sessions but cannot change them
- **WHEN** a member of T without a grant on S1 selects the sessions of S1, then updates one of
  them
- **THEN** the select returns them, and the update affects no row

#### Scenario: A non-member sees nothing of another team
- **WHEN** the owner of team U, who has no membership in T, selects from `users`, `shows`,
  `sessions`, `user_studio_memberships`, `studio_definitions`, `app_settings`, `team_invites` and
  `show_grants`
- **THEN** no row of T, and no user who is only in T, is returned

#### Scenario: Locked reads of own and target rows work
- **WHEN** inside a transaction a member of T selects their own membership in T `FOR SHARE`,
  then another member's membership in T `FOR SHARE`, and a granted member selects their own
  grant `FOR SHARE`
- **THEN** each returns the row; the same reads by a non-member of T return no row

#### Scenario: The owner's multi-step writes succeed
- **WHEN** the owner of T transfers ownership to an admin of T; and, separately, the owner of a
  team V with no shows deletes V as the team delete does; and a granted member of T leaves T
- **THEN** after the transfer T has one owner (the former admin) and the former owner is an
  admin; V's invites, definition, settings and memberships are all gone; and the leaving
  member's grants in T and membership in T are gone

#### Scenario: Cross-team conflicts are retried, not surfaced
- **WHEN** the owners of two different teams each run a catalog transaction through the
  server's adapter that reads their membership and writes a session, a show and their team's
  definition, interleaved so that each reads before the other commits, on a database with
  planner statistics
- **THEN** either transaction may abort with `40001`, the adapter retries it, and both
  transactions commit within the adapter's retry budget, with both teams' writes stored

#### Scenario: A member cannot make themselves a second owner
- **WHEN** a member of team T, which has an owner, updates their own membership's role to
  `owner` as `catalog_user`
- **THEN** the update fails with a unique violation (`23505`), and T still has one owner

### Requirement: Policy helpers are reviewed definer functions
The membership facts the policies need SHALL be read through `SECURITY DEFINER` functions in
schema `catalog`. They SHALL be owned by the migrations' role and SHALL pin `search_path` to
`pg_catalog, pg_temp`. They SHALL be executable by `catalog_user` only: not by `PUBLIC`,
`catalog_system`, `autologger_app` or any API role. They bypass row-level security, so each
function's own `WHERE` clause SHALL be its whole check. The functions SHALL be:
- `member_studios(uid)`: the ids of the user's member teams;
- `manager_studios(uid)`: the ids of the user's managed teams;
- `accessible_shows(uid)`: the ids of the user's accessible shows;
- `member_shows(uid)`: the ids of the shows of the user's member teams;
- `co_members(uid)`: the ids of the users with a membership in one of the user's member teams,
  the user included;
- `studio_exists(id)`: whether a team definition with that id exists;
- `show_exists(id)`: whether a show with that id exists.

A null or unknown `uid` SHALL give empty sets. The helpers SHALL be configured not to plan
sequential scans (`enable_seqscan = off`), so that where an index applies, the predicate locks a
`SERIALIZABLE` transaction takes in them cover index ranges rather than whole tables. Conflicts
that remain are retried by the adapter.

#### Scenario: Each helper returns exactly its set
- **WHEN** each helper is called for an owner, an admin, a granted member, an ungranted member,
  a user with no membership, and null
- **THEN** each returns exactly the expected ids or booleans, including empty sets for the last
  two

#### Scenario: Only the user role can call the helpers
- **WHEN** `has_function_privilege` is checked for `public`, `catalog_system`, `autologger_app`,
  `anon`, `authenticated` and `service_role` on each helper, and for `catalog_user`
- **THEN** every check is false except `catalog_user`'s, and each helper is `SECURITY DEFINER`
  with `search_path=pg_catalog, pg_temp` and `enable_seqscan=off` in its configuration
