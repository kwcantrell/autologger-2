# Tasks

The first commit on this branch is `openspec/changes/fix-aiv2-draft-reset/` only (AGENTS.md rule 6).
Tests run as the single file locally (`npx vitest run src/pages/index/components/AiV2Design.test.tsx`
in `web/`). The full suite runs in CI on the PR.

## 1. Failing tests first

- [x] 1.1 Add the D2 test to `AiV2Design.test.tsx`: a selection made right after a new question
  commits (default-lane render, click from a `MutationObserver` callback) stays
  `aria-pressed="true"`. Check: on the current code it fails with `Expected "true" Received
  "false"`.
  Evidence: in `web/`, `npx vitest run src/pages/index/components/AiV2Design.test.tsx -t 'draft state per pending question'` on the current component -> `× keeps a selection made right after a new question commits, before effects run`, `Expected: "true" Received: "false"`, `Tests 1 failed | 1 passed | 20 skipped (22)`, on 4 consecutive runs.
- [x] 1.2 Add a test that a draft from one question doesn't carry over to a new `requestId`:
  select an option on question A, rerender with question B (new `requestId`, same shape), and
  B's options are all `aria-pressed="false"`. Check: it passes on the current code (the effect
  covers it) and must still pass after 2.1.
  Evidence: same runs -> `starts a new question (new requestId) with no option selected` passed (`1 passed`) on the current code.

## 2. Fix

- [x] 2.1 Apply D1 in `AiV2Design.tsx`: one `{ requestId, answers, freeText }` state value, derived
  on render, with the reset `useEffect` and its biome-ignore removed. Check: in `web/`,
  `npx vitest run src/pages/index/components/AiV2Design.test.tsx` passes, including 1.1 and 1.2,
  on 3 consecutive runs. `npx biome check --error-on-warnings src/pages/index/components/AiV2Design.tsx src/pages/index/components/AiV2Design.test.tsx`
  is clean, and `npm run typecheck -w web` passes.
  Evidence: in `web/`, `npx vitest run src/pages/index/components/AiV2Design.test.tsx` -> `Tests 22 passed (22)` on 3 consecutive runs (1.1 now passes, 1.2 still passes, the original 20 unchanged); `npx biome check --error-on-warnings` on both files -> `Checked 2 files ... No fixes applied.`; `npm run typecheck -w web` rc=0; `grep -c 'requestId alone' AiV2Design.tsx` -> 0 (the effect's biome-ignore is gone).

## 3. Verify

- [x] 3.1 `scripts/check-change.sh --stage hook` passes (DB tests skip locally).
  Evidence: first run -> `FAIL commands`: `src/windowCoordinationBan.repo.test.ts` flagged the 1.1 test's direct `IS_REACT_ACT_ENVIRONMENT` writes (`global-dot-write`, lines 507/533), plus an intermittent unhandled Radix focus-scope timer error from `EventButtonsTable.test.tsx` (unrelated, not reproduced on rerun). Fixed by switching to `vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)` (restored by the file's `vi.unstubAllGlobals()` afterEach; design D2 updated). The 1.1 test still fails on the pre-fix component (`Received: "false"`, `1 failed | 1 passed`) and passes with it. `AiV2Design.test.tsx` -> `Tests 22 passed (22)` x3; `windowCoordinationBan.repo.test.ts` -> `Tests 52 passed (52)`; `npx vitest run` in `web/` -> `Test Files 133 passed (133)`, `Tests 1691 passed (1691)`. Rerun `scripts/check-change.sh --stage hook` -> all PASS, `PASS commands ran ['typecheck', 'test'] (pg/integration skipped: local run; ...)`, rc=0, 74s.

## After push (no checkbox, so the tasks gate doesn't wait on the run it gates)

- The PR's CI run: `gates`' `commands` passes, so the web suite including `AiV2Design.test.tsx` is
  green. Checked on the PR itself.
  Evidence: PR #87 merged as 352417d1 with every check `SUCCESS` (`gates`, `db-shard (1-3)`, `db-tests`, `secrets`, `dependency-review`). PR #84, updated onto it, went green and merged as 7995374e. That post-merge push run, 37618686855, which includes the fix -> success: `gates` 233s (`PASS commands ran ['typecheck', 'test'] (pg/integration: db-tests job)`), `db-shard` 272s/134s/188s, `db-tests` success. #87's own post-merge run, 37618288996, was cancelled by #84's push (`cancel-in-progress`).
