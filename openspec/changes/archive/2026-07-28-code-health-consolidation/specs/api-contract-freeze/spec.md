# Delta: api-contract-freeze — code-health-consolidation

Two authorized, failure-path-only contract deltas. Success-path behavior — JSON shapes,
status codes, WS message shapes, success-path emission semantics and ordering — is
explicitly unchanged by this change.

## ADDED Requirements

### Requirement: Broadcast atomicity with the owning transaction

WS `*.changed` broadcasts SHALL be emitted only for mutations whose owning transaction
has committed. The server SHALL NOT emit a broadcast for a write that is subsequently
rolled back (e.g. a commit-time `SQLITE_FULL` failure). On the success path, the set of
broadcasts emitted for a given mutation, their payloads, and their relative order SHALL
be identical to the current published behavior — this requirement authorizes suppressing
emission on failure, not any change to emission on success.

This requirement pins observables only — it does not mandate an implementation
mechanism. Mutations performed inside a transaction SHALL have their broadcasts held
until that transaction commits; broadcasts legitimately issued outside any transaction
(e.g. a composite RPC's deliberate post-commit emission) remain immediate sends and are
unaffected. The composite RPC's published frame set (its suppressed intermediate
store-level frames and its exact post-commit frames) is part of the frozen success-path
behavior and SHALL NOT change.

#### Scenario: Failed commit emits no broadcast

- **WHEN** a mutating hub RPC's transaction fails at or before commit
- **THEN** no `*.changed` broadcast of any kind is emitted for that mutation, and
  connected clients observe no notification for the rolled-back write

#### Scenario: Successful mutation broadcasts exactly as today

- **WHEN** a mutating hub RPC's transaction commits successfully
- **THEN** the broadcasts emitted (types, payloads, and relative order) match the
  published pre-change behavior exactly

#### Scenario: Composite mutation emits once, after commit

- **WHEN** a composite RPC performs multiple store mutations in one transaction
- **THEN** clients observe broadcasts only after the whole transaction commits, and the
  previously flag-suppressed intermediate broadcasts remain unobserved, matching the
  published pre-change success-path behavior

### Requirement: Suffix range against a zero-byte audio blob

On the audio download endpoint (`GET /api/sessions/:sessionId/audio/segments/:segmentId`,
the repo's only Range-consuming route), a syntactically valid suffix `Range` request
(`bytes=-N`, `N > 0`) against a zero-byte audio blob SHALL yield the same
unsatisfiable-range response the endpoint already produces for other unsatisfiable
ranges (`416`), rather than an internal error. (Implementation note for the auditor:
`InvalidRangeError → 416` is mapped at two sites — the router's local catch and the app
error handler — which must stay consistent.) This
authorizes converting the current crash-driven `500` on this path to `416`; all other
range-request behavior (including `Content-Range` semantics on satisfiable ranges) is
unchanged.

#### Scenario: Suffix range on empty blob returns 416

- **WHEN** a client requests `Range: bytes=-N` for an audio object whose stored blob is
  zero bytes long
- **THEN** the response is the endpoint's existing unsatisfiable-range response (`416`),
  not a `500`

#### Scenario: Satisfiable ranges are unchanged

- **WHEN** a client requests any range against a non-empty blob that the published
  contract satisfies today
- **THEN** the status, headers (`Content-Range`), and body bytes are unchanged
