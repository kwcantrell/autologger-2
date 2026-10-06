# Tasks

The first commit on `supabase-fix-audit-2026-10` holds only `openspec/changes/audit-fix-2026-10/`.
The PR targets `supabase-migration`, and the gates run with `GITHUB_BASE_REF=supabase-migration`.
Logs go under the session scratchpad as `af-<task>-<red|green>.log`, named in each `Evidence:`.
Resolution runs on the host lockfile-only (design D1); `node_modules` changes only through `npm ci`.

"The full suites" here: `cd server && npx vitest run --project unit --project integration --project pg`;
`npx vitest run` in `packages/storage`, `packages/session-core`, `packages/catalog`,
`packages/contract`, `packages/domain`, `packages/log-import`, `packages/transcription` and
`packages/ai-runtime`; `cd web && npx vitest run`; and `npm run typecheck`.

Keep each task's text, and later its `Evidence:`, in one block with no blank line: the evidence gate
reads only up to the first blank line.

## 1. Baseline and fix

- [x] 1.1 Baseline on 31a23d7, the failing check first: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit`. Verify: FAIL, with the four advisories of proposal.md in `npm audit` (recorded).
  Evidence: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit` on cf8f6c0 -> `FAIL  audit  npm audit --audit-level=high exited 1`; `npm audit` -> `proxy-addr  1.1.0 - 2.0.7`, `source-map-js  1.0.0 - 1.2.1`, `uuid  <11.1.1`, `4 vulnerabilities (2 moderate, 1 high, 1 critical)` (log `af-1.1-red.log`).
- [x] 1.2 Design D1 steps 1-3 on the host: `npm audit fix --package-lock-only --ignore-scripts`; add `"uuid": "^11.1.1"` to `package.json` `overrides`; `npm update uuid --package-lock-only --ignore-scripts`. Verify: `jq -r '.packages["node_modules/<pkg>"].version' package-lock.json` gives `proxy-addr` 2.0.8, `source-map-js` 1.2.2, `uuid` 11.1.1; `git diff --stat` touches only `package.json` and `package-lock.json`, and the lockfile diff changes no other version (recorded).
  Evidence: `npm audit fix --package-lock-only --ignore-scripts` -> exit 1 (uuid still flagged; log `af-1.2-fix.log`); override added; `npm update uuid --package-lock-only --ignore-scripts` -> exit 0 (log `af-1.2-update.log`). `jq … package-lock.json` -> `proxy-addr 2.0.8`, `source-map-js 1.2.2`, `uuid 11.1.1`. `git diff --stat` -> `package-lock.json | 30 +++++++++++++++++++-----------`, `package.json | 3 ++-` (one override line); the lockfile's version lines change only `2.0.7 -> 2.0.8`, `1.2.1 -> 1.2.2`, `8.3.2 -> 11.1.1`, the rest being those packages' resolved/integrity, `uuid` 11's funding and bin path, and 8.x's deprecation notice removed.
- [x] 1.3 The lockfile in `node:22` (design A4), then the host: in `docker run --rm node:22-bookworm-slim` on a copy of the tree's manifests, `npm ci --ignore-scripts` exits 0 and `npm ls uuid proxy-addr source-map-js` shows the three versions with `uuid@11.1.1 overridden`; then host `npm ci`. Verify: host `npm ls uuid` exits 0 with no `invalid`; `node -e` resolving `uuid` from `exceljs` and calling `v4()` prints a UUID; `cd packages/log-import && npx vitest run` and `cd server && npx vitest run --project integration src/routers/logImport.int.test.ts` are green.
  Evidence: `docker run --rm node:22-bookworm-slim` on a copy of every tracked `package.json` plus the lockfile -> `npm 10.9.9`, `ci=0`, `proxy-addr@2.0.8`, `source-map-js@1.2.2`, `uuid@11.1.1 overridden` (log `af-1.3-docker.log`); host `npm ci` -> exit 0 (log `af-1.3-hostci.log`); `npm ls uuid` -> exit 0, `exceljs@4.4.0 └── uuid@11.1.1`; `node -e` resolving `uuid` from `exceljs` -> `v4 via exceljs: d830d61b-…`; `cd packages/log-import && npx vitest run` -> `Tests  32 passed (32)`; `cd server && npx vitest run --project integration src/routers/logImport.int.test.ts` -> `Tests  15 passed (15)` (logs `af-1.3-logimport.log`, `af-1.3-server-logimport.log`).
- [x] 1.4 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit`. Verify: PASS, and `npm audit` reports `found 0 vulnerabilities` (a pass at `--audit-level=high` alone would hide the moderate `uuid` advisory).
  Evidence: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit` -> `PASS  audit  ran ['audit']` (log `af-1.4-green.log`); `npm audit` -> `found 0 vulnerabilities`.
- [x] 1.5 The full suites, then `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` and `--stage pr`. Verify: all green; a failure of only the deferred storage contention test is re-run and recorded (owner 2026-10-06); `--stage pr` records any gate that needs the PR itself (its body or labels).
  Evidence: full suites (`af-full.sh`) -> server `Tests  1525 passed | 4 skipped (1529)`, storage 133, session-core 33, catalog 50, contract 56, domain 50, log-import 32, transcription 67, ai-runtime 181, web `Tests  1419 passed (1419)`, typecheck exit 0 (log `af-1.5-full.log`). `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` -> exit 0, every gate PASS (log `af-1.5-hook.log`). `--stage pr` -> every gate PASS (`approval`, `panel 4 finding(s), no open criticals`, `artifacts-first`, `tests-with-code 0 source / 0 test file(s)`, `audit`) except `FAIL tasks 1 unticked task(s)`, this task, ticked here (log `af-1.5-pr.log`). No contention-test failure in these runs.
