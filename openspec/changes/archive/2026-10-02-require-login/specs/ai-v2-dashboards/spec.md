## MODIFIED Requirements

### Requirement: Design turn contract
`POST /api/sessions/:sessionId/ai/v2/design` SHALL accept a JSON body carrying the user's message
and, optionally, an identifier resuming a previous design conversation. Checks SHALL be evaluated
in this order, matching existing session sub-routes: authentication → session resolution/scoping
(`404` for nonexistent, deleted, or out-of-studio sessions) → configuration gate (`503`) → body validation (`422` schema, `400` malformed JSON) → turn slot (`409`). No
guard path SHALL spawn a subprocess. All error bodies SHALL use the repo's `{ detail }` shape.

#### Scenario: Invalid body rejected without side effects
- **WHEN** a client posts an empty message or a body missing required fields
- **THEN** the response is `422 { detail }` and no subprocess is spawned

#### Scenario: Unauthorized session is masked as 404
- **WHEN** a caller without studio access to `:sessionId` posts a design turn, whether or not the
  feature is configured or a turn is in flight
- **THEN** the response is `404`, leaking neither configuration nor in-flight state


## REMOVED Requirements

### Requirement: Open-network refusal
**Reason**: Login is always required (`require-login`), so a deployment with authentication
disabled on a reachable network can no longer exist and this `503` can never fire.
**Migration**: None. Design turns come only from signed-in members. The separate "Agent
credentials" rule (no key on a non-loopback bind → refuse) is unchanged.
