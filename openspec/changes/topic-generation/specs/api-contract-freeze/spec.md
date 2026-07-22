# api-contract-freeze — delta

## ADDED Requirements

### Requirement: Topic generation endpoint behavior

`POST /api/sessions/:sessionId/topics/generate` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `CLAUDE_CLI_PATH` unset/blank | `503 {detail}` — identical to the current unavailable response |
| open-network config (`REQUIRE_LOGIN` off + non-loopback + no `IP_ALLOWLIST`) | `503 {detail}`; no subprocess — mirrors the AI chat refusal |
| configured, another AI turn (chat or generate) holds the session slot, or global ceiling reached | `409 {detail}`; no subprocess |
| configured, session has no transcript words | `400 {detail}`; no subprocess |
| configured, success | `200 {topics: [...]}` — the session's topics after a crash-safe replace-all generation (prior topics deleted only after the fresh set is created), in the same shape `GET …/topics` returns |
| configured, CLI turn failure (spawn/timeout/CLI error/zero topics created) | `502 {detail}`; the session's prior topics are **unchanged, byte-for-byte** (never modified — the fresh topics this run created are removed) |

Existing route semantics are otherwise unchanged: an unknown/inaccessible session → the
existing `requireSession` behavior. No other stubbed surface changes — `transcribe.csv` keeps
its frozen `503`. The topics CRUD routes (`GET/POST/PATCH/DELETE …/topics`) are unchanged.

#### Scenario: Unconfigured deployments are byte-for-byte unchanged

- **WHEN** a deployment with no `CLAUDE_CLI_PATH` receives `POST
  /api/sessions/:id/topics/generate`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly, and no
  subprocess is spawned

#### Scenario: Configured success returns the topics list shape

- **WHEN** a configured deployment successfully generates topics
- **THEN** the response is `200` with `{topics}` whose entries match
  `GET /api/sessions/:id/topics` entries

#### Scenario: No-transcript maps to 400, concurrency to 409, CLI failure to 502

- **WHEN** a configured request has no transcript / hits the turn bound / the CLI turn fails
- **THEN** the response is `400` / `409` / `502` respectively (each `{detail}`-shaped),
  distinct from the unconfigured/open-network `503`

#### Scenario: transcribe.csv stays frozen

- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`
