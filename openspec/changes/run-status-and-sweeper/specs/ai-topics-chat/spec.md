## REMOVED Requirements

### Requirement: Spend and concurrency bounds

**Reason**: The process-wide ceiling it required is removed on `AI_PROVIDER=claude_cli` (run-status-and-sweeper D2), so its title and ceiling scenarios no longer describe the behaviour. Restated under "Spend bounds and per-session single-flight".

## MODIFIED Requirements

### Requirement: Egress and spend disclosure
The README SHALL document the AI chat feature: that enabling it sends session transcript
and topic content to Anthropic via the operator's `claude` CLI credentials, that turns
consume the operator's Anthropic quota/spend (with the per-session single-flight and per-turn
budget as the bounds, and no concurrency ceiling on `AI_PROVIDER=claude_cli` until the providers
change brings one back), the `CLAUDE_CLI_PATH` gate, the security
posture (no operator hooks/plugins/CLAUDE.md, MCP-only toolset, no host shell/filesystem
access), the requirement to run the server as the logged-in operator (and that
node-on-PATH / proxy vars may be needed), and the minimum tested CLI version.
`.env.example` SHALL carry the variables (`CLAUDE_CLI_PATH`, `AI_CHAT_TIMEOUT_SEC`,
`AI_PROVIDER`, and the per-turn budget var) with comments. `.env.example` SHALL NOT name
`AI_CHAT_MAX_CONCURRENT`. `docker/secrets-env.yaml` SHALL allow `AI_PROVIDER` and SHALL keep
`AI_CHAT_MAX_CONCURRENT`, marked as ignored, until every OpenBao secret has dropped it, because
the allowlist refuses a whole secret that holds an unlisted key (run-status-and-sweeper D1).

#### Scenario: Disclosure ships with the feature
- **WHEN** the change is archived
- **THEN** the README contains the AI chat section with egress, spend/bounds, gating,
  and lockdown documented, and `.env.example` lists the new
  variables

#### Scenario: The removed ceiling variable is gone
- **WHEN** `server/.env.example` and `docker/secrets-env.yaml` are read
- **THEN** `.env.example` does not name `AI_CHAT_MAX_CONCURRENT` and documents `AI_PROVIDER` with
  `claude_cli` as its default, and `docker/secrets-env.yaml` allows `AI_PROVIDER` and still allows
  the ignored `AI_CHAT_MAX_CONCURRENT`

### Requirement: Chat request contract
`POST /api/sessions/:sessionId/ai/chat` SHALL accept a JSON body
`{ message: string, claude_session_id?: string }` where `message` is 1–8000 characters
after trimming and `claude_session_id`, when present, is a non-empty string. The endpoint
SHALL evaluate checks in this order, matching the `transcript-words/generate` sibling:
authentication → session resolution/scoping (`404` for nonexistent, deleted, or
out-of-studio sessions, exactly as sibling session sub-routes such as
`POST /api/sessions/:sessionId/events`) → configuration gate (`503`) → approved user (`403`
with the detail `This feature is limited to approved users on this server.`, api-contract-freeze
"Run features are limited to approved users", run-status-and-sweeper D9) → body validation →
single-flight (`409`). Body validation SHALL use the repo's
existing semantics — `422 { detail: issues }` for schema violations (the global `ZodError`
mapping) and `400` for malformed JSON — and MUST NOT spawn a subprocess. All error bodies
SHALL be the repo's `{ detail }` shape.

#### Scenario: Invalid body rejected without side effects
- **WHEN** a client posts an empty/whitespace `message` or a body missing `message`
- **THEN** the response is `422 { detail }` and no `claude` subprocess is spawned

#### Scenario: Unauthorized session is masked as 404 before the config gate
- **WHEN** a caller without studio access to `:sessionId` posts a chat message, whether or
  not the feature is configured or a turn is in flight
- **THEN** the response is `404` (never `503`/`409`), leaking neither configuration nor
  in-flight state

#### Scenario: Unauthenticated request rejected like sibling routes
- **WHEN** a request lacks the credentials required by existing session sub-routes under
  the active auth configuration
- **THEN** the chat endpoint rejects it with the same status and shape those routes use

#### Scenario: A user who is not approved is refused before any spawn
- **WHEN** `CLAUDE_CLI_PATH` is set and a member of the session's show whose email is not an
  approved user posts a chat message
- **THEN** the response is `403 { detail }` with the fixed detail, no turn slot or run lease is
  taken, and no `claude` subprocess is spawned

## ADDED Requirements

### Requirement: The AI provider is chosen at boot
The server SHALL read `AI_PROVIDER` at boot (run-status-and-sweeper D1). Unset or blank SHALL mean
`claude_cli`, today the only accepted value. Any other value SHALL refuse to boot with an error that
names the accepted values and echoes the given value, and the refusal SHALL happen before the
`DATA_DIR` lock is taken, so a refused boot holds nothing. The provider SHALL decide whether run
ceilings apply: on `claude_cli` no ceiling applies to AI turns, YouTube imports or transcript
generation, in process or deployment-wide. The per-session single-flight of each run kind, with its
session-busy `409`, SHALL apply on every provider.

#### Scenario: An unset provider means claude_cli
- **WHEN** the server boots with `AI_PROVIDER` unset, or set to whitespace only
- **THEN** it boots with provider `claude_cli` and applies no run ceiling

#### Scenario: An unknown provider refuses to boot
- **WHEN** the server boots with `AI_PROVIDER=openai`
- **THEN** boot fails with an error naming `claude_cli` as the accepted value and echoing
  `openai`, and the `DATA_DIR` lock was never taken

### Requirement: Spend bounds and per-session single-flight
Chat spend SHALL be bounded per autologger session: at most one turn SHALL be in flight per
session; a second concurrent request for the same session SHALL respond `409` with an actionable
detail and MUST NOT spawn a subprocess. On `AI_PROVIDER=claude_cli`, the default and only
accepted value, there SHALL be no process-wide or deployment-wide ceiling on concurrent turns:
turns for different sessions SHALL all be admitted, and no at-capacity refusal exists
(run-status-and-sweeper D1, D2). `AI_CHAT_MAX_CONCURRENT` SHALL NOT be read; a value left in the
environment is ignored. A deployment-wide ceiling, a count of live run leases, is deferred to the
change that adds other providers. Each turn SHALL be spawned with a per-turn cost ceiling (the CLI
budget flag, e.g. `--max-budget-usd`, from a configured value).

#### Scenario: Concurrent turn on the same session is rejected
- **WHEN** a chat turn is streaming for session A and a second `POST …/ai/chat` arrives
  for session A
- **THEN** the second request receives `409` and no additional subprocess is spawned

#### Scenario: Turns on other sessions do not refuse a turn
- **WHEN** `AI_PROVIDER` is `claude_cli`, AI turns are in flight for three distinct sessions, and a
  chat turn is requested for a fourth session
- **THEN** the turn is admitted and its subprocess is spawned, and no at-capacity `409` is returned
