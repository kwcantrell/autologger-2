# Proposal: auto-generate-event-logs

## Why

Loggers hand-log recurring, transcript-detectable moments (e.g. YMH's SLATE button — every
utterance of the word "slate") in real time, which is tedious and error-prone for anything
that can be heard in the recording. The session already has a machine-readable transcript
and a locked-down Claude CLI one-shot pipeline (`topics/generate`); pointing that machinery
at user-authored per-button instructions turns hours of scrub-and-log into one click.

## What Changes

- **Per-button generation instructions (settings)**: BUTTON, DROPDOWN, and TEXT event
  buttons gain an optional free-text `auto_instruction` field in the Settings → event
  buttons table; DROPDOWN options additionally gain their own optional instruction,
  alongside the whole-button instruction. ON_OFF buttons are excluded (gate decision
  2026-07-28: their on/off phase lives in client-held toggle state a generated insert
  would corrupt). Instructions persist on the show's `categories` (catalog DB), carried
  through the server's category normalization (which today strips unknown keys).
- **AUTO GENERATE run**: a new AUTO GENERATE button on the event feed tab starts one
  generation run — a **synchronous POST** mirroring `topics/generate`'s guard ladder
  (config-gated on `CLAUDE_CLI_PATH`, open-network refusal, pre-spawn preconditions for
  anchored transcript/instructions, shared AI slot). The server runs a **single
  orchestrator CLI turn** that receives every instruction-bearing button/option plus
  the embedded existing events of those categories, reads the transcript at
  generation density via MCP, and logs events through a new `create_event` MCP tool.
  The CLI's closed-world lockdown is unchanged. Live progress is feed-native (gate
  decision 2026-07-28): generated events appear in every client's feed as they insert
  via the existing `event.changed` broadcasts; the route returns `{created, cap_hit}`.
- **Append, bounded and attributable**: runs only append — no existing event is
  modified or deleted; the model is shown the relevant categories' existing events and
  instructed to log only unlogged moments. Each run enforces a server-side per-run
  created-events cap; generated rows carry `auto_generated: true` + a run id in
  metadata and render with a compact marker in the feed (gate decision 2026-07-28).
  Generated inserts perform every side effect a manual insert performs (UI snapshots,
  catalog live projection), and land at transcript-derived timecodes with wall times
  interpolated from the session's existing timecode↔wall anchors.
- **New MCP tool** `create_event`, registered **only for generation turns** (the turn
  registration carries the turn's tool set); AI chat's tool surface is explicitly
  pinned to its current three tools. `get_transcript_words` gains a generation-density
  rendering (paged, never silently truncated) for generation turns only.

## Capabilities

### New Capabilities

- `auto-event-generation`: per-button/per-option generation instructions
  (instruction-bearing definition, participation by button type, message conventions);
  the AUTO GENERATE endpoint (guard ladder, response shape, failure mapping); the
  orchestrator turn (snapshot semantics, embedded-events dedup, untrusted-instruction
  framing, budget/timeout); append+cap+attribution semantics; timecode anchoring and
  the feed-order placement invariant; generation-density transcript rendering.

### Modified Capabilities

- `ai-topics-chat`: the session-scoped MCP tool registry grows `create_event`,
  registered per turn type server-side; the chat turn's tool surface stays pinned to
  `get_transcript_words`, `list_topics`, `create_topic` (an explicit non-widening
  requirement); `get_transcript_words` gains the generation-density variant for
  generation turns only.
- `web-session-console`: the event feed tab gains the AUTO GENERATE affordance
  (running state, inline outcomes, 409 handling, session-scoped run state), a visible
  marker on generated rows, burst-coalesced event refetches, and the 503 latch
  extension to event generation.
- `web-ui-system`: the Settings event-buttons table gains the per-button instruction
  field (BUTTON/DROPDOWN/TEXT only), per-option instruction fields in the options
  modal, and the instruction-bearing indicator.

## Impact

- **Contract impact (frozen surface — this change is its authorizing delta):**
  - New endpoint: `POST /api/sessions/:sessionId/events/generate` (synchronous JSON),
    added to the README endpoint table.
  - `profile.shows[].categories[*]` objects and their `dropdown_options[*]` entries
    gain an optional `auto_instruction` field (additive; flows through profile
    GET/update; the show-update normalization is extended to carry it).
  - `GET …/show-categories` gains one additive top-level boolean
    `auto_instructions_present`; its `categories` projection is otherwise unchanged.
    Companion's `categories` response is untouched — its handler keeps the existing
    fixed projection (id/label/color/type/dropdown_options{label, needs_context}/
    on_label/off_label), so the new fields never pass through to Companion.
  - The shared AI-slot `409` busy detail strings are reworded to name event generation
    among the possible holders (authorized here; the ai-v2-dashboards baseline
    requires the detail to name the holder).
  - WS: no new message types; `event.changed` emission semantics unchanged (per-insert).
- **Server**: generate route in the events router reusing `driveAiTurn` (no abort
  signal — runs complete); `create_event` MCP tool + per-turn tool registration + run
  snapshot on the turn registration; generation-density paged transcript rendering;
  timecode→wall interpolation over existing event anchors; event insert path extended
  with an explicit-anchor parameter; category normalization carries instructions;
  per-run cap + aggregate instruction bound; dedicated budget/timeout config.
- **Web**: settings instruction fields + indicator (`EventButtonsTable`,
  `EventOptionsModal`, save mappings), feed AUTO GENERATE control (mutation +
  `useGatedGenerate`/`GenerateToolbar` reuse), generated-row marker, burst-coalesced
  refetch, `show-categories` boolean consumption; hand-written API types + captured
  response-conformance fixtures updated for the changed shapes.
- **Companion**: no changes.
- **Tests**: unit + integration on schema/normalization round-trip, MCP tool bounds and
  registration split, guard ladder, interpolation placement property (multi-take
  fixture), cap behavior, catalog projection freshness; web component tests (settings,
  latch, marker, coalescing); a gated real-CLI test for model behavior; conformance
  fixtures re-captured.

## Non-Goals / Out of Scope

- No audio-based detection: generation reads the **transcript** (words + timecodes)
  only. Sessions without an anchored transcript are refused pre-spawn, not analyzed.
- No background/scheduled or auto-triggered runs — generation is user-initiated per
  session, one run at a time.
- No replace/undo semantics: runs append; cleanup is ordinary event deletion, aided by
  the generated-row marker. No bulk "delete this run" affordance in this change (the
  stored run id deliberately leaves room for one later).
- No per-event progress stream: run progress is feed-native (gate decision 2026-07-28
  reversing the earlier SSE draft); the route is synchronous.
- No changes to `topics/generate`, AI chat, or AI v2 dashboards behavior.
- No widening of the CLI lockdown (no built-in tools, no host filesystem/shell, no
  network beyond the loopback MCP + Anthropic API).
- No per-instruction cost controls beyond the run-level budget/timeout/cap bounds.
