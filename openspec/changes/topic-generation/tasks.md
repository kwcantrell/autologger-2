# topic-generation — tasks

> Plan of record. **Provisional until the adversarial panel + owner gate.** On branch
> `topics-generate` off `main`. Locate code by content. Every commit gated by `npm run
> typecheck` + `npm test`. Phases touching the frozen contract surface (3) and the
> CLI-spawn/AI-turn seam (2, 3) get a per-phase review at apply time.

## 1. Characterize the seam

- [ ] 1.1 Add a characterization integration test pinning the **current** `topics/generate`
  behavior: `POST /api/sessions/:id/topics/generate` returns `503 {detail}` with the current
  detail; and the `requireSession` guard is unchanged. (`transcribe.int.test.ts` already has
  a 503 assertion — extend/keep it; it is updated in phase 3.)

## 2. Shared turn helper + topic/budget primitives + one-shot generate (ai/chat seam — review FULL)

- [ ] 2.1 **Extract the shared `driveAiTurn` helper** (design D7) from the inline block in
  `routers/ai.ts` (`getAiMcpListener → registerTurn → spawnAiChatTurn → runAiChatTurn` +
  the `finally`: `killAiChatProcessGroup` + `mcpTurn.dispose()` + `cleanupConfig()` +
  `slot.release()`). Signature ~ `driveAiTurn({cliPath, sessionId, message, allowedTools?,
  maxBudgetUsd, timeoutMs, emit, abortSignal?}) → AiChatTurnOutcome`. **Rewire `ai/chat` to
  call it** (SSE-writing `emit`, its existing abortSignal) — behavior-preserving; `ai.int.test.ts`
  MUST pass unmodified (this touches the frozen `ai/chat` path).
- [ ] 2.2 Add a bulk `deleteTopics(ids: string[])` hub RPC (`SessionHub`/`TopicStore`, one
  transaction; the D3 swap primitive — NOT clear-all/restore), and a new
  `TOPIC_GENERATE_MAX_BUDGET_USD` (+ optional `TOPIC_GENERATE_TIMEOUT_SEC`) config in `env.ts`,
  defaulted higher than the chat's (design D6). Unit-test `deleteTopics` (deletes only the given
  ids, leaves others) + the config default.
- [ ] 2.3 Add the one-shot generate function: calls `driveAiTurn` with **`list_topics`
  withheld** (allowedTools = `get_transcript_words` + `create_topic`), a fixed one-shot user
  message (design D5), the dedicated budget/timeout (D6), a no-op `emit`, and **no abortSignal**
  (D2); returns the `AiChatTurnOutcome`. Unit-test vs `fake-claude.mjs`: success on a `result`
  line; failure on CLI error/timeout; and that the spawned argv's allowedTools excludes
  `list_topics`.

## 3. Route handler — crash-safe swap (frozen-surface phase — review FULL)

- [ ] 3.1 Replace the `503` stub in `routers/transcribe.ts` `topics/generate` with the gated
  handler (design D3), ordered: `requireSession` → `aiChatConfigured` (`503`) +
  `aiChatOpenNetworkRefused` (`503`) → transcript precondition (`400` if no transcript words,
  D4) → `aiChatTurns` acquire (`409`) → **record pre-run topic ids** → run the one-shot
  generate (2.3) → `newIds = current − preRunIds`; **success** (`newIds.length ≥ 1`):
  `deleteTopics(preRunIds)` → `200 {listTopics()}`; **failure** (turn failed OR
  `newIds.length === 0`): `deleteTopics(newIds)` → `502` (prior topics untouched). The turn
  slot + the helper's full cleanup release in a `finally`. The `502` body is a fixed
  handler-owned message (not the CLI outcome token).
- [ ] 3.2 Update the characterization test (1.1) + add integration coverage (fake-claude):
  unconfigured → `503` byte-for-byte; open-network → `503`, no spawn; no-transcript → `400`,
  no spawn; concurrency (slot held) → `409`, no spawn; success → `200 {topics}` with the fresh
  set replacing the old (shape matches `GET …/topics`); **CLI failure → `502` with the prior
  topics unchanged BYTE-FOR-BYTE (assert same ids/ordinals/timestamps) — seed a partial-new
  state (some topics already created this run) before the failure to prove `deleteTopics(newIds)`
  removes only the run's topics**; zero-topics-created → `502` with prior topics intact;
  `transcribe.csv` still `503`. Also assert the spawned argv withholds `list_topics`.

## 4. Docs

- [ ] 4.1 Update `README.md`: move `topics/generate` out of the unconditional-`503` rows into
  a configuration-gated row (gated on `CLAUDE_CLI_PATH`, alongside the AI chat disclosure),
  noting the replace-all semantics + transcript precondition + shared AI-turn spend bound.
  Keep `transcribe.csv` in the `503` row. Correct any now-stale "topics/generate keeps its
  intentional 503" claim in README/CLAUDE.md.

## 5. Final gates

- [ ] 5.1 `npm run typecheck` + `npm test` green.
- [ ] 5.2 `npm run e2e` (chromium + login-gate). No web change expected (the generate button
  already posts `topics/generate`); run `e2e:visual` to confirm no drift (the pre-existing
  16-baseline main drift stays out of scope) — do not re-bless.
