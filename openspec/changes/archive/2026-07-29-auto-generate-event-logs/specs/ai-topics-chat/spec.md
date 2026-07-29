# ai-topics-chat — delta spec (auto-generate-event-logs)

The session-scoped MCP toolset grows one event-writing tool for generation turns; the
chat turn's own tool surface is explicitly pinned to its current three tools so the
chat surface does not widen — enforced server-side per turn, not only by CLI argv.

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
  On an event-generation turn the same tool renders at generation density with
  deterministic paging (governed by `auto-event-generation`'s "Generation-density
  transcript rendering"); chat turns keep this rendering unchanged.
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

#### Scenario: Chat turns cannot write events
- **WHEN** a chat turn runs
- **THEN** the turn's MCP server does not register `create_event` (a call to it fails
  at the server, independent of CLI flags), and the spawned CLI's allowlist names
  exactly `get_transcript_words`, `list_topics`, `create_topic`

### Requirement: Subprocess security lockdown
The spawned CLI MUST be restricted to the autologger MCP tools and nothing else. The
spawn SHALL:

- load **no operator customizations** — hooks, plugins, and user/project/local
  `settings.json` and `CLAUDE.md` MUST NOT load or execute in the child (e.g.
  `--setting-sources ""` / equivalent), because lifecycle hooks run shell unconditionally
  and are not governed by tool allow/deny lists; the `claude login` credential path MUST
  still function under this setting;
- use strict MCP configuration so only the generated config loads
  (`--strict-mcp-config`), ignoring operator/project MCP servers;
- deny built-in tools and allow only the turn's explicit `mcp__autologger__*` allowlist
  (positive denial of the built-in set, plus an explicit per-turn allowlist — not a
  name-keyed denylist that drifts as the CLI's tool inventory grows); a chat turn's
  allowlist is the three chat tools;
- run with `shell: false` and an argument array; deliver the user message via stdin;
- use a working directory outside the repo and `DATA_DIR`; and
- inherit a minimal environment (at least `HOME` for credentials and `PATH`; proxy/TLS
  vars added where the deployment needs them).

The chat endpoint MUST NOT provide a path to arbitrary command execution or host
filesystem access for any authenticated user.

#### Scenario: Prompt-injected shell request cannot execute
- **WHEN** a chat message (or injected transcript content) asks the model to run a shell
  command or read a host file
- **THEN** the CLI has no permitted tool capable of doing so and no command executes

#### Scenario: Operator hooks and plugins do not fire in the child
- **WHEN** the operator's `~/.claude` configures lifecycle hooks, plugins, or a user-level
  `CLAUDE.md`
- **THEN** none of them load or execute in the spawned chat subprocess

#### Scenario: Operator MCP configs are not inherited
- **WHEN** the operator's `~/.claude` registers additional MCP servers
- **THEN** the spawned chat subprocess loads only the generated autologger MCP config
