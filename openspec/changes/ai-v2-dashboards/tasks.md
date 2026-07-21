# ai-v2-dashboards — Tasks

> Plan of record. Anchors are orientation only — locate code by content before editing.
> **Gated 2026-07-21** — four-mandate adversarial panel (~20 blockers) + owner gate passed;
> rulings folded across all four artifacts. See the design's "Panel & review log".
>
> **Phase 0 ran green** — 0.4 and 0.5, the potentially-fatal spikes, both passed; the SDK option
> set and lifecycle are confirmed, not hypotheses (see design.md "Resolved by the spike" and the
> `.apply` reports). **Still blocking, not yet run:** Phase 0b (the data work is sequenced ahead
> of the catalog).
>
> **Gate rulings that reshaped this plan:** the custom-widget iframe is **cut from v1**; the
> built-in tool set is **exactly the interactive question tool** (`tools: []` would strip it and
> kill the feature); dashboards are **edited directly** after the agent seeds them; and
> "data unavailable" is a **first-class rendered state**, never zeros.
>
> **Private reference:** `~/Desktop/autologgers-demo.html` embeds a real conversation with
> personal and financial detail. Read it for structure only — its content must never appear in
> code, tests, fixtures, seed data, or commits.

## 0. De-risking spike — BLOCKING

The predecessor change (`ai-session-analyst`) established the SDK lockdown mapping but was
superseded before its spike ran, so the option set was an unverified hypothesis and the
lifecycle question was open. **The spike has since run and come back green** — 0.4 and 0.5, the
potentially-fatal tasks, both passed, confirming the option set and lifecycle; see design.md
"Resolved by the spike".

Every spike task MUST be falsifiable: state the attempt and the expected refusal, never
"confirm X is safe" — which an implementer discharges as a checkbox.

- [x] 0.1 Add `@anthropic-ai/claude-agent-sdk` to the server workspace, **pinned exactly** (not
      `^`). Record the repo-resolved version in `design.md` and verify the load-bearing docstrings
      (`tools`, `allowedTools`, `strictMcpConfig`, `maxBudgetUsd`, `cwd`, `managedSettings`)
      against the pinned copy; correct D8 if they differ.
- [x] 0.2 Spike the tool surface **by attempting escape**: with `tools: []` plus the analyst
      allowlist, have the agent attempt a shell call and a filesystem read and assert **both are
      refused**. Dump the init event's available-tools list and assert it contains exactly our MCP
      tools plus `AskUserQuestion` and the named SDK-infrastructure tools. Record whether
      `canUseTool` fires for an allowlisted tool — if it does not, D8's layering is observability
      only and the design must say so.
- [x] 0.3 Spike the hook holes **with control arms**: (a) user tier — assert the operator's real
      `UserPromptSubmit` hook writes no sentinel under `settingSources: []` **and** does fire under
      `settingSources: ['user']`; (b) project tier — plant a hook in a `.claude/settings.json`
      inside a candidate `cwd`, assert it fires there and **does not** fire under our pinned `cwd`.
      Without the control arms a spike that fails for an unrelated reason reads as green.
- [x] 0.4 Spike `AskUserQuestion` under **our** option set — **potentially fatal, run this first
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
- [x] 0.5 Spike the orphan case: abort mid-turn against a child that **ignores SIGTERM**, then
      assert via `ps` that no agent process from that turn survives. Repeat for the timeout path.
      Determine whether the streaming-input prompt form is required for `interrupt()` to exist.
      **If no-orphan cannot be guaranteed, stop and re-gate.**
- [ ] 0.6 *(removed — the custom-widget iframe was cut from v1 at the 2026-07-21 gate.)*
- [x] 0.7 Resolve the inherited **`safeMode` conflict** (design D8b): it was an *unresolved
      escalation* in the predecessor, not a settled item, and supersession cannot discharge it.
      Determine whether `settingSources: []` + `strictMcpConfig: true` + pinned `cwd` already close
      what `--safe-mode` closes; if not, whether a named exact-match `extraArgs` exception is
      workable against the closed-world test; and whether it would disable our own MCP tools.
- [x] 0.8 Use `resolveSettings()` to verify the effective settings cascade **without spawning** —
      cheaper than a live spike for several D8 claims, including whether `managedSettings` actually
      carries `disableClaudeAiConnectors` through its restrictive-only filter (it is not in an
      enumerated allowlist category, and the documented failure mode is *silent* dropping).
- [x] 0.9 Establish an observable **no-spawn assertion on the SDK path**. The recorded
      test-infra workaround (`fake-claude` fixture argv recording) was built for the CLI transport;
      it is not established that it reaches the SDK's own transport. The spec asserts "no guard
      path SHALL spawn" and must be testable.
- [x] 0.10 Record results in `design.md` under "Resolved by the spike"; rewrite D7/D8 to cite
      observed behaviour, and drop the hypothesis framing only when they do.

## 0b. Data-first prerequisites (owner ruling — sequenced AHEAD of the catalog)

Design D2b. These are schema/ingest concerns, each warranting its own change and gate rather than
being smuggled in here. Listed so the dependency is explicit and the catalog is not built on data
that does not exist.

- [x] 0b.1 **SHIPPED via `persist-deepgram-enrichment`** (archived
      `openspec/changes/archive/2026-07-21-persist-deepgram-enrichment`, merged to `main`
      2026-07-21; folded into this branch by the 2026-07-21 sync-to-main rebase). Persists DeepGram
      `paragraphs` in `session_transcript_paragraphs` (nullable timeline `start_sec`/`end_sec`;
      NULL ≠ 0 preserved for anchorless rows), read via synchronous
      `SessionHub.listTranscriptEnrichment()` — no HTTP route, non-contract-bearing. `utterance_counts`
      now has a real boundary. Superseded here, not re-implemented.
- [x] 0b.2 **SHIPPED via `persist-deepgram-enrichment`** (same change). Persists DeepGram `sentiment`
      segments in `session_transcript_sentiment` (nullable timeline secs, malformed indices
      clamped/dropped). **Note:** the session-level sentiment *average* was **deferred** at that
      change's gate (DeepGram returns one average per codec group with no defined multi-group
      combination) — a consumer computes any roll-up from the stored segments. Superseded here, not
      re-implemented. The spec's `catalog` still bars a `sentiment` widget type until this data is
      wired into a widget (D2/D2b): 0b.2 unblocks the *data*, not the widget registration.
- [ ] 0b.3 **DEFERRED to its own post-v1 change** (owner decision 2026-07-21). Populate word timings
      on the manual-entry path (or derive them) and resolve speaker **names** rather than diarization
      indices. Not v1-blocking: DeepGram-anchored sessions already carry real timings from the
      enrichment remap; manual/anchorless transcripts render the degraded "unavailable" state (task
      4.7); v1 shows honest `Speaker N` labels for unresolved diarization indices — never zeros.
- [ ] 0b.4 **DEFERRED to Phase 6 QA** (owner decision 2026-07-21). Create a live reference session
      via the **DeepGram path** (a key in `server/.env` + real audio) — YouTube import stays `503`,
      so no URL import. Phase 1 aggregate tests use **synthetic** fixtures (task 1.1) plus the real
      captured DeepGram fixture already shipped with `persist-deepgram-enrichment`, so a live session
      is a demo/QA artifact, not a Phase 1 prerequisite.

> 0b.1/0b.2 have landed (see above). Until **0b.3** lands, widgets depending on word timings (talk
> time, duration) and on resolved speaker names render their **unavailable state** (task 4.7) on
> manual/anchorless transcripts rather than showing zeros — and DeepGram-anchored sessions render
> real timings. That is the degraded-state ruling working as intended, and it is what lets 0b.3 be
> sequenced independently of the catalog rather than blocking it.

## 1. Aggregates + catalog schema (server, no agent yet)

- [x] 1.1 TDD the aggregate computations over fixture transcripts (spec: *Session-scoped aggregate
      toolset*): speaker talk-time, utterance/question/filler counts, session duration, topic
      timeline, event counts/density. Assert invariants — talk-time sums to session duration,
      counts match hand-computed fixtures. Build fixtures from **synthetic** data, never from the
      private reference dashboard.
- [x] 1.2 TDD the widget-catalog + layout schema (spec: *Widget catalog is a closed set*, *Layout
      and interaction vocabulary*): unknown widget type rejected; undefined interaction rejected;
      interaction targeting a missing widget id rejected; a sentiment type is **absent** from the
      catalog. Zod, mirroring the repo's existing schema conventions.

## 2. Design-turn endpoint + agent (server)

- [x] 2.1 Config wiring: the AI v2 enable flag, the auth pair (key preferred; login fallback
      loopback-only + loud startup log), and the per-turn budget, in the server config layer and
      `server/.env.example`. AI v2 off must not affect the AI chat.
- [x] 2.2 TDD the route shell (spec: *Configuration-gated*, *Open-network refusal*, *Design turn
      contract*): integration tests first for the guard order — auth → session `404` →
      config/open-network `503` → body `422`/`400` → slot `409` — asserting an unauthorized session
      masks as `404` and that **no guard path spawns**. Reuse `requireSession` and `ApiError`.
- [ ] 2.3 **Closed-world** characterization test on the resolved SDK options (spec: *Subprocess
      security lockdown*): assert `tools: ['AskUserQuestion']` (the one-element closed base set —
      **not** `tools: []`, which Spike 0.4 proved strips the tool and kills the feature),
      `permissionMode: 'plan'` (**not** `'dontAsk'`, which bypasses `canUseTool`),
      `settingSources: []`, `strictMcpConfig: true`, pinned `cwd`, isolated config dir,
      `maxBudgetUsd`, `forkSession: false`, pinned system prompt, minimal env,
      `settings.askUserQuestionTimeout` (**not** via `managedSettings`),
      `managedSettings.disableClaudeAiConnectors`, and `previewFormat` at its `'markdown'` default
      — **and** assert `hooks`/`plugins`/`agents`/`extraArgs`/`additionalDirectories`/
      permission-bypass are **absent**. Do **not** hard-code `ToolSearch`/`ExitPlanMode` as
      required `canUseTool`-passers — Spike 0.4 found they don't request passage in minimal turns.
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
- [ ] 4.5 Assert **no `dangerouslySetInnerHTML` exists anywhere in the repo** (spec: *No
      agent-authored markup is ever rendered*) — a repo-wide grep test, no exceptions. Additionally
      assert no catalog component passes a config string into `href`, `src`, `style`, or any
      charting-library option documented to accept markup.
- [ ] 4.6 Direct-manipulation editing (spec: *Dashboards are edited directly*): add, remove,
      resize, reposition, retitle — persisted without running a design turn. Test: a saved
      dashboard is modified end-to-end with no agent turn.
- [ ] 4.7 Degraded-state rendering per widget (spec: *Data unavailability is a rendered state*):
      each component renders an explicit unavailable state naming the missing data. Test against a
      manually-entered transcript fixture (no timings) and an anchorless fixture — assert **no
      zeros are rendered as data**.

## 5. Persistence

- [ ] 5.1 Storage per the gate's D5 ruling (session DB vs catalog DB), with **whole-config**
      validation on write (spec: *Dashboard persistence*): every string field length-bounded and
      schema-constrained; a field that would be interpreted as markup, a URL, or code is rejected.
      Test: a widget title containing HTML is stored as text and renders inert; a `javascript:`
      URI is rejected on write.
- [ ] 5.2 Read/write/delete endpoints. Read scoped exactly as the session (`404` otherwise); write
      scoped at least as tightly; stored configs record `created_by` and the originating turn.
- [ ] 5.3 Bounds (spec: *Dashboard persistence*): per-session dashboard count, per-dashboard widget
      count, and serialized config size — each rejected on write when exceeded. Test the render-side
      guard too: a dashboard declaring an absurd widget count does not hang the viewer.

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
