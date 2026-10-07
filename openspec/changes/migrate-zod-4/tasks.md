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

- [ ] 2.1 Add `packages/contract/src/schemas.zod4.test.ts` with cases (a) to (e) from D3. Run it on zod 3: (a) and (e) must be red, and (b), (c) and (d) must be green.
- [ ] 2.2 Add `server/src/routers/validationBody.int.test.ts` covering the D3 route cases, and `server/src/zodSingleCopy.repo.test.ts` (the lockfile guard). Run both on zod 3 and record the reds: the non-finite topic and the lockfile guard.

## 3. Migrate (design D1, D2)

- [ ] 3.1 Edit the three manifests by hand per D1, then run a plain `npm install`. Check that `npm ls zod --json` shows one copy at 4.x, that `npm ls @anthropic-ai/claude-agent-sdk zod @anthropic-ai/sdk` exits 0, and that the lockfile guard is green. Record the lockfile diff summary: changed package names, which must match D1's expected list.
- [ ] 3.2 Code per D2: the five `z.record` calls, plus any typecheck-forced change, each recorded. `npm run typecheck` exits 0. 2.1 and 2.2 are green, and so are `schemas.test.ts`, `aiV2Catalog.test.ts` and `crossPackageErrorIdentity.int.test.ts`, unchanged.

## 4. Verify

- [ ] 4.1 Full suites as 1.1. Compare counts and explain every difference. No existing test assertion changed (D5).
- [ ] 4.2 Re-run the 1.2 script. The tool schemas differ from the before file only in the ways D4 lists. The parsed outputs are identical.
- [ ] 4.3 Live check on the dev stack (`docker restart autologger-dev-app`, then the gate):
  - a `422` probe;
  - an AI chat turn that calls `create_topic`, so the MCP SDK and zod 4 tools run;
  - an AI v2 design turn that calls an aggregate tool, so the Agent SDK `tool()` gets zod 4 shapes.
  Login needs the owner's temporary session row.
- [ ] 4.4 Check that the README's zod note (README.md:601-603) is still accurate, and edit it only if not. Then `scripts/check-change.sh` (all gates) and the tier 2 `consistency-read` pass.
