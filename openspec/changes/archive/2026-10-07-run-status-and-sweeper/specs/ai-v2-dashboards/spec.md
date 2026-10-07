## MODIFIED Requirements

### Requirement: Spend and concurrency bounds
A design turn SHALL acquire a slot from the same registry the AI chat uses, before any subprocess
is spawned, so per-session single-flight bounds both features together (one turn per session
across both) rather than doubling the operator's exposure. On `AI_PROVIDER=claude_cli` the
registry SHALL have no process-wide or deployment-wide ceiling, so design turns for different
sessions are never refused on account of each other (run-status-and-sweeper D2). When a slot cannot
be acquired the endpoint SHALL respond `409` with an actionable `{ detail }` naming which feature
holds the slot, and spawn nothing. The slot SHALL be released when the turn ends by any path,
including paths where the agent iterator never terminates. Each turn SHALL additionally carry a
per-turn spend ceiling.

#### Scenario: A second turn on a busy session is rejected
- **WHEN** a turn is already in flight for `:sessionId` — either feature — and a client posts a
  design turn for that session
- **THEN** the response is `409 { detail }` naming the holder, and no subprocess is spawned

#### Scenario: Turns on other sessions do not refuse a design turn
- **WHEN** `AI_PROVIDER` is `claude_cli`, AI turns are in flight for three other sessions, and a
  client posts a design turn for an idle session
- **THEN** the design turn is admitted, and no at-capacity `409` is returned

### Requirement: Design turn contract
`POST /api/sessions/:sessionId/ai/v2/design` SHALL accept a JSON body carrying the user's message
and, optionally, an identifier resuming a previous design conversation. Checks SHALL be evaluated
in this order, matching existing session sub-routes: authentication → session resolution/scoping
(`404` for nonexistent, deleted, or out-of-studio sessions) → configuration gate (`503`) →
approved user (`403` with the detail `This feature is limited to approved users on this server.`,
api-contract-freeze "Run features are limited to approved users", run-status-and-sweeper D9) →
body validation (`422` schema, `400` malformed JSON) → turn slot (`409`). The approved-user check
SHALL run after the whole shared AI v2 guard prologue (its principal `404`, the configuration `503`
and the agent-credentials `503` of "Agent credentials") and SHALL NOT be part of that prologue,
which the AI v2 answer route also runs and which stays ungated. No guard path SHALL spawn a
subprocess. All error bodies SHALL use the repo's `{ detail }` shape.

#### Scenario: Invalid body rejected without side effects
- **WHEN** a client posts an empty message or a body missing required fields
- **THEN** the response is `422 { detail }` and no subprocess is spawned

#### Scenario: Unauthorized session is masked as 404
- **WHEN** a caller without studio access to `:sessionId` posts a design turn, whether or not the
  feature is configured or a turn is in flight
- **THEN** the response is `404`, leaking neither configuration nor in-flight state

#### Scenario: A user who is not approved is refused before any spawn
- **WHEN** AI v2 is configured with usable agent credentials and a member of the session's show
  whose email is not an approved user posts a design turn
- **THEN** the response is `403 { detail }` with the fixed detail, no turn slot or run lease is
  taken, no subprocess is spawned, and the same user's request to the AI v2 answer route is not
  refused with `403`
