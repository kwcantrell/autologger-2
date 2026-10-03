## ADDED Requirements

### Requirement: Anchored event insert is one serialized transaction

The `create_event` write path SHALL compute its anchor basis and perform its insert
inside a single `SessionHub` transaction (`createAnchoredEvent`): the live-event read,
the exclusion of regenerate snapshot ids, the timecode wall-anchor computation, and the
explicit-anchor insert SHALL be one transactional RPC (invoking the store-level insert,
not a nested self-transactional delegate) whose body awaits nothing but its own
transaction's statements, and which runs in the session's per-session order, so no other
operation on the session runs between the anchor-basis read and the insert. Observable
behavior SHALL be unchanged from the prior two-step form: identical anchor math and monotone clamping, identical regenerate
snapshot-id exclusion, and exactly one `event.changed` broadcast per successful insert.

#### Scenario: Anchor basis and insert cannot interleave
- **WHEN** `createAnchoredEvent` executes
- **THEN** the anchor-basis read and the insert run inside one transaction, so no concurrent hub mutation can be observed between them

#### Scenario: Behavior parity with the prior insert path
- **WHEN** the existing `create_event` tests (anchor ordering among generated events, regenerate snapshot-id exclusion, cap behavior, broadcast emission) run against the transactional RPC
- **THEN** all pass unchanged — persisted rows, wall times, and WS emissions are byte-identical to the prior read-then-insert form

#### Scenario: Anchor basis and insert stay in one serialized transaction
- **WHEN** the `createAnchoredEvent` RPC body is inspected, and it runs while other operations on the same session are called concurrently
- **THEN** it awaits only its own transaction's statements, and none of the concurrent operations runs between its anchor-basis read and its insert

### Requirement: The create_event cap is reserved before any await

The `create_event` MCP tool handler SHALL check the per-run cap and reserve one slot of it in a
single synchronous step before its first `await`: a call SHALL be refused with the existing cap
error when the run's successful inserts plus its reserved slots already reach the cap. A
successful insert SHALL count as one created event; a failed insert SHALL release its reserved
slot and count nothing. So concurrent `create_event` tool calls on one run can never exceed the
per-run cap, however their awaits interleave, and the reported created count includes only
successful inserts. The tool's error texts, the order of its validations, and the generate route's
`{created, cap_hit}` response are unchanged.

#### Scenario: The cap check and reservation precede the first await
- **WHEN** the `create_event` handler body is inspected
- **THEN** the cap check and the slot reservation run synchronously before its first `await` expression

#### Scenario: Cap holds under concurrent calls
- **WHEN** multiple `create_event` tool calls arrive concurrently on one generation run at `cap - 1` created events, and the session's storage yields between statements
- **THEN** at most one insert succeeds and the reported `{created, cap_hit}` never exceeds the configured cap

#### Scenario: A failed insert frees its slot
- **WHEN** a `create_event` call passes the cap check and its insert then fails
- **THEN** the call returns the existing internal-error tool result, nothing is counted, and a later call on the same run can use the slot

## REMOVED Requirements

### Requirement: Anchored event insert is transactional

**Reason**: The session hub becomes asynchronous (ADR 0021 slice 7a), so the `createAnchoredEvent`
body awaits its own transaction's statements and can no longer be "zero `await`, one synchronous
transaction".

**Migration**: Replaced by "Anchored event insert is one serialized transaction", which keeps the
single transaction, the anchor math, the regenerate exclusion, the one `event.changed` per insert
and behaviour parity, and states the no-interleave guarantee through the session's per-session
order instead of synchronous execution.

### Requirement: The create_event handler is await-free

**Reason**: The handler must now await the session hub. The requirement itself said that a change
introducing an `await` there must first move cap reservation into the synchronous prologue, which
this change does.

**Migration**: Replaced by "The create_event cap is reserved before any await": the cap check and a
slot reservation run synchronously before the first `await`, a failed insert frees its slot, and
"Cap holds under concurrent calls" is kept.
