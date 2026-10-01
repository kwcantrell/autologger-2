## ADDED Requirements

### Requirement: The catalog transaction contract

The asynchronous catalog port SHALL expose promise-returning `all()`, `first()` and `run()`, and
a `tx()` that passes its body a handle scoped to that transaction, with the same interface. A
`tx()` called on that handle SHALL join the enclosing transaction.

A transaction SHALL be all-or-nothing. Any error inside it SHALL fail the whole transaction, even
if the body catches it: a statement error, a joined body's error, or the body's own error. A
failed transaction SHALL roll back and reject with the first error, which no later error,
rollback error or misuse error replaces.

Misuse SHALL reject the caller's promise instead of deadlocking, escaping the transaction or
leaking writes:
- the root handle used while the caller's transaction is open;
- a handle used after its transaction ended;
- a body that returns while a joined body is still running.

#### Scenario: A failed transaction leaves no writes
- **WHEN** a transaction body writes and then throws
- **THEN** none of its writes persist and the caller receives the body's error

#### Scenario: A caught statement error still fails the transaction
- **WHEN** a transaction body catches a failed statement and goes on writing
- **THEN** the transaction rolls back, none of its writes persist, and the caller receives the statement's error

#### Scenario: A joined transaction shares the outcome
- **WHEN** a body calls `tx()` on its handle and the joined body throws
- **THEN** the whole transaction rolls back, including writes made before the joined call

#### Scenario: Using the root handle inside a transaction is refused
- **WHEN** a transaction body issues a statement or transaction on the root handle
- **THEN** that call rejects with an error naming the transaction handle, promptly and without a deadlock

#### Scenario: A domain error survives a still-running joined body
- **WHEN** one of two parallel joined bodies throws while the other is still running
- **THEN** the transaction rolls back and the caller receives the thrown error, not a misuse error

#### Scenario: A handle outlives its transaction
- **WHEN** a transaction handle is used after its transaction has ended
- **THEN** the call rejects, and nothing is written

#### Scenario: A body returns before its joined work
- **WHEN** a body returns while a `tx()` it started on its handle is still running
- **THEN** the transaction rolls back, the caller's promise rejects, and the unfinished body's later writes are refused

### Requirement: The SQLite catalog adapter serialises each connection

Until the catalog moves to Postgres (ADR 0021 slice 4), the SQLite adapter SHALL run at most one
transaction at a time on a connection. Every adapter instance on that connection SHALL share one
lock. Root-handle statements and transactions SHALL wait until any open transaction ends, and
SHALL be served in the order they were called.

The adapter SHALL also:
- roll back and release a transaction that runs past its deadline;
- refuse to work on a connection left inside a transaction it did not open;
- after a rollback fails, refuse every later call instead of serving a connection that is still
  inside a transaction.

`KvStore` SHALL use this adapter, so key/value writes wait for an open catalog transaction instead
of joining it.

#### Scenario: Outside statements wait for an open transaction
- **WHEN** a root statement is issued while another transaction is awaiting
- **THEN** it runs only after that transaction ends, and sees its committed writes, or none of them if it rolled back

#### Scenario: Callers are served in call order
- **WHEN** a transaction, a root write and a second transaction are called in that order
- **THEN** their effects apply in that order

#### Scenario: Two adapters on one connection share the lock
- **WHEN** two adapter instances wrap the same connection and one opens a transaction
- **THEN** the other instance's statements wait for it

#### Scenario: A stalled transaction is released
- **WHEN** a transaction body does not settle before the deadline
- **THEN** the transaction rolls back, the caller receives a timeout error, and the next caller proceeds

#### Scenario: A failed rollback stops the adapter
- **WHEN** a rollback fails and the connection is still inside the transaction
- **THEN** the failing call rejects with its own first error, every later or queued call rejects with a broken-adapter error, and none writes to the connection
