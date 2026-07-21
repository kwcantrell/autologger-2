# ai-v2-dashboards — Tasks

> Plan of record. Anchors are orientation only — locate code by content before editing.
> **PROVISIONAL** until the adversarial panel + gate pass. OpenSpec treats a change as
> apply-ready the moment this file exists; it is not. Do not dispatch `opsx:apply` until the
> rulings are folded across all four artifacts and the consistency read is recorded.
>
> **Private reference:** `~/Desktop/autologgers-demo.html` embeds a real conversation with
> personal and financial detail. Read it for structure only — its content must never appear in
> code, tests, fixtures, seed data, or commits.

## 0. De-risking spike — BLOCKING

The predecessor change (`ai-session-analyst`) established the SDK lockdown mapping but was
superseded before its spike ran, so **the option set remains an unverified hypothesis** and the
lifecycle question is open. Lock nothing until this phase is green. A red result on 0.3 or 0.5
returns the transport choice to the gate.

Every spike task MUST be falsifiable: state the attempt and the expected refusal, never
"confirm X is safe" — which an implementer discharges as a checkbox.

- [ ] 0.1 Add `@anthropic-ai/claude-agent-sdk` to the server workspace, **pinned exactly** (not
      `^`). Record the repo-resolved version in `design.md` and verify the load-bearing docstrings
      (`tools`, `allowedTools`, `strictMcpConfig`, `maxBudgetUsd`, `cwd`, `managedSettings`)
      against the pinned copy; correct D8 if they differ.
- [ ] 0.2 Spike the tool surface **by attempting escape**: with `tools: []` plus the analyst
      allowlist, have the agent attempt a shell call and a filesystem read and assert **both are
      refused**. Dump the init event's available-tools list and assert it contains exactly our MCP
      tools plus `AskUserQuestion` and the named SDK-infrastructure tools. Record whether
      `canUseTool` fires for an allowlisted tool — if it does not, D8's layering is observability
      only and the design must say so.
- [ ] 0.3 Spike the hook holes **with control arms**: (a) user tier — assert the operator's real
      `UserPromptSubmit` hook writes no sentinel under `settingSources: []` **and** does fire under
      `settingSources: ['user']`; (b) project tier — plant a hook in a `.claude/settings.json`
      inside a candidate `cwd`, assert it fires there and **does not** fire under our pinned `cwd`.
      Without the control arms a spike that fails for an unrelated reason reads as green.
- [ ] 0.4 Spike `AskUserQuestion` under **our** option set — **potentially fatal, run this first
      among 0.2–0.6.** `AskUserQuestion` appears nowhere in `sdk.d.ts` as a type, constant, or
      tool-name literal (checked in both v0.2.72 and v0.3.216) — it is a CLI-side built-in. Our
      design sets `tools: []` (disable all built-ins) while the demo set
      `tools: ['AskUserQuestion']` with `permissionMode: 'plan'`. **Determine whether `tools: []`
      strips `AskUserQuestion`.** If it does, the interactive-question shape is impossible as
      designed and the options are (a) name it explicitly in `tools`, which weakens the
      built-in denial to a named allowlist, or (b) abandon the interactive shape — **either way
      the design returns to the gate.** Also: confirm `permissionMode: 'dontAsk'` (fail-closed,
      "deny if not pre-approved") does not contradict a tool whose purpose is to prompt; identify
      which SDK-infrastructure tools must pass `canUseTool`; confirm `managedSettings` accepts
      `disableClaudeAiConnectors` without its restrictive-only filter dropping it; and pin
      `previewFormat` at the `'markdown'` default plus an explicit `askUserQuestionTimeout`.
- [ ] 0.5 Spike the orphan case: abort mid-turn against a child that **ignores SIGTERM**, then
      assert via `ps` that no agent process from that turn survives. Repeat for the timeout path.
      Determine whether the streaming-input prompt form is required for `interrupt()` to exist.
      **If no-orphan cannot be guaranteed, stop and re-gate.**
- [ ] 0.6 Spike the iframe sandbox: confirm a custom widget with no `allow-same-origin` cannot
      reach `parent.document`, cookies, or storage; decide whether `allow-scripts` is needed at all
      in v1 (ship the stricter option if viable — design Open Questions).
- [ ] 0.7 Record results in `design.md` under "Resolved by the spike"; rewrite D7/D8 to cite
      observed behaviour, and drop the hypothesis framing only when they do.

## 1. Aggregates + catalog schema (server, no agent yet)

- [ ] 1.1 TDD the aggregate computations over fixture transcripts (spec: *Session-scoped aggregate
      toolset*): speaker talk-time, utterance/question/filler counts, session duration, topic
      timeline, event counts/density. Assert invariants — talk-time sums to session duration,
      counts match hand-computed fixtures. Build fixtures from **synthetic** data, never from the
      private reference dashboard.
- [ ] 1.2 TDD the widget-catalog + layout schema (spec: *Widget catalog is a closed set*, *Layout
      and interaction vocabulary*): unknown widget type rejected; undefined interaction rejected;
      interaction targeting a missing widget id rejected; a sentiment type is **absent** from the
      catalog. Zod, mirroring the repo's existing schema conventions.

## 2. Design-turn endpoint + agent (server)

- [ ] 2.1 Config wiring: the AI v2 enable flag, the auth pair (key preferred; login fallback
      loopback-only + loud startup log), and the per-turn budget, in the server config layer and
      `server/.env.example`. AI v2 off must not affect the AI chat.
- [ ] 2.2 TDD the route shell (spec: *Configuration-gated*, *Open-network refusal*, *Design turn
      contract*): integration tests first for the guard order — auth → session `404` →
      config/open-network `503` → body `422`/`400` → slot `409` — asserting an unauthorized session
      masks as `404` and that **no guard path spawns**. Reuse `requireSession` and `ApiError`.
- [ ] 2.3 **Closed-world** characterization test on the resolved SDK options (spec: *Subprocess
      security lockdown*): assert `tools: []`, `settingSources: []`, `strictMcpConfig: true`,
      pinned `cwd`, isolated config dir, `maxBudgetUsd`, fail-closed permission mode,
      `forkSession: false`, pinned system prompt, minimal env, and the allowlist including
      `AskUserQuestion` — **and** assert `hooks`/`plugins`/`agents`/`extraArgs`/
      `additionalDirectories`/permission-bypass are **absent**.
- [ ] 2.4 In-process MCP aggregate tools (spec: *Session-scoped aggregate toolset*): `sessionId`
      captured in the closure, **never** a parameter; hub resolved at call time, never held across
      an `await`; server instance built **per turn**, never module-scoped. Test: two concurrent
      turns on different sessions do not cross.
- [ ] 2.5 Turn runner + SSE relay: assistant text only, never reasoning/thinking; exactly one
      terminal event per completed stream; client abort emits none. Mirror the existing
      `guardedEmit` pattern rather than re-inventing it.
- [ ] 2.6 Lifecycle (spec: *Subprocess and turn lifecycle*): implement per 0.5's finding, with a
      timeout backstop **independent of the agent iterator**. Test: no orphan after abort or
      timeout; a never-yielding iterator still ends and releases its slot.
- [ ] 2.7 Slot acquisition against the shared registry (spec: *Spend and concurrency bounds*):
      `409` across **both** features, detail naming the holder, slot released on every path.
- [ ] 2.8 TDD terminal-`error` scrubbing: raw exception text, subprocess stderr, and agent error
      arrays never reach `{ detail }`.

## 3. Question round trip

- [ ] 3.1 TDD the pending-question registry (spec: *Design question round trip*): keyed by
      `(sessionId, turnId, requestId)` — **never** bare request id. Test: an answer carrying a
      foreign session or turn is rejected; the pending question remains.
- [ ] 3.2 `POST …/ai/v2/answer` route, full guard chain, resolving the blocked `canUseTool`.
- [ ] 3.3 TDD abandonment (spec, same requirement): client disconnect and turn timeout each
      abandon the pending question, terminate the child, and **release the slot** — this is the
      slot-leak hazard, not hygiene.

## 4. Web — AI v2 tab

- [ ] 4.1 Add the AI v2 surface (spec: *AI v2 tab*), **mounted-hidden**, with conversation/
      streaming/abort state **hoisted** above the panel. Test: switching tabs mid-stream neither
      aborts the turn nor clears the conversation.
- [ ] 4.2 Question view modelled on the demo's `QuestionView`: option cards + free-text fallback.
- [ ] 4.3 Catalog widget components — one per type — and the grid renderer driven by the layout
      DSL.
- [ ] 4.4 Previews render through the **real** components with sample data (spec: *Previews
      reflect the rendered result*). Test: preview and rendered widget resolve to the same
      component.
- [ ] 4.5 Sandboxed custom-widget frame (spec: *Model-authored markup is confined to a sandbox*).
      DOM test asserting the sandbox attributes and **absence of `allow-same-origin`**; assert no
      `dangerouslySetInnerHTML` exists anywhere outside this path.

## 5. Persistence

- [ ] 5.1 Storage per the gate's D5 ruling (session DB vs catalog DB), with validation on write
      (spec: *Dashboard persistence*).
- [ ] 5.2 Read/write endpoints scoped exactly as the session — a caller who cannot read the
      session gets `404` for its dashboards.

## 6. Docs + final gates

- [ ] 6.1 README: endpoint rows in the normative route table; document the egress/spend posture,
      the auth fallback behaviour, and the sandboxing guarantee.
- [ ] 6.2 Hermetic e2e over real SSE: a design turn, one question answered, a dashboard rendered.
- [ ] 6.3 Final gates: `npm run typecheck` + `npm test`, then `npm run e2e` (chromium +
      login-gate) **and** `npm run e2e:visual`. A new tab changes the strip, so visual diffs are
      expected branch-induced signal — **re-bless baselines in this branch's diff**, do not defer.

## Test-infra note (recorded debt — do not re-learn)

`vi.mock('node:child_process')` is **vacuous** through the shared `app` singleton: the eager `app`
build beats the hoisted mock. Any through-app spawn assertion must use the on-disk fixture's
invocation recording, not `spawnSpy`.
