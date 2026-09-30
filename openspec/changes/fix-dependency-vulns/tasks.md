## 1. Baseline (the failing check, first)

- [x] 1.1 With the lockfile still unchanged, set `lifecycle.commands.audit` to
  `npm audit --audit-level=high` and run `scripts/check-change.sh --only audit`. Expected: FAIL.
  Record the advisory count line as `Evidence:`.
  Evidence: `--only audit` on the old lockfile -> `FAIL audit npm audit --audit-level=high exited 1: 19 vulnerabilities (9 moderate, 9 high, 1 critical)`

## 2. Fix

- [x] 2.1 Run `npm audit fix --package-lock-only --ignore-scripts` with npm 11 (design 1). Test:
  `npm audit --json` leaves only `postcss`, `next`, `exceljs` and `uuid`, and `git diff --stat`
  touches only `package-lock.json`.
  Evidence: npm 11.19 -> `npm audit --json` leaves `['exceljs', 'next', 'postcss', 'uuid']` (3 moderate, 1 high); `git diff --stat` -> `package-lock.json` plus 1.1's `openspec/config.yaml` line
- [x] 2.2 Raise the floors (design 2) and add the `postcss` override, following the recipe in design
  3, then re-resolve. Test:
  - there is exactly one `postcss` (8.5.28) in the lock;
  - the resolved versions of `next`, `hono`, `@hono/node-server` and `undici` are unchanged from 2.1;
  - `scripts/check-change.sh --only audit` PASSES.
  Evidence: lock `postcss` -> `{'node_modules/postcss': '8.5.28'}`; `next` 15.5.26, `hono` 4.13.11, `@hono/node-server` 1.19.17 and `undici` 7.30.0 are the same after 2.1 and 2.2 (`unchanged: True`); `--only audit` -> `PASS audit`
- [x] 2.3 Add the npm entry to `.github/dependabot.yml` (design 5), and write ADR
  `docs/decisions/0019-dependency-audit-gate.md` (design 7). Test:
  `scripts/check-change.sh --only yaml,workflows` passes.
  Evidence: `--only yaml,workflows` -> `PASS yaml 57 YAML file(s) parse`, `PASS workflows actions pinned, token scoped`; the pre-commit hooks passed on commit c5d2439
- [x] 2.4 Run `npm ci`, `npm run typecheck`, `npm test` and `npm run build` in Docker `node:22`, on a
  fresh clone of this branch (no `server/data`). Expected: all rc 0; record the counts.
  Evidence: fresh clone (`ls server/data` -> No such file), `docker run node:22` -> `ci=0 typecheck=0 test=0 build=0`; `npm test` per workspace: 794+1384+21+49+56+1+24+34+158+66+34+32+268 = 2921 passed, 5 skipped, 0 failed
- [x] 2.5 Run the Playwright e2e (`npm run e2e`: chromium and login-gate, on port 8791, with
  `DATA_DIR` under `e2e/.data`) in `mcr.microsoft.com/playwright:v<@playwright/test version>`, on the
  same fresh clone after `npm ci`. Run it first on a fresh clone of `main` as the baseline.
  Expected: the same pass count.
  Evidence: `@playwright/test` is 1.61.1, but the Playwright image ships Node 24 and npm 11, which don't match the Node 22 `better-sqlite3` build. The e2e therefore ran in `node:22` with `npx playwright install --with-deps chromium`, on fresh clones of `main` and of this branch in parallel: main -> `33 passed (13.7s)`, e2e_rc=0; branch -> `33 passed (13.2s)`, e2e_rc=0
- [x] 2.6 Run `scripts/check-change.sh --stage pr --base main`, which includes `audit`, and record it
  as `Evidence:`. Expected: all pass, except gates that depend on later tasks.
  Evidence: `--stage pr --base main` -> PASS openspec, yaml, workflows, skills-sync, guide-size, change (tier 2), risk-floor, approval, panel (18), evidence, artifacts-first, size `22/400`, commands, **audit**. FAIL `tasks` (the later tasks). FAIL `tests-with-code`: `source changed but no test changed: ['packages/transcription/package.json']`. That is the `undici` floor bump, a manifest-only edit caught by `source_globs: packages/**`. It needs the owner's `no-test-needed` label; the reason goes in the PR body, and the behaviour is covered by the 2921 tests and the 33 e2e in 2.4 and 2.5

## 3. Archive and PR

- [ ] 3.1 Archive. There are no spec deltas (`skip_specs`). Test: `openspec validate --all --strict`
  passes.
- [ ] 3.2 Push and open the PR, stating the image exposure window. Record the first CI run as
  `Evidence:`. Expected: `gates` (with `audit`), `secrets` and `dependency-review` pass.

## Owner and Claude, after merge (no checkboxes, so the tasks gate ignores them)

- Claude: run `make prod-push` from clean `main`, and report the new `WEB_TAG` and `API_TAG`
  (design 8).
- Owner: deploy the new images, and dismiss the two `uuid` and `exceljs` Dependabot alerts as
  "vulnerable code not actually used".
