## ADDED Requirements

### Requirement: Session live projection is mirrored in order
The catalog's copy of a session's live projection SHALL be written by one ordered writer per
session in the server process. Each write SHALL carry the session's state at the moment it is
sent, not when it was queued, so a slower earlier write never overwrites a later state. The
columns are:
- event count;
- latest timecode;
- rolling;
- current take;
- elapsed frames;
- roll start.

A write that fails SHALL be logged at warning level and SHALL NOT fail the request. When a write
times out on the client, the next write for that session SHALL wait until the timed-out
statement has finished on the server, so the order holds. A detached job that outlives its
request SHALL NOT use the request's catalog. After shutdown begins, the writer SHALL write
nothing.

#### Scenario: Out-of-order completion
- **WHEN** two changes to one session commit in order A then B, and A's mirror write would reach the database after B's
- **THEN** the catalog ends with the projection of B's state

### Requirement: Settings defaults are race-free and never recreate a deleted team
Reading a team's settings SHALL write the default settings only when none are stored and the team
exists. It SHALL do so with a statement that never overwrites settings a concurrent request
stored, and it SHALL NOT use a transaction that concurrent first reads can conflict on. A
corrupt stored blob SHALL be replaced only if it is still the blob that was read. Reading the
settings of a team that does not exist SHALL return defaults without storing them. A settings row
that a read racing a team delete still writes SHALL never reach a later team with the same id,
because team creation removes it (team-management "Concurrent team writes").

#### Scenario: Concurrent first loads
- **WHEN** five profile loads for a new team run at the same time
- **THEN** all succeed, and one settings row exists for the team

#### Scenario: A deleted team stays deleted
- **WHEN** a request reads team T's settings after T's deletion has committed
- **THEN** no settings row for T is written

### Requirement: Expired key/value rows are purged periodically
The server SHALL purge expired key/value rows at boot and every 10 minutes while running. A
failed purge SHALL only warn.

#### Scenario: Sign-in starts don't accumulate
- **WHEN** many sign-in starts are made and their states expire
- **THEN** within 10 minutes of expiry their rows are gone without a restart
