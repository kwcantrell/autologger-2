## MODIFIED Requirements

### Requirement: Multi-turn continuity bound to the autologger session
The server SHALL spawn the CLI in non-interactive print mode with machine-readable
streaming output (`claude -p --output-format stream-json`), delivering the user message
via **stdin** (never as an interpretable argv positional, so a message beginning with `-`
cannot become a CLI flag). The server SHALL record, for each `claude_session_id` it issues, the autologger `:sessionId`
and the signed-in user whose turn issued it, in the catalog's key-value store with a 7-day
expiry, so any server process sharing the database sees it (ADR 0021 slice 9b). When a request
carries a `claude_session_id` that was issued for the **same** `:sessionId` **and the same
user**, and the CLI's conversation file for it exists in this process's CLI store, the server
SHALL resume that CLI conversation (CLI resume flag, without `--fork-session` so the id is
stable). A `claude_session_id` not issued for this `:sessionId` and user (foreign, another
user's, expired, or forged), or whose conversation file this process cannot find, SHALL be
rejected with `422` before any subprocess is spawned. The binding holds identifiers only, never
conversation content. When absent, a fresh CLI session
starts. The server SHALL relay the resulting session id in the `done` event, and the
client SHALL echo the id from the most recent `done`.

#### Scenario: Second turn resumes the first turn's session
- **WHEN** a client sends turn two with the `claude_session_id` from turn one's `done`
  event on the same session
- **THEN** the spawned CLI resumes that session and the reply reflects turn one's context

#### Scenario: Foreign session id is rejected, not resumed
- **WHEN** a client posts to `…/sessions/B/ai/chat` a `claude_session_id` that was issued
  for session A
- **THEN** the response is `422`, no subprocess is spawned, and session A's conversation
  is never resumed under session B

#### Scenario: Message cannot smuggle a CLI flag
- **WHEN** a client sends a `message` of `--dangerously-skip-permissions`
- **THEN** it is delivered as prompt text via stdin and is never parsed as a CLI option

#### Scenario: A co-member cannot resume another user's conversation
- **WHEN** user U2, with access to session A, posts to `…/sessions/A/ai/chat` a
  `claude_session_id` issued to user U1's turn on session A
- **THEN** the response is `422` and no subprocess is spawned

#### Scenario: Another process resumes the conversation
- **WHEN** turn one runs through process A and turn two, from the same user and session with turn
  one's `claude_session_id`, is served by process B that can read the CLI's conversation file
- **THEN** process B resumes the conversation

#### Scenario: A missing conversation file is a 422, not a CLI error
- **WHEN** a correctly bound `claude_session_id` is sent to a process whose CLI store has no
  conversation file for it
- **THEN** the response is `422` and no subprocess is spawned
