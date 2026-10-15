## ADDED Requirements

### Requirement: Account approvals are stored in the catalog
The migration `20261024000000_account_approvals.sql` SHALL create `catalog.account_approvals`,
and the recorded schema expectation of "The catalog schema lives in Postgres schema `catalog`"
SHALL gain it in the same change. Its columns:
- `email_norm`, `text COLLATE "C"`, the primary key, checked to be printable ASCII without
  spaces, of the shape `local@domain`, and equal to its own `lower()`;
- `approved_at_utc`, non-null ISO-8601 UTC text in the server's format
  (`YYYY-MM-DDTHH:MM:SS.sssZ`), so it compares as text against the Clock;
- `note`, nullable text of at most 200 characters.

Row-level security SHALL be enabled; `catalog_system` SHALL have a permissive policy allowing
every command, but only `select` and `delete` privileges (its `insert`, `update` and `truncate`
are revoked), so the app can read and consume approvals and never create one; there SHALL be no
`catalog_user` policy and `catalog_user`'s privileges SHALL be revoked; `anon`, `authenticated`
and `public` SHALL have no privileges.

The same migration SHALL create two functions that only `postgres` may execute (`execute`
revoked from `public`; `security invoker`; `search_path` fixed to `catalog, pg_temp`):
- `catalog.approve_account(email text, note text default null) returns text` trims ASCII spaces,
  refuses with SQLSTATE `22023` an email with any character outside `!`..`~` or not of the shape
  `local@domain`, folds `A`-`Z` to lowercase, inserts or refreshes the row (`approved_at_utc`
  now, `note` replaced, a blank note stored as null), and returns the normalized email;
- `catalog.revoke_account_approval(email text) returns boolean` applies the same normalization,
  deletes the row and returns whether one was deleted.

Rollback drops both functions and the table after the code is reverted; approvals are lost and
no account changes.

#### Scenario: Approving normalizes the email
- **WHEN** `postgres` runs `select catalog.approve_account('  Someone@Example.COM ')`
- **THEN** it returns `someone@example.com` and that row exists

#### Scenario: Approving twice refreshes the row
- **WHEN** an approved email is approved again with another note
- **THEN** one row remains, with the new note and a new `approved_at_utc`

#### Scenario: A malformed or non-ASCII email is refused
- **WHEN** `postgres` approves `no-at-sign`, `a b@example.com` or `ké@example.com`
- **THEN** each call fails with SQLSTATE `22023` and no row is written

#### Scenario: Revoking reports whether a row went
- **WHEN** `postgres` revokes an approved email, then revokes it again
- **THEN** the first call returns `true` and removes the row, the second returns `false`

#### Scenario: App roles can neither create approvals nor run the functions
- **WHEN** a `catalog_user` binding selects from `account_approvals`, a `catalog_system` binding
  inserts or updates a row, or `autologger_app` (under either catalog role) executes
  `catalog.approve_account`
- **THEN** each is refused with `42501`, while a `catalog_system` binding can select and delete

## MODIFIED Requirements

### Requirement: Row-level security is enabled on every catalog table
Every table in schema `catalog` SHALL have row-level security enabled. Every catalog table SHALL
have at least one policy for `catalog_system`. Every table except `kv`, `companion_devices`,
`companion_presence` and `account_approvals` SHALL also have at least one policy for `catalog_user`, the nine session
tables included (ADR 0021 slice 7b-2): a user binding reads and writes session content only as
"User policies enforce the team permission model" allows. Those four tables are system-only:
they have no `catalog_user` policy and `catalog_user` SHALL have no privilege on them.
`companion_devices` is read and written only by the reviewed system task `companion-device`, and
`companion_presence` only by `companion-presence` (ADR 0021 slice 9d), and `account_approvals`
is written only by `postgres` and read and deleted only by the OAuth callback's system task
`oauth-callback` (closed-signups).

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
- **THEN** every table has row-level security enabled and a policy for `catalog_system`; every
  table other than `kv`, `companion_devices`, `companion_presence` and `account_approvals` has at
  least one policy for `catalog_user`, each session table exactly one; and those four have no
  `catalog_user` policy

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
