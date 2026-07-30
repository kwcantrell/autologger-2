# ai-topics-chat — delta (topic-generate-paged-transcript)

## MODIFIED Requirements

### Requirement: Session-scoped MCP toolset
The spawned CLI SHALL be given a generated MCP configuration exposing session-scoped
tools, all hard-bound to the `:sessionId` of the originating request via the turn
registration (the model cannot address any other session — no tool parameter names a
session). The registry comprises four tools; **each turn registration SHALL carry the
turn's tool set, and the per-request MCP server SHALL register only that turn's tools
— a chat turn's set is exactly the three tools below** (the CLI `--allowedTools`
allowlist remains as belt-and-braces). `create_event` (defined by
`auto-event-generation`) is registered only for event-generation turns; a chat turn's
MCP server never exposes it:

- `get_transcript_words` — returns the session's transcript rendered as **compact,
  model-readable text**, not JSON rows: consecutive words are grouped into per-speaker
  segments, each line prefixed with the segment's session-time anchor and speaker when
  present (e.g. `[HH:MM:SS] speaker S1: …`); a session with no transcript renders as a
  short placeholder line. The rendering carries the word text, speaker, and session-time
  anchor and omits the other hub row fields (`start_sec`, `created_at_utc`, `ordinal`,
  `session_id`, …), which the model does not need and whose per-word repetition made the
  JSON form a single oversized payload that overflowed the CLI's tool-output limit and
  hid the transcript from the model. The output SHALL be a bounded, non-JSON rendering.
  On a generation-density turn (event generation and the topic-generation one-shot) the
  same tool renders at generation density with deterministic paging — defined solely by
  `auto-event-generation`'s "Generation-density transcript rendering". Chat turns keep
  the unpaged compact rendering unchanged, and a chat turn's registration SHALL NOT
  carry the paged-transcript word snapshot (the field that keys paged delivery).
- `list_topics` — returns the session's topics with the hub row fields.
- `create_topic` — creates one topic; input SHALL be validated with the same bounds as
  the existing `topicCreateSchema` (`session_time` ≤ 20 chars, `duration_sec` ≥ 0,
  `topic_level` 1–10 integer, `summary` ≤ 8000 chars); a violation SHALL return a tool
  error to the model (no insert, no crash).

`create_topic` SHALL write through the existing `SessionHub.insertTopic` path so the
insert is transactional and the ordinal is server-assigned — the identical code path a
manual insert takes; the hub SHALL be resolved at call time (never held across an
`await`). Topics have no WebSocket emission today (fact-check 2026-07-14) and the MCP
tools MUST NOT introduce one, alter any WS emission semantics, or add or alter any public
HTTP surface. (`create_event`'s writes produce the existing `event.changed` emission a
manual event insert already produces — governed by `auto-event-generation`; that is not
an alteration of emission semantics.)

#### Scenario: AI-created topic matches a manual insert
- **WHEN** the model calls `create_topic` with a valid payload during a chat turn
- **THEN** the topic row is inserted through `SessionHub.insertTopic` with a
  server-assigned ordinal, indistinguishable from a manually inserted row, and no WS
  message is emitted (matching manual-insert behavior)

#### Scenario: Out-of-bounds tool input is rejected safely
- **WHEN** the model calls `create_topic` with `topic_level` 99
- **THEN** the tool returns a validation error to the model, no row is inserted, and the
  chat turn continues

#### Scenario: Tools cannot reach another session
- **WHEN** a chat turn runs for session A
- **THEN** every MCP tool reads and writes session A only, with no tool parameter that
  can name a different session

#### Scenario: Transcript is delivered as bounded text, not JSON rows
- **WHEN** the model calls `get_transcript_words` for a session with a transcript
- **THEN** the tool returns a compact per-speaker, session-time-anchored text rendering
  (not a JSON array of hub rows), so a multi-thousand-word transcript stays within the
  CLI's tool-output limit and is visible to the model

#### Scenario: Chat turns keep the unpaged rendering
- **WHEN** a chat turn's model calls `get_transcript_words`
- **THEN** the tool has the zero-argument input shape and returns the whole compact
  rendering in one result — no `page` argument, no continuation marker — and the chat
  turn's registration carries no paged-transcript word snapshot

#### Scenario: Chat turns cannot write events
- **WHEN** a chat turn runs
- **THEN** the turn's MCP server does not register `create_event` (a call to it fails
  at the server, independent of CLI flags), and the spawned CLI's allowlist names
  exactly `get_transcript_words`, `list_topics`, `create_topic`
