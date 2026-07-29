# Design: auto-generate-event-logs

## Context

Users hand-log transcript-detectable moments via show-level event buttons. The repo
already has: (a) a locked-down Claude CLI one-shot pipeline (`driveAiTurn` in
`server/src/routers/aiTurn.ts`) used by `ai/chat` and `POST
/api/sessions/:sessionId/topics/generate`; (b) a session-scoped loopback MCP listener
(`aiMcpServer.ts`) exposing `get_transcript_words`/`list_topics`/`create_topic` with
per-turn bearer registration; (c) a transactional event store
(`EventStore.addEvent`) whose inserts broadcast `event.changed`; (d) show `categories`
stored as JSON on the show row (`z.array(z.record(z.unknown()))` on the wire, read back
verbatim — but the show-update path persists
`JSON.stringify(validateCategoriesList(...))`, which **rebuilds each category/option
from a fixed field set** (`studio.ts` `validateCategoriesList` /
`normalizeDropdownOptionEntry`), silently stripping unknown keys), edited in
`web/.../EventButtonsTable.tsx`; (e) a 503 capability-gating latch pattern on the
Transcript/Topics feed toolbars (`useGatedGenerate` + `GenerateToolbar`). Constraints:
frozen HTTP/WS contract (this change's delta specs are the authorization), single Node
process, hub RPCs synchronous + transactional, CLI closed-world lockdown
(`--tools ''`, `--strict-mcp-config`, loopback MCP + bearer, minimal env).

User decisions (2026-07-28, pre-panel): append with model-side dedup; a single
orchestrator agent fed all instructions decides its own fan-out; live progress;
instructions live per-button, with per-option + whole-button instructions for
DROPDOWN. Gate rulings (2026-07-28, post-panel — see Panel & review log): progress is
feed-native over a synchronous POST; per-run cap + visible generated-row marker;
BUTTON/DROPDOWN/TEXT participate with pinned message conventions, ON_OFF excluded;
client-side refetch coalescing.

## Goals / Non-Goals

**Goals**: per-button/per-option `auto_instruction` fields end-to-end
(settings UI → profile update → normalization → catalog → generate run); one-click
AUTO GENERATE on the event feed with feed-native live rows and a terminal count;
generated events transactional, transcript-anchored, correctly interleaved,
append-only, capped, attributable, and side-effect-identical to manual inserts; no
widening of chat's tool surface or the CLI lockdown.

**Non-Goals**: audio analysis; scheduled/auto-triggered runs; replace/undo or bulk
run-cleanup (run ids leave room for it later); per-event progress streaming; changes
to topics/chat/AI-v2 behavior; per-instruction budget knobs.

## Decisions

### D1 — Instructions are additive JSON fields carried through the normalization path
`categories[*].auto_instruction` and `categories[*].dropdown_options[*].auto_instruction`
(both optional strings, trimmed, ≤ 2000 chars; ON_OFF categories never carry one).
Storage is the existing categories JSON on the show row — **no catalog migration**.
Change sites (fact-check 2026-07-28 — the write path is NOT loose passthrough):
- **Server normalization is the single validation point**: `validateCategoriesList`
  and `normalizeDropdownOptionEntry` (`server/src/studio.ts`) gain `auto_instruction`
  carry-through (trimmed; empty ⇒ omitted; dropped on ON_OFF) with the ≤ 2000 bound
  enforced beside the existing 200-char label checks, throwing the same
  `ValidationError` → 400. (Panel: an added Zod superRefine was dropped — it would
  route through `ZodError` → **422**, diverging from every other category-field
  violation; `showUpdateEntrySchema.categories` stays `z.array(z.record(z.unknown()))`
  untouched.)
- **Web save mappings**: the settings save path rebuilds categories from drafts
  (`HomeSettingsModal` save mapping, `EventOptionsModal` option mapping) — both carry
  the new fields alongside the drafts (D9).
*Alternatives*: a full strict category schema (rejected: would newly reject legacy
loose shapes); a separate instructions table (rejected: second source of truth vs. the
copy-buttons flow and show round-trip).
*Residual*: dropdown options have no stable id — per-option instructions key by
label/position, so renaming an option orphans its instruction (accepted; recorded in
Risks).

### D2 — Route: `POST /api/sessions/:sessionId/events/generate`, synchronous JSON
Lives in the events router beside the manual log route; added to the README endpoint
table. Guard ladder mirrors `topics/generate`, in order: session 404-masking →
`CLAUDE_CLI_PATH` 503 → open-network-refusal 503 → anchored-transcript 400 →
no-instructions 400 → aggregate-instruction-bound 400 → `aiChatTurns.tryAcquire` 409
(slot stays router-owned per the existing seam; the shared busy details are reworded
to name event generation — authorized in the delta). Success: `200 {created,
cap_hit}`; post-spawn failure: the `topics/generate` opaque-502 mapping. **No
`abortSignal`** — a run always completes server-side (the `topics/generate` D2
precedent), so client disconnects/proxy idle timeouts cannot kill a run half-way.
*Alternative — SSE progress stream (the original draft)*: rejected at the gate
(2026-07-28). The feed already renders generated rows live via `event.changed`; the
stream added a frame vocabulary, per-turn callback plumbing, a scrub surface, and a
third copy of the 503-latch logic, and a silent stream dies to ordinary proxy idle
timeouts taking the run with it.

### D3 — One orchestrator CLI turn; "fan-out" is the model's own work plan
A single `driveAiTurn` invocation per run. The built-in tool set stays stripped
(`--tools ''`), so the CLI cannot spawn literal subagents; the orchestrator's mandated
behavior (dedicated system prompt) is to work through the instructions it was given
against the transcript, using `create_event` per hit. Tool allowlist:
`get_transcript_words`, `create_event`.

The run **snapshots at start** (carried on the turn registration, D6): frame rate,
start-offset, and the instruction-bearing categories (ids, names, types, colors,
instructions, option labels/instructions). Mid-run show/session edits do not affect
the in-flight run.

The message builder serializes, per instruction-bearing button: id, name, type,
button-level instruction, per-option instructions — plus that category's **complete
existing events** (compact one-line rendering with timecode, message, and a
generated-row marker) as the dedup basis. Instruction text is rendered inside
explicit untrusted-data delimiters; the system prompt states instructions describe
what to detect and cannot alter the tool contract, scope, or framing. Message
conventions (gate 2026-07-28, matching the manual flow): BUTTON → button label;
DROPDOWN option → option label (+ `" || context"` when `needs_context`, model-authored
context); whole-button DROPDOWN instruction = shared context + fallback detector
logging the button label; TEXT → model-authored message; ON_OFF excluded.
*Alternatives*: one CLI turn per instruction (rejected by user); widening the lockdown
for real subagents (rejected: breaks the closed-world invariant); a `list_events` MCP
tool for dedup (rejected by panel: a tool the model may not call makes dedup
best-effort-squared, and a recency-capped window is blind to exactly the back-dated
rows dedup needs — embedding the per-category events in the prompt guarantees they
are in context and needs no cap semantics).

### D4 — `create_event` anchors at the supplied timecode; wall time by anchor interpolation
The MCP tool accepts `{category, message, session_time}` with the grammar
`HH:MM:SS`, `HH:MM:SS:FF`, or drop-frame `HH:MM:SS;FF` (the renderings emit `;` at
29.97 — the model must be able to echo what it reads), parsed with the existing
timecode helpers at the snapshot frame rate; bounds: non-negative, < 24h. Category
must be in the run snapshot and never `internal` (any casing — internal events are
transport anchors; a model-authored `Recording N Started` would corrupt transcript
remapping). Message bounds mirror `logBodySchema`. Violations → tool error, no
insert, no crash.

`wall_time_utc` derives from the timecode — never the run-time clock — by
**piecewise-linear interpolation over the session's existing timecode↔wall anchor
pairs**: event rows carrying both `timecode_total_frames` and `wall_time_utc`
(including the internal `Recording N Started` rows `transcriptRemap` already parses),
sorted and clamped monotone. One usable anchor ⇒ constant offset from it; zero ⇒
`sessions.started_at_utc` + timecode-minus-start-offset arithmetic. Normative
invariant (spec): a generated event at timecode T sorts between the anchor events
bracketing T; generated events sort among themselves in timecode order.
*Alternative — inverting `timecodeForMark` against transport state (the original
draft)*: refuted by all four panel reviewers — `session_transport` is a single
current-state row (no history), and the mapping is a constant function while stopped
(the normal run condition), so it has no inverse; the naive session-start fallback
provably mis-interleaves multi-take sessions.
*Alternative — back-dated `markedAtUtc` through `addEvent`*: still rejected
(`timecodeForMark` reads current transport state).

Insert mechanics: `EventStore.addEvent` gains an **optional explicit-anchor
parameter** (`{timecodeTotalFrames, wallTimeUtc}`) that bypasses the
`timecodeForMark` computation — one insert path, one broadcast contract, no parallel
method (panel simplification). The tool composes metadata before insert:
`auto_generated: true`, `auto_generate_run_id`, plus the category label/color UI
snapshots (`mergeCategoryUiSnapshotsIntoMetadata` inputs come from the run snapshot),
so generated rows relink/degrade identically to manual rows. After the run, the
**router** performs the catalog `projectSessionLive` mirror (it has the catalog
handle; the MCP layer does not), so `GET /api/sessions` is current by the time the
route responds.

### D5 — Generation-density transcript rendering, paged
For generation turns, `get_transcript_words` renders with timecode anchors at bounded
intervals: new anchored line on speaker change AND every ≤ N words (N chosen so
placement lands within a few seconds; pinned at apply from fixture measurement) —
the chat rendering's one-anchor-per-speaker-turn density collapses single-speaker
sessions to one timestamp and makes per-utterance placement impossible (panel
blocker). Unanchored words render without invented timestamps. The rendering is
**paged deterministically** (sequential segments with an explicit continuation
marker) rather than silently truncated when it exceeds the measured tool-output
bound; a task measures a realistic long-session fixture against the CLI's tool-output
ceiling (which the child env whitelist deliberately prevents operators from raising).
Chat turns keep the existing rendering byte-identical.

### D6 — Turn registration carries the run context; tool set is registered per turn
`AiMcpListener.registerTurn` grows an optional per-turn context: the turn's **tool
set** (chat registers its three; generation registers `get_transcript_words` +
`create_event`) and, for generation turns, the run snapshot (frame rate, offset,
categories, run id, cap counter). `buildSessionMcpServer` registers only the turn's
tools — "chat turns cannot write events" is enforced server-side, with the CLI
`--allowedTools` pin as belt-and-braces (panel: argv-only enforcement left the spec's
"reachable only by generation turns" claim untested at the server). Chat turns pass no
context — zero behavior change. The SSE-progress `onEventCreated` callback from the
original draft is deleted with the stream (D2).

### D7 — Chat's allowlist is pinned, not defaulted
`AI_MCP_TOOL_NAMES` grows to four (registry). A new explicit
`AI_CHAT_ALLOWED_TOOLS = ['get_transcript_words', 'list_topics', 'create_topic']` is
passed by `ai.ts` — chat no longer relies on "omit ⇒ full registry", so growing the
registry can never silently widen chat. Tests pin both the chat argv's
`--allowedTools` and (D6) the server-side registration split.

### D8 — Config: dedicated accessors, generation-sized defaults
`eventGenerateMaxBudgetUsd` default **5.0** and `eventGenerateTimeoutSec` default
**600**, following the `topicGenerateMaxBudgetUsd` pattern — deliberately above the
topic-generate values (2.0/300): the workload is strictly larger (full transcript at
generation density + N instruction sweeps + per-hit tool round-trips), and the repo's
own recorded lesson (`env.ts`) is that reusing a smaller surface's budget makes the
button deterministically fail on large sessions. Also configured here: the per-run
created-events cap (default 200) and the aggregate pre-spawn instruction bound
(total instruction bytes + instruction-bearing entry count).
*(Panel wanted reuse of the topic knobs; overruled by the assumptions reviewer's
budget-exhaustion analysis + the env.ts precedent. Defaults are gate-visible here —
flagged for the owner at the gate summary.)*

### D9 — Web: mutation + existing latch machinery; marker; coalescing
The feed toolbar reuses **`useGatedGenerate` + `GenerateToolbar` verbatim-pattern**
(the same 503 latch, single inline channel, aria-disabled reason) with a React Query
mutation — no SSE consumer, no new hook family (the original draft's third latch copy
is gone). No-instructions detection reads the new `auto_instructions_present` boolean
on `GET …/show-categories` (panel simplification: the shared `showCategoriesApiShape`
projection is NOT forked; one boolean computed in the events router; Companion
divergence structurally impossible). 409 renders inline, retryable, unlatched. Run
state is keyed by the session the run started for (the mounted-hidden unkeyed panel
must not leak run state across a session switch — the AiV2Panel lesson). Generated
rows render a compact accessible "auto" marker off `metadata_json.auto_generated`.
`event.changed`-driven event refetches are debounced (~1s) during bursts (gate
2026-07-28: client-side coalescing; server emission semantics unchanged). Settings:
instruction fields per D1/web-ui-system spec; drafts + save mappings +
copy-from-show carry the fields; instruction-bearing indicator per the spec's single
definition. Hand-written API types (`web/src/api/types.ts`) and the captured
response-conformance fixtures are updated for the changed shapes (web-api-shape-
conformance invariant: fixtures are outputs, re-captured, never hand-edited).

## Risks / Trade-offs

- [Model recall — misses instances or misplaces hits] → generation-density rendering
  (D5) gives it real anchors; dedicated system prompt with per-instruction checklist
  discipline; gated real-CLI test on a captured fixture (fixtures can't catch
  model-behavior bugs — topic-generation lesson) including a re-run dedup exercise.
- [Interpolated wall times are approximations between sparse anchors] → the normative
  invariant is bracketing order, not exact reconstruction; anchors densify as manual
  events exist; accepted residual for anchor-poor sessions.
- [Transcript + instructions are attacker-influenced and steer a write tool] →
  lockdown unchanged; untrusted-data framing; category allowlist + `internal` denial;
  message/timecode bounds; per-run cap; run-id attribution + feed marker make cleanup
  targeted; append-only keeps blast radius to deletable rows. Second-order injection
  (generated text later read by AI-v2 `eventStats` and future runs' embedded events)
  is accepted: both consumers are closed-world-locked, session-scoped, and deletable.
- [Long transcript × many instructions vs budget/timeout/tool-output ceiling] →
  paged rendering (D5) + measured bound; generation-sized budget/timeout defaults
  (D8); partial results persist with `cap_hit`/502 visibility. Residual: no
  per-instruction resumability.
- [Dedup is model-side] → accepted by user decision; embedded complete per-category
  events (D3) remove the structural blindness the panel found; re-runs may still
  duplicate borderline matches — marker + run id make cleanup targeted.
- [Per-insert broadcast during bulk runs amplifies into refetch/relink load] →
  client-side debounce (gate); relink pass remains guarded by revision check;
  accepted residual: Companion and stale clients refetch per frame as today.
- [CSV formula injection in exports] → pre-existing (messages were always
  user-authored), but this change makes them third-party-influenced; export bytes are
  frozen — accepted residual, recorded here rather than silently inherited.
- [Option instructions key by label/position (no option ids)] → renaming an option
  orphans its instruction silently; accepted residual (an id migration for
  dropdown_options is out of scope).

## Migration Plan

Additive only: no DB migration (JSON fields), new route + one new MCP tool, additive
JSON fields/boolean, reworded 409 details. Deploy = normal build; rollback = revert
(instruction values persist harmlessly in categories JSON; generated events are
ordinary rows identifiable by metadata).

## Open Questions

None — both prior open questions were closed at the 2026-07-28 gate (message
conventions pinned per button type in the spec; budget/timeout/cap defaults pinned in
D8, flagged to the owner).

## Panel & review log

### 2026-07-28 — Fact-check pass (light-tier, pre-panel)
Mechanical fetch-and-compare over `proposal.md`, `design.md`, and the four delta specs
against the live repo (per-claim property + whole-function reads; report retained by
the orchestrating session). **28 checkable claims: 25 confirmed, 3 refuted, the
design-rationale/risk-acceptability cluster + both Open Questions left unverified
(judgment).** Corrections applied to the drafts:
1. Companion `categories` response misstated as `{id, label}` — actual projected shape
   is `{id, label, color, type, dropdown_options{label, needs_context}, on_label,
   off_label}`; "untouched" survives because the handler projects a fixed field set
   (`showCategoriesApiShape`), not because the shape is minimal.
2. "Categories persisted as loose JSON" was wrong for the WRITE path:
   `validateCategoriesList`/`normalizeDropdownOptionEntry` rebuild from fixed field
   sets and would silently strip `auto_instruction` today. D1 names both (plus the
   web save mappings) as change sites.
3. D9's "client knows the show's categories already" was unmechanized: the feed's
   category source (`GET …/show-categories`) projects through the same stripping
   projection. (Superseded at the panel by the `auto_instructions_present` boolean.)
Notable confirmed premises: `--tools ''` (no built-in Task tool in the child);
`registerTurn` carries only `{sessionId}` today (D6's per-turn context is genuinely
new); `ai/chat` relies on omit-⇒-full-registry today, so D7's pin is load-bearing.

### 2026-07-28 — Adversarial panel (4 reviewers: requirements / assumptions /
### failure & abuse / scope) + gate

Four independent skeptical reviewers over the corrected artifacts; ~40 raw findings
deduped by the orchestrating session. All four converged, in code, on the D4
inversion being unbuildable (single-row `session_transport`; `timecodeForMark`
constant while stopped; fallback mis-interleaves). Dispositions:

**Blockers/majors fixed in place** (spec + design reworked accordingly):
- D4 anchoring replaced with piecewise interpolation over existing event
  timecode↔wall anchor pairs + normative bracketing-order invariant (all reviewers).
- `get_transcript_words` collapses timecodes to one anchor per speaker turn — added
  the generation-density paged rendering (D5) + measured tool-output bound
  (assumptions B1/M5).
- `list_events`'s recency cap structurally defeated dedup and the tool might never be
  called — dropped; complete per-category events embedded in the prompt (assumptions
  M4, failure M2, requirements M5, scope 2).
- Missing gates added: open-network 503 refusal, pre-spawn 400s (anchored transcript,
  no instructions, aggregate instruction bound), guard order with 404-masking
  (failure B3/M5, requirements M1, B3).
- Write fidelity: generated inserts stamp UI snapshots + router performs the catalog
  `projectSessionLive` mirror; "indistinguishable" made concrete (failure M3,
  requirements B5).
- "Instruction-bearing" defined once (button OR any option) and used everywhere;
  option-only DROPDOWNs participate (requirements B1).
- Whole-button vs per-option semantics + per-type message conventions pinned in spec;
  Open Question 1 closed (requirements B2).
- Drop-frame `;` grammar accepted; timecode bounds defined; `internal` category
  denied in `create_event`; snapshot-at-run-start made normative (assumptions M3,
  failure minors, requirements m4).
- Chat pin strengthened from argv-only to server-side per-turn tool registration
  (requirements M3).
- 409 busy-detail rewording authorized in the delta (requirements M2).
- Instructions framed as delimited untrusted data + aggregate pre-spawn bound
  (failure M4).
- Run-id metadata stamped for attribution (failure B2/M6).
- Simplifications adopted: single validation point in `validateCategoriesList` (the
  superRefine would have produced 422, not 400); `addEvent` optional explicit-anchor
  parameter instead of a parallel insert method; `auto_instructions_present` boolean
  instead of forking the shared projection (scope 4/6/7).
- Session-switch run-state scoping + 409 UI handling specced (requirements M8/m5);
  conformance fixtures + hand-written types added to tasks (requirements m1).

**Escalated to the gate — owner rulings (2026-07-28):**
1. Progress delivery → **synchronous POST + feed-native liveness** (SSE draft
   deleted: D2/D6 reworked, stream vocabulary and consumer hook removed).
2. Abuse bounds → **per-run cap + run-id metadata + visible feed marker** adopted.
3. Button-type participation/messages → **BUTTON/DROPDOWN/TEXT with manual-matching
   conventions; ON_OFF excluded**.
4. Broadcast policy → **client-side refetch coalescing (~1s)**; server per-insert
   emission unchanged.
(D8's generation-sized budget/timeout/cap defaults — 5.0 USD / 600 s / 200 events —
were presented with the synthesis and stand as the recorded defaults.)

**Minors accepted as residual** (recorded in Risks): label-keyed option instructions
(no option ids); interpolation approximation between sparse anchors; second-order
injection into locked-down AI consumers; per-frame refetch for non-coalescing
clients; CSV formula-injection inheritance in frozen exports; model-side dedup
remaining best-effort on borderline matches.

### 2026-07-28 — Post-gate consistency read (light-tier)
One reviewer over the final proposal.md, design.md, tasks.md, and all four delta
specs, checking the twelve folded rulings for stale pre-decision language,
cross-document contradictions, and task/spec drift. Three MINOR findings, all fixed
in place: the spec's cap default hedged as "e.g. 200" (now "default 200"); proposal
Impact's "explicit-timecode parameter" (now "explicit-anchor", matching D4/tasks
2.3); proposal What-Changes omitting `cap_hit` from the response summary (now
`{created, cap_hit}`). All other checks clean — no stale SSE/`list_events`/
superRefine/`addEventAtTimecode`/split-projection language survives outside
correctly-recorded rejected alternatives; guard-ladder order, tool counts, the
instruction-bearing definition, config values, and MODIFIED-requirement titles are
consistent across all seven documents and verified against the live repo's symbols.
