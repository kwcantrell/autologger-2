# ai-v2-dashboards — Design

## Context

The session workspace already has a conversational agent (topics chat, CLI transport, shipped).
This change adds a second, differently-shaped one: the user **designs a dashboard** by answering
Claude's questions, and the result is a saved, re-renderable view of the session's own data.

Two external inputs shape it, both supplied by the operator:

- **`~/claude-agent-sdk-demos/ask-user-question-previews`** — a working Agent SDK demo whose
  mechanic is `canUseTool` blocking on a browser answer. This is the *interaction* model.
- **`~/Desktop/autologgers-demo.html`** — "Autologgers — Meeting Intelligence Demo", a built
  Preact SPA. This is the *output* reference. **It embeds a real private conversation** (personal
  and financial detail); it is read for structure only and its content must never reach any
  artifact of this change.

A predecessor change, `ai-session-analyst`, was gated 2026-07-20 and superseded before
implementation. Its findings are inputs here, not waste — see "Inherited findings".

## Goals / Non-Goals

**Goals**
- Conversational dashboard design with previews that cannot lie about the result.
- A dashboard that renders from the session's real data, re-renderable after the turn ends.
- Model-authored markup contained so it can never execute in the authenticated origin.

**Non-Goals**
- Sentiment widgets (no persisted data — see D2).
- Sharing, export, scheduled refresh, cross-session dashboards.
- Any change to the topics chat.

## Decisions

### D1 — Catalog first, sandboxed iframe as the single escape hatch (owner ruling)

Most widgets come from a **fixed catalog** rendered by our own React components. Claude selects
types and composes a layout; it does not author the markup. One escape hatch exists for genuinely
custom output: an **`<iframe sandbox>` without `allow-same-origin`**.

*Why not the demo's approach.* The demo renders Claude-authored HTML via
`dangerouslySetInnerHTML` + DOMPurify. That is proportionate for a single-user localhost toy. Here
the markup would be authored from **untrusted transcript content** (anyone audible on a recording
is an input author) and rendered in a **multi-user, studio-scoped, authenticated** page. DOMPurify
is a good sanitizer, but "sanitizer bug" and "authenticated origin" is a bad pairing to accept by
default when a catalog covers the common cases.

*Why the escape hatch survives anyway.* Restricting to a catalog alone would make the feature
brittle the first time a user wants something unanticipated. The iframe keeps that possible while
making the blast radius structural rather than dependent on a sanitizer being correct: no
`allow-same-origin` means no access to cookies, `localStorage`, or the parent DOM, so the worst
case is a broken tile rather than session compromise.

**Invariant a future reader must not "simplify":** there is **no** `dangerouslySetInnerHTML` path
outside the sandboxed iframe. Rendering a custom widget inline "just for one case" reopens exactly
the hole this decision closes.

### D2 — v1 catalog is limited to what today's schema can compute (owner ruling)

Verified against `server/src/session/`:

| Widget | Backing data | Status |
| --- | --- | --- |
| `talk_time_by_speaker` | `session_transcript_words.speaker` + `start_sec`/`end_sec` | ✅ computable |
| `utterance_counts` / `question_counts` / `filler_counts` | same table | ✅ computable |
| `session_duration` | `start_sec`/`end_sec` extents | ✅ computable |
| `topic_timeline` | `session_topics` | ✅ computable |
| `event_count_by_category` / `event_density` | `events` | ✅ computable |
| `transcript_excerpt` | `session_transcript_words` | ✅ computable |
| `sentiment_series` / `sentiment_by_topic` | — | ❌ **no persisted data** |

The reference dashboard's data model includes `sentimentSeries` and `sentimentAvg`, and DeepGram
*is* asked for sentiment (`server/src/node/deepgram.ts` sets `sentiment=true`, commit `7f47b31`).
But **nothing persists it** — no column in `session_transcript_words`, no handling under
`server/src/session/`. Confirmed by grep.

Shipping a sentiment widget would therefore produce a permanently empty tile. Sentiment
persistence is a schema migration plus a `transcript-generation` delta — a separate change with
its own gate. **The catalog is a closed set: a widget type with no backing data MUST NOT be
registered**, because an agent that can name it will name it.

### D3 — Previews render through the real components

A catalog preview renders via the **same React component** as the real widget, with sample data.
The demo's previews are Claude-authored HTML, which is the feature it exists to showcase — but it
also means a preview is a *drawing* of the result rather than the result.

Here, "what you see is what you get" is worth more than visual novelty: the user is picking
between widgets they will then live with. A preview that renders through the real component cannot
drift from it, and it removes an entire class of "the preview looked different" bugs. It is also
why the catalog is worth having at all — with free-form HTML there is no component to preview
*with*.

Custom-widget previews are the exception: they render in the same sandboxed iframe as the real
thing, which preserves the same what-you-see-is-what-you-get property by a different mechanism.

### D4 — Aggregates as tools, not raw rows

The MCP tools expose **computed aggregates** (`speaker_stats`, `topic_timeline`, `event_stats`),
not raw table dumps. The predecessor's panel found `get_transcript_words` unbounded — roughly
1.8 MB of JSON on a 90-minute session — which would blow the context window on first real use.

Aggregates fix this structurally: a designer agent needs *shape* ("three speakers, 62/28/10 split,
41 questions clustered in the last third"), not 12,000 word rows. Tools remain bounded and
paginated where they can still return lists (`transcript_excerpt`).

Carried-forward invariants: `sessionId` is captured in the tool closure and **never** a tool
parameter; hubs resolve at call time via `registry.get(sessionId)` and are **never** held across an
`await` (the idle-eviction sweeper can close one underneath a long turn); the MCP server instance
is built **per turn**, never hoisted to module scope. `SessionHub.listTranscriptWords`,
`listTopics`, and `listEvents` are all synchronous reads, so aggregation happens in the tool layer
and the synchronous-hub invariant holds.

### D5 — Dashboard persistence — OPEN, for the gate

A saved dashboard is validated JSON. Where it lives is a real fork:

- **(a) Session DB** (`DATA_DIR/sessions/<id>.db`) — travels with the session, deleted with it,
  matches the "one session's data per dashboard" scope. Cannot be reused across sessions.
- **(b) Catalog DB** — reusable as a template across sessions, survives session deletion, but
  needs its own scoping story against studios/teams and outlives the data it describes.

**Recommendation: (a) for v1**, matching the stated scope; a "save as template" feature can add
(b) later as an additive change. Flagged for the gate rather than assumed.

### D6 — Answer channel is a POST, not a WebSocket

The design turn streams back over **SSE on the POST** (as the topics chat does). The answer hop
needs a *client→server* path SSE cannot provide. Options considered:

- **Reuse the session WS** — rejected. `ai-topics-chat` D2 established that the per-session WS
  fan-out **broadcasts to every attached client**, browser tabs *and* Companion, and its emission
  semantics are frozen under `api-contract-freeze`. One user's design answers reaching every
  viewer of the session is wrong, and per-client addressing does not exist in the hub today.
- **A dedicated analyst/design WS route** — rejected for v1. It reverses D2's reasoning, adds
  upgrade plumbing, and adds frozen surface, all for a low-frequency request/response exchange.
- **A small `POST …/ai/v2/answer`** — **chosen.** Reuses the existing auth and session guards
  verbatim, is trivially scoped to the answering user, and adds one route. The demo needed a
  socket because it had no other authenticated channel; we already have one.

### D6a — Preview format and question timeout (found during fact-check, 2026-07-21)

Two `AskUserQuestion` surfaces the first draft did not account for, read from `sdk.d.ts` v0.3.216:

- **`toolConfig.askUserQuestion.previewFormat` defaults to `'markdown'`**, with `'html'` as the
  opt-in the demo takes. Because catalog previews here render through **React components** (D3),
  we do not need model-authored HTML for the common path — so we **stay on the `'markdown'`
  default** and never opt into HTML. This removes the sanitization question entirely for catalog
  previews; the sandboxed iframe (D1) remains the only place model markup renders at all.
- **`askUserQuestionTimeout`** (`'60s' | '5m' | '10m' | 'never'`, default `'never'`) auto-continues
  with whatever answers are selected after an idle period. The spec requires that an unanswered
  question not hold a turn open; this is a *native* mechanism for that, complementing — not
  replacing — the server-side abandonment path in D7, which must still exist because the client
  can vanish without the agent noticing.

**Caveat carried to the spike:** the demo runs SDK **v0.2.72**; the version inspected here is
**v0.3.216**. `toolConfig` exists in both, but no `AskUserQuestion` type, constant, or tool-name
literal appears anywhere in either `sdk.d.ts` — it is a CLI-side built-in, not an SDK-typed
symbol. **Whether it survives `tools: []` is therefore unverified and potentially fatal to this
design** (task 0.4). If `tools: []` strips it, the options are to name it in `tools` explicitly or
to abandon the interactive-question shape.

### D7 — `canUseTool` round trip, hardened

The demo's mechanic, adapted for a multi-user server:

| Demo (localhost, single user) | Here |
| --- | --- |
| one global `pending` map keyed by bare request id | keyed by `(sessionId, turnId, requestId)` and scoped to the turn |
| no auth on the answer | answer route runs the full guard chain; a request id from another session or turn is rejected |
| rejects pending promises on socket close | **mandatory**, not optional — see below |
| `ToolSearch`/`ExitPlanMode` passed through | same, but as a **named** allowance, never a wildcard |

The disconnect rejection is load-bearing, not hygiene: a parked promise with no answerer holds the
turn's concurrency slot open, which is the predecessor's D7 slot-leak hazard. The registry has no
TTL and no reaper, and `restart_supported` is `false` on this deployment, so a leaked slot wedges
that session until the process restarts.

### D8 — Security lockdown (inherited, still an unverified hypothesis)

Carried forward from the superseded change, including the four corrections its panel forced:
`tools: []` is the built-in denial (**`allowedTools` is auto-approve and does not restrict**);
`maxBudgetUsd` exists and enforces; `strictMcpConfig: true` suppresses the repo's checked-in
`.mcp.json`; `cwd` defaults to `process.cwd()` — the repo checkout containing `server/.env` — and
must be pinned elsewhere. Plus isolated `CLAUDE_CONFIG_DIR`, `disableClaudeAiConnectors` via
`managedSettings`, and subprocess env scrub.

`allowedTools` additionally carries **`AskUserQuestion`** here, which the predecessor did not need.

**Still unverified on the SDK path**, and blocking: whether `settingSources: []` suppresses the
operator's real `UserPromptSubmit` shell hook; whether the project-tier hook hole (below) is
closed by the pinned `cwd`; and **whether any process survives an abort** — `interrupt()` is
streaming-input-only and `abortController` kills one pid, not a group.

**The operator's verified finding that must not be re-lost:** SDK sessions always run
non-interactively, and **trust verification is skipped entirely in that mode** — so a
`.claude/settings.json` in the session's `cwd` executes hook commands with **zero prompt**, and
`CLAUDE_CONFIG_DIR` isolation does not help because the file lives in `cwd`. The pinned `cwd` is
what addresses this.

### D9 — Auth: scoped key preferred, login fallback loopback-only

Owner ruling: use `claude login` when the operator has the CLI installed. Guardrail retained: a
configured workspace-scoped key wins when present, the login fallback is confined to a loopback
bind, and the fallback is logged loudly at startup. Anthropic does not permit third-party
applications to offer claude.ai login, and this repo is described as portable — a packaged copy
silently billing the packager's personal subscription is a policy problem, not just an ops
surprise.

## Risks / Trade-offs

- **The catalog will feel limiting before it feels safe.** The first "can it just…" request that
  the catalog cannot express will push toward the iframe, and the iframe is the most complex part
  of the change (data passing, sizing, styling isolation). Accepted: the alternative is
  model-authored markup in the authenticated origin.
- **Aggregate tools constrain what the agent can notice.** Designing against summaries means the
  agent cannot spot something only visible in raw rows. Accepted — the predecessor's panel showed
  raw-row access is a context-window failure mode, and `transcript_excerpt` remains for detail.
- **Two agents, two transports.** The topics chat stays on the CLI; this runs on the SDK. Same
  cost the predecessor booked, unchanged.
- **SDK version drift on a 0.x dependency whose option semantics are the security boundary.** Pin
  exactly; the closed-world characterization test is the tripwire — but a tripwire reports after
  the fact.
- **Prompt injection reaches further than in the topics chat.** Transcript content is untrusted
  and now influences *what gets built*. Containment rests on the catalog being closed and the
  iframe being sandboxed — not on the model behaving.
- **A dashboard is a durable artifact.** Unlike a chat reply, a bad or malicious design persists
  and re-renders. Validation on write (unknown widget type rejected) is what keeps a stored
  dashboard from being a stored exploit.

## Open Questions

- **D5** — session DB vs. catalog DB for saved dashboards. Recommendation recorded; gate decides.
- Whether custom widgets need any script execution at all in v1, or whether `sandbox` with no
  `allow-scripts` (static markup only) is sufficient. The stricter option ships first if viable.

## Inherited findings (from the superseded `ai-session-analyst`)

Carried forward as **verified input**, not re-derived. Each was expensive to learn:

- **`allowedTools` does not restrict** — it is auto-approve (*"To restrict which tools are
  available, use the `tools` option instead"*). `tools: []` is the built-in denial. The
  predecessor's first draft got this backwards, leaving shell and filesystem built-ins live in a
  nominally locked-down agent.
- **`maxBudgetUsd` exists and enforces** — the predecessor's draft claimed no equivalent and
  rationalized a weaker bound.
- **`strictMcpConfig: true` is required** — it suppresses project `.mcp.json`, and this repo has
  one checked in (CodeGraph, commit `591ac17`) that would otherwise load into the agent.
- **`cwd` defaults to `process.cwd()`** — the repo checkout, which contains `server/.env`.
- **Trust verification is skipped for non-interactive sessions** (operator-verified, live test):
  a project-tier `.claude/settings.json` in `cwd` executes hooks with **zero prompt**, and
  `CLAUDE_CONFIG_DIR` isolation does not cover it because the file lives in `cwd`.
- **Lifecycle is unresolved** — `interrupt()` is streaming-input-only; `abortController` kills one
  pid, not a process group; the SDK exposes no pid.
- **Test-infra debt** — `vi.mock('node:child_process')` is vacuous through the shared `app`
  singleton.

## Panel & review log

### 2026-07-21 — Pre-panel fact-check (light-tier, mechanical fetch-and-compare)

**CONFIRMED (mechanically checkable):**
- `session_transcript_words` stores `speaker`, `word`, `start_sec`, `end_sec`, `ordinal`,
  `session_time` — read from `server/src/session/sessionCore.ts` and the `TranscriptWord` shape in
  `transcriptStore.ts`. Talk-time, utterance/question/filler counts, and duration are therefore
  computable (D2).
- `SessionHub.listTranscriptWords`, `listTopics`, and `listEvents` are **synchronous** reads (no
  `inTxn` wrapper, unlike the mutating siblings) — so aggregation in the tool layer preserves the
  synchronous-hub invariant (D4).
- **Sentiment is requested but never persisted**: `server/src/node/deepgram.ts` sets
  `sentiment=true` (commit `7f47b31`), and grep over `server/src/session/` returns **nothing**.
  D2's exclusion rests on this.
- The reference dashboard's data model (`bySpeaker`, `durationSec`, `fillerCounts`,
  `questionCount`, `utteranceCount`, `sentimentSeries`, `sentimentAvg`, `topics`, `summaryShort`,
  `speakers`) — extracted from the bundle's own string table, not guessed.
- `ai-topics-chat` D2's WS rationale (fan-out broadcasts to every attached client; emission
  semantics frozen) — read from the archived design. D6 rests on it.
- `AiChatTurnRegistry` is transport-agnostic (`tryAcquire`/`release`) and reusable unchanged.

**CORRECTED in the draft:**
- The reference dashboard was initially assumed to be hand-authored HTML. It is a **604KB built
  Preact SPA** mounting into `<div id="app">`; there is no hand-written markup to model on. This
  strengthened D1/D3 (catalog + real-component previews) rather than weakening them.

**LEFT UNVERIFIED (judgment-laden — for the panel):**
- Whether a catalog + one iframe escape hatch is the right flexibility/safety split (D1).
- Whether aggregate-only tools leave the agent enough to design well (D4).
- Whether session-DB or catalog-DB persistence is right (D5, open).
- **The entire lockdown option set (D8) remains an unverified hypothesis on the SDK path** — the
  predecessor was superseded before its spike ran. Phase 0 is blocking for exactly this reason.
- Whether `AskUserQuestion` fires under our option set at all (the demo's differs materially).

### 2026-07-21 — Adversarial panel (four skeptical mandates) + gate

*(pending)*

### 2026-07-21 — Post-gate consistency read (light-tier)

*(pending)*
