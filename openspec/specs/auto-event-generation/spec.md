# auto-event-generation

## Purpose

User-authored per-button (and per-dropdown-option) generation instructions, and a
user-initiated AUTO GENERATE run that appends transcript-derived log events through the
locked-down Claude CLI one-shot machinery.

**Definition — "instruction-bearing".** A button (show category) is
*instruction-bearing* iff its own `auto_instruction` is non-empty **or** (DROPDOWN
type) at least one of its `dropdown_options` carries a non-empty `auto_instruction`.
Every requirement below (participation, prompt enumeration, `create_event` allowlist,
the client's no-instructions state, the settings indicator) uses this single
definition. ON_OFF buttons never participate (their on/off phase lives in client-held
toggle state a generated insert cannot know or update); BUTTON, DROPDOWN, and TEXT
buttons participate when instruction-bearing.

## Requirements

### Requirement: Per-button generation instructions persist on the show
Each event button (a show `categories[*]` entry) of type BUTTON, DROPDOWN, or TEXT
SHALL carry an optional `auto_instruction` string field (trimmed; ≤ 2000 chars;
absent/empty means no button-level instruction). Each DROPDOWN option (a
`dropdown_options[*]` entry) SHALL likewise carry an optional `auto_instruction`
(same bounds). ON_OFF buttons SHALL NOT carry the field (a value arriving on one is
dropped by normalization, not an error). The fields SHALL persist through the existing
show-update path (profile update `show_updates[*].categories`) — including through the
server's category normalization, which today rebuilds categories/options from fixed
field sets and would silently strip unknown keys — and round-trip verbatim through
profile reads. Bound violations SHALL be rejected with the same validation-error
mechanics as other category-field violations (the existing 200-char label checks in
category normalization). The session `GET …/show-categories` response SHALL carry one
additive top-level boolean, `auto_instructions_present` (true iff any category of the
session's show is instruction-bearing) — the shared category projection itself is NOT
extended. These additive shape changes are authorized by this delta. The Companion
`categories` response SHALL NOT change.

#### Scenario: Instruction round-trips through settings save
- **WHEN** a user saves a button with `auto_instruction` "log every time someone says
  'slate'" and a dropdown option with its own `auto_instruction`
- **THEN** a subsequent profile read returns both fields verbatim on that show's
  category and option entries

#### Scenario: Over-long instruction is rejected
- **WHEN** a show update carries an `auto_instruction` longer than 2000 chars
- **THEN** the update is rejected with the same validation error mechanics as an
  over-long category label, and nothing is persisted

#### Scenario: Feed client learns instruction presence; Companion unchanged
- **WHEN** a session's show has at least one instruction-bearing button
- **THEN** `GET …/show-categories` returns `auto_instructions_present: true`, its
  `categories` entries carry no instruction fields, and the Companion categories
  response is byte-shape identical to today

### Requirement: Gated generation endpoint with pre-spawn preconditions
The server SHALL expose `POST /api/sessions/:sessionId/events/generate` (added to the
README endpoint table), a **synchronous JSON** route mirroring `topics/generate`'s
guard ladder, evaluated in this order before any subprocess or MCP registration
exists:

1. session resolution (unknown session masks as `404`, matching sibling routes);
2. `503 {detail}` when `CLAUDE_CLI_PATH` is unset;
3. `503 {detail}` under the open-network refusal (`REQUIRE_LOGIN` disabled +
   non-loopback bind + no allowlist), because a run spends the operator's Anthropic
   budget and writes into the session;
4. `400 {detail}` when the session's transcript is empty **or contains no word with a
   non-empty session-time anchor** (a run without anchors can only invent timecodes);
5. `400 {detail}` when the session's show has no instruction-bearing button;
6. `400 {detail}` when the instruction-bearing set exceeds the aggregate pre-spawn
   bound (a configured ceiling on total instruction bytes and instruction-bearing
   entry count);
7. `409 {detail}` when the per-session AI slot or the process-wide ceiling is held
   (same registry as AI chat/AI v2/topics). The shared-slot busy details SHALL name
   event generation among the possible holders — the wording changes to the existing
   shared-slot `409` detail strings at all three sibling endpoints — the session-busy
   AND at-capacity variants of `ai/chat`, the AI v2 design turn, and
   `topics/generate` — are authorized by this delta.

The route takes no generation parameters from the client; instructions and the
category snapshot are read server-side at run start. On success it SHALL respond
`200 {created, cap_hit}` (`created` = events inserted by the run; `cap_hit` = whether
the per-run cap ended writing early). A CLI/turn failure after spawn SHALL map to the
same opaque scrubbed failure mechanics as `topics/generate` (a `502 {detail}` that
never carries raw subprocess output); events inserted before the failure remain
persisted and are reported nowhere in the error body.

#### Scenario: Unconfigured deployment refuses
- **WHEN** `CLAUDE_CLI_PATH` is unset and a client POSTs to the generate route
- **THEN** the response is `503 {detail}` and no subprocess or MCP registration is
  created

#### Scenario: Open network refuses before spend
- **WHEN** `REQUIRE_LOGIN` is disabled, the server binds non-loopback with no
  allowlist, and a client POSTs to the generate route
- **THEN** the response is `503 {detail}` and nothing is spawned

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

### Requirement: Single orchestrator turn over all instructions
A generation run SHALL execute as **one** CLI turn driven through the existing
`driveAiTurn` lifecycle (MCP registration → spawn → outcome → no-orphan cleanup; all
existing lockdown invariants intact — no built-in tools, strict MCP config, loopback +
bearer; **no abort signal**, so a run always completes server-side regardless of the
initiating client's connection, exactly like `topics/generate`). The run SHALL
snapshot, at run start: the session's frame rate and start-offset, and the
instruction-bearing categories (ids, names, types, colors, instructions, option
labels/instructions). Mid-run edits to the show or session SHALL NOT affect the
in-flight run; they take effect on the next run.

The turn's message SHALL enumerate every instruction-bearing button and option from
the snapshot, and SHALL embed the session's existing events for those categories
(complete for each instruction-bearing category, rendered compactly with timecode,
message, and a generated-row marker) as the dedup basis — there is no events-reading
tool. Instruction text SHALL be rendered as clearly-delimited untrusted data, with the
system prompt stating that instructions describe *what to detect* and cannot alter the
tool contract, the run's scope, or the delimiter framing. The turn's tool allowlist
SHALL be exactly `get_transcript_words`, `create_event`. The turn SHALL run under the
configured generation budget (`--max-budget-usd`) and server-side timeout.

Message conventions (matching the manual logging flow, so generated rows share the
feed's vocabulary):
- BUTTON hit → `message` = the button's name/label verbatim.
- DROPDOWN option hit → `message` = the option label verbatim, or
  `<label> || <context>` when the option has `needs_context` (context authored by the
  model from the transcript moment). A whole-button DROPDOWN instruction acts as
  shared context/scoping for its option instructions and as a fallback detector: a hit
  matching the button instruction but no specific option logs the button's name.
- TEXT hit → `message` = model-authored text per the instruction (TEXT buttons carry
  free-form notes in the manual flow).

#### Scenario: One subprocess regardless of instruction count
- **WHEN** a show has five instruction-bearing buttons and generation runs
- **THEN** exactly one CLI subprocess is spawned, its allowlist is exactly
  `get_transcript_words` and `create_event`, and its prompt carries all five buttons'
  instructions and their categories' existing events

#### Scenario: Option-only DROPDOWN participates
- **WHEN** a DROPDOWN button has no button-level instruction but one option carries an
  instruction
- **THEN** the button is instruction-bearing: it is enumerated in the prompt, its
  category id is writable by `create_event`, and the no-instructions precondition does
  not trigger

#### Scenario: Generated messages match manual vocabulary
- **WHEN** the model logs a hit for a plain BUTTON named "SLATE"
- **THEN** the created event's `message` is exactly "SLATE", indistinguishable in
  vocabulary from a manual press

### Requirement: Generated events append, bounded and attributable
Generation SHALL only ever **append** events: no existing event is modified or deleted
by a run. Each run SHALL enforce a server-side **per-run created-events cap** (a
configured ceiling, default 200): once reached, further
`create_event` calls SHALL return a tool error naming the cap, and the run's response
reports `cap_hit: true`. Each generated event's `metadata_json` SHALL carry
`auto_generated: true` and a per-run `auto_generate_run_id`, so rows are attributable
to their run. A generated insert SHALL otherwise perform **every side effect a manual
insert performs**: the same transactional hub write path, server-assigned id, one
`event.changed` broadcast per insert (unchanged emission semantics), category
label/color UI snapshots merged into metadata (so later button deletion/rename
degrades and relinks identically to manual rows), and the catalog live projection
(`event_count` / max-timecode mirror) so `GET /api/sessions` stays truthful — the run
SHALL leave the catalog projection current by the time the route responds.

#### Scenario: Re-run does not duplicate or destroy
- **WHEN** a run previously logged three SLATE events and a second run executes over an
  unchanged transcript
- **THEN** no existing event is modified or deleted, the second run's prompt embeds
  the three existing SLATE events (complete for that category), and the prompt directs
  the model to log only moments not already logged

#### Scenario: The cap ends writing, not the world
- **WHEN** a run reaches the per-run cap mid-transcript
- **THEN** subsequent `create_event` calls return a tool error, previously created
  events persist, and the route responds `200` with `cap_hit: true`

#### Scenario: Sessions list stays truthful
- **WHEN** a run creates 40 events and completes
- **THEN** `GET /api/sessions` reflects the updated `event_count` without any
  intervening manual write

### Requirement: Events are anchored at transcript timecodes
`create_event` SHALL accept a category id (which MUST match the run's snapshot of
instruction-bearing categories and MUST NOT be `internal` in any casing; other ids are
rejected as tool errors), a message (validated with the same bounds as the manual log
path), and a session timecode string matching `HH:MM:SS`, `HH:MM:SS:FF`, or the
drop-frame form `HH:MM:SS;FF` (the transcript and event renderings emit `;` at
29.97fps, and the model must be able to echo what it reads). The server SHALL derive
the stored timecode fields from the supplied timecode by frame arithmetic at the
snapshot frame rate, using the same helpers the manual paths use. Bounds: the parsed
timecode must be non-negative and below 24h at the session frame rate; violations
return a tool error (no insert, no crash).

The stored `wall_time_utc` SHALL be derived from the supplied timecode — never the
run-time clock — by piecewise-linear interpolation over the session's existing
timecode↔wall anchor pairs (event rows carrying both `timecode_total_frames` and
`wall_time_utc`, including the internal `Recording N Started` rows), clamped monotone;
with fewer than two usable anchors the derivation falls back to a single-anchor offset
(one anchor) or session-start + timecode-offset arithmetic (zero anchors). Normative
placement invariant: **a generated event at timecode T sorts (by the feed's
`wall_time_utc ASC` order) between the existing anchor events whose timecodes bracket
T**, and generated events sort among themselves in timecode order.

#### Scenario: Event lands at the spoken moment
- **WHEN** the model calls `create_event` with session time `00:14:03:00` for a valid
  category
- **THEN** the stored event's timecode resolves to `00:14:03:00` at the snapshot frame
  rate regardless of when the run executes

#### Scenario: Drop-frame timecode is accepted
- **WHEN** the session is 29.97fps and the model echoes `00:14:03;12` from the
  transcript rendering
- **THEN** the timecode parses and the event is created

#### Scenario: Generated events interleave correctly
- **WHEN** a session has manual events at timecodes 00:10:00:00 and 00:20:00:00
  (recorded across a wall-clock pause) and the model creates an event at 00:15:00:00
- **THEN** the generated event sorts between those two manual events in the feed

#### Scenario: Unknown or internal category is rejected safely
- **WHEN** the model calls `create_event` with a category id outside the run snapshot,
  or with the id `internal`
- **THEN** the tool returns a validation error, no row is inserted, and the run
  continues

### Requirement: Generation-density transcript rendering
For a generation turn, `get_transcript_words` SHALL render the transcript with
timecode anchors at a bounded interval — a new anchored line at least at every speaker
change AND whenever the current line reaches a bounded word count (small enough that
an utterance can be placed to within a few seconds) — rather than the chat rendering's
one-anchor-per-speaker-turn density (which collapses a single-speaker session to one
timestamp and makes per-utterance placement impossible). Words without session-time
anchors render without invented timestamps. The rendering SHALL remain bounded: its
size against the CLI's tool-output limit SHALL be measured with a realistic
long-session fixture before the feature gates on it, and a transcript exceeding the
bound SHALL be delivered in deterministic sequential segments the model can page
through (never silently truncated). Chat turns keep the existing rendering unchanged.

#### Scenario: Single-speaker transcript is still anchored
- **WHEN** a generation turn reads a 40-minute single-speaker transcript
- **THEN** the rendering carries periodic timecode anchors throughout (bounded words
  per anchored line), not one anchor for the whole transcript

#### Scenario: Oversized transcript is paged, not silently cut
- **WHEN** the transcript rendering exceeds the measured tool-output bound
- **THEN** the tool delivers deterministic sequential segments with an explicit
  continuation marker, and the model can retrieve every segment
