# api-contract-freeze

The server's externally observable HTTP/WS contract is frozen. This capability replaces
the retired "Python parity" anchor. The freeze exists because real consumers depend on the
surface — the in-repo `web/` frontend, the separately-deployed Bitfocus Companion module,
the `e2e/` Playwright suite, and external API clients (bearer-token scripts, stale
Companion installs) — but consumers are the *reason* for the freeze, not its measuring
stick. The frozen surface is the full published surface (the README endpoint table is the
normative route inventory), independent of what any consumer currently reads.

## ADDED Requirements

### Requirement: Frozen HTTP/WS contract
The server SHALL preserve its entire published externally observable contract, including
but not limited to: the endpoint inventory (routes and methods; the README endpoint table
is the normative list), JSON response shapes, status codes, non-JSON response bodies
(CSV/JSONL exports), header and range-request semantics (e.g. `Content-Range` on audio
download), and WebSocket message shapes *and emission semantics* (which events fire and
when, not only their payloads). New API surface MUST NOT be added, and existing observable
behavior MUST NOT change, without an OpenSpec change whose delta spec authorizes it.

Two explicit non-loopholes:

- Absence of a current in-repo caller does NOT unfreeze any endpoint or field — surface
  kept for stale or external clients (e.g. `/api/companion/commands/wait`) is as frozen
  as surface `web/` reads on every render.
- Updating in-repo consumers in the same change does NOT exempt the server delta —
  deployed Companion module versions lag the repo, so "both sides moved together" still
  breaks fielded installs.

#### Scenario: Change proposal states contract impact
- **WHEN** a change proposal is drafted for this repo
- **THEN** it explicitly states the observable HTTP/WS contract impact

#### Scenario: Contract-affecting diff carries an authorizing delta spec
- **WHEN** a diff alters any published observable behavior (route, method, status code,
  response body shape or format, header semantics, or WS message shape or emission)
- **THEN** a delta spec authorizing that exact change exists under
  `openspec/changes/<name>/specs/`; a diff without one is a contract violation

#### Scenario: Unconsumed surface stays frozen
- **WHEN** an endpoint or response field has no current caller in `web/`, `companion/`,
  or `e2e/`
- **THEN** it remains part of the frozen contract, and removing or altering it still
  requires an authorizing delta spec

#### Scenario: Consumer co-mutation is not an exemption
- **WHEN** a change edits an observable server behavior and updates the in-repo consumers
  to match within the same change
- **THEN** the server delta still requires an authorizing delta spec
