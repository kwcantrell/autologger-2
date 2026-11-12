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

- [ ] 1.1 Baseline on beed639b, the failing check first: `GITHUB_BASE_REF=main scripts/check-change.sh --only audit`. Verify: FAIL, with the advisories of proposal.md in `npm audit` (recorded).
  Evidence:
- [ ] 1.2 Design D1 steps 1-2 on the host. Verify: `jq -r '.packages["node_modules/<pkg>"].version' package-lock.json` gives `next` 15.5.29, `undici` 7.30.2, `vite` 8.3.8, `zod` 4.6.7, `body-parser` 2.4.0 and `diff` 8.0.4; `git diff --stat` touches only `package-lock.json` and `web/package.json` (one line); no locked version moves across a major (recorded).
  Evidence:
- [ ] 1.3 The lockfile in `node:22`, then the host: in `docker run --rm node:22-bookworm-slim` on a copy of the tree's manifests, `npm ci --ignore-scripts` exits 0 and `npm ls` shows the versions of 1.2; then host `npm ci`. Verify: host `npm ls next undici vite zod diff` exits 0 with no `invalid`.
  Evidence:
- [ ] 1.4 `GITHUB_BASE_REF=main scripts/check-change.sh --only audit`. Verify: PASS, and `npm audit` reports exactly the two moderate hono advisories of proposal.md Non-goals.
  Evidence:
- [ ] 1.5 The full suites, then `GITHUB_BASE_REF=main scripts/check-change.sh --stage hook` and `GITHUB_BASE_REF=main scripts/check-change.sh`. Verify: all green except, in the last run, the `tasks` gate for this task itself (recorded).
  Evidence:
