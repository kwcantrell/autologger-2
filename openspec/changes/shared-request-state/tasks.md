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

- [x] 1.1 Run the unit suites and typecheck on the base and record the counts. The DB-suite baseline is the last CI run on `supabase-migration`. List the existing tests D4 categories 1-3 may touch: `grep -rn "clearLogImportJobs\|createLogImportJob\|getLogImportJob\|__resetAiChatIssuedSessionIdsForTests\|aiV2PendingQuestions\|API route missing" --include=*.test.ts --include=*.test.tsx server/src packages web/src`. Known flakes (record if they recur): storage "8 contending", `catalogContention.pg` cross-team retry, `aiMcpServer` "Cap holds under concurrent calls", `crossProcess.int` timeout.
  - Evidence: `cd server && npx vitest run --project unit` -> `Test Files 32 passed | 2 skipped (34)`, `Tests 326 passed | 3 skipped (329)`; `npx vitest run` in log-import -> `Tests 32 passed (32)`, ai-runtime -> `Tests 181 passed (181)`; `cd packages/storage && npx vitest run --project unit` -> `Tests 60 passed (60)`; `cd web && npx vitest run` -> `Tests 1689 passed (1689)`; `npm run typecheck` -> exit 0. DB baseline, CI run 37618686855 on `supabase-migration` (#84 merge, success): server integration+pg 3 shards -> `Tests 372 + 474 + 507 passed | 1 skipped`; storage pg -> `Tests 85 passed (85)`. No known flake recurred (log `9b-1.1-baseline.log`).
  - Evidence: the grep -> category 1: `packages/log-import/src/jobStore.test.ts`, `server/src/routers/logImport.int.test.ts:4,53`, `sessionHub.interleave.int.test.ts:22,331`, `apiResponseFixtures.int.test.ts:27,1353`, `server/src/test/session/callers.int.test.ts:9,95`; category 2: `server/src/routers/ai.int.test.ts:84,152,157` and `access.int.test.ts:21,156,173` (`__resetAiChatIssuedSessionIdsForTests`), `aiV2.int.test.ts:44,132,140,889-1118` (`aiV2PendingQuestions` singleton); `packages/ai-runtime/src/aiV2PendingQuestions.test.ts:23` (import only); `server/src/packageBoundaries.repo.test.ts:2474` (file name in a list, not a test of the singleton); no `API route missing` hit in tests (log `9b-1.1-baseline.log`).

## 2. Log-import jobs in kv (design D1)

- [x] 2.1 Test first, `packages/log-import/src/jobStore.test.ts` with an in-package `MemoryKv`, covering the D4 store cases (ordered writes under a delayed put, final stale failure and the runner stopping, a throwing kv). Also test first, in `packages/storage/src/kvStore.pg.test.ts`: `replaceIf` with `{expirationTtl}` sets the new expiry, and without it keeps the old one. Red, then add the option to the port and the Postgres store, and rewrite `jobStore.ts` as `createLogImportJobStore(kv, clock)` with the per-job chain. Green.
  - Evidence: red, `cd packages/log-import && npx vitest run src/jobStore.test.ts` -> `TypeError: createLogImportJobStore is not a function`, `Tests 24 failed (24)` (log `9b-2.1-red.log`); `cd packages/storage && npx vitest run --project pg src/kvStore.pg.test.ts` -> `with {expirationTtl} sets the new expiry … AssertionError: expected null to be 'b'`, `Tests 1 failed | 14 passed (15)`; the second new case (a stale `expected` with `{expirationTtl}` is refused and the expiry is untouched) already passed, since today's `replaceIf` never changes the expiry (log `9b-2.1-red-pg.log`).
  - Evidence: green, `npx vitest run` in log-import -> `Tests 41 passed (41)` (was 32: `jobStore.test.ts` went from 15 cases to 24; the size-cap, never-prune and prune-on-insert cases went with the map) (log `9b-2.1-green.log`); storage `--project pg src/kvStore.pg.test.ts` -> `Tests 15 passed (15)`, `--project unit` -> `Tests 60 passed (60)` (log `9b-2.1-green-pg.log`). `jobStore.test.ts` rewritten under D4 category 1; new `packages/log-import/src/test/memoryKv.ts` imports no vitest, so it needs no boundary exemption. The store adds `isLost(id)` and `release(id)` (awaits the chain, then forgets local state) beside D1's `{create, get, appendLine, setStatus, heartbeat}`; the server moves to it in 2.2.
- [x] 2.2 Test first, the new `logImport.int.test.ts` cases (a GET through a second app; a stale job read as failed after 61 s; the creator-scoped 404 unchanged). Red, then wire the store per binding (`c.env.ports.logImportJobs`) through `config.ts` and the routes, with the runner's heartbeat timer and `lost` check. Green. Existing log-import tests pass, changed only under D4 category 1.
  - Evidence: red, the three new cases against the pre-2.1 `jobStore.ts` (restored for the run): `cd server && npx vitest run --project integration src/routers/logImport.int.test.ts -t "shared across server processes"` -> `× a running job whose process stopped heartbeating 61 s ago reads as failed, finally … AssertionError: expected 404 to be 200`, `Tests 1 failed | 2 passed | 16 skipped (19)`. The GET-through-B and creator-404 cases already passed there: the old `globalThis` map is shared by both apps inside one test process, so only the kv-seeded stale record can fail on it (log `9b-2.2-red.log`).
  - Evidence: green, `cd server && npx vitest run --project integration src/routers/logImport.int.test.ts src/routers/sessionHub.interleave.int.test.ts src/routers/apiResponseFixtures.int.test.ts src/test/session/callers.int.test.ts` -> `Test Files 4 passed (4)`, `Tests 73 passed (73)` (log `9b-2.2-green.log`); `--project unit` -> `Tests 326 passed | 3 skipped (329)`, after `promiseHygiene` flagged a promise identity comparison in `release` (now a counter) (log `9b-2.2-unit.log`); `npm run typecheck` -> 0 `error TS`. Existing-test edits, all D4 category 1: the `clearLogImportJobs` import and calls removed from `logImport.int`, `sessionHub.interleave.int`, `apiResponseFixtures.int` and `callers.int` (each test has its own database).
- [x] 2.3 Test first, the web `BatchImportModal` 404 text (D4 category 3). Red, then change the hint. Green.
  - Evidence: red, `cd web && npx vitest run src/pages/index/components/BatchImportModal.test.tsx` -> `× a log-import job 404 says the job was not found and to start again`, `Received: "Failed: HTTP 404 — Log import job not found. (API route missing — restart the Node server …)"`, `Tests 1 failed | 13 passed (14)` (log `9b-2.3-red.log`); green, `cd web && npx vitest run` -> `Test Files 133 passed (133)`, `Tests 1692 passed (1692)` (1689 at 1.1: this case, plus 2 from the merged `AiV2Design` fix) (log `9b-2.3-green.log`). No existing test asserted the old hint, so category 3 is a new case only.

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
