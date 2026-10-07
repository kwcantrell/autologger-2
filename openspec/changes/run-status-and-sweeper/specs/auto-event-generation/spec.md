## MODIFIED Requirements

### Requirement: Generation endpoint guard ladder runs before any spawn
The server SHALL expose `POST /api/sessions/:sessionId/events/generate` (added to the
README endpoint table), a **synchronous JSON** route mirroring `topics/generate`'s
guard ladder, evaluated in this order before any subprocess or MCP registration
exists:

1. session resolution (unknown session masks as `404`, matching sibling routes);
2. `503 {detail}` when `CLAUDE_CLI_PATH` is unset;
3. `403 {"detail": "This feature is limited to approved users on this server."}` when the
   requester's verified login email is not an approved user (api-contract-freeze "Run features
   are limited to approved users", run-status-and-sweeper D9); a malformed optional body's `400`
   (see "Optional generate body for regenerate and selection") is answered before steps 2 and 3;
4. `400 {detail}` when the session's transcript is empty **or contains no word with a
   non-empty session-time anchor** (a run without anchors can only invent timecodes);
5. `400 {detail}` when the session's show has no instruction-bearing button;
6. `400 {detail}` when the instruction-bearing set exceeds the aggregate pre-spawn
   bound (a configured ceiling on total instruction bytes and instruction-bearing
   entry count);
7. `409 {detail}` when the per-session AI slot is held (same registry as AI chat/AI
   v2/topics). On `AI_PROVIDER=claude_cli` there is no process-wide or deployment-wide
   ceiling, so there is no at-capacity refusal, and AI turns for other sessions never
   cause this `409` (run-status-and-sweeper D2). The shared-slot busy details SHALL name
   event generation among the possible holders — the wording of the existing
   shared-slot session-busy `409` detail strings at all three sibling endpoints
   (`ai/chat`, the AI v2 design turn, and `topics/generate`) carries it; the at-capacity
   detail strings are removed.

The optional request body carries only run modifiers (`regenerate`, `selection` —
see "Optional generate body for regenerate and selection"); instructions and the
category snapshot are read server-side at run start, never from the client. On
success it SHALL respond `200 {created, cap_hit}` (`created` = events inserted by
the run; `cap_hit` = whether the per-run cap ended writing early), plus `deleted`
when `regenerate` was true. A CLI/turn failure after spawn SHALL map to the
same opaque scrubbed failure mechanics as `topics/generate` (a `502 {detail}` that
never carries raw subprocess output); events inserted before the failure remain
persisted and are reported nowhere in the error body.

#### Scenario: Unconfigured deployment refuses
- **WHEN** `CLAUDE_CLI_PATH` is unset and a client POSTs to the generate route
- **THEN** the response is `503 {detail}` and no subprocess or MCP registration is
  created

#### Scenario: A user who is not approved is refused before spend
- **WHEN** `CLAUDE_CLI_PATH` is set and a member of the session's show whose email is not an
  approved user POSTs to the generate route with a well-formed body
- **THEN** the response is `403` with the fixed detail, no AI slot or run lease is taken, and no
  subprocess or MCP registration is created

#### Scenario: Non-loopback bind without an allowlist is not refused
- **WHEN** the server binds non-loopback with no allowlist and a signed-in member of the
  session's studio POSTs to the generate route on a configured deployment
- **THEN** no network-posture `503` is returned, and the guard ladder above applies

#### Scenario: Anchorless transcript refuses before spend
- **WHEN** the session's transcript exists but no word carries a session-time anchor
- **THEN** the response is `400 {detail}` naming the missing anchors and nothing is
  spawned

#### Scenario: No instructions configured refuses before spend
- **WHEN** generation is requested for a session whose show has no instruction-bearing
  button
- **THEN** the response is `400 {detail}` stating that no instructions are configured
  and nothing is spawned

#### Scenario: Busy slot names the holder
- **WHEN** an AI chat turn is streaming for session A and a generate run is requested
  for session A
- **THEN** the request receives `409` with a detail naming the holding feature set,
  and no subprocess is spawned

#### Scenario: Turns on other sessions do not refuse a run
- **WHEN** `AI_PROVIDER` is `claude_cli`, AI turns are in flight for three other sessions, and a
  generate run is requested for an idle session that passes the earlier guards
- **THEN** no `409` is returned and the run is spawned

#### Scenario: Partial results survive a failed run
- **WHEN** the CLI exits nonzero after the run has inserted events
- **THEN** the route responds `502` with the scrubbed generate-failure detail, no raw
  subprocess output, and the already-inserted events remain persisted
