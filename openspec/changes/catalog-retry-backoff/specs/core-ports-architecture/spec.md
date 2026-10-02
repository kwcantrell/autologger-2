## MODIFIED Requirements

### Requirement: The Postgres catalog adapter

A Postgres implementation of the catalog port SHALL meet "The catalog transaction contract",
proven by the catalog transaction contract test suite. That suite SHALL include a
statement the body starts without awaiting: if it fails, the transaction fails.

Statements:
- it SHALL accept the `?` placeholders the catalog stores use, and leave quoted text and comments
  unchanged;
- it SHALL return 64-bit integer values as numbers;
- `run()` SHALL return the affected-row count;
- a statement with a text parameter containing U+0000 (NUL) SHALL be refused with a distinct
  invalid-text error before it is sent; inside a transaction, that refusal fails the transaction.

Transactions:
- every transaction SHALL run at the `SERIALIZABLE` isolation level;
- a transaction that fails on a serialization failure or a deadlock SHALL roll back and run its
  body again, at most five runs in total. The caller SHALL then receive the last serialization
  error;
- before running the body again after its `n`th run, the adapter SHALL wait a random delay of at
  least 0 and less than `20 × 2^(n−1)` milliseconds, holding no connection while it waits and
  never waiting past the transaction's deadline. If the deadline has passed when a run would
  start, the caller SHALL receive the timeout error, with no statement sent;
- no other failure SHALL be retried;
- because a body may run more than once, a transaction body SHALL have no effect outside the
  catalog database;
- a transaction SHALL resolve only when the server confirms its commit;
- when a commit's reply never arrives, the caller SHALL receive a distinct "outcome unknown"
  error, and the adapter SHALL NOT retry or roll back after it.

Time:
- one deadline SHALL cover the whole transaction: waiting for a connection, every run, and the
  commit;
- when the deadline passes, any statement in flight SHALL be cancelled, the transaction SHALL end
  on the server, and the caller SHALL receive a timeout error;
- no step SHALL wait on the server without a bound.

Connections:
- a connection SHALL serve another transaction only after its previous transaction was confirmed
  committed or rolled back, with no cancel pending;
- any other connection SHALL be closed and replaced;
- after a transaction's connection is lost, no statement of that transaction SHALL be sent
  anywhere, and the process SHALL keep running.

Sharing:
- in the server, the catalog stores and the key/value store SHALL share one instance of this
  adapter, and a key/value call SHALL never join a catalog transaction.

Closing:
- the adapter SHALL have an asynchronous `close()`;
- after `close()`, waiting and new calls SHALL reject, no connection SHALL be opened, and
  `close()` SHALL resolve once the adapter's connections have closed.

#### Scenario: The shared contract holds on Postgres
- **WHEN** the catalog transaction contract suite runs against the Postgres adapter, as the app's least-privilege role
- **THEN** every case passes

#### Scenario: A dropped failing statement fails the transaction
- **WHEN** a transaction body starts a write that violates a unique key without awaiting it, and returns
- **THEN** the caller receives the unique-violation error, and no write persists

#### Scenario: Concurrent read-modify-write transactions both commit
- **WHEN** two transactions read the same row, both wait until each has read it, and then each increments it
- **THEN** both calls resolve, the row has been incremented twice, and the bodies ran three times in total

#### Scenario: Retries are bounded and selective
- **WHEN** a body hits a serialization failure on every run, or a deadlock on its first run only, or a unique violation
- **THEN** its body runs exactly five times and the caller receives the serialization failure; or runs twice and commits; or runs once and the caller receives the unique violation

#### Scenario: Contending writers back off and all commit
- **WHEN** eight transactions concurrently read and then increment the same row
- **THEN** all eight commit and the row has been incremented eight times

#### Scenario: A backoff that reaches the deadline times out without another run
- **WHEN** a transaction's backoff wait ends at or after its deadline
- **THEN** the caller receives the timeout error, no statement of a new run is sent, and no connection is taken or opened for it

#### Scenario: A stalled statement is cancelled at the deadline
- **WHEN** a transaction's statement is still running at the deadline
- **THEN** the caller receives a timeout error promptly, the server session running it ends within seconds, none of the transaction's writes persist, and the next transaction commits

#### Scenario: A queued transaction times out cleanly
- **WHEN** every transaction connection is busy and a waiting transaction reaches its deadline
- **THEN** it receives a timeout error, and once the busy transactions end, as many new transactions as there are connections all commit

#### Scenario: A lost connection leaks nothing
- **WHEN** a transaction's server connection is terminated while its body is awaiting, and the body then issues another write
- **THEN** that write is refused without being sent, the transaction rejects, no write of the transaction persists, the process keeps running, and later transactions, more than the adapter's concurrent-transaction limit, all commit

#### Scenario: A commit with no reply is reported as unknown
- **WHEN** the connection is lost, or the time bound passes, after the commit was sent and before its reply
- **THEN** the caller receives the outcome-unknown error, no rollback or retry is attempted, and that connection is replaced

#### Scenario: An unconfirmed rollback retires the connection
- **WHEN** a rollback on a transaction's connection fails
- **THEN** that connection is closed and replaced, and the next transaction runs on the replacement

#### Scenario: Closing with work in flight
- **WHEN** `close()` is called while one transaction runs and another waits for a connection
- **THEN** the running one settles, the waiting one rejects, and no connection of the adapter remains on the server once `close()` resolves

#### Scenario: Placeholders and integers
- **WHEN** a statement contains a `?` inside a quoted string and one outside it, and selects a row count
- **THEN** only the outer `?` is bound, and the count is a number

#### Scenario: NUL text is refused before it is sent
- **WHEN** a statement binds a string containing NUL, at the root or inside a transaction
- **THEN** the call rejects with the invalid-text error, no statement is sent for it, and a transaction it was part of writes nothing
