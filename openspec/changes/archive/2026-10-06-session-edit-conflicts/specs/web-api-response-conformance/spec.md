## MODIFIED Requirements

### Requirement: Every response-consuming site has a recorded conformance verdict

Every site in `web/src` where a JSON API response acquires a client type SHALL be enumerated and
SHALL carry a recorded verdict naming the endpoint, the client shape, the emitted shape, and
whether they conform.

The enumeration SHALL be **semantic, not textual**. It SHALL include assertions made through
local generic wrapper functions, calls that take no explicit type argument, and responses read
directly from `fetch` rather than through the shared client helper. A count of occurrences of
any particular call spelling SHALL NOT be treated as evidence that the enumeration is complete.

A client type applied to a **non-2xx error body** (for example the `current` row of a version
conflict) SHALL count as a response-consuming site too. Its conformance check SHALL use a fixture
captured from a real non-2xx response.

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

#### Scenario: A typed error body is enumerated

- **WHEN** the web gives a client type to the JSON body of a non-2xx response
- **THEN** that site appears in the enumeration, and its type is checked against a fixture
  captured from a real response with that status
