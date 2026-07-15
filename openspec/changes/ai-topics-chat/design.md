# ai-topics-chat — Design

## Context

Sessions now get real transcripts (transcript-generation, shipped 2026-07-14), but topics
are still hand-typed; `POST …/topics/generate` intentionally returns `503`. The workspace
has a flat client-side tablist in `SessionWorkspace.tsx` (`feedTab:
'events' | 'transcribe' | 'topics'`, feeds rendered by conditional mount). Topic writes
flow through `SessionHub.insertTopic` (transactional, server-assigned ordinal — but **no
WS emission**: `TopicStore` never broadcasts, unlike event/audio/lease/transport stores,
and `useSessionSocket` has no topics case; confirmed by the 2026-07-14 fact-check).
Validation at the route uses `topicCreateSchema` (`server/src/schemas.ts`). Constraints in
force: frozen HTTP/WS contract, single Node process, synchronous hub RPC bodies, async
work in the router layer (DeepGram generation is the template: env-gated, single-flight,
hub used only for the final synchronous mutation).

The user decision set (explore, 2026-07-14): drive the operator's **claude CLI** (not the
Agent SDK) so auth rides on their `claude login`; the use case is **DeepGram transcript →
topics**; chat history is **ephemeral**; the model gets a real **`create_topic`** tool.
Gate rulings (2026-07-14): global spend cap + per-turn budget; SSE vocabulary
additive-open; chat UI plain-text + Stop button; refuse chat on open (anonymous,
non-loopback) networks.

## Goals / Non-Goals

**Goals:**
- Conversational topic creation from the transcript, human-steered, with the chatting
  client seeing rows appear live while the model works.
- Zero behavior change for unconfigured deployments; zero change to existing frozen
  surface.
- The chat endpoint is safe to expose to any authenticated user — locked-down CLI, no
  host shell/filesystem reachability, bounded spend.

**Non-Goals** (see proposal): chat persistence, general assistant tools,
`update_topic`/`delete_topic`, `topics/generate` backend, Companion surface, API-key auth
path, broadcasting chat over the session WS, markdown rendering in v1, cross-client
(non-chatting-client) topic liveness.

## Decisions

### D1 — claude CLI subprocess, not the Agent SDK
Spawn `claude -p --output-format stream-json` per turn. *Alternative:*
`@anthropic-ai/claude-agent-sdk` (same engine, in-process, less plumbing) — rejected by
owner decision: the deployment's existing `claude` install and login are the integration
point. Consequence we accept: stdout protocol parsing and process lifecycle are ours.

### D2 — SSE on the POST response, not WebSocket
The chat turn streams back on the `POST …/ai/chat` response as `text/event-stream`. Event
vocabulary is **additive-open** (gate 2026-07-14): the four meanings (`delta`/`tool`/
`done`/`error`) and the one-terminal-event-per-completed-stream invariant are frozen, but
new event types/fields may be added without a further delta and clients ignore unknown
types — precedent is `api-contract-freeze`'s additive-open `login_error` code set. This
leaves room for future `thinking`/`usage`/cancel-ack events. *Alternatives:* (a) piggyback
on the session WS — rejected: SessionHub fan-out broadcasts to every client and its
emission semantics are frozen; (b) a dedicated WS route — rejected: upgrade plumbing for
no benefit. The web client uses `fetch` + ReadableStream parsing (EventSource cannot POST)
and an `AbortController` for the Stop control.

### D3 — In-process MCP server on a loopback-only ephemeral port
The MCP server runs **inside the existing Node process** (single-process invariant holds —
a second listener, not a second process), bound to `127.0.0.1` on an ephemeral port,
speaking Streamable HTTP via `@modelcontextprotocol/sdk`. Each turn gets a generated MCP
config pointing at it with a per-turn bearer token (cryptographically random, ≥128-bit);
the bearer is validated **at the HTTP layer before transport dispatch**, and the
token→session mapping resolves the session id from the turn registration, never from a
tool parameter. Concurrent turns share the one listener via **per-connection transport
instantiation** (SDK stateless/ session-keyed pattern), not a single global transport.
Tool bodies resolve the hub **at call time** (`registry.get(sessionId).insertTopic(...)` —
never holding a handle across an `await`, so the idle-eviction sweeper can't close it
underneath a long turn) so transactions and ordinals are literally the manual-insert code
path. Topics have no WS emission (fact-check 2026-07-14), so there is no fan-out on this
path for AI or manual inserts; client liveness is D9's SSE-driven invalidation.

*Alternatives:* (a) stdio MCP helper process calling back over loopback HTTP to the public
API — rejected: needs an internal auth token honored by the public middleware (new auth
surface on frozen routes) and a third process per turn; the in-process listener is
strictly fewer parts since the hub is in-process; (b) MCP endpoint on the public `:8787`
app — rejected: adds a route to the frozen public surface; (c) helper opening the session
SQLite directly — rejected outright: bypasses the hub, breaking transaction/ordinal
invariants; (d) **no MCP — inline the transcript into the prompt and parse structured
topic output** — rejected: conflicts with the owner's "real `create_topic` tool" decision
and trades schema-validated transactional writes for fragile output parsing (scope panel
concurred this is the lever *if* MCP were ever cut, but did not recommend it).

**Deliberate invariant for future readers:** the MCP listener MUST stay loopback-bound
(mirror of the Vite `server.host` pin). "Helpfully" binding it to LAN, or moving the MCP
endpoint onto `:8787` for tidiness, re-opens exactly the surface this design closes.

### D4 — Lockdown flag set
Spawn (argv array, `shell: false`, **user message on stdin** — never an argv positional,
so a `--`-prefixed message can't become a flag) with:

- `--setting-sources ""` — load **no** user/project/local settings: this is the flag that
  stops operator **hooks** (which run shell unconditionally on lifecycle events and are
  *not* governed by tool allow/deny lists), plugins, and user-level `CLAUDE.md` from
  loading in the child. The `claude login` credential path must still work under this
  (credentials are not a "setting source" — verify in the 3.2 spike). This is the primary
  security control; the fact-check found this repo's own `~/.claude/settings.json` has a
  `UserPromptSubmit` shell hook, so without this flag every turn would execute it.
- built-in tools disabled positively (`--tools ""` if it does not also suppress MCP tools
  — verify in spike; otherwise `--disallowedTools` naming the built-in set) **plus**
  `--allowedTools mcp__autologger__get_transcript_words,mcp__autologger__list_topics,
  mcp__autologger__create_topic`. Positive denial beats a name-keyed denylist that drifts
  as the CLI adds built-ins (`Skill`, `SlashCommand`, …).
- `--strict-mcp-config --mcp-config <generated file>` (only our config loads).
- `--append-system-prompt` with the topics brief (D7).
- **No** `--fork-session` (so `--resume` reuses the id and multi-turn continuity holds).
- `cwd` = a **stable per-autologger-session** empty directory outside repo/`DATA_DIR`
  (NOT a fresh per-turn dir: the CLI stores sessions per-cwd, so a fresh cwd per turn
  would break `--resume` on turn 2 — see D5/Open Questions). The generated config file is
  written there mode `0600` and removed in the turn's `finally`.
- env: inherit `HOME` (credentials) + `PATH`, plus proxy/TLS vars where the deployment
  needs them; strip the rest. README notes: run the server as the logged-in operator, and
  ensure `node` is on `PATH` if the CLI is an npm-global (not a native install).

A characterization test pins the full argv (fake CLI records it), including
`--setting-sources ""` and the stdin delivery.

### D5 — Turn lifecycle, single-flight, and spend bounds
Two-axis bound (gate 2026-07-14): a **per-session** in-flight registry (second turn on the
same session → `409`) using DeepGram's single-flight *mechanism* (module-level state in
the router, cleared in `finally`) with a deliberately looser scope than DeepGram's single
process-wide flag (`server/src/routers/transcribe.ts`), **plus** a **process-wide**
concurrency ceiling `AI_CHAT_MAX_CONCURRENT` (small default) rejecting excess turns, and a
per-turn CLI budget flag (`--max-budget-usd` from a configured value). The looser session
scope is what makes independent sessions chatting concurrently a feature; the global
ceiling and per-turn budget are what keep that from becoming unbounded operator spend.

Each child is spawned in its own process group; on `done`/`error`, a turn timeout
(`AI_CHAT_TIMEOUT_SEC`, default 300 — the guaranteed backstop), or best-effort SSE client
disconnect, the server kills the group (SIGTERM, SIGKILL after grace) and drops the MCP
turn registration + bearer token + config file at the same moment. Disconnect detection
via `@hono/node-server`'s abort signal is best-effort; the timeout is the guarantee, so the
timeout path is the primary tested one (D10 fixture hang mode).

### D6 — stream-json relay mapping
Parse the CLI's JSONL stream: `system/init` → capture `session_id`; assistant text →
`delta`; `tool_use` → `tool` (short name only, `mcp__autologger__` stripped — arguments
never relayed); terminal `result` → `done` with the session id, or `error` with one of the
fixed scrubbed strings (never raw stdout/stderr/result text, device-login URLs, or paths).
**Taxonomy pinned by the 2026-07-14 spike (2.1.202).** The captured stream confirmed the
double-emit and surfaced a second concern:

- `--include-partial-messages` is *additive* — the same assistant text appears both as
  `stream_event` `content_block_delta:text_delta` lines **and** in the complete
  `{type:"assistant"}` message event. The relay MUST emit text from **one** source only.
  Decision: relay text from the `assistant` message events (message-level `delta`s) and
  **drop** the `stream_event` partial lines — simpler than reassembling partial deltas,
  and "zero or more deltas" is satisfied at message granularity. (If token-level
  smoothness is later wanted, switch to partial deltas and suppress the full message —
  but not in v1.)
- **Thinking blocks leak if unfiltered.** The stream carried
  `content_block_start:thinking` + `thinking_delta` + `signature_delta` (the model's
  reasoning). The relay MUST map **only** `text` content blocks to `delta` events and
  MUST NOT relay `thinking`/`signature` content — otherwise the model's chain-of-thought
  streams to the browser. `tool_use` blocks → `tool` events (name only).
- `tool_use.name` arrived as the full `mcp__autologger__ping` — confirming the
  prefix-strip rule for the `tool` SSE event.

D10's fixture encodes this exact taxonomy (init `system/subtype:init` with `session_id`;
interleaved `stream_event` thinking/text/tool_use lines; full `assistant` messages;
terminal `result`).

### D7 — System prompt scoping
`--append-system-prompt`: the model is AutoLogger's topics assistant for one session;
fetch the transcript via `get_transcript_words`, propose/create topics via `create_topic`
(`session_time` `HH:MM:SS`-style ≤ 20 chars, `topic_level` 1–10, concise summaries), check
`list_topics` before creating to avoid duplicates, stay on task. Guidance, not security —
the security boundary is D3/D4; prompt injection via transcript content is contained to
"junk topics on this session" (hand-editable, deletable) by construction.

### D8 — Gating semantics
`CLAUDE_CLI_PATH` unset/blank/whitespace → `503` (DeepGram-style detail). Open-network
refusal (`REQUIRE_LOGIN` disabled + non-loopback + no allowlist) → `503` before spawning,
independent of the auth gate. Set-but-broken (missing binary, not logged in, bad version,
proxy/TLS failure) surfaces as the stream's scrubbed `error` event — the gate is
configuration presence, not a startup probe, so a broken install fails per-turn, visibly,
without blocking boot.

### D9 — Web restructure
`feedTab` becomes `'events' | 'ai'` with a nested `aiTab: 'chat' | 'transcribe' | 'topics'`
defaulting to `chat` (plain `useState`; no routing — deep-linking subtabs is out of
scope). **Mount discipline (corrected 2026-07-14):** chat message state and the SSE
reader/`AbortController` are lifted to the AI-panel (or workspace) level, and the three
subtab panels stay mounted (hidden via CSS) rather than the repo's default conditional
mount — otherwise switching Chat→Topics unmounts `AiChat`, aborts the fetch, and (per the
lifecycle rule) kills the turn, which is exactly the action the "watch topics appear"
scenario tells the user to take. `TranscribeFeed`/`TopicsFeed` render unchanged.

**Topic liveness (corrected 2026-07-14):** the original draft assumed a WS-driven
`useTopics` invalidation; the fact-check showed none exists. Chosen mechanism: on a `tool`
SSE event naming `create_topic`, `AiChat` calls `queryClient.invalidateQueries` on the
topics key — the chatting client sees rows appear during the turn. Other connected clients
keep today's manual-insert semantics (refetch on focus/staleness). *Alternative escalated
to the gate:* a `topic.changed` WS broadcast for true multi-client liveness — not adopted
(WS emission semantics are frozen surface; it would need its own contract authorization
plus Companion-lag review); adoptable later if wanted. `AiChat` also owns the Stop control
(abort the fetch), plain-text rendering, tool-activity chips, the `503` explainer, and
`error`-event rendering.

### D10 — Hermetic test double for the CLI
Tests never invoke the real `claude`. A fixture script (Node) plays the CLI: records its
argv (asserting the D4 lockdown — `--setting-sources ""`, strict MCP config, the allowlist,
stdin delivery, stable cwd — verbatim), emits canned stream-json (init/session_id, partial
text, `tool_use`, result) matching the **real** 2.1.202 taxonomy captured in the 3.2 spike,
and exercises failure/timeout paths (nonzero exit, garbage output, hang). `CLAUDE_CLI_PATH`
pointing at the fixture is the whole harness — same trick as the DeepGram fetch stub; keeps
CI free of Anthropic credentials.

## Risks / Trade-offs

- **CLI flag/stream drift across versions** → fixture pins argv; README states the minimum
  tested version; a broken/old CLI fails as a scrubbed per-turn `error` (D8), not a crash.
- **`--setting-sources ""` might disable credentials or our own MCP** → verified as the
  first 3.2 spike; fallback is a narrower setting-source selection that still excludes
  hooks/plugins. This is the single most load-bearing security check in the change.
- **`--resume` vs per-turn cwd** → resolved by the stable per-session cwd (D4/D5); the
  spike confirms resume works across two spawns before the design locks.
- **Partial-message double-emit** (D6) → captured-stream spike + explicit dedup rule.
- **Huge transcripts may exceed context via `get_transcript_words`** → accepted for v1;
  tool-side paging can be added later without touching frozen surface (MCP params internal).
- **Prompt injection through transcript content** → blast radius capped at `create_topic`
  on the same session (D3/D4); rows visible live and hand-editable.
- **Loopback is reachable by any local process** → per-turn ≥128-bit bearer, HTTP-layer
  check, `0600` config, `finally` cleanup + startup sweep of stale turn dirs.
- **SSE through the Vite dev proxy** → plain `http-proxy` with no compression middleware
  (probed) should pass unbuffered; verify in dev; production is same-origin.
- **`~/.claude` accumulates CLI session files** (history is only *server*-ephemeral) →
  documented; acceptable on the operator's own machine.

## Migration Plan

Additive and gated: deploy with `CLAUDE_CLI_PATH` unset → only visible change is the tab
restructure (Chat shows not-configured; Transcribe/Topics behave as before). Enable by
setting the variable (and, on a shared network, keeping auth on); disable/rollback by
unsetting it. No data migrations, no catalog/session schema changes.

## Open Questions

- Minimum claude CLI version to document: spike ran on 2.1.202 with every pinned flag
  behaving as designed; document 2.1.202 as the tested floor and set the minimum during
  implementation.

### Resolved by the 2026-07-14 spike (empirical, real turns on 2.1.202)

The 0.1 spike ran real turns against a loopback Streamable-HTTP MCP server (one `ping`
tool) with the full D4 flag set. All five questions resolved **green**:

- **(a) `--setting-sources ""` preserves credentials + loads our MCP** — turn completed
  normally (auth intact) with `--setting-sources ""`; `mcp_servers: [{name:"autologger",
  status:"connected"}]` in the init event.
- **(b) `--tools ""` disables built-ins without touching MCP tools** — the init event's
  available-tools list was exactly `["mcp__autologger__ping"]`: every built-in gone, the
  MCP tool retained and successfully invoked (server recorded `pingCalls=1`, model quoted
  the nonce). So `--tools ""` is the primary built-in lockdown; `--allowedTools` admits
  the MCP three. `permissionMode: default` yet the allowlisted MCP tool ran with no
  prompt in `-p` — no `--dangerously-skip-permissions`-class flag needed.
- **(c) `--mcp-config` HTTP transport works** — an inline JSON string
  `{"mcpServers":{"autologger":{"type":"http","url":"http://127.0.0.1:<port>/mcp",
  "headers":{"Authorization":"Bearer <token>"}}}}` connected; the HTTP-layer bearer check
  fired. No SSE fallback needed. D3's in-process HTTP listener topology is validated.
- **(d) `--resume` across two spawns sharing a stable cwd** — turn 2 (separate process,
  same cwd, `--resume <id>`) correctly recalled turn 1's tool call. The stable-per-session
  cwd (D4/D5) makes resume work; a fresh per-turn cwd would have broken it.
- **(e) stream taxonomy + hook suppression** — captured; see D6 below. Hook check:
  a project-level `UserPromptSubmit` shell hook was **suppressed** under
  `--setting-sources ""` (sentinel absent) and **fired** in a control run with
  `--setting-sources project` (sentinel present) — the B1 fix is empirically confirmed,
  and no user-level `CLAUDE.md` appeared in `memory_paths`.

## Panel & review log

### 2026-07-14 — Pre-panel fact-check (light-tier, mechanical fetch-and-compare)

15 claim groups checked against the live repo and installed CLI. **Confirmed (11):**
`topicCreateSchema` bounds; `insertTopic` transactionality + server-assigned ordinal;
`topics/generate` unconditional 503; `feedTab` state/union in `SessionWorkspace.tsx`;
npm scripts (`typecheck/test/lint/e2e/e2e:visual`) and Playwright projects (`chromium`,
`login-gate`); `server/.env.example` + README endpoint table; sibling route
`POST …/events`; no `CLAUDE_CLI_PATH`/`ai/chat` collision; Hono `streamSSE` present
(hono ^4.6.14); claude CLI installed (2.1.202); all pinned CLI flags present verbatim in
`--help`. **Corrected (3):** (1) topics have **no** WS fan-out (`TopicStore` never
broadcasts; `useSessionSocket` has no topics case; `useTopics` invalidates only from its
own mutations) — corrected across all artifacts, liveness re-designed as SSE-driven
(D9); (2) Zod schema violations map to **422**, not 400 (`app.ts` global handler) — spec
request-contract corrected; (3) DeepGram single-flight is **process-wide**, not
per-session — D5 reworded (same mechanism, looser scope). **Left unverified (2):** exact
rendered tab-label strings (now marked non-normative in the spec); `--mcp-config`
HTTP-transport JSON support (moved to the 3.2 spike bundle).

### 2026-07-14 — Adversarial panel (four skeptical mandates) + gate

Four reviewers (requirements / assumptions / failure-&-abuse / scope-&-simpler-design),
calibrated skeptical. Playwright/Explore-tier read-only verification against the live repo
and machine. Dispositions below.

**Blockers/majors fixed in place:**
- **Operator hooks/plugins/CLAUDE.md execute via `HOME`** (two reviewers, verified against
  this machine's `~/.claude/settings.json`): `--strict-mcp-config`/tool lists do not stop
  lifecycle hooks, which run shell unconditionally on attacker-fed input. Fixed: D4 adds
  `--setting-sources ""` as the primary control; spec lockdown requirement names
  hooks/plugins/CLAUDE.md + a scenario; credential-preservation is spike (a).
- **`claude_session_id` unbound to the autologger session** (two reviewers): `--resume`
  with a foreign id leaks cross-session (cross-team) context, bypassing tool isolation.
  Fixed: spec "Multi-turn continuity bound to the autologger session" — server tracks
  issued ids per `:sessionId` and rejects unowned ids with `422` before spawning.
- **Argv flag injection**: a `--`-prefixed message could become a CLI flag. Fixed: message
  delivered via stdin (D4 + spec + characterization test).
- **`--resume` vs per-turn cwd** (CLI stores sessions per-cwd): fixed to a stable
  per-session cwd (D4/D5) + spike (d).
- **Partial-message double-emit** (D6): fixed with the captured-stream spike (e) + dedup
  rule.
- **Subtab switch unmounts the stream and kills the turn** (two reviewers): fixed —
  mounted-hidden panels + hoisted chat state (D9) + spec state-survival requirement +
  scenario.
- **`tool` event name ambiguity** (wire name vs short name breaks liveness silently):
  fixed — spec pins the `mcp__autologger__`-stripped short name.
- **Stale "WS fan-out" in design Context**: fixed (the one spot the fact-check sweep
  missed).
- **SSE over-freeze**: fixed per gate — additive-open vocabulary (D2/spec).
- Minors folded: status-code precedence order; absolute log-scrubbing (no leveled logging);
  `error`-detail whitelist covering not-logged-in URL leak; MCP transport per-connection +
  HTTP-layer token check; hub resolved at call time; default subtab Chat; disconnect
  best-effort with timeout as guarantee; config `0600` + cleanup + startup sweep;
  `--fork-session` absence; env-gap README notes; `message` trim.

**Findings escalated to the gate → decisions:**
- **Unbounded operator spend** (per-session single-flight × unlimited sessions) →
  **decided: global cap + per-turn budget** (D5, spec "Spend and concurrency bounds").
- **SSE vocabulary freeze posture** → **decided: additive-open** (D2).
- **Chat UI v1 scope** (missing Stop, undecided markdown) → **decided: plain text + Stop
  button**, markdown deferred (D9, spec).
- **Dev/LAN exposure of a paid endpoint** → **decided: refuse (503) on anonymous +
  non-loopback + no-allowlist** (D8, spec "Open-network refusal").

**Minors accepted as residual:** cross-client (non-chatting-client) topic liveness stays
at today's manual-insert semantics (the `topic.changed` broadcast alternative is available
later but out of scope); the real client↔server SSE seam gets one hermetic e2e happy-path
(task 5.2) rather than exhaustive chunk-boundary coverage; large-transcript context limits
accepted for v1 (tool paging is future, non-contract work).

### 2026-07-14 — Post-gate consistency read (light-tier)

Read proposal.md, spec.md, design.md, tasks.md. Verified clean: no stale WS-fan-out
language; 400-vs-422 consistent (400 malformed JSON only, 422 schema + foreign
`claude_session_id`); no surviving "fresh per-turn cwd" except as the labelled rejected
alternative; no closed-vocabulary SSE phrasing; env-var names consistent across all four;
global-cap and open-network-refusal decisions present in all relevant artifacts; every
requirement has a WHEN/THEN scenario. **Two fold-back gaps found and fixed:** proposal.md's
chat-endpoint bullet lacked the SSE additive-open decision, and its Chat-subtab bullet
lacked the Stop control — both present in spec/design, now added to the proposal. `openspec
validate --strict` passes.
