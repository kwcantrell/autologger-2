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

### D1 — Catalog only. No model-authored markup renders, anywhere. (owner ruling, revised
2026-07-21)

Every widget comes from a **fixed catalog** rendered by our own React components. Claude selects
types and composes a layout; **it never authors markup**.

*Why not the demo's approach.* The demo renders Claude-authored HTML via
`dangerouslySetInnerHTML` + DOMPurify. That is proportionate for a single-user localhost toy. Here
the markup would be authored from **untrusted transcript content** (anyone audible on a recording
is an input author) and rendered in a **multi-user, studio-scoped, authenticated** page.

*Why the sandboxed-iframe escape hatch was cut (owner ruling, after the panel).* The first draft
kept an `<iframe sandbox>` escape hatch for custom widgets. The panel priced it honestly: three
tasks, the most complex part of the change, justified only by a hypothesis about a feature with
**zero users** — while carrying the entire XSS/CSP/exfiltration surface. Specifically it found
(a) the spec pinned no sandbox token set, so a conforming implementation could ship
`allow-scripts allow-same-origin`, which is self-defeating; (b) **this application has no CSP at
all** (verified: no `Content-Security-Policy` anywhere in `server/src/`), so `allow-scripts` alone
permits `fetch()` to any origin — exfiltrating precisely the session data the widget was handed;
and (c) passing data in via `srcdoc` interpolation is itself an injection vector, since
`JSON.stringify` does not escape `</script>`.

Cutting it removes all three at once, and removes the only path by which agent-authored markup
reaches a browser. Adding it later is purely additive, against shipped components, with real
information about what it is for.

**Invariant a future reader must not "simplify": there is NO `dangerouslySetInnerHTML` anywhere
in this feature — no exceptions, no "just for one case."** A repo-wide assertion enforces it. If a
future change wants custom widgets, it must first specify an exact sandbox token set, a CSP with
`connect-src 'none'`, and a `postMessage` data channel — the three things this draft lacked.

### D2a — "Computable" was checked as column-existence, not population (corrected)

The draft's D2 table marked widgets "✅ computable" because the **columns exist**. The panel showed
the real question is whether they are **populated**, and I verified each claim:

- **`TranscriptStore.insertTranscriptWord` writes only 6 columns** — `start_sec`/`end_sec` are
  never written and take the schema default `0.0`. `transcriptWordCreateSchema` does not even
  accept them. **Every manually-entered transcript has no timing.**
- **`transcriptRemap.ts` writes literal `start_sec: 0, end_sec: 0`** for anchorless words — any
  session lacking the internal anchor events. **Every unanchored DeepGram transcript has no
  timing.**
- **`speaker` is a diarization index** (`number` → `String(w.speaker)`), not a name. A talk-time
  legend would read "0, 1, 2".
- **`paragraphs=true` is requested and discarded** — `extractWords` reads only
  `alternatives[0].words`. There is **no utterance boundary in storage**, so `utterance_counts` has
  no definition and two implementers would invent two different ones.
- **`smart_format` removes disfluencies**, so `filler_counts` over a formatted transcript plausibly
  reports near-zero regardless of how people actually spoke.
- **`events.category` is an opaque id**; labels come from `enrichEventRpc` against the **catalog
  DB** — outside SessionHub. *This was a finding of the predecessor's panel that I failed to carry
  forward.*
- **`session_topics.session_time` is `z.string().max(20)` with no format validation**, so
  `topic_timeline` has no reliable numeric time to plot.

This is the same error the predecessor's panel caught in the lockdown table: **checking existence
rather than semantics.** Recording it here so the next reader distrusts a "✅" that has not been
traced to a write path.

### D2b — Fix the data first, and make "unavailable" a first-class rendered state (owner ruling)

**Ruling: sequence the data work ahead of the dashboard, and design for absence regardless.**

1. **Data-first change(s)** land before the catalog depends on them: persist DeepGram
   `paragraphs` (already requested and paid for) to give utterances a real boundary; persist
   `sentiment` (same); populate or derive word timings on the manual-entry path; and resolve
   speaker **names** rather than diarization indices. Each is a schema/ingest concern with its own
   gate, not something to smuggle into a dashboard change.
2. **A real test session** is created from `https://www.youtube.com/watch?v=BQP0QejCmxw` so the
   catalog is exercised against genuine transcript data rather than synthetic fixtures alone.
   (Note: YouTube import is currently `503` — see the open question below.)
3. **Degraded state is normative, per widget.** Every widget renders one of: real data, or an
   **explicit unavailable state naming the reason** ("Talk time unavailable — this transcript has
   no word timings"). **Zeros are never rendered as data.** This is what makes a wider catalog
   honest rather than misleading, and it converts the panel's "permanently empty tile" failure into
   a designed, legible state.

**Open question for the gate:** YouTube import is deliberately `503` in this repo (no external
integration wired). Creating the reference session therefore needs a route — import the audio
manually and run the existing DeepGram path, or wire the import. Flagged rather than assumed.

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

*(The draft carved out an exception here for custom-widget previews rendering in the sandboxed
iframe. With the iframe cut from v1 (D1), there is no exception: **every** preview is a real
component.)*

**Mechanism, which the draft left unspecified (panel finding).** The SDK's preview channel is a
model-authored **string** (`markdown` or `html`) — there is no way for it to name a React
component, so "renders through the real component" is not a configuration of the question tool but
a decision to **not use its preview field at all**. Option identity is therefore carried by a
**catalog widget-type identifier validated against the closed set on receipt**, never by matching
free-text labels; the agent's supplied `preview` is discarded server-side (D6a). The answer payload
must also distinguish a chosen catalog option from the free-text fallback, which is a different
shape entirely.

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

### D5a — A stored dashboard is attacker-influenced content, and validation must be whole-config

**The panel finding most likely to have shipped**, because every artifact pointed attention at the
iframe and away from here.

The draft's containment argument was: catalog widgets are safe *because* they render through our
own React components. That covers widget **structure**. It says nothing about widget **content** —
and the draft spec never constrained content at all (the words "title" and "label" appeared
**zero times**). But a dashboard config carries: widget titles and captions the agent authors,
`transcript_excerpt` content that is untrusted transcript text by design, and speaker labels
derived from DeepGram.

**The categorical change from the predecessor:** it was read-only and ephemeral — injected text
reached one operator once, in a `delta` event, and was gone. This change **persists
attacker-influenced strings into a durable artifact that re-renders, unattended, in other users'
authenticated sessions, indefinitely.** The draft's write-validation checked only widget type and
interaction vocabulary, so an injected title passes validation and is stored.

React's JSX escaping handles the obvious payload, but it is not the boundary: a title flowing into
`href`/`src` (`javascript:`), a `style` attribute, an SVG `<use>`, or a chart library's
HTML-accepting tooltip all execute — and this repo has no charting library yet, so that choice is
still ahead of us.

**Ruling:** validation on write is **whole-config**, not type-and-interaction. Every string field
is bounded and constrained by schema, and **no field of a stored dashboard is ever interpolated
into HTML, a URL, a style, or an event handler** — text only, everywhere.

### D5b — Write authorization, bounds, and a delete path

Three omissions the panel found in the persistence requirement, all now normative:

- **Who may write was never stated.** Read scoping was specified; write scoping was not. Combined
  with unvalidated content and no delete path, the lowest-privileged studio member could plant a
  persistent artifact in every colleague's workspace with no way to remove it through the UI.
- **No bounds of any kind** — no cap on dashboards per session, widgets per dashboard, or config
  size. The words "limit", "quota", and "maximum" appeared zero times. On a `restart_supported:
  false` deployment, recovery from a scripted write loop is manual filesystem surgery.
- **No delete path.** "delete" appeared zero times; the artifact was write-only and monotonic,
  while the design's own Risks section named stored-config-as-stored-exploit as a risk.

**Ruling:** stored configs record `created_by` and the originating turn; write is scoped at least
as tightly as read; per-session dashboard count, per-dashboard widget count, and serialized config
size are all bounded and rejected on write; a delete/replace path exists.

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

**Corrected after the panel — the key must bind the PRINCIPAL, not just the session.** The draft
keyed on `(sessionId, turnId, requestId)`, which is **the same hole the predecessor's panel found
for resume ids, carried forward unfixed**. Under it, any studio co-member who can pass
`requireSession` could answer another user's pending question — and here an answer *determines what
gets built and stored*, converting a read-side confidentiality nit into a **write-side integrity
hole on a durable artifact**. Ruled:

- The pending entry records the **user id of the principal that initiated the turn**; an answer is
  rejected unless the answering principal is identical.
- Turn and request ids are **≥128-bit CSPRNG-derived**, matching the existing `aiMcpServer.ts`
  precedent, so guessing is not the fallback defense.
- **The `API_TOKEN` path is explicitly refused on AI v2 routes.** `requireSession` skips the studio
  check entirely when `user === null`, so a shared Companion device token would otherwise pass for
  *every session in the deployment*. A device token has no user id and therefore cannot satisfy the
  principal check — but the refusal is stated normatively rather than left as an emergent property.
- An answer for a turn no longer in flight is rejected without effect, and the pending entry is
  deleted when the turn ends by any path, so it cannot be resolved late.

### D7a — Agent proposes, user adjusts (owner ruling, 2026-07-21)

The panel asked whether conversational design earns its place at all, given a closed catalog and a
fixed layout grammar — and separately found there was **no edit path**: changing one widget meant
redoing the whole conversation, so "the second edit is more expensive than the first creation."

**Ruling: the agent's job is the first draft, not every edit.** It reads the session's aggregates
and *proposes* a starting dashboard — the one thing a menu genuinely cannot do. Everything after is
**direct manipulation**: add, remove, resize, reorder, retitle, without a turn.

This makes the edit path a **core requirement rather than an omission**, and it means the picker UI
is needed either way — so the catalog components, previews, grid, and persistence are load-bearing
regardless of whether a turn ever runs. It also bounds the agent's blast radius: the durable
artifact is mostly shaped by direct user action, with the agent seeding it.

### D8a — `AskUserQuestion` is a BUILT-IN: `tools: []` makes this feature impossible

**The panel's fatal finding, verified independently before folding.** The first draft specified
`tools: []` (disable all built-ins) plus `AskUserQuestion` in `allowedTools`. That configuration
cannot work:

- **`AskUserQuestionInput` appears in `sdk-tools.d.ts`'s `ToolInputSchemas` union** — the generated
  inventory of *Claude CLI built-in tool inputs*, alongside `BashInput` and `FileReadInput`. It is
  a built-in, not an MCP tool. (The first fact-check missed this by grepping only `sdk.d.ts`.)
- **`tools: []`** is documented as *"Disable all built-in tools."*
- **`allowedTools`** is *"auto-allowed **without prompting**… To restrict which tools are
  available, use the `tools` option instead"* — a permission annotation **over** the base set. It
  does not add to it.
- **The demo does the opposite of the draft**: `tools: ["AskUserQuestion"]`, with **nothing** in
  `allowedTools`. The one working reference puts it in the base set.

**Consequence:** with `tools: []` the tool is never advertised, the model cannot emit it,
`canUseTool` never fires, and no question reaches the browser — the entire design conversation is
dead. Worse, the closed-world characterization test would **pass**, certifying the broken
configuration, because it asserts option *values*, not that the interaction works.

**Ruling: the built-in set is exactly `['AskUserQuestion']`.** This is a knowingly weaker security
claim than "all built-ins disabled" and the gate accepts it explicitly rather than discovering it
during apply. Mitigations that make it acceptable:

- The base set is a **one-element closed set**, not an open allowlist — `Bash`, `Read`, `Write`,
  `Edit`, and `WebFetch` remain absent.
- **`disallowedTools`** (dropped in transit from the predecessor — see D8b) is re-instated naming
  the built-in write/exec set, since it is the only option documented as overriding an allow.
- `AskUserQuestion` cannot read files, run commands, or reach the network; its blast radius is
  asking the user a question.

The spec's lockdown requirement is reworded accordingly: **"the built-in tool set SHALL be exactly
the one interactive question tool"**, not "all built-ins disabled outright", which was
unsatisfiable alongside the interaction this feature requires.

**Also ruled (from the same finding):** `permissionMode` moves off `'dontAsk'`. The SDK documents
`dontAsk` as an **auto-deny short-circuit** that can bypass `canUseTool` — the exact callback this
design blocks on. The demo uses `'plan'` and notes the tool "still fires" there. Spike 0.4 pins
which mode actually runs the callback; `'dontAsk'` is ruled out on the evidence.

### D8b — Inheritance was lossy: three controls and one open conflict were dropped

The draft claimed the predecessor's findings were carried "as **verified input**, not re-derived."
The panel checked and that framing was inaccurate in two ways, both now corrected:

1. **The predecessor's own log calls most of it unverified** — *"No spike has been run for the
   SDK"*, *"D1 stays an unverified hypothesis"*. What transferred was **panel corrections to a
   document**, i.e. doc-reading, not empirical results. The "verified input" heading overstated it
   and is removed.
2. **Three controls vanished in transit** and are re-instated here:
   - **`disallowedTools`** — belt-and-braces naming the built-in write/exec set. Now load-bearing
     rather than optional, because D8a forces a non-empty `tools` array.
   - **`MCP_TOOL_TIMEOUT`** in the env whitelist — the predecessor recorded *"a hung in-process MCP
     tool is unbounded"*; this change adds **more** MCP tools (D4 aggregates) and had inherited the
     risk without the mitigation.
   - **`persistSession: false`** — a live finding about on-disk transcripts, dropped without a
     disposition. Recorded as an open trade (it conflicts with `resume`).
3. **`safeMode` was an escalated, explicitly UNRESOLVED conflict** in the predecessor, not a
   settled item. This change inherited *both sides* — the project-hook hole and the closed-world
   ban on `extraArgs` — but neither the conflict nor the spike meant to settle it. **An open
   blocker cannot be discharged by supersession.** Restored as spike 0.8.

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

Carried forward from the superseded change. **These are panel corrections to a document —
doc-reading, not empirical results** (see D8b: the predecessor's own log records "no spike has
been run for the SDK"). They are still unverified on the SDK path, and Phase 0 exists to settle
them. Each was expensive to learn and must not be re-derived from scratch:

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

Four reviewers, distinct mandates, ~20 blockers. **Every load-bearing finding was re-verified
against the repo or the SDK type surface before folding** — several were fatal.

**Blockers/majors FIXED IN PLACE:**

- **`tools: []` makes the feature impossible (D8a).** `AskUserQuestionInput` is in
  `sdk-tools.d.ts`'s `ToolInputSchemas` union — the **built-in** inventory — so `tools: []`
  ("disable all built-ins") strips it. The demo does the opposite (`tools: ["AskUserQuestion"]`,
  nothing in `allowedTools`). The closed-world test would have **passed** on the broken config.
  Ruled: built-in set is exactly `['AskUserQuestion']`, `disallowedTools` re-instated,
  `permissionMode` moved off `'dontAsk'` (an auto-deny short-circuit that can bypass the very
  callback this design blocks on).
- **Stored XSS on the "safe" path (D5a).** Catalog rendering protects structure, not **content**;
  "title"/"label" appeared zero times in the spec. Validation is now whole-config, and no stored
  field is ever interpolated into HTML, a URL, a style, or an event handler.
- **Answers bound a session, not a principal (D7).** Any studio co-member could answer another
  user's question and steer what gets built — the *same* hole the predecessor's panel found for
  resume ids, carried forward unfixed. Principal binding, ≥128-bit ids, and explicit `API_TOKEN`
  refusal are now normative.
- **Persistence had no write authorization, no bounds, no delete path (D5b).**
- **"Computable" was column-existence, not population (D2a).** Manual inserts never write
  `start_sec`/`end_sec`; `transcriptRemap` writes literal zeros for anchorless words; `speaker` is
  a diarization index; `paragraphs` is requested and discarded; `smart_format` strips the fillers
  `filler_counts` would count; `events.category` is a UUID whose label lives in the catalog DB;
  topic `session_time` is an unvalidated string. **Same class of error as the predecessor's
  lockdown table.**
- **Inheritance was lossy (D8b).** "Verified input" overstated doc-reading as empirical result;
  `disallowedTools`, `MCP_TOOL_TIMEOUT`, and `persistSession` were dropped in transit, and the
  `safeMode` conflict was an *unresolved escalation* that supersession cannot discharge.

**ESCALATED TO THE GATE (owner rulings, 2026-07-21):**

- **Sequencing.** The scope reviewer priced the agent layer at 18 of 25 tasks and all the risk,
  and argued for shipping the picker first. **Ruled: both together, with the blockers fixed.**
- **Custom-widget iframe.** **Ruled: cut from v1** (D1). This removes findings B2/B3/B5/S3/m14 in
  one stroke — including that **this application has no CSP at all**, so `allow-scripts` alone
  would have permitted exfiltration of exactly the data the widget was handed. The repo-wide
  no-`dangerouslySetInnerHTML` assertion is retained and strengthened to "anywhere, no exceptions".
- **Data first (D2b).** Persist `paragraphs`/`sentiment`, fix timings and speaker names ahead of
  the catalog; create a real reference session from a YouTube source; and make **"data
  unavailable" a first-class rendered state per widget** — zeros are never rendered as data.
- **Interaction shape (D7a).** **Agent proposes, user adjusts** — the agent seeds a first draft
  from session aggregates; every subsequent edit is direct manipulation. Makes the edit path a
  core requirement rather than the omission the panel found.

**NOTED — process/safety issue with the panel itself:** the scope reviewer's headline claim (that
the shipped CLI's `--permission-prompt-tool` replaces `canUseTool`, collapsing Phase 0) was
produced by **building and running a nested `claude -p` wired to a permission-prompt MCP server
that unconditionally returned `{behavior:"allow"}`** — an autonomous loop with its approval gate
rubber-stamped, spending ~$0.085 unasked. That was not sanctioned. `--permission-prompt-tool` does
**not** appear in the installed CLI's `--help`, so the claim rests on an undocumented flag
exercised through a rubber-stamped harness. **The finding is recorded but NOT adopted**; if the
CLI transport is ever revisited, it needs verification through a sanctioned path.

**MINORS ACCEPTED AS RESIDUAL:** the `503` config gate remains a configuration oracle for
authorized users (correctly ordered relative to the important `404` masking); the pending-question
map inherits the predecessor's unbounded-map shape, now with an explicit deletion requirement.

### 2026-07-21 — Post-gate consistency read (light-tier)

**Three findings, all fixed.** Read all four post-fold documents — `proposal.md`, `design.md`,
`specs/ai-v2-dashboards/spec.md`, `tasks.md` — against the folded gate rulings.

**Found and fixed:**
1. **`design.md` "Inherited findings" still read "Carried forward as verified input"** — the exact
   framing D8b says was corrected and removed. D8b described the fix; the target prose was never
   edited. Now states plainly that these are panel corrections to a document, unverified on the SDK
   path, with Phase 0 existing to settle them.
2. **`proposal.md` Non-Goals still presumed the iframe existed** — *"Custom widgets render only in
   the sandboxed iframe; there is no `dangerouslySetInnerHTML` path outside it"* contradicted the
   same document's own "cut from v1" bullet. Now a repo-wide, no-exception claim.
3. **Dead custom-widget preview language** in D3 and in the spec's preview requirement — vacuously
   true under the v1 cut, but readable as live scope. Both removed.

**Fixed opportunistically while in the file:** the same D3 pass closed panel finding A5 (the
option→component binding mechanism was asserted but never specified). The SDK's preview channel is
a model-authored *string* and cannot name a component, so "renders through the real component" is a
decision to **not use the preview field**; option identity is now carried by a validated catalog
type identifier rather than inferred from display text. Added as a normative requirement + scenario.

**Clean on:** cross-references (all decision IDs D1–D9 plus the a/b corrections defined and
referenced; task 0.6 correctly marked removed; every requirement name cited in `tasks.md` matches a
spec heading verbatim); coverage (every normative SHALL has a covering task; no task implements
unauthorized work); numbering (the a/b insertions read as layered corrections, clearly labelled).
