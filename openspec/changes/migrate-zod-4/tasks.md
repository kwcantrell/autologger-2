# Tasks

**Branch and commits**
- The first commit on `migrate-zod-4` holds only `openspec/changes/migrate-zod-4/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `z4-<task>-<red|green>.log`, and each `Evidence:` line
  names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and `Evidence:` stay in one block with no blank line.

**Commands**
- `cd server && npx vitest run --project unit --project integration --project pg`.
- `npx vitest run` in `packages/contract`, `packages/session-core`, `packages/ai-runtime` and
  `packages/storage`.
- `cd web && npx vitest run`.
- `npm run typecheck`.

**Never run `npm update` or `npm audit fix`** (design D1).

## 1. Baselines

- [x] 1.1 On the base commit, run the full suites and record the counts, plus `npm ls zod @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk` (expect `invalid`). Known flakes, record if they recur: storage "8 contending", `catalogContention.pg` cross-team retry, `aiMcpServer` "Cap holds under concurrent calls".
  - Evidence: base e645e421; server `npx vitest run --project unit --project integration --project pg` -> `Test Files 130 passed | 3 skipped (133)`, `Tests 1651 passed | 4 skipped (1655)`; contract 60, session-core 41, ai-runtime 181, storage 133 passed; web 1689 passed; `npm run typecheck` exit 0; `npm ls zod @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk` -> `zod@3.25.76 invalid: "^4.0.0" from node_modules/@anthropic-ai/claude-agent-sdk`, exit 1; no known flake recurred (logs `z4-1.1-server.log`, `z4-1.1-{contract,session-core,ai-runtime,storage,web,typecheck,npmls}.log`)
- [x] 1.2 Record the tool input schemas on the base: a one-off script, not committed, dumps `tools/list` for each MCP chat tool set (chat, generation) and for the aggregate tools. Save the JSON as `z4-1.2-tools-before.json`. Also record the parsed outputs of every request schema with a `.default` or `.transform`, for the inputs (c) uses, as `z4-1.2-parse-before.json`.
  - Evidence: `tsx z4/dump.mts` (scratchpad, not committed) -> `tools: chat=get_transcript_words,list_topics,create_topic | generation_event=…,create_event | generation_topic=… | aggregate=speaker_stats,utterance_stats,topic_timeline,event_stats,transcript_excerpt,propose_dashboard`, `parse schemas: 15` (26 inputs, all parsed) (log `z4-1.2-before.log`; `z4-1.2-tools-before.json`, `z4-1.2-parse-before.json`)

## 2. Tests first (design D3)

- [x] 2.1 Add `packages/contract/src/schemas.zod4.test.ts` with cases (a) to (e) from D3. Run it on zod 3: (a) and (e) must be red, and (b), (c) and (d) must be green.
  - Evidence: `cd packages/contract && npx vitest run src/schemas.zod4.test.ts` on zod 3.25.76 -> `Tests 3 failed | 35 passed (38)`; red: (a) `expected { code: 'invalid_type', …(4) } to not have property "received"`, (e) duration_sec and peaks `expected true to be false`; (b), (c), (d) green (log `z4-2.1-red.log`)
- [x] 2.2 Add `server/src/routers/validationBody.int.test.ts` covering the D3 route cases, and `server/src/zodSingleCopy.repo.test.ts` (the lockfile guard). Run both on zod 3 and record the reds: the non-finite topic and the lockfile guard.
  - Evidence: `npx vitest run --project integration src/routers/validationBody.int.test.ts` on zod 3 -> `Tests 1 failed | 3 passed (4)`, red: non-finite topic `expected 201 to be 422` (log `z4-2.2-red-int.log`); `npx vitest run --project unit src/zodSingleCopy.repo.test.ts` -> `Tests 2 failed | 1 passed (3)`, red: `expected '3.25.76' to match /^4\./`, `@anthropic-ai/sdk` `expected undefined to be defined`; the dependencies check is green (log `z4-2.2-red-repo.log`)

## 3. Migrate (design D1, D2)

- [x] 3.1 Edit the three manifests by hand per D1, then run a plain `npm install`. Check that `npm ls zod --json` shows one copy at 4.x, that `npm ls @anthropic-ai/claude-agent-sdk zod @anthropic-ai/sdk` exits 0, and that the lockfile guard is green. Record the lockfile diff summary: changed package names, which must match D1's expected list.
  - Evidence: manifests edited by hand, then `npm install` -> exit 0, `found 0 vulnerabilities` (log `z4-3.1-install.log`); `npm ls zod --json` -> exit 0, one version `4.6.5` (`z4-3.1-npmls-zod.json`); `npm ls @anthropic-ai/claude-agent-sdk zod @anthropic-ai/sdk` -> `zod@4.6.5`, `@anthropic-ai/sdk@0.131.0`, exit 0, no invalid (log `z4-3.1-npmls.log`); lockfile guard -> `Tests 3 passed (3)` (log `z4-3.1-green-repo.log`); lockfile diff -> CHANGED zod 3.25.76->4.6.5, @babel/runtime dev:true->prod, workspace entries server/contract/ai-runtime; ADDED @anthropic-ai/sdk 0.131.0, @stablelib/base64, fast-sha256, json-schema-to-ts, standardwebhooks, ts-algebra; nothing else (log `z4-3.1-lockdiff.log`)
- [x] 3.2 Code per D2: the five `z.record` calls, plus any typecheck-forced change, each recorded. `npm run typecheck` exits 0. 2.1 and 2.2 are green, and so are `schemas.test.ts`, `aiV2Catalog.test.ts` and `crossPackageErrorIdentity.int.test.ts`, unchanged.
  - Evidence: the five `z.record(z.unknown())` -> `z.record(z.string(), z.unknown())` (schemas.ts:26, :68, :365; mcpTools.ts:302, :305); typecheck forced no other change: `npm run typecheck` -> exit 0 (log `z4-3.2-typecheck.log`); contract `npx vitest run src/schemas.zod4.test.ts src/schemas.test.ts src/aiV2Catalog.test.ts` -> `Tests 98 passed (98)` (log `z4-3.2-green-contract.log`); server `npx vitest run --project unit --project integration src/zodSingleCopy.repo.test.ts src/routers/validationBody.int.test.ts src/crossPackageErrorIdentity.int.test.ts` -> `Tests 9 passed (9)` (log `z4-3.2-green-server.log`)

## 4. Verify

- [x] 4.1 Full suites as 1.1. Compare counts and explain every difference. No existing test assertion changed (D5).
  - Evidence: server -> `Test Files 1 failed | 131 passed | 3 skipped (135)`, `Tests 1 failed | 1657 passed | 4 skipped (1662)`: the failure is the known flake `catalogContention.pg` cross-team retry (`expected [ 'fulfilled', 'rejected' ]`), rerun once -> `Tests 1 passed (1)` (logs `z4-4.1-server.log`, `z4-4.1-rerun-contention.log`); vs 1.1: +2 files, +7 tests = `validationBody.int.test.ts` (4) and `zodSingleCopy.repo.test.ts` (3). contract 98 (60 + 38 in `schemas.zod4.test.ts`); session-core 41, ai-runtime 181, web 1689, unchanged; storage `1 failed | 132 passed`: the known flake "8 contending" (`repetition 3: 1/8 exhausted`), rerun once -> `Tests 133 passed (133)` (logs `z4-4.1-{contract,session-core,ai-runtime,storage,web}.log`, `z4-4.1-rerun-storage.log`); `npm run typecheck` exit 0 (log `z4-4.1-typecheck.log`); `git diff --stat e645e421 HEAD` -> no existing test file touched (D5)
- [x] 4.2 Re-run the 1.2 script. The tool schemas differ from the before file only in the ways D4 lists. The parsed outputs are identical.
  - Evidence: `tsx z4/dump.mts` -> same tool sets as 1.2 (log `z4-4.2-after.log`); key-order-insensitive tools diff -> only `additionalProperties: false` removed (from all 8 tools that had it), `transcript_excerpt` offset/limit `integer`+`minimum` -> `number`, `propose_dashboard` record items gain `propertyNames: {type: string}`; descriptions kept; the raw diff also moves `description` before `type` (key order only); chat shapes have no `.int()` fields, so none became `integer` (logs `z4-4.2-tools-sorted.diff`, `z4-4.2-tools.diff`); `diff z4-1.2-parse-before.json z4-4.2-parse-after.json` -> exit 0, identical (log `z4-4.2-parse-raw.diff`)
- [x] 4.3 Live check on the dev stack (`docker restart autologger-dev-app`, then the gate):
  - a `422` probe;
  - an AI chat turn that calls `create_topic`, so the MCP SDK and zod 4 tools run;
  - an AI v2 design turn that calls an aggregate tool, so the Agent SDK `tool()` gets zod 4 shapes.
  Login needs the owner's temporary session row.
  - Evidence: `make dev-up` rebuilt the dev image (container `zod` 4.6.5); owner-created temporary login row, deleted afterwards (API back to 401) (log `z4-4.3-live.log`). 422 probes: `POST /api/sessions {"title":"x"}` -> `422 {"detail":[{"expected":"string","code":"invalid_type","path":["show_id"],"message":"Invalid input: expected string, received undefined"}]}`; `POST …/topics` with `"duration_sec":1e400` -> `422` `invalid_type` path `["duration_sec"]`, topics stayed 0. AI chat on ATS_0098: SSE `event: tool {"name":"create_topic"}`, reply "Done. I added the topic \"zod4 live check\"…", topics 0 -> 1 (`['zod4 live check']`). AI v2 design turn calling `transcript_excerpt` offset 0 limit 5 -> `"Alright. So here we are,"`, equal to the first five rows of `catalog.session_transcript_words` for the session ("Alright. So here we are,"), so the Agent SDK aggregate tools run with zod 4 shapes; a `speaker_stats` turn answered "There is 1 speaker in this session (diarization id \"0\")".
- [ ] 4.4 Check that the README's zod note (README.md:601-603) is still accurate, and edit it only if not. Then `scripts/check-change.sh` (all gates) and the tier 2 `consistency-read` pass.
