# ai-session-analyst — Design

## Context

`ai-topics-chat` shipped a write-capable topics agent on a hand-spawned `claude` CLI plus a
loopback MCP listener. This change adds a **second agent** — a read-only Session Analyst —
on the Claude Agent SDK, and deliberately leaves the topics chat alone.

The interesting design content is therefore not "how do we build a chat endpoint" (that
pattern is established and proven) but three narrower questions: **may we use the SDK at all**
(D0), **what makes read-only actually read-only** (D2), and **how much of the proven CLI
posture carries over** (D1).

## Goals / Non-Goals

**Goals**
- A read-only conversational agent scoped to exactly one session.
- Reuse the shipped SSE vocabulary, guard order, and spend-bound machinery rather than
  re-inventing them.
- Carry over the proven `ai-topics-chat` D4 security posture in SDK form, with read-only
  enforced in depth.

**Non-Goals**
- Migrating the topics chat to the SDK (explicitly out of scope; see D0's scope limit).
- Any mutating tool, cross-session scope, or new auth mechanism.
- Persisting analyst conversations.

## Decisions

### D0 — Supersedes `ai-topics-chat` D1 (owner ruling, 2026-07-20)

`ai-topics-chat` design **D1** reads:

> **D1 — claude CLI subprocess, not the Agent SDK.** *Alternative:*
> `@anthropic-ai/claude-agent-sdk` (same engine, in-process, less plumbing) — rejected by
> owner decision: the deployment's existing `claude` install and login are the integration
> point. Consequence we accept: stdout protocol parsing and process lifecycle are ours.

**That rationale no longer holds.** Verified mechanically against `sdk.d.ts` v0.3.216
(package installed and read; see the fact-check log below):

- `pathToClaudeCodeExecutable?: string` — *"Path to the Claude Code executable. Uses the
  built-in executable if not specified."* Points the SDK at the deployment's existing install.
- `env?: {…}` — *"When omitted, the subprocess inherits `process.env`."* `HOME` therefore
  carries the same `claude login` credentials the CLI path uses today, and the option still
  permits D1-below's minimal-env control.

So the SDK can use *the deployment's existing `claude` install and login* — precisely the
property D1 said it lacked. **Owner ruling 2026-07-20: supersede D1 for this change only.**

> **Superseded in part by D10 (same day).** The "no API key needed, auth rides on `claude login`"
> half of this argument is a **policy problem** for a portable multi-user product — Anthropic does
> not permit third-party apps to offer claude.ai login. D10 rules a scoped API key preferred, with
> the login fallback confined to loopback. D0's *technical* premise stands (the SDK can use the
> existing install); its *auth* premise is narrowed, leaving the in-process MCP toolset (D3) as the
> primary justification. Read D0 and D10 together.

**Scope limit (deliberate):** this supersession authorizes the SDK for the **analyst only**.
The topics chat keeps its CLI transport, argv characterization test, and loopback listener
untouched. D1 remains in force for that agent. A future migration of the topics chat would be
its own change with its own gate.

**Correction to a common framing:** the SDK is *not* "in-process" as a whole — `settingSources`
is documented as enforcing lockdown "on the spawned subprocess", so a subprocess still exists.
What is genuinely in-process is the **MCP toolset** (D3). Anyone reasoning about this change as
"no subprocess" is reasoning from a false premise.

*Alternative considered:* build the analyst on the existing CLI path (reuse `spawnAiChatTurn`,
`relayAiChatTurn`, `aiMcpServer`). Rejected at the gate in favour of the SDK, but it is the
honest fallback if the panel demolishes D0 — the cost of reversing is one runner module, not
the whole change.

### D1 — Lockdown posture — an UNVERIFIED HYPOTHESIS until Phase 0 runs

> **Status (2026-07-20 panel + gate): this table is NOT "the security core"; it is a
> hypothesis.** The first draft mapped the proven D4 flag set onto SDK options and got **4 of
> 9 rows wrong — every error weakening the child relative to the shipped CLI agent.** The
> corrected table is below. It MUST NOT be locked until the Phase 0 spike rewrites it from
> *observed behaviour*. See the panel log for the four defective rows and their evidence.

`ai-topics-chat` D4 is empirically proven (2026-07-14 spike, real turns). The SDK equivalents,
**corrected** after the panel:

| `ai-topics-chat` D4 (proven) | Analyst (SDK) — corrected |
| --- | --- |
| `--setting-sources ""` | `settingSources: []` — see the scope caveat below |
| `--tools ""` (positive built-in denial) | **`tools: []`** — *"Disable all built-in tools"*. **NOT `allowedTools`** |
| `--allowedTools <3 names>` | `allowedTools: <3 names>` — *auto-approve*, not restriction |
| *(no CLI equivalent)* | `disallowedTools` naming the built-in write/exec set — belt-and-braces |
| `--strict-mcp-config` | **`strictMcpConfig: true`** — suppresses project `.mcp.json`, user settings, plugins |
| `--mcp-config <0600 file>` | `mcpServers: { analyst: createSdkMcpServer(…) }` — no file, no port, no token |
| `--append-system-prompt <brief>` | `systemPrompt` (pinned constant, not inline) |
| message on stdin, never argv | `prompt` parameter (never argv) |
| minimal env whitelist | explicit `env` — **REPLACES, does not merge**; must include `MCP_TOOL_TIMEOUT` |
| stable per-session cwd outside repo/`DATA_DIR` | **`cwd`** — same; default is `process.cwd()` = **the repo checkout** |
| process-group kill ladder | see D7 — `interrupt()` is streaming-input-only; **unresolved** |
| `--max-budget-usd` | **`maxBudgetUsd`** (it exists and enforces) + `maxTurns` |
| **no** `--fork-session` | `forkSession: false` **pinned explicitly**, never defaulted |
| *(CLI `-p` implied non-interactive)* | **`permissionMode: 'dontAsk'`** — fail-closed; `'default'` prompts, and nobody is there to answer |
| *(no CLI equivalent — D11)* | **`CLAUDE_CONFIG_DIR`** on the child env — isolates credentials, transcripts, daemon socket namespace, `.claude.json` |
| *(no CLI equivalent — D11)* | **`disableClaudeAiConnectors`** via **`managedSettings`** — not an `Options` field; `settingSources: []` means no settings source would carry it |
| *(no CLI equivalent — D11)* | **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`** on the child env — strips credentials from any spawned subprocess |
| *(D12)* | `allowedTools` additionally carries `AskUserQuestion`, plus the named SDK-infrastructure tools spike 0.9 identifies |

**The four corrections the panel forced** (each verified against `sdk.d.ts` v0.3.216):

1. **`allowedTools` does not restrict.** Its docstring: *"List of tool names that are
   auto-allowed **without prompting for permission**… **To restrict which tools are available,
   use the `tools` option instead.**"* The draft mapped `--tools ""` onto the one option the SDK
   documents as *not* doing that job, leaving `Bash`/`Read`/`Write` in a "read-only" agent.
2. **`maxBudgetUsd` exists.** *"Maximum budget in USD for the query. The query will stop if this
   budget is exceeded."* The draft claimed no equivalent and recorded a weaker bound as an
   unavoidable trade-off. It was not unavoidable.
3. **`strictMcpConfig` was dropped.** The draft folded it into the `mcpServers` cell reasoning
   "the config *file* is gone" — but the flag's job is suppressing *other* MCP sources: *"project
   `.mcp.json`, user settings, plugins, and on-disk agent frontmatter."* **This repo has a
   checked-in `.mcp.json`** (CodeGraph, commit `591ac17`), which would have loaded into a
   nominally three-tool agent.
4. **`cwd` was absent entirely.** It defaults to `process.cwd()` — the repo checkout, which
   contains `server/.env` (real `GOOGLE_CLIENT_SECRET`, `DEEPGRAM_API_KEY`). The predecessor
   went to deliberate trouble here (`stableSessionCwd` under `tmpdir()`); the draft inherited
   none of that reasoning.

**`settingSources: []` — narrower than first claimed.** It disables the *user/project/local*
tiers, which is what suppresses the `UserPromptSubmit` **shell hook** in this operator's real
`~/.claude/settings.json`. It does **not** cover: the managed/policy tier (*"the managed-settings
policy tier is still read from disk"*), programmatic `hooks`/`plugins`/`agents` options, or
`.mcp.json` (that is `strictMcpConfig`'s job). The draft's claim that it stops "hooks, plugins,
and `CLAUDE.md`" full stop was **broader than the evidence**. A future reader who relaxes it
reopens the hook hole — **do not** — but it is one door of several, not "the" control.

**Closed-world characterization test (D2 layer 4).** Pinning values catches a *change*; only a
closed-world assertion catches an *addition*. The test SHALL assert the resolved options contain
exactly the enumerated keys, and that `hooks`, `plugins`, `agents`, `extraArgs`,
`additionalDirectories`, `allowDangerouslySkipPermissions`, and `permissionPromptToolName` are
**absent**, and `permissionMode` is neither `'bypassPermissions'` nor `'acceptEdits'`.

### D2 — Read-only: one guarantee, plus drift detection and observability

> **Corrected 2026-07-20 after the panel.** The draft claimed "three independent layers, **each
> sufficient alone**." That was **false in both directions** and dangerous: it invites a future
> reader to delete the one layer that actually guarantees anything ("we still have two others").
> The layers are ordered and interacting, not independent.

1. **Registration — THE guarantee.** Only the three read tools are constructed; `create_topic`
   has no handler, so no configuration mistake elsewhere can invoke it. This is what the spec's
   "session state byte-identical" scenario actually rests on. **Never remove this layer.**
2. **`tools: []` — the built-in denial.** Removes `Bash`/`Read`/`Write`/`Edit`/`WebFetch` from
   the base set. This is a *different job* from layer 1 (which governs only our MCP tools) and
   is the layer the draft omitted entirely. Without it, read-only-ness of our three tools is
   irrelevant — the built-ins are the attack surface.
3. **`allowedTools` + `disallowedTools` — drift detection, not restriction.** `allowedTools` is
   auto-approve; it does **not** restrict. `disallowedTools` is the only option documented as
   overriding an allow (*"removed from the model's context and cannot be used, even if they
   would otherwise be allowed"*).
4. **`canUseTool` — observability, and a partial gate.** Returns `{ behavior: 'deny', message }`
   for anything off the allowlist, and `SDKResultSuccess.permission_denials` makes a denial
   *assertable in a test* — that is its real value: proving the model tried and was stopped,
   rather than merely never trying.

   **It is NOT a universal chokepoint.** `allowedTools` entries are auto-allowed *without
   prompting*, and `canUseTool` sits on the prompt path — so a name added to `allowedTools`
   plausibly bypasses it entirely, which is precisely the scenario the draft claimed it caught.
   The SDK also documents *"PreToolUse hook denies bypass canUseTool."* **Spike 0.2 must
   determine empirically whether `canUseTool` is invoked for an allowlisted tool.** If it is
   not, this layer is observability only and the design says so.

Layers 2–4 are configuration and drift detection. Layer 1 is the guarantee.

### D3 — In-process MCP tools remove a surface

`createSdkMcpServer` + `tool()` (Zod schemas, in-process handlers) mean the analyst needs **no**
loopback HTTP listener, **no** per-turn bearer token, and **no** generated `0600` config file —
the three mechanisms `ai-topics-chat` D3 had to build and defend. This is a net *reduction* in
attack surface, and is the strongest practical argument for D0.

Two invariants carry over unchanged from that design and must not be "simplified":

- **`sessionId` is captured in the tool closure, never a tool parameter.** This is what stops the
  model addressing another session. A tool signature that accepts a session id reopens it.
- **Tools resolve the hub at call time** via `registry.get(sessionId)`, never holding a handle
  across an `await` — the idle-eviction sweeper can close a hub underneath a long turn.

Hub RPC bodies stay synchronous (repo invariant); any async work lives in the tool/router layer.

### D4 — Reuse `AiChatTurnRegistry`, shared instance

`AiChatTurnRegistry` already implements exactly the needed two-axis bound (per-session
single-flight + process-wide ceiling) and is transport-agnostic — `tryAcquire`/`release` work
unchanged.

**Decision: share the existing singleton** rather than instantiate a second. Consequence: one
in-flight turn per session *across both agents* — starting an analyst turn while a topics turn
runs on the same session returns `409`. That is the desired behaviour: it prevents one session
running two paid agents concurrently, and keeps the operator's spend ceiling meaningful rather
than doubling it by accident.

*Alternative:* a separate registry instance per agent. Rejected — it silently doubles the
process-wide ceiling, which is the opposite of what a spend bound is for.

### D5 — SSE vocabulary reuse

Reuse the `ai-topics-chat` event vocabulary (`delta` / `tool` / `done` / `error`) and its
**additive-open** posture. The terminal-event discipline is normative and identical: **exactly
one** terminal event per completed stream, and a client abort emits **none** (the client must
not wait for one after Stop). `SDKResultMessage.session_id` supplies the id echoed back for
multi-turn continuity, and `resume` consumes it.

Only assistant **text** is relayed; model reasoning/thinking content MUST NOT be relayed —
carried over from `ai-topics-chat`, which filters it deliberately.

### D6 — Gating semantics

Follows the `CLAUDE_CLI_PATH` precedent (`ai-topics-chat` D8): unconfigured ⇒ `503` with an
actionable `{ detail }`, plus the same open-network refusal so a paid endpoint is never served
anonymously on a reachable network. Guard order matches the shipped sibling exactly:
auth (`401`) → session resolution (`404`, masking unauthorized sessions before anything below)
→ config gate + open-network refusal (`503`) → body validation (`422`/`400`) → turn slot (`409`).
No guard path spawns.

### D10 — Auth: scoped key preferred, login fallback loopback-only (owner ruling, 2026-07-20)

**This corrects a policy error in D0.** D0 justified the SDK partly on *"auth rides on `claude
login`, no `ANTHROPIC_API_KEY` required"* and presented that as the win. But the SDK overview
states: *"Anthropic does not allow third party developers to offer claude.ai login or rate limits
for their products… use the API key authentication methods instead."* autologger is described in
`CLAUDE.md` as portable — *"runs anywhere Node 22 runs"* — with teams, invites, and studio
scoping. A portable multi-user product whose AI features silently bill the packager's personal
subscription is a policy violation, not just an ops smell. (The shipped topics chat has the same
property; it was gated as an operator-local tool. This decision does not retroactively change it.)

**Ruling (2026-07-20): support both, key preferred.**

1. A workspace-scoped API key, when configured, is used — never the OAuth fallback.
2. Absent a key, the login fallback is permitted **only on a loopback bind**, and the fallback is
   logged loudly at startup so an operator cannot drift into it unaware.
3. Non-loopback with no key is already `503` under the open-network refusal.

The key SHOULD live in a dedicated Anthropic **Workspace** with its own spend limit, so a
compromised key cannot drain the org (`claude-dev-resources.md` checklist items 1 and 6).

**Consequence for D0:** its auth argument is now secondary. The SDK's remaining justification is
the in-process MCP toolset (D3) and typed options. That is still a real argument, but it is a
*narrower* one than D0 was ruled on — recorded here rather than quietly reinterpreted.

### D11 — Child hardening beyond `settingSources` (owner ruling, 2026-07-20)

Source: the operator's own empirically-verified research (`~/claude-dev-questions/`, live tests
dated 2026-07-20), which is authoritative over doc-reading here.

**The finding that matters most, and that D1 missed:** SDK sessions *always* run
non-interactively, and **trust verification is skipped entirely in that mode**. A
`.claude/settings.json` sitting in the session's `cwd` therefore loads and **executes hook
commands with zero prompt**, for any `cwd`, trusted or not. Crucially, *"`CLAUDE_CONFIG_DIR`
isolation doesn't help — the exploitable file lives in `cwd`."* The same path lets an untrusted
directory merge in `permissions.allow` rules (permission rules **merge** across scopes rather
than override) and inject an `env` block into every subprocess.

D1's `settingSources: []` addresses the *user* tier. The project tier reached through `cwd` is a
different hole, and the post-panel `cwd`-outside-the-repo pin mitigates it — but for a reason the
design never stated. It is now stated, and Phase 0 must test the **project**-tier hook, not only
the user-tier one.

**Ruled in (all four):**

| Control | Status against the SDK surface |
| --- | --- |
| Isolated `CLAUDE_CONFIG_DIR` | Env var, not an `Options` field — set it on the child `env`. Isolates credentials, transcripts, the agent-daemon socket namespace, and `.claude.json`. Does **not** isolate `cwd`-scoped project settings. |
| `disableClaudeAiConnectors` | **Not an `Options` field** — it is a *settings* key (*"when true in any settings source"*), and we load none. Route it through **`managedSettings`**, which the SDK documents for *"embedding applications… enforce them on the spawned subprocess"* and filters **restrictive-only** (can tighten, never widen). |
| Subprocess env scrub | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` on the child env. Low marginal value once `tools: []` removes Bash, but cheap. |
| `safeMode` | **Not an SDK `Options` field** — CLI-only. See the conflict below. |

**Unresolved conflict — `safeMode` vs. the closed-world test.** The operator's checklist calls
`--safe-mode` *"the only tested mitigation that closes both this and the project-hooks hole at
once."* But the SDK exposes no `safeMode` option, so it could only reach the child via
`extraArgs` — which D1's closed-world characterization test **forbids** as a widening surface,
and rightly so. Three ways out, to be settled by spike **0.8**:
(a) demonstrate that `settingSources: []` + `strictMcpConfig: true` + a pinned `cwd` already
close what `--safe-mode` closes, making it redundant; (b) carve a *narrow, named* `extraArgs`
exception for `--safe-mode` only, asserted by the closed-world test as an exact-match allowance
rather than an open field; or (c) verify `--safe-mode` does not also disable our own
`createSdkMcpServer` tools — if it does, it is unusable here regardless.

**Bonus finding — `persistSession: false`.** The SDK can disable transcript-to-disk entirely
(*"Sessions will not be saved to `~/.claude/projects/` and cannot be resumed later"*). This
directly addresses the on-disk conversation state the proposal's Non-Goals had to be corrected
about. It **conflicts with `resume`**, so it is a genuine trade: ephemeral turns with no
multi-turn continuity, or continuity with transcripts on disk. Spike 0.8 measures the cost;
the gate decides.

### D7 — Subprocess and turn lifecycle — OPEN, and potentially D0-reversing

The draft mapped the predecessor's process-group kill ladder to "`abortController` +
`query.interrupt()`" and put no lifecycle requirement in the spec at all. The panel found both
halves defective:

- **`interrupt()` is unavailable as designed.** The SDK documents control requests as *"only
  supported when **streaming input/output** is used."* The design delivers the message as a
  `string` prompt, which is not streaming input.
- **`abortController` does not kill a process group.** It grants an SDK graceful-close path
  (stdin EOF → ~2s grace) and then a signal that reaches **one pid**. The shipped CLI path
  deliberately spawns `detached: true` so `process.kill(-pid, …)` reaches *"the CLI and any
  MCP/helper children it spawns."* The SDK exposes no pid, no handle, no `detached` control.
- **A hung in-process MCP tool is unbounded.** Tool calls are bounded by `MCP_TOOL_TIMEOUT`,
  *"effectively unbounded by default"* — and D1 mandates a minimal `env` that would omit it.

**Resolution path (Phase 0):** either adopt the streaming-input `prompt` form so `interrupt()`
genuinely exists, or drop it from the design and rely on a per-server `timeout` plus an
SDK-iterator-**independent** timeout backstop. Spike 0.6 must assert via `ps` that no `claude`
process survives an abort and a timeout, against a child that ignores SIGTERM.

**If no-orphan cannot be guaranteed under the SDK, that is a D0-reversing finding** and the
honest fallback (build on the proven CLI path) applies. Orphans keep spending the operator's
money, and `restart_supported` is `false` on this deployment.

### D8 — Motivating questions must be traced to reachable data

The panel found the proposal's three motivating questions appear **only** in `proposal.md` and
are traced nowhere. Traced against the real schema, two are not answerable:

- **"Which topics have no events under them?" — the relation does not exist.** `session_topics`
  is `(id, session_time, duration_sec, topic_level, summary, ordinal, created_at_utc)`. There is
  **no `topic_id` on events**, no join table, no foreign key (verified). Containment would have
  to be *inferred* from `topic.session_time` — which is `z.string().max(20).default('')`,
  free-form with no format validation, frequently empty — against event SMPTE timecodes. Two
  different time systems. The analyst would produce confident, unfalsifiable, wrong answers.
- **"Summarize the second half" — needs a session duration no tool exposes.** Transcript
  `end_sec` is `0.0` for anchorless words.
- **"What happened around 12:30?" — partly reachable, but degraded.** `list_events` reading the
  hub returns `category` as a **studio-profile UUID**; the operator-visible label is attached in
  the *router* by `enrichEventRpc(ev, profile)`, which the hub never calls. Unfixed, the analyst
  answers with opaque UUIDs where the operator sees "Take Start".

**Decisions:** (a) `list_events` is **router-shaped, not hub-shaped** — enriched with the
category label, crossing a hub/catalog seam the existing MCP toolset never crossed; (b) the
topic↔event containment question is **removed from the Why** unless a derivation with a stated
time base is specified — the analyst SHALL state its basis and refuse to infer an unmodelled
relation; (c) tool results are **bounded and slice-able** (see D9), since every motivating
question is a *slice* and `get_transcript_words` is currently unbounded (~1.8 MB on a 90-minute
session, which would blow the context window on the first real use).

### D9 — Tool result bounds

`get_transcript_words` today is `SELECT *` with no filter, cap, or pagination. For a one-shot
topics pass that was tolerable; for an analyst whose every question is a slice it is the primary
failure mode. Range/slice parameters become normative, with a documented cap and an explicit
truncation indicator so the model can say "I only saw part of this" rather than summarizing a
silently truncated transcript. MCP tool params are internal, so this is not a contract change.

### D12 — Interactive clarifying questions via `canUseTool` (owner ruling, 2026-07-20)

Modelled on the operator's `ask-user-question-previews` demo
(`~/claude-agent-sdk-demos/`), which validates the pattern end to end.

The demo's insight is that **`canUseTool` is not only a gate — it is an interaction channel**.
The callback blocks; the server forwards the question to the browser and parks a promise
resolver in a map; the user answers; the promise resolves; `query()` continues. The draft used
`canUseTool` only to deny.

**Why this earns its place here:** panel finding D8 established that two of three motivating
questions are ambiguous or unanswerable — *"what happened around 12:30?"* has no defined time
base (wall clock vs. SMPTE vs. elapsed). Rather than guessing or refusing, the analyst can ask.
This converts D8 from a scoping problem into a runtime interaction.

**Adaptations required — the demo is a single-user localhost toy and must not be copied
literally:**

- Its `pending` map is keyed by **request id alone**, with one global map and no auth. Ours MUST
  be keyed by `(sessionId, turnId, requestId)` and scoped to the turn — a bare request id is the
  cross-session leak shape the panel already flagged.
- The demo lets `ToolSearch` and `ExitPlanMode` pass through `canUseTool` because they are SDK
  infrastructure that loads `AskUserQuestion`. Our default-deny gate would break on this; the
  allowance must be explicit and named, not a wildcard.
- The demo rejects pending promises on socket close *"so the `query()` loop unwinds instead of
  hanging indefinitely."* That is the **same hazard as D7's slot leak** — a parked promise with
  no answerer holds the turn slot open. The rejection path is mandatory here, not optional.
- `AskUserQuestion` must be added to `allowedTools`; `tools: []` still holds for built-ins.

Preview HTML (`toolConfig.askUserQuestion.previewFormat`) is **out of scope** — it is the demo's
subject but adds a sanitization burden (the demo uses DOMPurify) for no analyst benefit.

### D13 — Transport for the question round trip — OPEN

The turn stream stays **SSE on POST** as gated (D5); `ai-topics-chat` D2 rejected WebSocket
because the per-session WS fan-out **broadcasts to every attached client** (browser tabs *and*
Companion) and its emission semantics are frozen under `api-contract-freeze`. Nothing in D12
changes that: analyst replies must not broadcast to every viewer of the session.

But D12's round trip needs a **client→server** path that SSE cannot provide. Options, unresolved:

- **(a) Reuse the existing session WS** for the answer hop only. Cheapest plumbing, but the
  fan-out means an answer — and any question payload echoed over it — reaches every attached
  client. Needs a per-client addressing story the current hub does not have.
- **(b) A small `POST …/ai/analyst/answer`** carrying `(turnId, requestId, label)`. No new
  transport, no upgrade plumbing, reuses the existing auth/session guards verbatim, and is
  trivially scoped to the answering user. Adds one route to the frozen surface.
- **(c) A dedicated analyst WS route**, demo-shaped and bidirectional — but this reverses D2,
  replaces the gated SSE requirement wholesale, and adds frozen surface needing its own
  authorization.

**Recommendation: (b).** It preserves D2 and D5 untouched, adds the least frozen surface, and
the question round trip is low-frequency request/response — precisely what a POST is for. The
demo needed a socket because it had no other channel; we already have an authenticated one.

## Risks / Trade-offs

- **Two transports to maintain — repriced after the panel.** The draft booked this as "one
  module." It is not. The honest cost is a second runner, a second relay (over a ~35-variant
  `SDKMessage` union), a second lockdown posture every future security reviewer must hold in
  their head, a second characterization test, a second upgrade cadence — **plus a full
  re-derivation of the 2026-07-14 spike**, which answered five questions the SDK path must now
  re-ask four of:

  | 2026-07-14 CLI spike | Analyst re-derivation |
  | --- | --- |
  | (a) setting-sources preserves creds + loads MCP | 0.1 + 0.3 |
  | (b) built-ins gone, MCP tools retained | 0.2 |
  | (c) MCP transport connects | *(obviated — in-process)* |
  | (d) resume across turns | 0.3 |
  | (e) stream taxonomy + hook suppression | 0.4 + 0.1 |

  Accepted knowingly at the 2026-07-20 gate, with the mapping corrected and the spike hardened.

- **New dependency on the security boundary, on a 0.x cadence.** Three installs on this machine
  span v0.2.72 → v0.3.181 → v0.3.216. A pre-1.0 package whose option *semantics* are the
  lockdown is a standing maintenance tax. Pin exactly (not `^`); the closed-world
  characterization test is the tripwire, but a tripwire reports *after* the fact.
- **Prompt injection — containment must be re-derived, not inherited.** The predecessor argued
  injection is contained to "junk topics on this session" *by construction*, because its tool
  surface was three tools behind a token-authenticated listener. That argument does **not**
  transfer: transcript content is untrusted (anyone *audible* can inject, not just a system
  user), and even with the toolset correct, injected text is relayed to the operator through
  `delta` events as **trusted analysis of their own session** — a phishing channel the
  predecessor lacked, and harder to notice than a visible, deletable junk topic row.
- **Shared-registry DoS (D4's downside, previously recorded as pure upside).** With
  `AI_CHAT_MAX_CONCURRENT` defaulting to 2 and a 300s timeout, any authenticated user can hold
  the whole process's AI capacity for 5 minutes, blocking the topics chat for **every session in
  the deployment**. The analyst doubles the endpoints from which this is reachable and is the
  one a low-privilege user is likeliest to be granted. The `409` also leaks turn liveness.
- **Slot leak wedges a session permanently.** The shipped `finally` release is safe because
  `runAiChatTurn` guarantees the promise resolves. Under D7's unresolved lifecycle, a
  never-terminating iterator means `finally` never runs; the registry has no TTL and no reaper,
  and `restart_supported` is `false`. The timeout backstop must be independent of the SDK
  iterator.
- **Resume binds a session, not a principal.** The map is `sdkSessionId → autologgerSessionId`;
  it never records *who*. A leaked or replayed id lets any user who passes `requireSession` for
  that session resume another user's conversation. The predecessor shares this hole, but the
  analyst is the agent whose output is most worth reading. The map is also unbounded.

## Open Questions

*(none blocking — D0's transport question was resolved by owner ruling before drafting; it is
recorded above rather than left open, and the panel is explicitly tasked with re-litigating it)*

## Panel & review log

### 2026-07-20 — Pre-panel fact-check (light-tier, mechanical fetch-and-compare)

Claims verified mechanically against the installed package and repo source.

**CONFIRMED (mechanically checkable):**
- `@anthropic-ai/claude-agent-sdk` resolves at **v0.3.216** — read from the installed
  `package.json`.
- `pathToClaudeCodeExecutable?: string` exists, documented "Path to the Claude Code executable"
  — `sdk.d.ts:1703`.
- `env?: {…}` documented "When omitted, the subprocess inherits `process.env`" — `sdk.d.ts:1414`.
- `settingSources?: SettingSource[]`, `SettingSource = 'user' | 'project' | 'local'`, documented
  "Pass `[]` to disable filesystem settings (SDK isolation mode)" — `sdk.d.ts:1883`, `:6564`.
- `createSdkMcpServer` and `tool()` exported — `sdk.d.ts:480`, `:6878`.
- `CanUseTool` / `PermissionResult` deny arm requires `message` — `sdk.d.ts:206`, `:2087`.
- `SDKResultSuccess` carries `session_id`, `total_cost_usd`, `permission_denials` —
  `sdk.d.ts:4252`–`:4280`.
- `resume?: string` and `forkSession?: boolean` exist — `sdk.d.ts:1776`, `:1473`.
- `ai-topics-chat` D1 text quoted verbatim in D0 — read from
  `openspec/changes/archive/2026-07-15-ai-topics-chat/design.md:41`.
- `AiChatTurnRegistry` exposes `tryAcquire(sessionId, maxConcurrent)` / idempotent `release`, and
  is transport-agnostic — `server/src/routers/aiChatRegistry.ts`.
- `requireSession` / `ApiError` exist in `server/src/routers/_helpers.ts`; guard order in D6
  matches `server/src/routers/ai.ts`.
- Existing subtabs are `Chat | Transcribe | Topics`, rendered mounted-hidden with hoisted state —
  `web/src/pages/index/components/AiPanel.tsx`.

**CORRECTED in the draft:**
- The framing "the SDK runs the agent in-process" was **false** and has been corrected in D0 —
  a subprocess still exists; only the MCP toolset is in-process.
- An earlier assumption that the SDK requires `ANTHROPIC_API_KEY` was **false**; corrected in
  D0 and the proposal's Non-Goals.

**LEFT UNVERIFIED (judgment-laden — for the panel):**
- Whether one read-only agent is the right product shape versus extending the topics chat.
- Whether a second transport is worth its maintenance cost (D0) — the central question.
- Whether the shared-registry `409` coupling (D4) is desirable or surprising in practice.
- Whether `settingSources: []` is empirically sufficient **on the SDK path** — proven for the
  CLI by the 2026-07-14 spike, assumed by translation here. **No spike has been run for the SDK.**

### 2026-07-20 — Adversarial panel (four skeptical mandates) + gate

Four reviewers with distinct mandates (requirements / assumptions / failure & abuse / scope &
simpler design), calibrated skeptical. **Eight blockers, with strong independent convergence:
three of four reviewers independently found the same defect in D1's mapping table.**

**Blockers/majors FIXED IN PLACE:**

- **D1's mapping table was wrong in 4 of 9 rows, every error weakening the child** relative to
  the shipped CLI agent. Independently found by the assumptions, failure/abuse, and requirements
  reviewers; each correction re-verified against `sdk.d.ts` v0.3.216 before folding:
  1. `--tools ""` → `allowedTools` is **inverted**. `allowedTools` is *auto-approve*
     (*"To restrict which tools are available, use the `tools` option instead"*). Real analogue
     is **`tools: []`**, which the draft never mentioned. Consequence had it shipped:
     `Bash`/`Read`/`Write` live in a "read-only" agent, with `cwd` at the repo checkout
     containing `server/.env`.
  2. **`maxBudgetUsd` exists** and enforces; the draft claimed no equivalent and rationalized a
     weaker bound in Risks.
  3. **`strictMcpConfig` was dropped**, on the reasoning that the config *file* was gone — but
     its job is suppressing *other* MCP sources. This repo has a checked-in `.mcp.json`
     (CodeGraph, `591ac17`) that would have loaded.
  4. **`cwd` was absent**, defaulting to `process.cwd()` = the repo checkout.
  Also added: `permissionMode: 'dontAsk'` (fail-closed; `'default'` prompts and no one is
  there), `disallowedTools`, explicit `forkSession: false`, `MCP_TOOL_TIMEOUT` in the env
  whitelist.
- **D2's "three independent layers, each sufficient alone" was false and dangerous** — it
  invites deleting the one layer that guarantees anything. An allowlisted tool plausibly
  bypasses `canUseTool` entirely (auto-allow short-circuits the prompt path), so layer 3 cannot
  backstop layer 2 — the exact scenario the draft claimed it caught. Rewritten: layer 1
  (registration) is the guarantee; the rest are denial, drift detection, and observability.
  Whether `canUseTool` fires for an allowlisted tool is now an explicit spike question.
- **`settingSources: []` was over-claimed** as stopping "hooks, plugins, and `CLAUDE.md`" full
  stop. It covers the user/project/local tiers only — not the managed/policy tier (*"still read
  from disk"*), not programmatic `hooks`/`plugins`/`agents`, not `.mcp.json`. Narrowed to the
  evidence.
- **No subprocess-lifecycle requirement existed at all** (the predecessor had one). `interrupt()`
  is streaming-input-only and therefore unavailable as designed; `abortController` kills one pid,
  not a process group, and the SDK exposes no pid. Now **D7**, flagged as potentially
  D0-reversing if no-orphan cannot be guaranteed.
- **Requirements failure: 2 of 3 motivating questions are unanswerable.** Verified: no `topic_id`
  anywhere — topic↔event containment is not modelled; `list_events` returns category UUIDs, not
  operator-visible labels; "second half" needs a duration no tool exposes. The questions appeared
  only in `proposal.md` and were traced nowhere. Now **D8**.
- **`get_transcript_words` is unbounded** (~1.8 MB on a 90-minute session) while every motivating
  question is a *slice*. Now **D9**.
- **Risks repriced.** Added the spike re-derivation table, prompt-injection containment
  re-derivation (the predecessor's argument does not transfer), shared-registry DoS, slot-leak
  wedging, and the resume-binds-session-not-principal hole.
- **Closed-world characterization test** replaces value-pinning: pinning catches a *change*, only
  a closed-world assertion catches an *addition* (`hooks`/`plugins`/`agents`/`extraArgs`/…).

**ESCALATED TO THE GATE (owner decision, 2026-07-20):**

- **Reverse D0 and build on the proven CLI path?** The scope reviewer priced CLI reuse at
  **~45–60 lines** of parameterization (`registerTurn` gains a `mode`; `buildAiChatArgv` gains
  two fields; relay and registry unchanged) and showed it **deletes Phase 0 entirely**, since
  those questions are already answered empirically. It also demonstrated D3's "removes a surface"
  is an accounting error: the listener/token/config-file all remain in-repo for the topics chat,
  so the SDK path *adds* a column to every row and removes none. No reviewer demolished D0 on its
  own terms (`pathToClaudeCodeExecutable` and the `env` semantics are real).
  **Ruling: keep the SDK. Correct the mapping, harden the spike, re-gate on spike results.**
  D1 stays an unverified hypothesis until Phase 0 returns green on the *corrected* control set.
- **Fourth subtab vs. a composer mode toggle.** The scope reviewer argued the subtab strip
  communicates nothing about the read-only distinction, that users will ask the wrong agent, and
  that a toggle would also make D4's shared-slot `409` self-evident rather than surprising.
  **Deferred: subtab retained for now**; revisit if the `409` proves confusing in practice. The
  `409` detail string must name the *other agent* as the holder.

**MINORS ACCEPTED AS RESIDUAL:**

- `503` config gate before body validation is a mild configuration oracle for authorized users
  (correctly ordered relative to the important `404` masking).
- The issued-id map remains unbounded, matching the predecessor's accepted residual; now
  explicitly recorded in Risks rather than silently inherited.
- Analyst enable flag not yet named (`AI_ANALYST_ENABLED` proposed); task 1.1 to fix.
- Abort terminal-event `MAY` tightened to `SHALL NOT` in the spec.

### 2026-07-20 — Second gate: operator research + SDK demo (D10–D13)

The operator supplied two external inputs after the first gate: a working Agent SDK demo
(`~/claude-agent-sdk-demos/ask-user-question-previews`) and their own empirically-verified
research notes (`~/claude-dev-questions/`, live tests dated 2026-07-20). Both were treated as
**authoritative over doc-reading**, the research especially so — it records live tests with
recorded output, not citations.

**What the demo confirmed:** D0's technical premise, empirically — a working program relying on
`claude login` with no API key. Also that `tools: [...]` is the restriction option (backing the
panel's B1 correction), and that `canUseTool` must let named SDK-infrastructure tools through.

**Blockers found and fixed (D10–D11):**

- **D0's auth argument was a policy violation for a portable product.** The operator's notes cite
  the SDK overview: third-party developers may not offer claude.ai login. D0 had made "no API key
  needed" the *selling point*. Ruled: scoped key preferred, login fallback loopback-only and
  logged (**D10**). D0's auth premise is narrowed; its technical premise stands.
- **`settingSources: []` does not close the hole that actually matters.** The operator's live test
  proved SDK sessions skip trust verification entirely, so a project-tier `.claude/settings.json`
  in `cwd` executes hooks with **zero prompt** — and config-dir isolation cannot help, because the
  file lives in `cwd`. The post-panel `cwd` pin mitigates this, but the design never said why.
  Now **D11**, with spike 0.7 testing the *project* tier rather than only the user tier.
- **Two requested controls are not SDK `Options` fields** — verified, not assumed:
  `disableClaudeAiConnectors` is a *settings* key (and we load no settings sources), so it must
  route through `managedSettings`, which the SDK documents for embedding applications and filters
  restrictive-only. `safeMode` has no SDK surface at all.

**ESCALATED — unresolved, spike 0.8:** `--safe-mode` is the operator's checklist's "only tested
mitigation" for the project-hook hole, but it could only reach the child via `extraArgs`, which
D1's closed-world test forbids as a widening surface. Three exits recorded in D11; the spike
decides. Also surfaced: `persistSession: false` would eliminate on-disk transcripts entirely but
**conflicts with `resume`** — a real trade for the gate, measured by the same spike.

**Ruled in (D12):** the demo's `canUseTool` → promise → browser round trip, which converts panel
finding D8 from a scoping problem into a runtime interaction — the analyst asks which time base
is meant instead of guessing. Adaptations recorded: the demo's single-user `pending` map keyed by
bare request id must become turn-scoped here, and its disconnect-rejection path is **mandatory**
(it is the same hazard as D7's slot leak).

**OPEN (D13):** the question round trip needs a client→server path SSE cannot provide.
Recommendation is a small `POST …/ai/analyst/answer` rather than WebSocket — `ai-topics-chat` D2
rejected WS because the session fan-out broadcasts to every attached client including Companion,
and analyst replies must not broadcast. Awaiting the operator's ruling.

### 2026-07-20 — Post-gate consistency read (light-tier)

> Scope note: this read covers the **first** gate's fold-back (panel blockers B1–B8). D10–D13
> landed afterwards and have not yet been consistency-read; that read runs once D13 is ruled.

**Clean.** Read all four post-fold documents — `proposal.md`, `design.md`,
`specs/ai-session-analyst/spec.md`, `tasks.md` — against the folded gate rulings.

- **Stale language:** none. No surviving claim that `allowedTools` restricts tools; no surviving
  "independent layers / each sufficient alone" (the D2 occurrence is the corrected framing, the
  panel-log occurrence is past-tense about the *removed* claim); no surviving "no
  `--max-budget-usd` equivalent"; D1 described as an unverified hypothesis everywhere it appears;
  abort terminal-event is `SHALL NOT` throughout (the one remaining `MAY` is the unrelated
  additive-open vocabulary clause).
- **Cross-document contradictions:** none. Proposal's per-turn USD ceiling matches the spec's
  spend requirement and tasks 3.1/3.4; the corrected persistence Non-Goal matches D0's
  subprocess framing; D7's open status is consistently gated rather than assumed resolved.
- **Cross-references:** clean. D0–D9 each defined exactly once, sequential, no gaps. Every
  D-reference resolves; the three references to `ai-topics-chat`'s own D1/D4/D9 are explicitly
  labelled as belonging to that document. All cited task numbers and requirement names resolve.
- **Coverage:** every spec requirement has a covering task; no task implements unauthorized work.
- **Numbering:** sequential within every phase after the insertions (0.0/0.5/0.6/3.7); no
  duplicates.

**One item found and fixed:** `tasks.md`'s "PROVISIONAL until the panel + gate pass" banner was
correct when written but would have read as stale the moment this entry was recorded. Replaced
with a gated-2026-07-20 header that carries forward what is still genuinely open — Phase 0 is
blocking, and D1/D7 remain unverified hypotheses.

### 2026-07-21 — Superseding sequencing ruling (ui-refresh gate)

The `ui-refresh` change's gate ruled that **ui-refresh lands first**. Its five-tab flat IA
(Event Feed | Transcript | Topics | Assistant | Dashboards, single owner:
`web-session-console`) dissolves the AiPanel subtab structure this change's plan of record
builds on ("`Chat | Analyst | Transcribe | Topics` subtabs"). Before this change's apply, its
artifacts MUST be re-planned via `opsx:update` against the post-ui-refresh IA (likely shapes:
Analyst as a sixth top-level tab, or a sub-surface of the Assistant tab) with a consistency
read. Until then, `tasks.md` here is stale as written — do not dispatch from it.
