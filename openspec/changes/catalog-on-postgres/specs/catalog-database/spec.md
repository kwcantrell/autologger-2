## ADDED Requirements

### Requirement: The server's catalog runs on Postgres
The server SHALL keep its catalog only in the Postgres `catalog` schema: users, memberships,
preferences, teams, shows, settings, the session index, invites and key/value entries. It SHALL
connect as `autologger_app`, using the connection settings its compose stack passes (`PGHOST`,
`PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`). It SHALL NOT open, create or migrate a SQLite
catalog file. One catalog adapter per server process SHALL serve every catalog store and the
key/value store.

The server SHALL NOT apply catalog migrations; the stack's migrations service does.

**Boot.** Before listening, the server SHALL wait for the catalog to answer a query on the `kv`
table, for at most 30 seconds in total. Each attempt SHALL be bounded by the time remaining. It
SHALL log each distinct failure code once, as it first appears, and SHALL exit non-zero if the
catalog is not ready in time. The supervisor then retries.

**Password rotation.** Rotating the app role's password SHALL follow this order:
1. change the secret;
2. apply the migrations service, which sets the role's password;
3. recreate the app.

Between steps 2 and 3, new catalog connections fail.

**Show order.** Listing a team's shows SHALL order them by name, ignoring ASCII letter case.
Names that are equal in that order SHALL be sorted bytewise.

**Error logs.** When an unexpected catalog error is logged, the log SHALL name the error's code,
constraint and table, and SHALL NOT include the values involved.

#### Scenario: Catalog writes land in Postgres
- **WHEN** the server creates a team, a show and a session, and the app restarts
- **THEN** all three are read back after the restart, and no `catalog.db` file exists in a `DATA_DIR` that had none

#### Scenario: The server waits for the migrated catalog
- **WHEN** the server starts before the catalog schema exists, and the migrations service applies it within 30 seconds
- **THEN** the server begins listening after the schema appears, without a restart

#### Scenario: An unreachable catalog stops boot
- **WHEN** the catalog does not answer a query on `kv` within 30 seconds of start
- **THEN** the server exits non-zero within a few seconds after the 30 seconds, without having listened

#### Scenario: Shows sort case-insensitively
- **WHEN** a team has shows named `b`, `A` and `a`
- **THEN** listing them returns `A`, `a`, `b`

#### Scenario: A duplicate-key error logs no values
- **WHEN** an unexpected unique violation on a user's email reaches the server's error handler
- **THEN** the response is the generic `500`, and the log line names the code and constraint but not the email
