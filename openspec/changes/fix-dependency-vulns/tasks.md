## 1. Baseline (the failing check, first)

- [ ] 1.1 With the lockfile still unchanged, set `lifecycle.commands.audit` to
  `npm audit --audit-level=high` and run `scripts/check-change.sh --only audit`. Expected: FAIL.
  Record the advisory count line as `Evidence:`.

## 2. Fix

- [ ] 2.1 Run `npm audit fix --package-lock-only --ignore-scripts` with npm 11 (design 1). Test:
  `npm audit --json` leaves only `postcss`, `next`, `exceljs` and `uuid`, and `git diff --stat`
  touches only `package-lock.json`.
- [ ] 2.2 Raise the floors (design 2) and add the `postcss` override, following the recipe in design
  3, then re-resolve. Test:
  - there is exactly one `postcss` (8.5.28) in the lock;
  - the resolved versions of `next`, `hono`, `@hono/node-server` and `undici` are unchanged from 2.1;
  - `scripts/check-change.sh --only audit` PASSES.
- [ ] 2.3 Add the npm entry to `.github/dependabot.yml` (design 5), and write ADR
  `docs/decisions/0019-dependency-audit-gate.md` (design 7). Test:
  `scripts/check-change.sh --only yaml,workflows` passes.
- [ ] 2.4 Run `npm ci`, `npm run typecheck`, `npm test` and `npm run build` in Docker `node:22`, on a
  fresh clone of this branch (no `server/data`). Expected: all rc 0; record the counts.
- [ ] 2.5 Run the Playwright e2e (`npm run e2e`: chromium and login-gate, on port 8791, with
  `DATA_DIR` under `e2e/.data`) in `mcr.microsoft.com/playwright:v<@playwright/test version>`, on the
  same fresh clone after `npm ci`. Run it first on a fresh clone of `main` as the baseline.
  Expected: the same pass count.
- [ ] 2.6 Run `scripts/check-change.sh --stage pr --base main`, which includes `audit`, and record it
  as `Evidence:`. Expected: all pass, except gates that depend on later tasks.

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
