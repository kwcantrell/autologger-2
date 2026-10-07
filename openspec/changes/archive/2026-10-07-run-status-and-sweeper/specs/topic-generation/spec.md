## MODIFIED Requirements

### Requirement: Single-flight and concurrency bounds

Topic generation SHALL acquire a turn slot from the shared AI-turn registry
(`aiChatTurns`) — per-session single-flight, with no process-wide or deployment-wide ceiling on
`AI_PROVIDER=claude_cli` (run-status-and-sweeper D2) — the same bound the AI chat uses, since a
generation run is a `claude` CLI turn that spends budget. A request that cannot acquire a slot
SHALL respond `409 {detail}` and spawn nothing.

#### Scenario: Concurrent generation is rejected

- **WHEN** a `topics/generate` request arrives while another AI turn (chat, AI v2 design, event
  generation or topic generation) holds the session's slot, in this or another process
- **THEN** the response is `409 {detail}` and no subprocess is spawned; AI turns running for other
  sessions never cause this refusal
