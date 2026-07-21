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

### D5 — Dashboard persistence — RULED: session DB (apply-time owner ruling, 2026-07-21)

A saved dashboard is validated JSON. Where it lives was a real fork:

- **(a) Session DB** (`DATA_DIR/sessions/<id>.db`) — travels with the session, deleted with it,
  matches the "one session's data per dashboard" scope. Cannot be reused across sessions.
- **(b) Catalog DB** — reusable as a template across sessions, survives session deletion, but
  needs its own scoping story against studios/teams and outlives the data it describes.

**Ruled (a) Session DB for v1** (owner, 2026-07-21, at the Phase 5 check-in): it matches the stated
"one session's data per dashboard" scope, is deleted with the session, and fits the
`DashboardPersistencePort`'s `load(sessionId)`/`save(sessionId, config)` shape that Phase 4 already
built. A "save as template" feature can add (b) later as a purely additive change. Session DBs have no
migration files — the new table is an idempotent `CREATE TABLE IF NOT EXISTS` in `sessionCore.ts`'s
`initSchema`, mirroring how the enrichment tables were added.

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

### D6a — Preview format and question timeout (found during fact-check, 2026-07-21; confirmed by spike 0.4)

Two `AskUserQuestion` surfaces the first draft did not account for, read from `sdk.d.ts` v0.3.216:

- **`toolConfig.askUserQuestion.previewFormat` defaults to `'markdown'`**, with `'html'` as the
  opt-in the demo takes. Because catalog previews here render through **React components** (D3),
  we do not need model-authored HTML for the common path — so we **stay on the `'markdown'`
  default** and never opt into HTML. Spike 0.4 pinned `previewFormat: 'markdown'` in every live
  turn and never opted into `'html'`. The sandboxed iframe was cut in D1 anyway, so model markup
  has no render path left at all.
- **`askUserQuestionTimeout`** (`'60s' | '5m' | '10m' | 'never'`, default `'never'`) auto-continues
  with whatever answers are selected after an idle period. **Correction (task 0.4):** this is a
  field of the **`Settings`** interface (`sdk.d.ts:4897`), not of `toolConfig.askUserQuestion` —
  the two live on different option surfaces despite reading like one mechanism in the original
  draft. It must be set via the top-level **`settings`** option; it does **not** survive
  `managedSettings`' restrictive-only filter (confirmed twice, independently, by 0.4's and 0.8's
  `resolveSettings()` checks — the same call that lets `disableClaudeAiConnectors` through drops
  `askUserQuestionTimeout`). Whether the `settings`-tier value is honored at runtime was not
  independently spawned (would need a turn idling ≥60s, out of spend scope). The spec still
  requires that an unanswered question not hold a turn open, so the server-side abandonment path
  in D7 remains the load-bearing backstop regardless — this is a native complement to it, not a
  replacement, whether or not the client-side timeout is later verified live.

**Resolved by spike 0.4 (was: unverified and potentially fatal to this design).**
`AskUserQuestion` is a CLI-side built-in, not an SDK-typed symbol — no type, constant, or
tool-name literal for it appears in `sdk.d.ts` in either the demo's v0.2.72 or the pinned
v0.3.216. Task 0.4 exercised the interaction live: `tools: []` strips it entirely (the model
cannot even emit a real `tool_use` block for it — see D8a), while `tools: ['AskUserQuestion']`
advertises it, fires it, and completes the round trip end to end. See "Resolved by the spike"
above and D8a below for the full result.

### D7 — `canUseTool` round trip, hardened

The demo's mechanic, adapted for a multi-user server:

| Demo (localhost, single user) | Here |
| --- | --- |
| one global `pending` map keyed by bare request id | keyed by `(sessionId, turnId, requestId)` and scoped to the turn |
| no auth on the answer | answer route runs the full guard chain; a request id from another session or turn is rejected |
| rejects pending promises on socket close | **mandatory**, not optional — see below |
| `ToolSearch`/`ExitPlanMode` passed through | same, but as a **named** allowance, never a wildcard |

**Confirmed live (spikes 0.2, 0.4).** The full round trip — `AskUserQuestion` advertised, a real
`tool_use` block, `canUseTool` invoked, a programmatic answer unblocking the turn — was exercised
end to end three times under this design's option set (task 0.4), and `canUseTool` was separately
confirmed to fire and gate for every advertised tool (the MCP aggregate tool and
`AskUserQuestion`), while refusing unadvertised tools by absence rather than by a denial that ever
reaches it (task 0.2). D8's layering is enforcement, not observability-only. **Correction:** in
the minimal two-tool turns spiked, `ToolSearch`/`ExitPlanMode` did not request `canUseTool`
passage at all — the named-passthrough branch stays in the implementation defensively, but no
turn shape in Phase 0 required it for a successful result; the closed-world test (task 2.3) should
assert `canUseTool` fires for exactly the tool set actually exercised, not hard-code these two as
always-present.

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

**The panel's fatal finding, verified independently before folding — and spike-confirmed live**
(task 0.4): `tools: []` produced zero `AskUserQuestion` advertisement in `system/init` and the
model could not even emit a syntactically real `tool_use` block for it (it emitted inert text
that only *mimics* a function call), while `tools: ['AskUserQuestion']` advertised, fired, and
completed the round trip end to end. The first draft specified `tools: []` (disable all
built-ins) plus `AskUserQuestion` in `allowedTools`. That configuration cannot work:

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
design blocks on. The demo uses `'plan'` and notes the tool "still fires" there. **Confirmed live
by spike 0.4:** `permissionMode: 'dontAsk'` auto-denied before `canUseTool` ever ran, for every
tool tried — not only `AskUserQuestion` — so it is ruled out on live evidence, not only
documentation. `'plan'` is the mode the spike found that both advertises the tool and routes
through `canUseTool`.

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

**`tools`** additionally carries **`AskUserQuestion`** here (D8a), which the predecessor did not
need — an interactive question tool has no analogue in a read-only session analyst. (Corrected:
the first draft's `allowedTools`-based framing was itself the fatal misconfiguration D8a found;
`allowedTools` never restricts, so the built-in is carried in `tools`, not there.)

**Resolved by Phase 0 spikes (0.3, 0.5) — see "Resolved by the spike" above for full evidence:**
`settingSources: []` suppresses the operator's real `UserPromptSubmit` shell hook (task 0.3a,
control-armed); the project-tier hook hole (below) is closed by `settingSources: []` itself, not
by the pinned `cwd` as originally framed (task 0.3b, including a hostile-`cwd` control arm); and
no-orphan on abort is achievable, but **not** via the SDK's default `abortController` alone — it
requires an implementer-owned process-group kill ladder wired through `spawnClaudeCodeProcess`,
mirroring `killAiChatProcessGroup` (task 0.5). `interrupt()` remains unused by this design
regardless of its runtime behavior (task 0.5 found it resolves rather than throws against a
string prompt, contra a naive docstring reading — moot, since the design never calls it).

**The operator's verified finding that must not be re-lost:** SDK sessions always run
non-interactively, and **trust verification is skipped entirely in that mode** — so a
`.claude/settings.json` in the session's `cwd` executes hook commands with **zero prompt**, and
`CLAUDE_CONFIG_DIR` isolation does not help because the file lives in `cwd`. **Corrected (task
0.3b, control arm 3):** `settingSources: []` alone closes this hole, confirmed live even against a
planted hostile `cwd` — the pinned `cwd` remains valuable defense-in-depth (and is still the fix
for the separate `server/.env`-exposure concern this section opened with) but is not itself what
suppresses the hook.

**Pinned SDK: `@anthropic-ai/claude-agent-sdk@0.3.216`** (task 0.1, 2026-07-21): docstrings for
tools/allowedTools/strictMcpConfig/maxBudgetUsd/cwd/managedSettings verified against the pinned
copy — match D8 as written. Also confirmed: `AskUserQuestionInput` is present in
`sdk-tools.d.ts`'s `ToolInputSchemas` union at this version (same version the D8a finding was
verified on; no drift), and `disableClaudeAiConnectors?: boolean` exists on the `Settings`
interface that `managedSettings` accepts. Install note (not a docstring finding): the package
declares a peer dependency on `zod@^4.0.0` across every published `0.2.x`/`0.3.x` version checked,
which conflicts with this repo's `zod@^3.24.1`; installed with `--legacy-peer-deps` to get an
exact pin without forcing a zod major bump. No nested/duplicate `zod` was created — one `zod@3.x`
remains at the top level, so whether the SDK's own runtime code requires `zod@4` behavior at
call time (as opposed to only at `npm install` peer-resolution time) is unverified and is a
candidate concern for task 2.4 (in-process MCP tools) or a follow-up spike.

**Resolved by spike 0.4:** `zod@3.25.76` schemas work correctly against the pinned SDK's
`createSdkMcpServer`/`tool()` at call time — confirmed live in the Arm B turn, where the model
called an MCP tool built from a repo-style zod@3 raw-shape schema and got back the expected
result. The peer-dependency mismatch is peer-resolution-time only, not a runtime interop problem;
task 2.4 should not re-litigate it.

### D9 — Auth: scoped key preferred, login fallback loopback-only

Owner ruling: use `claude login` when the operator has the CLI installed. Guardrail retained: a
configured workspace-scoped key wins when present, the login fallback is confined to a loopback
bind, and the fallback is logged loudly at startup. Anthropic does not permit third-party
applications to offer claude.ai login, and this repo is described as portable — a packaged copy
silently billing the packager's personal subscription is a policy problem, not just an ops
surprise.

### D10 — The design turn commits its proposal through a `propose_dashboard` MCP tool (apply-time owner ruling, 2026-07-21)

The gated artifacts said a design turn "produces a **starting** dashboard" (D7a) but never specified
**how** a turn yields a concrete `DashboardConfig`. The Phase 4 review surfaced the gap: the design
turn's `done` event carried `{}`, and nothing assembled a completed turn into a renderable config, so
the feature's core loop — *agent proposes a dashboard* — produced nothing, and the Phase 6 e2e
("a dashboard rendered") had no path to pass. Owner ruling on the mechanism:

The agent reads the session aggregates (D4 tools), asks the user catalog-widget questions with real
previews (D7 round trip), then **calls an in-process `propose_dashboard` MCP tool** with the assembled
`DashboardConfig`. That tool is the single commit point:

- **It validates the WHOLE config against the Phase-1 catalog/layout schema at the tool boundary** —
  this is D5a's whole-config validation applied at the *proposal* entry point, not only at the user
  write path. Agent-authored config is attacker-influenced content (transcript text can steer the
  agent), so an invalid or markup-bearing config is rejected before it is proposed, exactly as a user
  write would be.
- **The validated config is streamed to the initiating client on the design turn's own SSE stream, as
  a `dashboard` event** (delivered only to that client, like the `question` event — never on the frozen
  WS fan-out). The client renders it in the grid (D1/D3 components — never markup) and can persist it
  through the D5 store.

*Why a typed tool over a free-text final message or client-side accumulation.* A tool input is a typed,
schema-validated boundary — structurally safer than parsing a model's free-text final message, and it
keeps the config an explicit, single, validated artifact rather than something reassembled from the
question/answer trail (which cannot carry layout and titles cleanly). The tool extends the per-turn MCP
server built in task 2.4; it is in-process, not new HTTP surface. The one new observable is the
`dashboard` SSE event on the (already delta-authorized) design route.

### D11 — The rendered dashboard computes its aggregates client-side; no new HTTP surface (apply-time owner ruling, 2026-07-21)

The Phase-2.4 MCP aggregate tools serve the **agent**, not the web **renderer**, and no delta
requirement authorizes a "GET aggregate data" route. The Phase 4 review confirmed the renderer's data
path was unspecified. Owner ruling: **the rendered dashboard's widgets get their data by computing
aggregates in the web**, from the **existing** `useTranscriptWords` / `useTopics` / `useEvents`
endpoints — the same session data the other tabs already fetch — reusing the Phase-1 `aggregates.ts`
**logic** (shared or mirrored to the web workspace to avoid a second, divergent implementation). The
degraded/unavailable signals the components key on (D2b) come from that same shared aggregation, so the
"never zeros as data" rule holds identically on the client.

This keeps the change's **"additive `ai/v2` routes only"** posture (proposal "Contract impact"): no
`GET`-aggregates route, no delta amendment, no new frozen surface. The trade is that aggregation runs
client-side — acceptable, since the raw data is already fetched client-side for the existing tabs and a
dashboard is not a high-frequency compute. (`event_count_by_category` labels live in the catalog DB
outside the hub (D2a); the web resolves them from its existing category source where available, and
renders the honest "labels unavailable" affordance otherwise — never a fabricated label.)

## Resolved by the spike (Phase 0, 2026-07-21)

Empirical results from the Phase 0 de-risking spikes, each run under `maxBudgetUsd ≤ 0.25`/turn,
operator-login auth, and the shared option-set builder in `.apply/spikes/harness.mjs`. Full
evidence, exact option deltas, and live-turn counts are in `.apply/task-0.*-report.md`; this
section is the terse, decision-relevant summary. D6a/D7/D8/D8a above are rewritten to cite these
results directly.

- **0.1 — SDK pinned.** `@anthropic-ai/claude-agent-sdk@0.3.216` exact, no range operator. Six
  load-bearing docstrings (`tools`, `allowedTools`, `strictMcpConfig`, `maxBudgetUsd`, `cwd`,
  `managedSettings`) match D8 as written. `AskUserQuestionInput` confirmed present in
  `sdk-tools.d.ts`'s `ToolInputSchemas` union at this exact version.

- **0.4 — the fatal question, GREEN.** `tools: ['AskUserQuestion']` + `permissionMode: 'plan'`
  works end to end, live: `system/init` advertises the tool, a real `tool_use` block fires,
  `canUseTool` executes, a programmatic answer unblocks the turn, the turn completes
  successfully. `tools: []` and `permissionMode: 'dontAsk'` each **independently** kill the
  interaction (the former strips advertisement entirely — the model emits inert text that only
  *mimics* a tool call; the latter auto-denies before `canUseTool` ever runs, for every tool, not
  only `AskUserQuestion`). D8a's gate-accepted weakening (built-in set = exactly
  `['AskUserQuestion']`) is now spike-confirmed, and `'dontAsk'` is ruled out on live evidence, not
  only documentation. `previewFormat` stays pinned at the `'markdown'` default throughout.

- **0.4 — design corrections that amend D6a and D8.** `askUserQuestionTimeout` is a **`Settings`**
  field (`sdk.d.ts:4897`), set via the top-level **`settings`** option — **not** part of
  `toolConfig.askUserQuestion`, which D6a's original prose conflated. It does **not** survive
  `managedSettings`' restrictive-only filter (so it must never be passed via `managedSettings`);
  `disableClaudeAiConnectors` **does** survive that filter, in the same call (re-confirmed
  independently by 0.8).

- **0.4 — zod interop.** The repo's `zod@3.25.76` works at runtime with the pinned SDK's
  `createSdkMcpServer` + `tool()`, despite the SDK's declared `zod@^4.0.0` peer — a
  peer-resolution-time-only mismatch, not a runtime one. Closes the concern task 0.1 opened; task
  2.4 should not re-litigate it.

- **0.5 — the other potentially-fatal question, GREEN with a design correction.** No-orphan is
  achievable for both the abort and timeout triggers, but **not** via the SDK's default
  `abortController` alone: that path is single-pid (SIGTERM at 2s, SIGKILL at 7s, gated on the
  *tracked leader's* exit status — confirmed from `sdk.mjs` source and live). A naive
  process-group-forward of the SDK's own signals left a real SIGTERM-ignoring companion process
  **orphaned, live**. Closing it requires an **implementer-owned pgid group-kill ladder gated on
  group liveness**, wired through the SDK's `spawnClaudeCodeProcess` spawn override — mirroring
  `killAiChatProcessGroup` in `server/src/routers/aiChatRunner.ts` almost exactly. The SDK exposes
  no child pid anywhere (typed and live-confirmed) — `spawnClaudeCodeProcess` is the only way to
  obtain one. The turn iterator **throws** on abort in every arm (tasks 2.5/2.6 must catch it, not
  rely on a clean loop return). `interrupt()` resolves, rather than throwing, against a string
  prompt on the pinned version — moot here, since the design never calls it.

- **0.2 / 0.3 — escape attempts and hook holes.** Shell (`Bash`) and filesystem (`Read`) escape
  attempts were both refused under the shipping `tools: ['AskUserQuestion']` set, by
  non-advertisement — neither tool appeared in `system/init`, so no real `tool_use` block for
  either was ever possible. `canUseTool` **fires** for every advertised tool (the MCP aggregate
  tool and `AskUserQuestion` both), gating in addition to being merely notified — D8's layering is
  **enforcement**, not observability-only. Hook holes, both control-armed: `settingSources: []`
  suppresses the operator's real user-tier `UserPromptSubmit` hook (fires under
  `settingSources: ['user']` on the identical setup); a planted project-tier hostile hook fires
  under a hostile `cwd` + `settingSources: ['project']` (control, proving the plant works) but
  **not** under the shipping config, and — the correction — **not even under a hostile `cwd`** when
  `settingSources: []` alone is set (arm 3). **D8's attribution is corrected accordingly:** the
  pinned `cwd` is defense-in-depth (and remains load-bearing for the separate `server/.env`
  exposure concern), but `settingSources: []` is itself what closes the project-tier hook hole —
  not the pinned `cwd`, as the original prose claimed.

- **0.7 — `safeMode` NOT needed.** Our existing combination — `settingSources: []` (hooks) +
  `strictMcpConfig: true` (repo `.mcp.json`) + pinned empty `cwd` + isolated empty
  `CLAUDE_CONFIG_DIR` (CLAUDE.md, skills) + never setting `plugins`/`skills`/`agents` — already
  closes every category `--safe-mode` closes, for this design's runtime shape. `settingSources: []`
  and `--safe-mode` are **not** equivalent mechanisms (they gate different, largely
  non-overlapping categories); it is the full combination that closes the gap, not any one control
  alone. Settles D8b's inherited, explicitly-unresolved `safeMode` conflict. No `extraArgs`
  exception is needed in task 2.3 — the closed-world test keeps asserting `extraArgs` fully absent.

- **0.8 — settings-cascade record.** `resolveSettings()`'s own input surface covers only
  `{cwd, settingSources, managedSettings, serverManagedSettings}` — most of D8's controls
  (`tools`, `disallowedTools`, `strictMcpConfig`, `mcpServers`, `permissionMode`,
  `settings.askUserQuestionTimeout`, and others) are not `Settings`-cascade fields at all and were
  correctly verified live in 0.1–0.5 rather than through this API. Of the fields that *are*
  representable: `settingSources: []` yields an empty resolved `sources` array (independent
  confirmation of 0.3); `managedSettings.disableClaudeAiConnectors` survives the restrictive-only
  filter; `managedSettings.askUserQuestionTimeout` is dropped by the same call, alongside the
  docstring's own named "silently dropped" examples (`model`, `cleanupPeriodDays`) — strengthening
  confidence the filter is real allowlist membership, not a no-op.

- **0.9 — no-spawn is testable on the SDK path.** Using the `pathToClaudeCodeExecutable` option
  pointed at an on-disk recorder fixture (`server/src/test/fixtures/ai-v2-sdk-spawn-recorder.mjs`),
  committed as a new test seam (`server/src/routers/aiV2SdkSpawn.ts` /
  `aiV2SdkSpawn.test.ts`, commit `cd31da8`) — deliberately not `vi.mock('node:child_process')`,
  which is unreliable for the SDK path for the same eager-module-vs-hoisted-mock timing reason
  D8b's inherited test-infra finding names. `query()` spawns synchronously at call time (before
  the caller's first `await`), so the recorder need not drain a turn to prove a spawn occurred.
  Task 2.2's route tests should reuse this seam directly rather than re-deriving one.

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

Carried forward from the superseded change. **These were panel corrections to a document —
doc-reading, not empirical results** when first folded (see D8b: the predecessor's own log
records "no spike has been run for the SDK"). Phase 0 has since settled most of them empirically;
each bullet below records what happened. See "Resolved by the spike" above for the full evidence
and per-task citations — the blanket "still unverified" framing this section used to carry is now
largely false and is corrected item by item:

- **`allowedTools` does not restrict; `tools: []` is the built-in denial.** Doc-derived, and now
  behaviorally consistent with every live spike: `tools` controlled what was advertised in
  `system/init` in every turn (0.2, 0.4), while `allowedTools` was never populated or exercised as
  a restriction mechanism in Phase 0. The predecessor's first draft got this backwards, leaving
  shell and filesystem built-ins live in a nominally locked-down agent; no spike re-created that
  specific wrong configuration to independently re-confirm the failure mode, so this stays
  doc-derived rather than newly spiked.
- **`maxBudgetUsd` exists and enforces** — the predecessor's draft claimed no equivalent and
  rationalized a weaker bound. Doc-confirmed (task 0.1) and used successfully as a spend cap in
  every live turn across Phase 0 (≤$0.25/turn, never exceeded); not stress-tested to observe it
  actually cut off an over-budget turn.
- **`strictMcpConfig: true` is required** — it suppresses project `.mcp.json`, and this repo has
  one checked in (CodeGraph, commit `591ac17`) that would otherwise load into the agent.
  Doc-confirmed (task 0.1); not independently re-verified live against this repo's own
  `.mcp.json` in Phase 0, so this stays hedged as doc-derived.
- **`cwd` defaults to `process.cwd()`** — the repo checkout, which contains `server/.env`.
  Doc-confirmed (task 0.1); genuinely untested beyond that (no spike arm ever left `cwd`
  unpinned), so it stays hedged.
- **Trust verification is skipped for non-interactive sessions — RESOLVED, with a correction.**
  Task 0.3 confirmed live, with control arms, that `settingSources: []` — not the pinned `cwd`, as
  originally framed here and in D8 — is what suppresses both the user-tier hook (0.3a) and the
  project-tier hook (0.3b, including against a planted hostile `cwd`). See D8's corrected
  attribution above.
- **Lifecycle is unresolved — LARGELY RESOLVED (task 0.5).** `abortController` kills one pid, not
  a process group: confirmed from `sdk.mjs` source and live. The SDK exposes no pid: confirmed,
  both typed and live. No-orphan is achievable, but only via an implementer-owned process-group
  kill ladder through `spawnClaudeCodeProcess` — a naive group-forward of the SDK's own signals
  left a real orphan live. `interrupt()`'s actual runtime behavior against a string prompt
  (resolves, does not throw) is now known, though moot since this design never calls it.
- **Test-infra debt — ADDRESSED, not eliminated.** `vi.mock('node:child_process')` is vacuous
  through the shared `app` singleton. Task 0.9 built and committed a working alternative test seam
  (`pathToClaudeCodeExecutable` pointed at an on-disk recorder fixture) for the SDK path
  specifically, rather than fixing the underlying mock-timing hole; the underlying vitest
  mock-timing issue itself remains unfixed for any code that still relies on `vi.mock` for this.

## UI design brief (2026-07-21, post-gate design artifact)

Confirmed with the owner through the impeccable shape flow (register/personality/a11y captured
in the repo-root `PRODUCT.md`). This section is **visual guidance for apply-time implementers**,
not new normative surface: where it and the delta spec could ever disagree, the spec wins. The
rendered form of every decision below is `design/mockup.html` (standalone, synthetic data only,
state switcher bottom-left) — the mockup is the visual spec; this section records the decisions
and their reasons.

**Topology — canvas + docked design rail.** The dashboard grid is the tab's primary surface; the
design conversation lives in a right-docked, collapsible rail (V5 aside width). Question cards,
tool-activity lines, notices, and the free-text input all render in the rail; the canvas is never
blocked by a turn. On ≤767px the rail stacks below the canvas. Direct manipulation (D7a) is
reachable in every state that shows a grid, not a mode the conversation gates.

**Register and direction.** Product register, dark, extending the V5 glass system unchanged
(no new chrome vocabulary). Anchors: Vercel Analytics (thin-stroke, one-hue charts, generous
space) and Linear Insights (typographic data; numbers and labels carry the design). Charts are
quiet; data is the loudest layer. Anti-references hold: no consumer-cute AI styling, no terminal
aesthetic; mono is reserved for timecode and data values.

**Data-viz palette (validated, not eyeballed).** Categorical slots, dark mode, validated with the
dataviz six-checks validator against the effective glass surface `#131b2e`: `#0284c7` (sky,
brand-anchored), `#199e70`, `#c98500`, `#008300`, `#9085e9`, `#e66767`, `#d55181`, `#d95926` —
band/chroma/contrast PASS; worst adjacent CVD ΔE 10.3 (floor band, legal because every
multi-series widget carries direct labels). Slots are assigned to entities in fixed order and
never cycled; **speakers take slots 1..N consistently across every widget in a dashboard**.
Single-series marks (event density, nominal category bars) use the brand sky `#38bdf8`; nominal
bars are never colored by value. Text never wears a series color; identity comes from a swatch
beside text tokens.

**State inventory** (all rendered in the mockup): saved, empty (teaching state with both entry
paths — "Design with AI" and "Start blank"), designing (streaming tool lines + Stop turn),
question pending (option previews rendered by the real widget components with sample data +
free-text fallback + idle-timeout hint), draft landed ("Draft · yours to edit", staggered
entrance, Keep/Edit), editing (drag/resize handles, retitle-in-place, remove, near-opaque catalog
picker with unavailable types disabled-with-reason, keyboard hints), degraded (per-widget
unavailable states naming the missing data — never zeros), busy 409 (names the holding feature),
turn error (saved dashboard untouched), unconfigured 503 (actionable, input disabled).

**Degraded-state visual language.** A dashed-ring "Data unavailable" badge plus one sentence
naming the missing data and why, left-aligned in the widget body; visually distinct from loading
and from error. This is the D2b requirement's rendered form and appears even in the healthy
sample dashboard (filler words) so the state reads as normal, not broken.

**Motion.** 150–250ms ease-out state transitions; the only stagger is the draft-landing entrance
(45ms/widget, translateY 7px + fade). Full `prefers-reduced-motion` fallbacks. No decorative
motion.

**Accessibility.** WCAG AA on the actual glass surfaces; color never the only channel (direct
labels on every multi-series widget, swatch-beside-text identity); keyboard-operable editing
(arrow move, shift-arrow resize, Enter retitle, Del remove) rendered as visible hints in edit
mode; chart tooltips are supplementary, never the only path to a value.

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

### 2026-07-21 — UI design brief + hi-fi mockup folded in (post-gate edit)

Owner-confirmed design brief (impeccable shape flow: canvas + docked rail topology, Vercel
Analytics / Linear Insights anchors, validated data-viz palette, full state inventory) added as
the "UI design brief" section, with its rendered form committed as `design/mockup.html`
(standalone, synthetic data only; nothing sourced from the private reference demo). Explicitly
non-normative: the delta spec wins on any conflict. Targeted addition, not structural rework, so
per process this gets a light-tier consistency read (outcome recorded below), not a re-panel.

**Consistency read (light-tier, 2026-07-21): clean.** Read `design.md` in full plus the delta
spec against the new section: cross-references live (D7a, D2b, `design/mockup.html` on disk), no
contradictions with D1–D9 or the spec's requirements (no agent preview HTML, no sentiment
widgets, no WS answers, edit path turn-free), log entry accurate.

### 2026-07-21 — Phase 0 de-risking spikes (empirical, apply-time)

Both potentially-fatal questions — 0.4 (`AskUserQuestion` under our locked-down `tools` set) and
0.5 (no-orphan lifecycle) — came back **GREEN**: the transport choice does **not** return to the
gate. Design corrections folded into D6a/D7/D8/D8a from the spike evidence: `askUserQuestionTimeout`
belongs on the top-level `settings` option, not `toolConfig.askUserQuestion` (0.4); the
project-tier hook hole is closed by `settingSources: []` itself, with the pinned `cwd` recast as
defense-in-depth rather than the fix (0.3); no-orphan on abort/timeout requires an
implementer-owned process-group kill ladder wired through `spawnClaudeCodeProcess` for task 2.6,
mirroring `killAiChatProcessGroup` — the SDK's default `abortController` alone is insufficient
(0.5); and `safeMode` is ruled unnecessary, closing D8b's inherited, explicitly-unresolved
conflict, with no `extraArgs` exception needed in task 2.3 (0.7). Per-task evidence, exact option
deltas, and live-turn counts live in `.apply/task-0.1-report.md` through `.apply/task-0.9-report.md`
(and the combined `.apply/task-0.2-0.3-report.md`, `.apply/task-0.7-0.8-report.md`); a terse
summary is recorded above under "Resolved by the spike".

**Phase 0 review (apply-time, full tier — 2026-07-21):** the phase's three committed artifacts (SDK
pin 0.1, no-spawn test seam 0.9, this fold 0.10) reviewed clean after one fix wave. Two Important
stale-artifact findings were fixed: `tasks.md` task 2.3 still named the disproven `tools: []`
(corrected to the confirmed `tools: ['AskUserQuestion']` set) and `spec.md` still attributed the
project-hook-hole closure to the pinned `cwd` alone (corrected to credit `settingSources: []`, with
`cwd` as defense-in-depth). Post-fix spec/design consistency read: **clean** — the edited
"Subprocess security lockdown" requirement and this design's D8/"Resolved by the spike" now agree,
no SHALL relaxed.

### 2026-07-21 — Apply-time owner ruling: design→dashboard seam + renderer data source (D10, D11)

The **Phase 4 full-tier review** (PASS/PASS) surfaced two forward gaps the gated plan left
unspecified — neither a defect in the shipped Phase 4 code, both genuine underspecifications: (1) the
design turn had **no wired mechanism** to produce a `DashboardConfig` (the `done` event carried `{}`),
so *agent proposes a dashboard* produced nothing renderable and Phase 6's e2e had no path to pass;
(2) the **renderer's data path** was unspecified (the Phase-2.4 MCP tools serve the agent, not the
web, and no delta requirement authorizes a render endpoint). Both were escalated to the owner at the
Phase 5 check-in and ruled:

- **D10 — commit via a `propose_dashboard` MCP tool.** The agent assembles the config and calls a typed
  in-process tool that validates the **whole config** (D5a) at the boundary; the validated config
  streams to the initiating client on a new `dashboard` SSE event. Chosen over free-text final-message
  parsing (fragile) and pure client-side accumulation (can't carry layout/titles cleanly).
- **D11 — client-side aggregation for the renderer.** The web computes widget data from the existing
  `useTranscriptWords`/`useTopics`/`useEvents` endpoints, reusing `aggregates.ts` logic — **no new HTTP
  surface**, preserving the "additive `ai/v2` routes only" contract posture (chosen over a new GET
  endpoint, which would need a delta amendment).

Folded across all three artifacts: **design.md** D10/D11 (above); **spec.md** — *Dashboards are edited
directly* gains a normative proposal-delivery paragraph + two scenarios (validated proposal to the
initiating client only; invalid proposal rejected), and *Dashboard persistence* extends whole-config
validation to "wherever a configuration enters — user write **and** agent proposal alike"; **tasks.md**
— Phase 5 gains tasks 5.4 (propose_dashboard tool), 5.5 (stream `dashboard` event + client render),
5.6 (client-side aggregation), with a scope note. **Process:** this is an apply-time owner ruling
filling a review-found gap, not structural rework, so it takes a **light-tier consistency read** (not a
re-panel); its adversarial coverage comes from the **Phase 5 full-tier review** (the new surface is
contract-affecting — a `dashboard` SSE event — and security-relevant — agent-authored config validated
whole) and the whole-branch audit. New `dashboard` SSE event is additive on the already-delta-authorized
design route; no existing route/status/shape/WS emission changes.

**Consistency read (light-tier, 2026-07-21): one Important finding, fixed; otherwise clean.** Read all
three folded documents (design D10/D11 + log, spec's two amended requirements, tasks 5.4–5.6) against
each other and the pre-existing gated design. Confirmed: D10/D11 ↔ spec ↔ tasks agree on tool name/role,
whole-config validation applying to the agent proposal, and client-side aggregation with no new HTTP
route; the new `dashboard` SSE event is **additive and client-only** (rides the already-authorized
design POST's stream, like `question`; the frozen WS fan-out is untouched); no contradiction with
D1/D3/D4/D5a/D5b/D6/D7 or the "additive only" contract posture; `DashboardPersistencePort` description
matches the shipped Phase-4 code; no stale pre-fold language survives. **Fixed:** task 5.5 wrongly said
the `dashboard` event "maps into the existing scrub allow-list on error" — but the shipped `question`
event uses a **direct `stream.writeSSE`** bypassing `guardedEmit`'s `delta`/`done`/`error` closed union
(whose scrub is error-`detail`-content-only, not an event-type gate); corrected to point the implementer
at the real `question` precedent.
