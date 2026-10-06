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

- [ ] 1.1 Baseline on 31a23d7, the failing check first: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit`. Verify: FAIL, with the four advisories of proposal.md in `npm audit` (recorded).
- [ ] 1.2 Design D1 steps 1-3 on the host: `npm audit fix --package-lock-only --ignore-scripts`; add `"uuid": "^11.1.1"` to `package.json` `overrides`; `npm update uuid --package-lock-only --ignore-scripts`. Verify: `jq -r '.packages["node_modules/<pkg>"].version' package-lock.json` gives `proxy-addr` 2.0.8, `source-map-js` 1.2.2, `uuid` 11.1.1; `git diff --stat` touches only `package.json` and `package-lock.json`, and the lockfile diff changes no other version (recorded).
- [ ] 1.3 The lockfile in `node:22` (design A4), then the host: in `docker run --rm node:22-bookworm-slim` on a copy of the tree's manifests, `npm ci --ignore-scripts` exits 0 and `npm ls uuid proxy-addr source-map-js` shows the three versions with `uuid@11.1.1 overridden`; then host `npm ci`. Verify: host `npm ls uuid` exits 0 with no `invalid`; `node -e` resolving `uuid` from `exceljs` and calling `v4()` prints a UUID; `cd packages/log-import && npx vitest run` and `cd server && npx vitest run --project integration src/routers/logImport.int.test.ts` are green.
- [ ] 1.4 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit`. Verify: PASS, and `npm audit` reports `found 0 vulnerabilities` (a pass at `--audit-level=high` alone would hide the moderate `uuid` advisory).
- [ ] 1.5 The full suites, then `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` and `--stage pr`. Verify: all green; a failure of only the deferred storage contention test is re-run and recorded (owner 2026-10-06); `--stage pr` records any gate that needs the PR itself (its body or labels).
