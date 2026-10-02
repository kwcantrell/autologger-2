## REMOVED Requirements

### Requirement: Configuration-gated generation

**Reason**: The open-network `503` it also required fired only with `REQUIRE_LOGIN` off, a
non-loopback bind and no `IP_ALLOWLIST`. `REQUIRE_LOGIN` is removed and login is always
required, so that refusal can no longer happen and is deleted. The configuration gate itself is
unchanged and is restated under "Topic generation is configuration-gated".

**Migration**: None for clients. A configured deployment never answers the open-network `503`
detail any more; a caller now needs a signed-in session (see `api-contract-freeze` "Login is
required on every API route").

## ADDED Requirements

### Requirement: Topic generation is configuration-gated

Topic generation SHALL be gated on the same `claude` CLI configuration the AI chat uses
(`aiChatConfigured` / `CLAUDE_CLI_PATH`). When unconfigured, `POST
/api/sessions/:sessionId/topics/generate` SHALL behave identically to its pre-change
unavailable response (`503`). The endpoint SHALL NOT have any network-posture refusal: a
configured deployment proceeds to the remaining checks for a signed-in caller whatever its bind
address or `IP_ALLOWLIST`.

#### Scenario: Unconfigured deployment is unchanged

- **WHEN** a deployment with no `CLAUDE_CLI_PATH` receives `POST
  /api/sessions/:id/topics/generate`
- **THEN** the response is `503 {detail}`, matching the pre-change unavailable response
  exactly, and no `claude` subprocess is spawned

#### Scenario: Non-loopback bind without an allowlist is not refused

- **WHEN** a configured deployment bound to a non-loopback address with no `IP_ALLOWLIST`
  receives the request from a signed-in member of the session's studio
- **THEN** no network-posture `503` is returned, and the request proceeds to the remaining
  checks (concurrency, transcript precondition)

## MODIFIED Requirements

### Requirement: Failure mapping

A failure after the gates pass — CLI spawn error, timeout, CLI-signaled error, or a run that
creates no topics — SHALL respond `502 {detail}` (distinct from the unconfigured
`503` and the concurrency `409`), with the pre-run topics left untouched (they were never
modified; the topics this run created are deleted). The detail is a **fixed, handler-owned**
message (never the raw CLI output or its internal outcome token).

#### Scenario: CLI turn failure maps to 502 with prior topics unchanged

- **WHEN** the `claude` CLI turn fails for a configured, in-bounds, has-transcript request
- **THEN** the response is `502 {detail}`, the session's prior topics are unchanged (left
  exactly as they were), and no raw CLI output is surfaced
