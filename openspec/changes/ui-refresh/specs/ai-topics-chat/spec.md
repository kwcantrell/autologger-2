# ai-topics-chat (delta)

## MODIFIED Requirements

### Requirement: AI tab and subtab arrangement
The workspace tab inventory, order, and labels are governed by `web-session-console` (which
this change makes the single owner of tab IA: Transcript, Topics, and the chat surface render
as top-level sibling tabs; there is no nested subtab arrangement). Within that structure, this
capability owns the chat surface's and feeds' semantics: the Transcript and Topics tabs render
the existing `TranscribeFeed` and `TopicsFeed` components with their current behavior
(columns, sorting, inline editing, Auto Generate / Insert toolbar) unchanged. Chat message
state and any in-flight SSE turn SHALL survive switching among any of the workspace tabs —
switching MUST NOT unmount the chat stream, abort the turn, or clear the conversation. The
chat surface SHALL render the conversation as whitespace-preserved plain text (no markdown
rendering in v1), stream assistant replies as they arrive, surface `tool` events as activity
indicators, offer a Stop control that aborts the in-flight turn (client aborts the fetch;
server terminates per the lifecycle requirement), show a clear not-configured state when the
endpoint returns `503`, and render terminal `error` events. On receiving a `tool` event naming
`create_topic`, the chatting client SHALL invalidate its topics query so AI-created rows
appear in the Topics tab during the turn — this client-side refresh is the liveness mechanism
(there is no topics WS emission to rely on). The normative requirements are: deference of tab
structure/labels to `web-session-console`, the feeds' unchanged behavior, state survival
across tab switches, the liveness refresh, the Stop control, and the not-configured state.

#### Scenario: Feeds survive the move
- **WHEN** the user opens the Transcript or Topics tab
- **THEN** the feed renders with its established columns, sorting, inline editing, and
  Auto Generate / Insert toolbar, behaviorally unchanged from before the IA restructure

#### Scenario: Switching tabs mid-turn preserves the turn
- **WHEN** a chat turn is streaming and the user switches to any other workspace tab and back
- **THEN** the stream is not aborted, the conversation is not cleared, and subsequent deltas
  continue rendering into the same conversation

#### Scenario: AI-created topics appear during the turn
- **WHEN** the in-flight turn emits a `tool` event naming `create_topic`
- **THEN** the client invalidates its topics query and the new topic row is visible in the
  Topics tab while the turn is still streaming

#### Scenario: Stop aborts an in-flight turn
- **WHEN** the user activates Stop during a streaming turn
- **THEN** the client aborts the fetch, the turn ends in the UI, and the conversation up to
  that point remains

#### Scenario: Unconfigured chat is explained in place
- **WHEN** the chat endpoint returns `503`
- **THEN** the chat surface shows its not-configured state in place (no dead send affordance)
