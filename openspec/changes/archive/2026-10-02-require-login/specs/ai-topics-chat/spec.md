## MODIFIED Requirements

### Requirement: Chat request contract
`POST /api/sessions/:sessionId/ai/chat` SHALL accept a JSON body
`{ message: string, claude_session_id?: string }` where `message` is 1–8000 characters
after trimming and `claude_session_id`, when present, is a non-empty string. The endpoint
SHALL evaluate checks in this order, matching the `transcript-words/generate` sibling:
authentication → session resolution/scoping (`404` for nonexistent, deleted, or
out-of-studio sessions, exactly as sibling session sub-routes such as
`POST /api/sessions/:sessionId/events`) → configuration gate (`503`) → body validation → single-flight (`409`). Body validation SHALL use the repo's
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

### Requirement: Egress and spend disclosure
The README SHALL document the AI chat feature: that enabling it sends session transcript
and topic content to Anthropic via the operator's `claude` CLI credentials, that turns
consume the operator's Anthropic quota/spend (with the concurrency ceiling and per-turn
budget as the bounds), the `CLAUDE_CLI_PATH` gate, the security
posture (no operator hooks/plugins/CLAUDE.md, MCP-only toolset, no host shell/filesystem
access), the requirement to run the server as the logged-in operator (and that
node-on-PATH / proxy vars may be needed), and the minimum tested CLI version.
`.env.example` SHALL carry the new variables (`CLAUDE_CLI_PATH`, `AI_CHAT_TIMEOUT_SEC`,
`AI_CHAT_MAX_CONCURRENT`, and the per-turn budget var) with comments.

#### Scenario: Disclosure ships with the feature
- **WHEN** the change is archived
- **THEN** the README contains the AI chat section with egress, spend/bounds, gating,
  and lockdown documented, and `.env.example` lists the new
  variables

## REMOVED Requirements

### Requirement: Open-network refusal
**Reason**: Login is always required (`require-login`), so a deployment with authentication
disabled on a reachable network can no longer exist and this `503` can never fire.
**Migration**: None. Every chat turn comes from a signed-in member; unauthenticated calls get
the general `401`.
