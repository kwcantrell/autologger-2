# Tasks

The first commit on `audit-fix-2026-11` holds only `openspec/changes/audit-fix-2026-11/`. The PR
targets `main`, and the gates run with `GITHUB_BASE_REF=main`. Logs go under the session scratchpad
as `af-<task>-<red|green>.log` and are named in each `Evidence:`. Resolution runs on the host
lockfile-only (design D1); `node_modules` changes only through `npm ci`.

"The full suites" here are:
- the root `npm test`, which covers every workspace: the `docker/scripts` `node --test` pair,
  `server`, `web`, `companion`, `media-worker` and every `packages/*`;
- the server's database projects, which the root `npm test` skips locally:
  `cd server && npx vitest run --project integration --project pg --maxWorkers=4` (CI shards
  these instead; 4 workers stays under this machine's `autologger_app` connection cap);
- `npm run typecheck`.

Keep each task's text and later its `Evidence:` in one block with no blank line, because the
evidence gate reads only up to the first blank line.

## 1. Baseline and fix

- [x] 1.1 Baseline on beed639b, the failing check first: `GITHUB_BASE_REF=main scripts/check-change.sh --only audit`. Verify: FAIL, with the advisories of proposal.md in `npm audit` (recorded).
  Evidence: `GITHUB_BASE_REF=main scripts/check-change.sh --only audit` on 0907004e (beed639b + artifacts) -> `FAIL  audit  npm audit --audit-level=high exited 1`; `npm audit` -> `13 vulnerabilities (1 low, 7 moderate, 4 high, 1 critical)` (log `af-1.1-red.log`).
- [x] 1.2 Design D1 steps 1-2 on the host. Verify: `jq -r '.packages["node_modules/<pkg>"].version' package-lock.json` gives `next` 15.5.29, `undici` 7.30.2, `vite` 8.3.8, `zod` 4.6.7, `body-parser` 2.4.0 and `diff` 8.0.4; `git diff --stat` touches only `package-lock.json` and `web/package.json` (one line); no locked version moves across a major (recorded).
  Evidence: `npm audit fix --package-lock-only --ignore-scripts` -> exit 1 (the hono pair needs `--force`; log `af-1.2-fix.log`); `npm install diff@8.0.4 -w web --save-exact --package-lock-only --ignore-scripts` -> exit 0 (log `af-1.2-diff.log`). `jq … package-lock.json` -> `next 15.5.29`, `undici 7.30.2`, `vite 8.3.8`, `zod 4.6.7`, `body-parser 2.4.0`, `diff 8.0.4`. `git diff --stat` -> `package-lock.json | 784`, `web/package.json | 2 +-` (`"diff": "8.0.2"` -> `"8.0.4"`). Python diff of the lockfile `packages`: `changed 49 added 16 removed 0 major moves []`.
- [x] 1.3 The lockfile in `node:22`, then the host: in `docker run --rm node:22-bookworm-slim` on a copy of the tree's manifests, `npm ci --ignore-scripts` exits 0 and `npm ls` shows the versions of 1.2; then host `npm ci`. Verify: host `npm ls next undici vite zod diff` exits 0 with no `invalid`.
  Evidence: `docker run --rm node:22-bookworm-slim` on a copy of every tracked `package.json` plus the lockfile -> `v22.23.3`, `10.9.9`, `ci=0`, `ls=0` for `npm ls next undici vite zod diff body-parser` (log `af-1.3-docker.log`); host `npm ci` -> exit 0 (log `af-1.3-hostci.log`); host `npm ls next undici vite zod diff` -> exit 0; `npm ls | grep -c invalid` -> `0`.
- [x] 1.4 `GITHUB_BASE_REF=main scripts/check-change.sh --only audit`. Verify: PASS, and `npm audit` reports exactly the two moderate hono advisories of proposal.md Non-goals.
  Evidence: `GITHUB_BASE_REF=main scripts/check-change.sh --only audit` -> `PASS  audit  ran ['audit']` (log `af-1.4-green.log`); `npm audit` -> `2 moderate severity vulnerabilities`, both `@hono/node-server` GHSA-rmxm-3fg6-px4f (and `@hono/node-ws` through it), as in proposal.md Non-goals.
- [x] 1.5 The full suites, then `GITHUB_BASE_REF=main scripts/check-change.sh --stage hook` and `GITHUB_BASE_REF=main scripts/check-change.sh`. Verify: all green except, in the last run, the `tasks` gate for this task itself (recorded).
  Evidence: Root `npm test` stopped in `server` with 9 failures in 4 `|pg|` files, all `PostgresError: too many connections for role "autologger_app"` under default parallelism (log `af-1.5-npmtest.log`); those 4 files alone -> `Tests 26 passed (26)` (log `af-1.5-pg-rerun.log`). `cd server && npx vitest run --project integration --project pg --maxWorkers=4` -> `Test Files 134 passed | 1 skipped`, `Tests 1967 passed | 1 skipped` (log `af-1.5-db.log`). The rest of the root `npm test` chain, run one by one (log `af-1.5-rest.log`): `docker/scripts` `node --test` -> `pass 110, fail 0`; server unit -> `615 passed | 5 skipped`; web -> `2436 passed`; companion 31; media-worker 111; domain 58; contract 238; ports 1; storage 237; catalog 61; session-core 65; transcription 101; media-import `32 passed | 2 skipped`; log-import 41; ai-runtime 334, all exit 0. `npm run typecheck` -> exit 0 (log `af-1.5-typecheck.log`). `GITHUB_BASE_REF=main scripts/check-change.sh --stage hook` -> exit 0, every gate PASS (log `af-1.5-hook.log`). `GITHUB_BASE_REF=main scripts/check-change.sh` -> exit 0, all 15 gates PASS including `audit` and `tasks  all tasks ticked` (log `af-1.5-pr.log`).
