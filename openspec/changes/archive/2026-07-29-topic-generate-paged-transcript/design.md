## Context

`topics/generate` (topic-generation, shipped 2026-07-22) runs a one-shot CLI turn whose
MCP registration passes `mcpContext: { tools: ['get_transcript_words', 'create_topic'] }`
— no `generation` run snapshot. In `aiMcpServer.ts`, the `get_transcript_words` tool
builder keys its rendering on `generation !== undefined`:

- **generation turns** → paged generation-density rendering
  (`renderGenerationTranscriptPage`, continuation marker, built by
  `auto-generate-event-logs` because a long transcript overflows the CLI's MCP
  tool-output limit);
- **everything else** → the zero-arg chat rendering: `formatTranscriptForModel(words)`,
  the WHOLE transcript in one tool result.

Topic one-shots take the second path. On session `017a5ca0…` (31,621 words) the chat
rendering is 216,526 chars — over the CLI's tool-output ceiling. The CLI diverts
oversized tool output to an on-disk file and tells the model where it went; the one-shot
exposes only `get_transcript_words` + `create_topic` (no Read/Bash), so the model
couldn't follow the redirect, wrote one placeholder topic ("transcript unavailable…"),
the turn exited ok, and the route's crash-safe swap replaced the prior topic set.

**Panel finding that reshaped this design** (assumptions reviewer, read from the
operator's CLI binary, version 2.1.220): the CLI accepts any MCP tool result of
≤ 50,000 chars unconditionally (its `len/4` estimator short-circuit against the
25k-token cap at a 0.5 factor); above that it calls the real `countTokens` API and
diverts when the true count exceeds the cap — a cap that is **remotely configurable**
(`MAX_MCP_OUTPUT_TOKENS` env → a remote gate value → 25000 default), and whose
divert-vs-truncate behavior is itself env-conditional. The existing 8000-word page
bound renders the motivating session's pages at 64,762–69,335 bytes — all four above
the always-accept threshold, with timecode-prefix-dense text tokenizing at ~2–2.8
chars/token, i.e. a best-case margin under 5% and a plausible overflow. Rendered bytes
per word are unbounded: line count is set by diarization churn (the real session
averages 7.17 words/line across 13 speakers; a speaker-flip-every-word page measures
327,999 bytes). The word bound is therefore not a safe page bound on either consumer.

Constraints: the frozen HTTP/WS contract (untouched here); chat-turn rendering pinned
byte-identical by `aiMcpServer.test.ts`; the one-shot's two-tool allowlist and
no-abort/run-to-completion posture are spec'd invariants of `topic-generation`;
`create_event` registration is keyed by the explicit `tools` set, never by snapshot
presence.

## Goals / Non-Goals

**Goals:**
- A topic one-shot reads its transcript through bounded sequential pages — every page
  under the CLI's stable always-accept threshold, explicit continuation marker, never
  one unbounded payload, never a silent truncation — and a run that did not fetch every
  page can never replace the prior topic set.
- One shared, size-safe pager for both generation-density consumers (event + topic).
- Deterministic paging within a run (page boundaries cannot shift mid-turn).
- The shipped defaults actually pay for the multi-page workload on real long sessions.

**Non-Goals:**
- Changing chat-turn rendering, or fixing the chat path's own overflow on very long
  transcripts (residual + roadmap candidate).
- Any observable HTTP/WS change; any new status code or precondition.
- A semantic model-output quality gate (the coverage gate is mechanical only).
- A per-run `create_topic` cap; backfilling the affected session's topics.

## Decisions

### D1 — Key paged delivery by a dedicated context field carrying ONLY words

Widen `AiMcpTurnContext` with a flat optional field, e.g.
`pagedWords?: readonly AiGenerationSnapshotWord[]` — the already-exported 3-field
snapshot shape (`{word, session_time, speaker}`) the rendering path consumes; NOT raw
hub rows (their ~8 fields/word carry several MB of dead weight on long sessions, and
`events.ts` already documents the 3-field projection as a binding review carry). The
`get_transcript_words` builder registers the paged (page-input) shape when EITHER
`generation !== undefined` (unchanged) OR `pagedWords` is present, sourcing words as
`generation?.words ?? pagedWords ?? live hub read`.

- **Alternative — fabricate an `AiGenerationRunContext`** (empty categories, cap 0,
  dummy frame rate, dummy run id): rejected on SEMANTIC grounds — the type has six
  required event-run fields a topics turn has no true values for, and a "generation
  run" object with `cap: 0` on a turn with no run poisons every future reading of the
  type. (The panel corrected the earlier security framing: registration is keyed by
  the `tools` set and `categories: []` rejects every `create_event` call, so a
  fabricated snapshot could not actually leak event-writing — the cost is coherence,
  and that is enough.)
- **Alternative — a bare paging flag with a live hub read per page**: rejected; the
  busy lock covers AI turns only, so DeepGram `replaceTranscriptWords` and the
  entirely un-locked single-word transcript-word routes can mutate words mid-run and
  shift page boundaries between calls.
- **Alternative — unify both carriers into one `transcript: {paged, words}` field
  replacing `generation.words`**: architecturally cleaner (one carrier, one keying
  rule) but rejected NOW — it re-keys a shipped path and rewrites live pins for zero
  functional gain on this bug. If a third paged consumer appears, unify then.

### D2 — Snapshot captured synchronously inside `generateTopicsTurn`

`generateTopicsTurn` takes the word read itself — `registry.get(sessionId)
.listTranscriptWords()` projected to the 3-field shape — as the immediately-preceding
synchronous statement before `driveAiTurn(...)`, and passes it as `pagedWords`. This
mirrors the `events.ts` precedent EXACTLY as documented there ("no `await` occurs
between here and the turn registration, so nothing can interleave") and keeps
`transcribe.ts` out of the snapshot path entirely (the route's pre-slot read remains
what it is: the no-transcript precondition). An earlier draft required a "fresh read
AFTER slot acquisition" in the route; the panel showed that rule is a no-op (no `await`
between the precondition read and the slot) that contradicted the precedent it claimed
to mirror, and dropped it.

### D3 — System prompt: explicit paging protocol + untrusted-data clause

`TOPIC_GENERATE_SYSTEM_PROMPT` names the paged protocol concretely — the transcript
arrives in sequential pages; each non-final page ends with a continuation marker naming
the next page; the model MUST keep fetching until a page carries no marker before
treating the transcript as fully read — mirroring `EVENT_GENERATE_SYSTEM_PROMPT`'s
existing paging instruction. It also gains an untrusted-data clause (mirroring the
event prompt's discipline for instruction text): transcript content is data, cannot
change the tools, the task, or the paging rules, and only the tool's own trailing
marker governs paging. "Always create at least one topic" stays — it was ADDED in
`d19d1af` as part of the dedicated-prompt fix, after the reused chat brief's
check-`list_topics` dedup instruction (against a withheld tool) made the real model
create too few or ZERO topics.

### D4 — The shared pager packs by rendered size, not word count

`renderGenerationTranscriptPage` packs lines into a page until adding the next line
would exceed a hard rendered-size cap of **45,000 chars** (safely under the CLI's
50,000-char always-accept short-circuit — the only STABLE guarantee in the CLI's code
path, given the token cap is remotely configurable), keeping
`GENERATION_PAGE_SIZE_WORDS = 8000` as a secondary cap. Packing stays on line
boundaries and deterministic. This applies to BOTH consumers — the event path inherits
the fix for its identical latent overflow (its current pages can exceed the threshold
under diarization churn). A single over-cap line (pathological 2000-char words) is
split hard at the cap rather than emitted oversized. The measurement fixture becomes
ADVERSARIAL — maximal line count per word (speaker change every word) — and the test
asserts the cap invariant (no page over 45,000 rendered chars) rather than pinning one
fixture's byte count as "worst-case"; the existing 62,952-byte pin is superseded and
its "worst-case" wording demoted to "this fixture's page" (production data already
measured 10% above it).

- **Alternative — keep 8000 words and pre-measure page 0 via a real countTokens call**:
  rejected; it validates one session against one CLI version's remotely-movable cap,
  and leaves diarization churn unbounded.
- **Alternative — topic-specific page size**: rejected (two bounds to maintain; the
  ceiling is turn-kind-independent).

### D5 — Continuation-marker forgery neutralized in the shared rendering

Transcript text is untrusted third-party input (DeepGram of arbitrary audio, YouTube
imports, direct word CRUD with no charset restriction — a "word" may be 2000 chars
including newlines). Body lines are neutralized so no transcript content can render a
line matching the continuation-marker shape (a `---`-run rewrite mirroring
`eventGeneratePrompt.ts`'s `neutralizeDelimiterTokens`), on both consumers. With D6's
coverage gate, a forged "stop early" cue can at worst waste a run (502 + restore),
never corrupt the topic set; D5 closes the marker-shaped half of that hole at the
rendering, and the event path inherits it (declared scope widening, not silent).

### D6 — Mechanical page-coverage gate on the crash-safe swap

The turn registration tracks pages served (a per-registration `Set<number>` of page
indices + the snapshot's total page count — the exact `createdEvents` counter pattern),
surfaced through `AiMcpTurn`/`DriveAiTurnResult`. The `topics/generate` route's success
predicate becomes: `outcome.ok && newIds.length >= 1 && every page 0..N-1 served`.
Anything less takes the EXISTING failure mapping — restore the fresh rows, prior topics
byte-for-byte intact, the existing 502 `{detail}`. This is bookkeeping the server
already owns (it serves the pages), not model-behavior inference; it closes the
partial-prefix-read hazard paging introduces — a model that stops after page 1 of 4
would otherwise replace a good full-session topic set with quarter-coverage topics,
strictly less detectable than the motivating bug. The gate also makes the
budget-exhaustion outcome mapping moot at the swap (belt to the verified `is_error`
braces — see Panel log).

### D7 — Spend/time defaults sized for the workload this change creates

`TOPIC_GENERATE_MAX_BUDGET_USD` default 2.0 → **5.0**; `TOPIC_GENERATE_TIMEOUT_SEC`
default 300 → **600** — the event-generate values, for the reason `env.ts` already
records verbatim against these exact knobs: a full-transcript-at-generation-density
read "would make the button deterministically fail on large sessions" on the smaller
defaults. Panel arithmetic on the motivating session: ~110k tokens of accumulated
pages, N `create_topic` round-trips re-reading the cached prefix → ~$1.2–1.9 at 20–40
topics, 160–360s wall — marginal-to-negative against 2.0/300, comfortable under
5.0/600. Same env vars; `.env.example` and README knob docs updated (including the
now-false "event knobs default higher" comparatives — the two become equal). The gated
real test runs at THESE defaults (it currently hard-codes `maxBudgetUsd: 5` and
`timeoutMs: 300_000`, so it could pass while the shipped button fails).

### D8 — Test strategy

- Rendering (`aiMcpGenerationRendering.test.ts`): size-cap packing invariant under the
  adversarial fixture; neutralization; determinism/marker/out-of-range pins carry over.
- Keying (`aiMcpServer.test.ts`): `pagedWords` registration exposes the `page` shape and
  sources the snapshot; chat registration byte-identical (existing pins unmodified);
  one-shot tool pair registers no `create_event`/`list_topics`; pages-served counter
  visible on the registration. No third copy of the marker/paging assertions — the
  rendering suite owns those.
- Turn (`topicGenerate.test.ts`): mcpContext carries `pagedWords` + the exact two-tool
  set; argv unchanged; prompt constant names the paging protocol and untrusted-data
  clause (direct string assertions). NOTE: the existing `toEqual({ tools: [...] })`
  whole-object pin on mcpContext must be updated — expected churn.
- Route: partial coverage → restore + 502; full coverage → replace (drive with a stubbed
  outcome/registration).
- Gated real CLI (`topicGenerate.real.test.ts`) — the PRIMARY acceptance evidence: no
  real-model multi-page paging run exists anywhere in the repo today (both existing
  real-test fixtures are single-page, so `auto-generate-event-logs` validated the
  rendering, never the paging behavior). Multi-page fixture with INCREASING timecodes
  (the current fixture anchors every word at `00:00:01`) and an unguessable content
  canary present only on the last page, asserted to reach a topic summary (the marker
  announces "of N", so "timecodes span pages" alone is extrapolatable). Run at
  production defaults; record observed cost and wall time in the apply ledger.

## Risks / Trade-offs

- [Pages shrink to ~45KB → ~7 pages on the motivating session → more round-trips] →
  linear, cached-prefix turns; covered by D7's bounds; each page is guaranteed-accepted,
  which beats fewer pages gambling on a remote-configurable tokenizer cap.
- [Model skips pages despite prompt + marker] → D6 converts silent corruption into loud
  502 + restore; D8's real test is the behavioral evidence.
- [CLI changes its always-accept threshold or divert behavior] → 10% margin under the
  stable short-circuit; behavior read from CLI 2.1.220 and recorded here; a future CLI
  bump re-runs the real test.
- [Very long sessions (~50k+ words) exceed the model context window; the CLI's
  auto-compaction (not disableable through the env whitelist) summarizes early pages →
  coarser early topics on a "successful" full-coverage run] → **accepted residual**,
  documented in README (supported ceiling); degradation is gradual (compacted gist),
  not destruction, and the coverage gate still requires every page fetched.
- [A "successful" full-coverage run with degenerate output still replaces prior topics]
  → accepted residual (semantic gate is a Non-Goal); materially narrowed by D6.
- [Longer runs hold the shared AI turn slot (default max 2 process-wide) to completion
  with no abort signal → other AI features 409 meanwhile] → accepted residual
  (pre-existing posture; window lengthens), noted for the roadmap.
- [Crash mid-run leaves fresh rows alongside prior topics (no startup reconciliation);
  paging lengthens the window] → accepted residual, unchanged mechanism.
- [`create_topic` has no per-run cap while budget rises] → accepted residual;
  budget/timeout bound it; the event path's `cap` pattern is the follow-up shape.
- [DeepGram regeneration completing mid-run → topics reflect the run-start transcript]
  → deliberate: the run reflects the transcript as of run start; a concurrent
  replacement's topics come from the next run.
- [Invariant a future reader might "helpfully" undo: chat turns MUST keep the unpaged
  compact rendering, and chat registrations never carry `pagedWords`] → normative in
  `ai-topics-chat` after this change; do not "unify" chat onto paging.
- [Invariant: `create_event` registration stays keyed by the `tools` set; the topic
  turn's context carries no event-run fields] → normative in `topic-generation` after
  this change.
- [`ai/chat` itself overflows on this same session today (216,526 chars > cap): the
  model just can't read the transcript in chat] → out of scope; recorded residual +
  roadmap candidate.

## Migration Plan

None — no data, schema, or contract migration. Deploy is a server restart; rollback is
a revert. Operators who pinned `TOPIC_GENERATE_MAX_BUDGET_USD`/`TOPIC_GENERATE_TIMEOUT_SEC`
explicitly keep their values (only defaults move).

## Open Questions

None blocking.

## Panel & review log

- **2026-07-29 — Pre-panel fact-check pass** (opus fetch-and-compare, 18 claims).
  Checked: 18 stated claims across proposal/design/deltas — builder keying, one-shot
  mcpContext shape, registration-by-tools-set, page-size constants + measured bounds,
  pager behavior, snapshot precedence, chat-rendering byte-pins, the failed session's
  DB evidence (31,621 words; 1 placeholder topic; the 216,526-char figure independently
  REPRODUCED by re-rendering the real rows), busy-lock scope, crash-safe swap
  mechanics, npm scripts, `topicCreateSchema` bounds, baseline-fidelity diffs of both
  MODIFIED blocks (no silent drift), `auto-event-generation` reference integrity.
  Corrected (landed in drafts): D3's prompt history was REFUTED ("always create at
  least one topic" was ADDED in `d19d1af`, never removed-then-rebroken); the real-test
  gate claim was REFUTED (gate is `RUN_REAL_AI_TESTS=1` + CLI resolution, not
  `CLAUDE_CLI_PATH` absence) — landed in the real-test task (now 4.1 after the
  post-panel renumbering); proposal Impact now names `transcribe.ts`; D2 pinned the
  snapshot read location; the README edit made unconditional (now task 5.1); the
  `toEqual` mcpContext pin flagged as expected churn (now task 3.1). Left unverified: the CLI's
  divert-to-file generalization, token estimates, judgment claims — all subsequently
  resolved or adjudicated by the panel (below).

- **2026-07-29 — Adversarial panel** (4 opus reviewers: requirements, assumptions,
  failure & abuse, scope/simpler-design; Fable synthesis). Sharpest findings: the
  8000-word page bound is token-unsafe on the motivating session (assumptions BLOCKER,
  measured against the real rows and the real CLI 2.1.220 binary); the 2.0/300 topic
  bounds can't pay for the paged workload (found independently by all four reviewers);
  paging introduces a partial-prefix-read path to the destructive swap (failure M3,
  scope M2); the continuation marker is forgeable from untrusted transcript text
  (failure M4); D2's post-slot re-read rule was a no-op contradicting the events.ts
  precedent (scope M3, failure m8); the `auto-event-generation` "governed by" pointer
  didn't reach topic turns (requirements M3, scope M4); no real-model multi-page paging
  evidence exists anywhere in the repo (assumptions M4, scope m8 — both real-test
  fixtures are single-page).

  **Blockers/majors fixed in place:** pager repacked by rendered size ≤45,000 chars
  with adversarial fixture + hard split of over-cap lines (D4); budget/timeout defaults
  → 5.0/600 with spec backing (D7 + MODIFIED bounds requirement); page-coverage gate on
  the swap via the createdEvents pattern (D6 + ADDED requirement + scenario);
  marker neutralization in the shared rendering + untrusted-data prompt clause (D5 +
  auto-event-generation delta scenario); snapshot moved into `generateTopicsTurn`
  matching the events.ts precedent, transcribe.ts dropped from the snapshot path (D2);
  third delta added widening `auto-event-generation`'s scope clause — single owner for
  the rendering, topic-generation's restatement reduced to an ADDED requirement whose
  transcript-delivery SHALLs are its own (requirements M3/m2, scope M4); prompt SHALL
  made testable with a scenario + direct string assertions (requirements M2);
  short-transcript same-tool-shape scenario added (requirements m1); "8000 words"
  removed from scenario text (requirements m4); no-event-run-fields sentence added
  (requirements m5); "byte-identical to pre-change" deixis replaced with the property
  (requirements m3, scope m5); chat-never-carries-pagedWords made normative — a
  declared seam for the whole-branch audit (failure m6); D1 example shape flattened to
  `pagedWords?: readonly AiGenerationSnapshotWord[]` (failure m7, scope m2); D1's
  fabricated-snapshot rejection restated on semantic grounds and alternative (c)
  recorded with a forward note (scope findings); real test repointed at production
  defaults with increasing-timecode fixture + last-page canary (assumptions m7, scope
  M1/m8); per-registration memoized pagination noted for the implementer (failure m9);
  goal reworded from "ANY length" to the bounded-pages property + supported-ceiling
  residual (requirements B1's contradiction, assumptions M3, failure M5); doc-comment
  inventory added to tasks (scope m7); duplicate paging assertions trimmed from the
  keying tests (scope m10); fact-check's open budget-exhaustion item RESOLVED — the
  CLI yields `is_error: true` (`error_max_budget_usd`) so exhaustion maps to 502 +
  restore (assumptions SOUND #4, correcting the failure reviewer's B2 hypothesis and
  the earlier Risks bullet).

  **Escalated to the gate:** the user pre-authorized "run the panels and then apply"
  (2026-07-29), so gate-level decisions were exercised under that standing instruction
  and are surfaced in the session summary rather than held: (1) raising operator spend
  defaults 2.0→5.0 / 300→600s; (2) changing the SHARED pager (event-generation pages
  repack + neutralization — event path deliberately affected); (3) adopting the
  page-coverage gate (a new internal failure cause on an existing 502). All three
  follow the user's mandate (make topics/generate work on the motivating session);
  none touches the frozen contract.

  **Minors accepted as residual:** `create_topic` uncapped per run; AI-slot starvation
  window lengthens (no abort by design); crash-orphan window lengthens; stale-run-start
  transcript on concurrent regeneration (deliberate, now stated); >50k-word sessions
  degrade via CLI auto-compaction on a full-coverage run (documented ceiling);
  `ai/chat` long-transcript overflow (roadmap candidate); CLI cap remotely
  configurable (margin + version recorded); topic-generation delta pins the snapshot
  property normatively while the event baseline leaves it implementation-level
  (accepted asymmetry — the coverage gate depends on it for topics).

- **2026-07-29 — Post-fold consistency read** (opus, all seven change documents +
  three baselines). NOT clean — 9 findings, all fixed in place: real-test task now
  replaces the hard-coded `timeoutMs: 300_000` too and raises the vitest timeout above
  the 600s production bound (was un-runnable as written); phantom
  `eventGenerate.test.ts` reference dropped from proposal Impact; task 3.2 now sweeps
  the now-false "event knobs default higher" comparatives in env.ts/.env.example/
  README; four more falsified doc-comment sites added to 5.1
  (`GENERATION_LINE_MAX_WORDS`, the rendering block comment, `ToolBuildContext`,
  `registerTurn`); the model-facing generation tool DESCRIPTION ("fixed sequential
  pages of at most N words") added to task 1.1's edit list; task 1.1 now supersedes
  the 80,000-byte bound and the test name, not just the 62,952 pin; task 2.2's
  "zero-page" example corrected (chat turn, not event turns); stale pre-renumbering
  task pointers in the fact-check log entry annotated; two spec ambiguities tightened
  (auto-event-generation's oversized scenario now says "rendered-size cap";
  topic-generation's ADDED requirement now separates the delivery guarantee from the
  documented context-ceiling residual). Verified clean by the same read: no stale
  pre-panel language anywhere, D1–D8 references resolve, 45,000/5.0/600/8000-secondary
  consistent across documents, coverage-gate semantics identical in all four
  statements, capability list matches the delta files, all "governed by" pointers
  resolve to real headers, all four MODIFIED blocks baseline-faithful outside intended
  edits.
