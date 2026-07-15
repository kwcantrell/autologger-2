# ai-topics-chat — Tasks

> Plan of record. Anchors are orientation only — locate code by content before editing.
> Gated by the 2026-07-14 panel + gate (rulings folded into proposal/spec/design).

## 0. De-risking spike (before D3/D4 lock)

- [x] 0.1 Spike bundle run against 2.1.202 (2026-07-14) — all green, results in design.md
      "Resolved by the 2026-07-14 spike": (a) `--setting-sources ""` keeps `claude login`
      auth + loads our `--mcp-config`; (b) `--tools ""` leaves ONLY the MCP tools available
      (built-ins gone) and MCP tool ran under `permissionMode: default` via `--allowedTools`
      with no prompt; (c) `--mcp-config` inline JSON with `type:"http"` + bearer header
      connected (no SSE fallback needed); (d) `--resume` across two spawns sharing a stable
      cwd recalled context; (e) taxonomy pinned — partial+full double-emit confirmed (relay
      full `assistant` messages, drop `stream_event` partials) and thinking blocks present
      (MUST filter). Hook suppression confirmed (project hook fired only under
      `--setting-sources project`, suppressed under `""`).

## 1. Gate + endpoint skeleton (server)

- [x] 1.1 Config wiring: add `CLAUDE_CLI_PATH`, `AI_CHAT_TIMEOUT_SEC` (default 300),
      `AI_CHAT_MAX_CONCURRENT` (small default), and the per-turn budget var to the server
      config layer (`server/src/node/`) and `server/.env.example` with comments; unset/
      blank/whitespace `CLAUDE_CLI_PATH` means feature off.
- [x] 1.2 TDD the route shell (spec: Configuration-gated endpoint; Open-network refusal;
      Chat request contract): int tests first for the check order — auth → session `404`
      → open-network/config `503` → body `422`/`400` → single-flight `409` — asserting an
      unauthorized session masks as `404` before `503`/`409`, an anonymous non-loopback
      no-allowlist bind returns `503`, and bad bodies spawn nothing; then the Hono router
      (`server/src/routers/ai.ts`) wired in `app.ts`.

## 2. In-process MCP server (design D3)

- [x] 2.1 Add `@modelcontextprotocol/sdk` to the server workspace; implement the
      loopback-only ephemeral-port Streamable-HTTP listener with per-connection transport,
      per-turn registration (session id + ≥128-bit bearer, dropped on turn end), and
      bearer validation at the HTTP layer before dispatch; unit tests: rejects
      missing/stale/expired tokens, never binds non-loopback, two concurrent turns on
      distinct sessions don't cross-talk.
- [x] 2.2 TDD the three tools (spec: Session-scoped MCP toolset): `get_transcript_words`
      and `list_topics` read via `registry.get()` at call time (never held across an
      `await`) with hub row fields; `create_topic` validates with `topicCreateSchema`
      bounds (tool error on violation, no insert) and writes through
      `SessionHub.insertTopic` — int test asserts the row is indistinguishable from a
      manual insert (server-assigned ordinal, no WS emission — topics have none) and that
      no tool parameter can address another session.

## 3. CLI turn runner (design D4–D6, D8)

- [x] 3.1 Build the hermetic fake-`claude` fixture (design D10): records argv to a file,
      reads the prompt from stdin, emits canned stream-json matching the 0.1-captured
      taxonomy (init/session_id, partial text, `tool_use`, result), supports failure modes
      (nonzero exit, garbage output, not-logged-in, hang for timeout tests).
- [x] 3.2 TDD spawn + lockdown (spec: Subprocess security lockdown): characterization test
      pins the full argv verbatim — `-p --output-format stream-json`, `--setting-sources
      ""`, built-in denial + `--allowedTools` with exactly the three `mcp__autologger__*`
      tools, `--strict-mcp-config --mcp-config <generated>`, `--append-system-prompt`
      brief (D7), no `--fork-session` — plus `shell: false`, message on stdin, stable
      per-session cwd outside repo/`DATA_DIR`, minimal env (`HOME`,`PATH`,+proxy), and the
      generated config content written `0600` and cleaned up. Scenario tests: prompt-
      injected shell request executes nothing; a `--`-prefixed message is prompt text, not
      a flag; operator hooks/plugins do not fire.
- [x] 3.3 TDD stream relay (spec: SSE reply stream shape; Multi-turn continuity):
      JSONL → SSE mapping with the D6 dedup rule (`delta`/`tool` with short tool names/
      `done` with `claude_session_id`/scrubbed `error` from the fixed string set), exactly
      one terminal event per completed stream, unknown-event forward-compat, `--resume`
      passed only for a `claude_session_id` issued for this `:sessionId` (foreign id →
      `422`, no spawn).
- [ ] 3.4 TDD spend + lifecycle (spec: Spend and concurrency bounds; Subprocess
      lifecycle): per-session `409`, process-wide `AI_CHAT_MAX_CONCURRENT` rejection,
      per-turn budget flag passed, process-group SIGTERM→SIGKILL on done/timeout/
      best-effort-disconnect (fixture hang mode is the guaranteed-path test), registration
      + token + config dropped with the child, no orphan processes after each test.

## 4. Web workspace (design D9)

- [ ] 4.1 Tab restructure in `SessionWorkspace.tsx`: top-level `Event Feed | AI`,
      nested `Chat | Transcribe | Topics` (default Chat) with panels **mounted-hidden**
      (not conditional-mount) and chat state/stream hoisted to the AI-panel level so
      switching preserves the turn; `TranscribeFeed`/`TopicsFeed` unchanged (spec: AI tab
      and subtab arrangement) — component tests cover switching mid-turn without unmount
      and feed presence.
- [ ] 4.2 `AiChat` component: ephemeral message state, `fetch` + ReadableStream SSE
      parsing (ignoring unknown event types + comments), `claude_session_id` echo of the
      latest `done`, tool-activity chips, topics query invalidation on a `tool` event
      naming `create_topic`, a Stop control (`AbortController.abort()`), plain-text
      (no-markdown) rendering, `503` not-configured explainer, `error`-event rendering
      (spec: Ephemeral chat history; AI tab and subtab arrangement) — tests with a mocked
      SSE response including Stop-mid-stream.

## 5. Docs + final gates

- [ ] 5.1 README + `.env.example`: endpoint-table row for `POST …/ai/chat`; AI chat
      section (egress + spend/bounds disclosure, `CLAUDE_CLI_PATH`/timeout/concurrency/
      budget vars, open-network refusal, security posture — no operator hooks/plugins/
      CLAUDE.md, MCP-only, no host shell, run-as-logged-in-operator + node-on-PATH/proxy
      notes, minimum tested CLI version) (spec: Egress and spend disclosure).
- [ ] 5.2 Final gates: `npm run typecheck`, `npm test`, `npm run lint`, `npm run e2e`
      (chromium + login-gate) with a hermetic happy-path chat e2e (`CLAUDE_CLI_PATH` →
      fixture, real SSE over real HTTP), and `npm run e2e:visual` — the tab restructure
      legitimately alters workspace UI, so re-bless the affected visual baselines in this
      change's diff rather than deferring drift.
