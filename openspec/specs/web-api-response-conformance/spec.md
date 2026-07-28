# web-api-response-conformance

## Purpose

That the web client's response types match what the server actually emits — verified at build
and test time against fixtures **captured from real server responses**, rather than asserted by
an unchecked type parameter. Covers the captured-fixture discipline and its staleness guard,
tolerance of additive server changes, the zero-runtime-cost constraint, the semantic enumeration
of every site in `web/src` where a JSON response acquires a client type together with its
recorded verdict, the audit's shape authority and what a `CONFORMS` verdict means, and the
repo-level invariant that stops new response-consuming sites from silently skipping
verification.

## Requirements

### Requirement: Client response types are verified against captured real responses

For every endpoint whose JSON payload the web client consumes, the client's response type SHALL
be checked against a fixture **captured from a real server response**, and that check SHALL fail
the build or the test suite when the two diverge.

Fixtures SHALL be produced by executing the server's own route and recording what it emits.
Fixtures SHALL NOT be hand-authored from a reading of the client type or of the handler source,
because a hand-authored fixture can encode the same incorrect belief as the type it is meant to
check — which is how the defect this capability addresses survived.

#### Scenario: A client type that omits an emitted-and-consumed field fails the build

- **WHEN** a client response type is edited to require a field the captured response does not
  contain
- **THEN** the conformance check fails

#### Scenario: A client type that mistypes a field fails the build

- **WHEN** a client response type declares a field with a type the captured response
  contradicts
- **THEN** the conformance check fails

#### Scenario: Fixtures cannot silently go stale

- **WHEN** the server changes an endpoint's emitted shape without the fixture being re-captured
- **THEN** the test that captures that endpoint's response fails

### Requirement: Verification tolerates additive server changes

A response carrying fields the client does not declare SHALL NOT fail verification. The
conformance check SHALL constrain only that the client's declared fields are present and
correctly typed in the captured response — never that the client declares everything the server
sends.

#### Scenario: An undeclared field in the captured response is tolerated

- **WHEN** a captured response contains fields absent from the client's response type
- **THEN** the conformance check passes

### Requirement: Verification is build-time, with no runtime cost

Conformance SHALL be established at build or test time. The shipped browser bundle SHALL NOT
gain a response-validation dependency, per-response parsing work, or any new runtime failure
mode as a result of this capability.

#### Scenario: No validation dependency reaches the bundle

- **WHEN** the web application is built
- **THEN** no schema-validation library is present in the output
- **AND** response handling performs no per-response shape checking at runtime

### Requirement: Every response-consuming site has a recorded conformance verdict

Every site in `web/src` where a JSON API response acquires a client type SHALL be enumerated and
SHALL carry a recorded verdict naming the endpoint, the client shape, the emitted shape, and
whether they conform.

The enumeration SHALL be **semantic, not textual**. It SHALL include assertions made through
local generic wrapper functions, calls that take no explicit type argument, and responses read
directly from `fetch` rather than through the shared client helper. A count of occurrences of
any particular call spelling SHALL NOT be treated as evidence that the enumeration is complete.

The verdict record SHALL be a version-controlled artifact that survives the change's archival.

#### Scenario: A wrapper-laundered assertion is enumerated

- **WHEN** a response type is applied through a local generic wrapper rather than at the shared
  fetch helper
- **THEN** that site appears in the enumeration with its endpoint and concrete response type

#### Scenario: A client-side mismatch is fixed

- **WHEN** the audit finds a client shape that does not match the emitted response
- **THEN** the client shape is corrected to match the server
- **AND** a test covers the corrected shape

#### Scenario: A server-side divergence is escalated, not fixed

- **WHEN** the audit finds the server emitting a shape that contradicts a documented statement
  about that shape
- **THEN** the finding is recorded and escalated
- **AND** no server response shape is modified by this change

### Requirement: The audit's shape authority and the meaning of a verdict are stated

The audit SHALL treat the server's emitted response as the authority on shape. Where an
emitted shape depends on the caller, on stored data, or on a code branch, the verdict SHALL
state that dependency rather than recording a single shape as if it were invariant.

A `CONFORMS` verdict SHALL be understood to mean "the client matches what the server emits" —
not "what the server emits is intended". The record SHALL say so, so that a future reader does
not mistake the audit for a ratification of every current emission.

#### Scenario: A caller-dependent shape is recorded as such

- **WHEN** an endpoint emits a field only for some callers or some stored states
- **THEN** the verdict records the branch condition rather than a single unconditional shape

### Requirement: New response-consuming sites cannot silently skip verification

A repo-level invariant test SHALL fail when a site in `web/src` gives a client type to a JSON
API response without a corresponding conformance check or a recorded, deliberate exemption.

#### Scenario: An unverified new site fails the suite

- **WHEN** a new response-consuming site is added with a client type and no conformance check
  and no recorded exemption
- **THEN** the repo-invariant test fails and names the offending site
