## MODIFIED Requirements

### Requirement: Row-level security is enabled on every catalog table
Every table in schema `catalog` SHALL have row-level security enabled. Every catalog table SHALL
have at least one policy for `catalog_system`. Every table except `kv` SHALL also have at least
one policy for `catalog_user`, the nine session tables included (ADR 0021 slice 7b-2): a user
binding reads and writes session content only as "User policies enforce the team permission
model" allows.

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
  every table other than `kv` has at least one policy for `catalog_user`, each session table
  exactly one

#### Scenario: No user policy allows everything
- **WHEN** the `catalog_user` policies of schema `catalog` are listed with their `USING` and
  `WITH CHECK` expressions
- **THEN** none of them is the constant `true`

#### Scenario: Allow-all policies change nothing
- **WHEN** `catalog_system` inserts, selects, updates and deletes rows of every catalog table,
  including rows that name another user and rows of teams no user is a member of
- **THEN** every statement affects the same rows it would without row-level security

#### Scenario: A user binding is refused on the session tables
- **WHEN** `autologger_app`, switched to `catalog_user` with the id of a user who has no access
  to session S's show (another team's owner, a member of S's team without a grant, or no user
  id), selects from, inserts into, updates or deletes from each session table for S
- **THEN** a user without access is refused: each select returns no row of S, each update and
  delete affects no row, and each insert fails with `42501`; the same statements with the id of
  the owner of S's team, or of a member with any grant on S's show, read and write S's rows

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
| the nine session tables | rows of sessions of accessible shows | rows of sessions of accessible shows | rows of sessions of accessible shows | rows of sessions of accessible shows |
| `kv` | refused | refused | refused | refused |

A session row's content is reachable exactly where `requireSession` admits the user (team-management
"Member content access"), whatever the grant's `can_write`; a member of the team without a grant
reads the session's `sessions` row (its title) and none of its content. The cost of this rule for
one statement SHALL NOT grow with the number of sessions the user can access.

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

#### Scenario: A member without a grant sees no session content
- **WHEN** a member of T without a grant on S1 selects the events, transport, transcript words
  and meta of a session of S1, and inserts an event into it; and the member is then granted S1
  and repeats both
- **THEN** before the grant the selects return no row and the insert fails with `42501`; after
  the grant the selects return the session's rows and the insert succeeds

#### Scenario: Locking a session row needs show access
- **WHEN** a session of S1 is selected `FOR UPDATE` by T's owner, by a granted member of S1, by a
  member without a grant, and by the owner of another team
- **THEN** the first two lock the row, and the last two get no row and no error

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
- `show_exists(id)`: whether a show with that id exists;
- `session_exists(id)`: whether a session with that id exists.

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
