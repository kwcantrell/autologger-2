## Why

`POST /api/sessions/:id/topics/generate` fails on long transcripts. The topic one-shot's
`get_transcript_words` registration carries no generation snapshot, so the tool falls
through to the zero-arg **chat** rendering — the entire compact transcript in ONE tool
result. On a real session (`017a5ca0…`, 31,621 words) that rendering is 216,526 chars,
over the Claude CLI's MCP tool-output ceiling: the CLI diverted the payload to an on-disk
file the tool-locked one-shot cannot read (no file/shell tools), and the model — obeying
the prompt's "always create at least one topic" — created a single placeholder topic
saying the transcript was unavailable. The run counted as a success, so the crash-safe
swap **replaced the session's entire topic set with that placeholder**.

The paged generation-density rendering (`renderGenerationTranscriptPage`) shipped with
`auto-generate-event-logs` for exactly this problem, but (a) it is keyed to
event-generation turns only, and (b) the panel found its 8000-word page bound is a
**bytes proxy for a tokens decision**: on the motivating session every rendered page
lands above the CLI's 50,000-char always-accept threshold with a best-case token margin
under 5% against the 25k-token cap (CLI 2.1.220, read from the operator's binary), and
rendered bytes per word are unbounded under diarization churn — so word-bounded pages
can still overflow, on both the event path (latent) and any topic path built on it.

## What Changes

- **Page packing moves from word count to rendered size** (shared pager, both
  generation-density consumers): a page is packed on line boundaries to a hard
  rendered-size cap (≤ 45,000 chars) chosen under the CLI's stable 50,000-char
  always-accept short-circuit, with the existing 8000-word cap retained as a secondary
  bound. The "worst-case" measurement fixture becomes adversarial (maximal line count
  per word), not merely realistic.
- **Topic one-shot turns get the paged rendering** via a new dedicated
  `AiMcpTurnContext` field carrying ONLY a run-start word snapshot (no fabricated
  event-run snapshot; `create_event` registration stays keyed by the explicit tool
  set). The snapshot is captured synchronously before any `await` in the turn path —
  the same discipline `events/generate` documents — so mid-run transcript mutation
  cannot shift page content or boundaries.
- **The crash-safe swap gains a mechanical page-coverage gate**: the MCP registration
  counts pages served (the existing `createdEvents` counter pattern); a run that
  created topics without fetching EVERY page maps to the existing 502-and-restore
  failure path instead of replacing the prior topic set. This closes the new
  partial-prefix-read hazard paging introduces (strictly less detectable than the
  motivating bug) without any semantic model-output inference.
- **Continuation-marker forgery is neutralized in the shared rendering** (transcript
  text is untrusted third-party input), and `TOPIC_GENERATE_SYSTEM_PROMPT` gains the
  explicit paging protocol plus an untrusted-data clause mirroring the event prompt's.
- **`topics/generate`'s spend/time defaults are raised to the event-generate values**
  (`TOPIC_GENERATE_MAX_BUDGET_USD` 2.0 → 5.0, `TOPIC_GENERATE_TIMEOUT_SEC` 300 → 600):
  the change moves topic-generate onto the same full-transcript-at-generation-density
  workload whose cost `env.ts` already documents as deterministically failing the
  smaller knobs. Same env vars, no new surface.
- The gated real-CLI test becomes the change's primary acceptance evidence: a
  multi-page fixture at PRODUCTION defaults (the current test hard-codes the
  event-generate budget), with increasing timecodes and a last-page content canary —
  no real-model multi-page paging run exists anywhere in the repo today.
- Chat turns keep the existing compact rendering **byte-identical** (pinned by existing
  tests) and their registrations never carry the new field.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `topic-generation`: ADDED requirement for paged, complete, snapshot-stable one-shot
  transcript delivery (including the prompt protocol and the page-coverage success
  gate); MODIFIED "Dedicated spend and time bounds" (multi-page sizing, defaults no
  lower than event-generation's); MODIFIED machinery requirement gains a pointer to the
  added requirement.
- `auto-event-generation`: MODIFIED "Generation-density transcript rendering" — scope
  widens from event-generation turns to generation-density turns (event generation and
  the topic one-shot), the page bound is restated as a rendered-size cap with an
  adversarial measurement fixture, and body lines can no longer forge the continuation
  marker.
- `ai-topics-chat`: MODIFIED "Session-scoped MCP toolset" — the `get_transcript_words`
  bullet points at `auto-event-generation` as the single owner of the paged rendering,
  chat registrations SHALL NOT carry the paged-transcript field, and the chat-rendering
  pin is stated as a property (zero-arg shape, one unpaged result) rather than a
  temporal "pre-change" reference.

## Impact

- **Contract impact: none.** No HTTP/WS observable change — same routes, same
  `200 {topics}` / `400/409/502/503` ladder and `{detail}` bodies, no WS emission
  change. The 502-and-restore path gains a new internal cause (incomplete page
  coverage); status, shape, and detail string are the existing ones.
- **Event-generation runs are affected** (deliberately): pages repack under the size
  cap, and marker-shaped body text is neutralized. Both are internal model-facing
  fixes to the same latent overflow/forgery hazards; the event path's spec scenarios
  keep passing.
- Code: `server/src/routers/aiMcpServer.ts` (pager packing + neutralization + context
  field + pages-served counter), `server/src/routers/topicGenerate.ts` (snapshot +
  prompt), `server/src/routers/aiTurn.ts` (page-coverage plumbing, `createdEvents`
  pattern), `server/src/routers/transcribe.ts` (swap coverage gate),
  `server/src/env.ts` + `server/.env.example` + README (defaults).
- Tests: `aiMcpGenerationRendering.test.ts` (size-cap packing, adversarial fixture,
  neutralization), `aiMcpServer.test.ts` (keying/registration), `topicGenerate.test.ts`
  (snapshot/prompt/argv), `transcribe`-level swap-gate tests,
  `topicGenerate.real.test.ts` (multi-page at production defaults).

## Non-Goals

- No change to chat-turn transcript rendering, and no fix for the chat path's own
  same-shaped overflow on very long transcripts (`ai/chat` on the motivating session
  is known-broken above the cap today) — recorded as a residual and roadmap candidate.
- No new HTTP surface, no new status codes or preconditions (an over-context-window
  transcript degrades via the CLI's auto-compaction and the loud budget/timeout
  failure paths; the supported ceiling is documented, not enforced by a new 4xx).
- No **semantic** model-output quality gate on the swap (the page-coverage gate is
  mechanical bookkeeping, not model-behavior inference).
- No per-run `create_topic` cap (bounded by budget/timeout; recorded as residual with
  the event path's `cap` pattern named as the follow-up shape if needed).
- No re-generation/backfill of the affected session's topics as part of this change.
