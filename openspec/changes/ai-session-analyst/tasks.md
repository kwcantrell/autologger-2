# ai-session-analyst — Tasks

> Plan of record. Anchors are orientation only — locate code by content before editing.
> **Gated 2026-07-20** — adversarial panel (8 blockers) + owner gate passed; rulings folded
> across all four artifacts; post-gate consistency read recorded clean. See the design's
> "Panel & review log".
>
> **Phase 0 is BLOCKING and not yet run.** Design D1 (the security-option mapping) and D7
> (subprocess lifecycle) remain unverified hypotheses. A red result on 0.2 or 0.6 returns D0
> to the gate rather than being worked around.

## 0. De-risking spike (before D1/D2/D7 lock) — BLOCKING

The `ai-topics-chat` D4 lockdown was proven empirically before it was trusted. The first draft
of this change carried it over **by translation** and got **4 of 9 rows wrong**, every error
weakening the child (see the 2026-07-20 panel log). D1 is therefore an **unverified hypothesis**.
Lock nothing until this phase is green **against the corrected control set**; a red result on
0.2 or 0.6 sends D0 back to the gate (fallback: build on the existing CLI path).

**Every spike task below MUST be falsifiable.** State the attempt and the expected refusal —
never "confirm X is safe", which an implementer discharges as a checkbox.

- [ ] 0.0 Add `@anthropic-ai/claude-agent-sdk` to the server workspace, **pinned exactly** (not
      `^`). Record the repo-resolved version in `design.md`. Every citation in the panel log was
      read from a scratch install outside the repo; re-verify the load-bearing docstrings
      (`tools`, `allowedTools`, `strictMcpConfig`, `maxBudgetUsd`, `cwd`) against the pinned copy
      and correct D1 if they differ. This must precede 0.1–0.6, which cannot run without it.
- [ ] 0.1 Spike `settingSources: []` **with a control arm**: with the operator's real
      `~/.claude/settings.json` (which carries a `UserPromptSubmit` **shell hook**), assert the
      hook writes **no** sentinel under `settingSources: []`, **and** that the same hook **does**
      fire under `settingSources: ['user']`. Without the control arm a spike that fails for an
      unrelated reason reads as green. Also assert `claude login` still authenticates.
- [ ] 0.2 Spike the tool surface **by attempting escape, not by confirming intent**: with
      `tools: []` + the three-name `allowedTools`, have the model attempt a `Bash` call and a
      filesystem `Read`, and assert **both are refused**. Dump the init event's available-tools
      list and assert it contains exactly the three analyst tools. Then run the same with `tools`
      omitted and record the difference — that is the evidence for D2 layer 2. Separately assert
      whether `canUseTool` is invoked at all for (a) an allowlisted tool and (b) a
      non-allowlisted one; if it is not invoked for (a), D2 layer 4 is observability only and the
      design says so.
- [ ] 0.3 Spike `pathToClaudeCodeExecutable` against `CLAUDE_CLI_PATH`: assert
      `apiKeySource === 'oauth'` on the init message with `ANTHROPIC_API_KEY` **present in
      `process.env` but absent from the whitelist**, so the test cannot pass by accident. Then
      `resume` continuity across two turns, with `cwd` pinned outside the repo.
- [ ] 0.4 Pin the message taxonomy across the ~35-variant `SDKMessage` union: which variants
      carry assistant text vs reasoning/thinking; whether `includePartialMessages` is needed for
      incremental deltas at all (without it the "stream" may be a single end-of-turn dump); and
      how `aborted` / `supersedes` retraction interacts with text already relayed as `delta`.
- [ ] 0.5 Spike MCP source suppression: with the repo's checked-in `.mcp.json` (CodeGraph)
      present and `cwd` at the repo, assert the CodeGraph server **does** appear without
      `strictMcpConfig`, and **does not** appear with `strictMcpConfig: true`. This is the row
      the draft dropped entirely.
- [ ] 0.6 Spike the orphan case (design D7): abort mid-turn against a child that **ignores
      SIGTERM**, then assert via `ps` that no `claude` process from that turn survives. Repeat
      for the turn-timeout path. Determine whether the streaming-input `prompt` form is required
      for `interrupt()` to exist. **If no-orphan cannot be guaranteed, stop and re-gate** — this
      is the D0-reversing finding.
- [ ] 0.7 Record all results in `design.md` under "Resolved by the spike"; rewrite D1/D2/D7 to
      cite observed behaviour rather than translation, and drop the "unverified hypothesis"
      banner only when they do.

## 1. Gate + endpoint skeleton (server)

- [ ] 1.1 Config wiring: add **`AI_ANALYST_ENABLED`** alongside the existing `CLAUDE_CLI_PATH`
      in the server config layer and `server/.env.example` with comments, plus the per-turn
      budget var the spend requirement now mandates. Analyst off must not affect `ai/chat`.
      Decide and record whether the flag also gates the subtab's *visibility* — otherwise the
      tab renders and only fails on send.
- [ ] 1.2 TDD the route shell (spec: *Configuration-gated analyst endpoint*, *Open-network
      refusal*, *Analyst request contract*): integration tests first for the check order —
      auth → session `404` → config/open-network `503` → body `422`/`400` → slot `409` —
      asserting an unauthorized session masks as `404` before `503`/`409`, and that **no guard
      path spawns**. Then the route in `server/src/routers/ai.ts`, reusing `requireSession`
      and `ApiError` from `_helpers.ts`.

## 2. Read-only toolset (design D2, D3, D8, D9)

- [ ] 2.1 TDD the three tools (spec: *Read-only tool surface*): `get_transcript_words`,
      `list_topics`, `list_events` via `createSdkMcpServer` + `tool()` with Zod schemas.
      `sessionId` captured in the closure — **never a tool parameter**; hub resolved at call
      time via `registry.get(sessionId)`, never held across an `await`. The MCP server instance
      is built **per turn**, never hoisted to module scope (a shared instance would capture one
      `sessionId` and leak across sessions with no token layer left to catch it). Tests: no tool
      accepts a session id; each reads only; two concurrent turns on different sessions don't
      cross.
- [ ] 2.2 `list_events` is **router-shaped, not hub-shaped** (design D8): enrich with the
      operator-visible category label rather than returning the internal category id. This
      crosses the hub/catalog seam the existing MCP toolset never crossed — locate the existing
      enrichment helper by content and reuse it.
- [ ] 2.3 Bound the tool results (design D9, spec: *Read-only tool surface*): range/slice on
      `get_transcript_words`, paging on `list_events`, a documented cap on both, and an explicit
      truncation indicator in the result. Test with a realistically large transcript, not a
      fixture-sized one — the happy-path fixture will pass either way.
- [ ] 2.4 TDD the `canUseTool` gate: a tool name off the allowlist is denied with a message;
      `create_topic` specifically is denied; denials appear in `permission_denials`. Scope this
      to what spike 0.2 actually established about when the gate fires.

## 3. Analyst turn runner (design D1, D4, D5, D7)

- [ ] 3.1 **Closed-world** characterization test on the resolved options object (spec:
      *Subprocess security lockdown*). Assert the enumerated keys and values — `tools: []`,
      `settingSources: []`, three-name `allowedTools`, `disallowedTools`, `strictMcpConfig: true`,
      `permissionMode: 'dontAsk'`, `maxBudgetUsd`, `maxTurns`, `forkSession: false`, pinned
      `systemPrompt`, `cwd` outside repo/`DATA_DIR`, minimal `env` including `MCP_TOOL_TIMEOUT`
      — **and** assert `hooks`, `plugins`, `agents`, `extraArgs`, `additionalDirectories`, and
      any permission-bypass switch are **absent**. Value-pinning catches a change; only the
      closed-world assertion catches an addition. This is the tripwire for SDK version drift.
- [ ] 3.2 Implement the runner wrapping `query()`, translating `SDKMessage` → SSE per the
      taxonomy pinned in 0.4. Relay assistant text only; **never** reasoning/thinking.
- [ ] 3.3 TDD terminal-event discipline (spec: *Analyst SSE reply stream*): exactly one
      terminal event per completed stream; client abort emits none. Mirror the `guardedEmit`
      pattern in `aiChatRunner.ts` rather than re-inventing it.
- [ ] 3.4 TDD slot acquisition against the **shared** `AiChatTurnRegistry` (spec: *Spend and
      concurrency bounds*): a busy session `409`s across **both** agents; the process-wide
      ceiling is shared, not doubled; the `409` detail names the *other* agent when it holds the
      slot; the slot releases on every path **including a turn whose iterator never yields**.
- [ ] 3.5 TDD the resume guard (spec: *Multi-turn continuity*): a foreign/stale
      `analyst_session_id` is `422` **before** any spawn; an id issued to a **different
      principal** is `422`; an own id resumes. The analyst's id map is **separate** from the AI
      chat's — a chat id must never resume as an analyst conversation or the reverse.
- [ ] 3.6 Lifecycle (design D7, spec: *Subprocess and turn lifecycle*): implement per spike 0.6's
      finding — the streaming-input `prompt` form if `interrupt()` is required, otherwise a
      per-server tool `timeout` plus a timeout backstop **independent of the agent iterator**.
      Test: no orphan survives abort or timeout; a never-yielding iterator still ends and
      releases its slot.
- [ ] 3.7 TDD terminal-`error` scrubbing (spec: *Analyst SSE reply stream*): raw exception text,
      subprocess stderr, and agent error arrays never reach `{ detail }`.

## 4. Web — Analyst subtab (design D9 of ai-topics-chat)

- [ ] 4.1 Add `Analyst` to `AI_SUBTABS` in `AiPanel.tsx`, rendered **mounted-hidden**, with
      conversation/streaming/abort state **hoisted** into `AiPanel` (spec: *Analyst subtab*).
- [ ] 4.2 Build the panel modelled on `AiChat.tsx` (SSE consumption, Stop button, abort). The
      client MUST NOT wait for a terminal event after Stop.
- [ ] 4.3 Test: switching subtabs mid-stream neither aborts the turn nor clears the conversation.

## 5. Docs + final gates

- [ ] 5.1 README: add the endpoint row to the normative route table, and document the analyst's
      egress/spend posture and read-only guarantee alongside the AI chat disclosure.
- [ ] 5.2 Hermetic e2e over real SSE for the happy path.
- [ ] 5.3 Final gates: `npm run typecheck` + `npm test`, then `npm run e2e` (chromium +
      login-gate) **and** `npm run e2e:visual`. The subtab strip changes, so visual diffs are
      expected branch-induced signal — **re-bless baselines in this branch's diff**, do not
      defer the drift.

## Test-infra note (recorded debt — do not re-learn)

`vi.mock('node:child_process')` is **vacuous** through the shared `app` singleton: the eager
`app` build beats the hoisted mock. Any through-app spawn assertion must use the on-disk
`fake-claude` fixture's argv/invocation recording, not `spawnSpy`. Check whether the fixture
needs an SDK-shaped analogue during 0.4.
