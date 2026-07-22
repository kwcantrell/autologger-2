# ai-topics-chat — spec (delta)

This change adds `topics/generate`, which drives the **same** session-scoped MCP toolset the
AI chat uses. Wiring the real (large) transcript through the CLI exposed that
`get_transcript_words` returned the raw hub rows as a single JSON string — on a real
multi-thousand-word session that is a ~300 KB single line that overflows the spawned CLI's
tool-output token limit, so the model never sees the transcript. The tool now returns a
compact, model-readable text rendering instead. Because this tool is shared by `ai/chat` and
`topics/generate`, the change is folded back into the `ai-topics-chat` capability here.

## MODIFIED Requirements

### Requirement: Session-scoped MCP toolset
The spawned CLI SHALL be given a generated MCP configuration exposing exactly three
tools, all hard-bound to the `:sessionId` of the originating request via the turn
registration (the model cannot address any other session — no tool parameter names a
session):

- `get_transcript_words` — returns the session's transcript rendered as **compact,
  model-readable text**, not JSON rows: consecutive words are grouped into per-speaker
  segments, each line prefixed with the segment's session-time anchor and speaker when
  present (e.g. `[HH:MM:SS] speaker S1: …`); a session with no transcript renders as a
  short placeholder line. The rendering carries the word text, speaker, and session-time
  anchor and omits the other hub row fields (`start_sec`, `created_at_utc`, `ordinal`,
  `session_id`, …), which the model does not need and whose per-word repetition made the
  JSON form a single oversized payload that overflowed the CLI's tool-output limit and
  hid the transcript from the model. The output SHALL be a bounded, non-JSON rendering.
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
HTTP surface.

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
