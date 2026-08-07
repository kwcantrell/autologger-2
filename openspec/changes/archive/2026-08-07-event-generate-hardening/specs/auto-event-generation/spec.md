# auto-event-generation — delta (event-generate-hardening)

## MODIFIED Requirements

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
(complete for each instruction-bearing category — **except, on regenerate, the rows
in the pre-spawn auto-row snapshot, which SHALL be excluded** — rendered compactly
with timecode, message, and a generated-row marker) as the dedup basis — there is no
events-reading tool. Instruction text SHALL be rendered as clearly-delimited
untrusted data, with the
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

Generation SHALL **append** events by default: when `regenerate` is absent or
false, no existing event is modified or deleted by the run. When
`regenerate` is true and no `selection` is supplied, the server SHALL
snapshot the ids of every session event whose metadata has
`auto_generated === true`, append newly generated events under the same
per-run created-events cap and attribution rules (`auto_generated: true` +
`auto_generate_run_id`) as today, and delete the snapshotted rows only after
the CLI turn succeeds with at least one created event (**delete-after-success**
— see "Optional generate body
for regenerate and selection" for the full ordering, exclusion,
zero-created, and failure semantics). Manual (non-auto) events SHALL NOT be deleted. `regenerate: true`
combined with
a non-empty `selection` SHALL be rejected with `400`. Each run SHALL still
enforce the per-run created-events cap; further `create_event` calls SHALL
return a tool error naming the cap, and the run's response reports
`cap_hit: true`. Each generated event's `metadata_json` SHALL carry
`auto_generated: true` and a per-run `auto_generate_run_id`, so rows are
attributable to their run. A generated insert SHALL otherwise perform **every
side effect a manual insert performs**: the same transactional hub write path,
server-assigned id, one `event.changed` broadcast per insert (unchanged
emission semantics), category label/color UI snapshots merged into metadata
(so later button deletion/rename degrades and relinks identically to manual
rows), and the catalog live projection (`event_count` / max-timecode mirror)
so `GET /api/sessions` stays truthful — the run SHALL leave the catalog
projection current by the time the route responds (on regenerate, current
**including** the post-success delete's decrement).

#### Scenario: Generate All appends without deleting

- **WHEN** generate runs with no body or `{ regenerate: false }`
- **THEN** no existing events are deleted and new auto rows may be appended

#### Scenario: Regenerate All replaces auto rows after success

- **WHEN** generate runs with `{ regenerate: true }` and no `selection` and the
  CLI turn succeeds
- **THEN** the pre-run `auto_generated` events are deleted only after the CLI
  turn succeeds, manual events remain, and the run's new auto rows persist

#### Scenario: Regenerate with selection is rejected

- **WHEN** generate runs with `{ regenerate: true, selection: [...] }` where
  `selection` is non-empty
- **THEN** the response is `400 { detail }` and no events are deleted

#### Scenario: Re-run does not duplicate or destroy
- **WHEN** a run previously logged three SLATE events and a second run executes over an
  unchanged transcript without `regenerate`
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

### Requirement: Optional generate body for regenerate and selection

`POST /api/sessions/:sessionId/events/generate` SHALL accept an optional JSON
body. Absent or empty body SHALL mean Generate All (full instruction-bearing
set, no delete). Fields:

- `regenerate` (boolean, default false)
- `selection` (optional array of `{ category_id, option_label? }`, at most
  **500 entries**; `category_id` at most **200 characters**; `option_label`
  at most **200 characters** — violating any bound SHALL yield the same
  malformed-body `400 {detail}` as other schema violations):
  - omitted or empty → full instruction-bearing set
  - non-empty → only matching instruction-bearing **entries** participate
    (button-level when `option_label` is null/omitted; a dropdown option when
    `option_label` equals that option’s stored label and that option has a
    non-empty `auto_instruction`)
  - unknown ids/labels that match nothing SHALL be ignored for membership;
    if after filtering zero instruction entries remain, SHALL `400` (same
    class as no-instructions)

Regenerate SHALL be **delete-after-success** (the `topics/generate`
crash-safe-swap precedent): after the guard ladder and successful AI-slot
acquire and before CLI spawn, the run SHALL snapshot the **ids** of the
session's current `auto_generated` rows; those rows SHALL be **excluded from
the run's existing-events enumeration** (the prompt's per-category existing
list) **and from the run's anchor-interpolation basis** (the existing-event
anchors that place new rows' wall times), so the replacement rows are neither
deduplicated against nor positioned by rows that are about to be replaced;
the snapshot SHALL NOT be deleted until the CLI turn succeeds **and created
at least one event**. On such a success,
the snapshotted rows still present SHALL be deleted inside the session hub in
**one transaction** (the deletion MAY be issued in id-chunks within that
transaction) emitting **one `event.changed` broadcast when at least one row
was removed, and none otherwise**, before the `200` response is built. A CLI
turn that succeeds with **zero created events** SHALL NOT delete the snapshot
— destruction requires a replacement (gate ruling E1; the topics precedent's
spirit) — and SHALL respond `200 { created: 0, cap_hit: false, deleted: 0 }`.
A failed pre-guard SHALL NOT
delete events, and a failed CLI turn (502) SHALL NOT delete events — the
prior auto rows persist alongside any partial new rows (which persist per the
existing append-failure semantics); a subsequent regenerate snapshots and
replaces both.

On success the response SHALL be `{ created, cap_hit }` and, when
`regenerate` was true, SHALL also include `deleted` (the number of
snapshotted prior auto rows actually removed after success; `0` on a
zero-created success).

#### Scenario: Custom selection filters the run

- **WHEN** generate runs with a `selection` naming one button-level entry and
  one dropdown option entry, and `regenerate` is false
- **THEN** no events are deleted and the run snapshot/prompt/allowlist include
  only those instruction entries

#### Scenario: Empty selection after filter fails

- **WHEN** generate runs with a `selection` that matches no instruction-bearing
  entry
- **THEN** the response is `400 { detail }` and no CLI turn runs

#### Scenario: Over-bound selection is malformed

- **WHEN** generate runs with a `selection` of more than 500 entries, or any
  entry whose `category_id` exceeds 200 characters or `option_label` exceeds
  200 characters
- **THEN** the response is `400 {detail}` — after session resolution (the 404
  mask stays first) and before any configuration/spend guard, snapshot,
  delete, or spawn — no events are deleted, and no CLI turn runs

#### Scenario: Zero-created success keeps the prior set

- **WHEN** a `{ "regenerate": true }` run's CLI turn completes cleanly but
  `create_event` was never successfully called
- **THEN** no events are deleted, every prior auto row is still present, and
  the response is `200 { created: 0, cap_hit: false, deleted: 0 }`

#### Scenario: Failed regenerate run preserves the prior set

- **WHEN** a `{ "regenerate": true }` run passes every pre-guard and the CLI
  turn then fails
- **THEN** the response is `502 {detail}`, every prior auto-generated row is
  still present, and any events the failed run inserted before failing also
  persist

#### Scenario: Successful regenerate replaces the prior set after the run

- **WHEN** a `{ "regenerate": true }` run succeeds
- **THEN** the prior auto rows remained readable for the whole run (a mid-run
  `GET …/events` includes them), the prompt's existing-events enumeration and
  the anchor-interpolation basis excluded them, and after success the pre-run
  snapshot's still-present rows are deleted in one transaction with one
  `event.changed` broadcast, with `deleted` reporting that count
