## MODIFIED Requirements

### Requirement: Topic generation is configuration-gated

Topic generation SHALL be gated on the same `claude` CLI configuration the AI chat uses
(`aiChatConfigured` / `CLAUDE_CLI_PATH`). When unconfigured, `POST
/api/sessions/:sessionId/topics/generate` SHALL behave identically to its pre-change
unavailable response (`503`). The endpoint SHALL NOT have any network-posture refusal: a
configured deployment proceeds to the remaining checks for a signed-in caller who can access the
session's show, whatever its bind address or `IP_ALLOWLIST`; a caller without that access gets the
masked `404` of every session route.

#### Scenario: Unconfigured deployment is unchanged

- **WHEN** a deployment with no `CLAUDE_CLI_PATH` receives `POST
  /api/sessions/:id/topics/generate`
- **THEN** the response is `503 {detail}`, matching the pre-change unavailable response
  exactly, and no `claude` subprocess is spawned

#### Scenario: Non-loopback bind without an allowlist is not refused

- **WHEN** a configured deployment bound to a non-loopback address with no `IP_ALLOWLIST`
  receives the request from a signed-in caller who can access the session's show
- **THEN** no network-posture `503` is returned, and the request proceeds to the remaining
  checks (concurrency, transcript precondition)
