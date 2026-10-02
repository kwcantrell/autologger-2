## ADDED Requirements

### Requirement: Key/value compare-and-set
The key/value port SHALL offer `replaceIf(key, expected, next)`. In one statement, it replaces the
value of an unexpired key only if the stored value equals `expected`, keeps its expiry, and reports
whether it replaced.

#### Scenario: A newer value wins
- **WHEN** a value is read, another writer then stores a different value, and the reader calls `replaceIf` with what it read
- **THEN** `replaceIf` reports false and the other writer's value remains

### Requirement: Root catalog statements are time-bounded
A catalog statement outside a transaction SHALL reject with a timeout error when it hasn't
completed within the adapter's root deadline (5 seconds by default), including any time spent
waiting for a pooled connection. Each root connection SHALL carry one statement at a time.
- A statement that times out before it was sent SHALL be withdrawn and SHALL never run.
- For one already sent, the adapter SHALL NOT send a cancel, because a late cancel could reach
  another caller's statement on that pooled connection; the role's statement timeout ends it on
  the server. Such a write may still apply after the caller's timeout, so its outcome is unknown,
  and the adapter SHALL NOT retry it.
- The timeout error SHALL expose when the statement has finished on the server, so a caller that
  orders its writes can wait for it.

#### Scenario: A paused database
- **WHEN** a root statement is sent while the database does not answer
- **THEN** the caller receives the timeout error within about the root deadline, and later statements succeed once the database answers
