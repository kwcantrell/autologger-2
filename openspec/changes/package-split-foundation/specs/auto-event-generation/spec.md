# auto-event-generation — Delta Spec

## ADDED Requirements

### Requirement: Anchored event insert is transactional

The `create_event` write path SHALL compute its anchor basis and perform its insert
inside a single `SessionHub` transaction (`createAnchoredEvent`): the live-event read,
the exclusion of regenerate snapshot ids, the timecode wall-anchor computation, and the
explicit-anchor insert SHALL be one synchronous transactional RPC (invoking the
store-level insert, not a nested self-transactional delegate), with zero `await`
expressions in the RPC body. Observable behavior SHALL be unchanged from the prior
two-step form: identical anchor math and monotone clamping, identical regenerate
snapshot-id exclusion, and exactly one `event.changed` broadcast per successful insert.

#### Scenario: Anchor basis and insert cannot interleave
- **WHEN** `createAnchoredEvent` executes
- **THEN** the anchor-basis read and the insert run inside one transaction, so no concurrent hub mutation can be observed between them

#### Scenario: Behavior parity with the prior insert path
- **WHEN** the existing `create_event` tests (anchor ordering among generated events, regenerate snapshot-id exclusion, cap behavior, broadcast emission) run against the transactional RPC
- **THEN** all pass unchanged — persisted rows, wall times, and WS emissions are byte-identical to the prior read-then-insert form

#### Scenario: Hub synchronous invariant holds
- **WHEN** the `createAnchoredEvent` RPC body is inspected
- **THEN** it contains zero `await` expressions and runs inside a single synchronous transaction

### Requirement: The create_event handler is await-free

The `create_event` MCP tool handler SHALL contain zero `await` expressions: the cap
check, the transactional RPC call, and the per-run counter increment SHALL execute as
one uninterruptible synchronous sequence, so concurrent `create_event` tool calls on one
run can never interleave between the cap check and the counter increment and the per-run
cap can never be exceeded. Any future change introducing an `await` into this handler
(e.g. an async session-access port) SHALL first move cap reservation into the
synchronous prologue or the transactional RPC, authorized by its own delta.

#### Scenario: Handler is uninterruptible
- **WHEN** the `create_event` handler body is inspected
- **THEN** it contains zero `await` expressions from cap check through counter increment

#### Scenario: Cap holds under concurrent calls
- **WHEN** multiple `create_event` tool calls arrive concurrently on one generation run at `cap - 1` created events
- **THEN** at most one insert succeeds and the reported `{created, cap_hit}` never exceeds the configured cap
