# Tasks

**Branch and commits**
- The first commit on `shared-request-state` holds only `openspec/changes/shared-request-state/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `9b-<task>-<red|green>.log`, and each `Evidence:` line
  names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- Targeted tests while working (ADR 0026): `cd server && npx vitest run --project <unit|integration> <files>`.
- `npx vitest run` in `packages/log-import`, `packages/ai-runtime` and `packages/storage`.
- `cd web && npx vitest run`.
- `npm run typecheck`.
- The full pg/integration suites run in CI on the PR (ADR 0026; owner preference: no local full DB runs). Locally, only the targeted tests being written, plus unit suites and typecheck.

## 1. Baselines

- [ ] 1.1 Run the unit suites and typecheck on the base and record the counts. The DB-suite baseline is the last CI run on `supabase-migration`. List the existing tests D4 categories 1-3 may touch: `grep -rn "clearLogImportJobs\|createLogImportJob\|getLogImportJob\|__resetAiChatIssuedSessionIdsForTests\|aiV2PendingQuestions\|API route missing" --include=*.test.ts --include=*.test.tsx server/src packages web/src`. Known flakes (record if they recur): storage "8 contending", `catalogContention.pg` cross-team retry, `aiMcpServer` "Cap holds under concurrent calls", `crossProcess.int` timeout.

## 2. Log-import jobs in kv (design D1)

- [ ] 2.1 Test first, `packages/log-import/src/jobStore.test.ts` with an in-package `MemoryKv`, covering the D4 store cases (ordered writes under a delayed put, final stale failure and the runner stopping, a throwing kv). Also test first, in `packages/storage/src/kvStore.pg.test.ts`: `replaceIf` with `{expirationTtl}` sets the new expiry, and without it keeps the old one. Red, then add the option to the port and the Postgres store, and rewrite `jobStore.ts` as `createLogImportJobStore(kv, clock)` with the per-job chain. Green.
- [ ] 2.2 Test first, the new `logImport.int.test.ts` cases (a GET through a second app; a stale job read as failed after 61 s; the creator-scoped 404 unchanged). Red, then wire the store per binding (`c.env.ports.logImportJobs`) through `config.ts` and the routes, with the runner's heartbeat timer and `lost` check. Green. Existing log-import tests pass, changed only under D4 category 1.
- [ ] 2.3 Test first, the web `BatchImportModal` 404 text (D4 category 3). Red, then change the hint. Green.

## 3. AI v2 questions in kv (design D2)

- [ ] 3.1 Test first, the `aiV2PendingQuestions.test.ts` cases (D4) with an in-package `MemoryKv`. Red, then add the kv rows (stored before emit), the 500 ms poller, the CAS `resolveAnswer` and the fire-and-forget row delete on abandon, with the registry built per binding (`c.env.ports.aiV2Questions`). Green.
- [ ] 3.2 Test first, the `aiV2.int.test.ts` cases (an answer through app B reaches the turn on A within 1 s, and two concurrent answers accept one). Red, then wire it, asserting B's registry never held a local entry. Green. Existing AI v2 tests pass, changed only under D4 category 2.

## 4. AI chat resume in kv (design D3)

- [ ] 4.1 Test first, the `ai.int.test.ts` cases (a co-member's resume gets 422; a resume through a second app sharing the CLI home works; a file under a different project directory gets 422; a path-shaped id gets 422; an expired binding gets 422) and an `encodeCwd` unit test against the observed CLI path. Red, then replace `issuedClaudeSessionIds` with the kv binding and the exact-path file check. Green. Existing AI chat tests pass, changed only under D4 category 2.

## 5. Verify

- [ ] 5.1 Unit suites, typecheck and `openspec validate --all --strict` locally. The pg/integration suites come from the PR's CI run. Compare the counts with 1.1 and explain every difference.
- [ ] 5.2 Latency bench per D5. Record the medians.
- [ ] 5.3 README: the log-import, AI v2 and AI chat paragraphs (~212-214), the multi-process invariant (~509-514) and the package tree's "In-memory job-status store" (~729) now say this state is shared. Live check on the dev stack, with a second app process as in 9a 7.3 and the owner's temporary login row:
  - a design turn on A answered through B continues;
  - a chat turn on A resumed through B works, with the image's real CLI (2.1.284), which confirms the `encodeCwd` path;
  - another user's resume gets 422;
  - a log-import poll through B returns the job.
  Sheets may be unconfigured; then check the job record and its 503 instead.
- [ ] 5.4 `scripts/check-change.sh` (all gates) and the tier 2 `consistency-read`.
