## REMOVED Requirements

### Requirement: Gated generation endpoint with pre-spawn preconditions

**Reason**: Its guard ladder included an open-network `503` (`REQUIRE_LOGIN` disabled +
non-loopback bind + no allowlist). `REQUIRE_LOGIN` is removed and login is always required, so
that step can no longer fire and is deleted; the later steps move up by one. Restated under
"Generation endpoint guard ladder runs before any spawn".

**Migration**: None for clients. The open-network `503` detail is never returned; a caller
needs a signed-in session (see `api-contract-freeze` "Login is required on every API route").

## ADDED Requirements

### Requirement: Generation endpoint guard ladder runs before any spawn
The server SHALL expose `POST /api/sessions/:sessionId/events/generate` (added to the
README endpoint table), a **synchronous JSON** route mirroring `topics/generate`'s
guard ladder, evaluated in this order before any subprocess or MCP registration
exists:

1. session resolution (unknown session masks as `404`, matching sibling routes);
2. `503 {detail}` when `CLAUDE_CLI_PATH` is unset;
3. `400 {detail}` when the session's transcript is empty **or contains no word with a
   non-empty session-time anchor** (a run without anchors can only invent timecodes);
4. `400 {detail}` when the session's show has no instruction-bearing button;
5. `400 {detail}` when the instruction-bearing set exceeds the aggregate pre-spawn
   bound (a configured ceiling on total instruction bytes and instruction-bearing
   entry count);
6. `409 {detail}` when the per-session AI slot or the process-wide ceiling is held
   (same registry as AI chat/AI v2/topics). The shared-slot busy details SHALL name
   event generation among the possible holders — the wording changes to the existing
   shared-slot `409` detail strings at all three sibling endpoints — the session-busy
   AND at-capacity variants of `ai/chat`, the AI v2 design turn, and
   `topics/generate` — are authorized by this delta.

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

#### Scenario: Partial results survive a failed run
- **WHEN** the CLI exits nonzero after the run has inserted events
- **THEN** the route responds `502` with the scrubbed generate-failure detail, no raw
  subprocess output, and the already-inserted events remain persisted
