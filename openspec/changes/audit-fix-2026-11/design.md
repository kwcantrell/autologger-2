# Design: audit-fix-2026-11

## Context

As in `audit-fix-2026-10`, the host runs npm 11.19 (node 24.21) and blocks install scripts, while
CI's test jobs and the images use `node:22` (npm 10). The images' base is
`ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60…` (`docker/Dockerfile:13`). So:
- **resolution** runs on the host with `--package-lock-only --ignore-scripts`, which writes no
  `node_modules`;
- **the lockfile is checked** with `npm ci` in Docker `node:22-bookworm-slim`, before the host's own
  `node_modules` are refreshed with `npm ci`.

## D1. The recipe

1. `npm audit fix --package-lock-only --ignore-scripts`. This exits 1, because the hono advisories
   need `--force`.
2. `npm install diff@8.0.4 -w web --save-exact --package-lock-only --ignore-scripts`.

## Assumptions and evidence

All of these ran on a scratch copy of every tracked `package.json` plus `package-lock.json` from
beed639b (`$CLAUDE_JOB_DIR/tmp/af-scratch`), on 2026-11-11.

| # | Assumption | Command | Observed |
| - | --- | --- | --- |
| A1 | Steps 1-2 change only patch and minor versions | steps 1-2, then a Python diff of `packages` in the old and new lockfile | 49 changed versions, all patch or minor (the one 0.x minor, `@oxc-project/types` 0.139.0 -> 0.156.0, types only the rolldown/vite toolchain), including `next 15.5.26 -> 15.5.29`, `undici 7.30.0 -> 7.30.2`, `vite 8.1.4 -> 8.3.8`, `zod 4.6.5 -> 4.6.7`, `body-parser 2.3.0 -> 2.4.0`, `qs 6.16.0 -> 6.17.1`, `vitest 4.1.11 -> 4.1.12`, `rolldown 1.1.5 -> 1.2.19`, `@hono/node-server 1.19.17 -> 1.19.19`, `diff 8.0.2 -> 8.0.4`; 16 added (optional platform binaries of `vite`'s `lightningcss` and `rolldown`, plus `@emnapi/*` under the wasm binding); 0 removed |
| A2 | The gate passes afterwards, and what remains is only the hono pair | `npm audit --package-lock-only` | `2 moderate severity vulnerabilities` (`@hono/node-server`, `@hono/node-ws`); `--audit-level=high` exits 0 |
| A3 | npm 10 installs the npm 11 lockfile | `docker run --rm node:22-bookworm-slim`: `npm ci --ignore-scripts`; `npm ls next undici vite zod diff` | `10.9.9`, `ci=0` (node v22.23.3, which satisfies the new `vite`/`rolldown` engines `^20.19 \|\| >=22.12`); `next@15.5.29`, `undici@7.30.2`, `vite@8.3.8`, `zod@4.6.7`, `diff@8.0.4` |
| A4 | `web` uses only `diff`'s line/word diff, not the patch APIs in the advisory | `grep -rn "parsePatch\|applyPatch" web/src`; `grep -rln "from 'diff'" web/src` | no `parsePatch`/`applyPatch`; one importer, `web/src/pages/index/components/wiki/wikiDiff.tsx` |
| A5 | The server does not call hono's `serveStatic` (GHSA-rmxm-3fg6-px4f) | `grep -rn "serveStatic" server/src packages --include=*.ts \| grep -v test` | only two comments in `server/src/app.ts` (lines 291 and 312) describing the code that replaced it |

## Risks / Trade-offs

- **`vite` 8.1 → 8.3 and `rolldown` 1.1 → 1.2** are minor releases of the web build. A regression
  would show in `npm run typecheck`, the web suite or the image build. Task 1.5 runs the first two,
  and 1.3's `npm ci` in `node:22` covers the install.
- **`zod` 4.6.7** validates every request. A behaviour change would show in the contract and
  server suites, including the frozen 422 issue shapes (`validationBody.int.test.ts`).
- **The hono advisories stay open**, reported as moderate. The gate is `--audit-level=high`. The
  2.x upgrade is a separate change (proposal Non-goals).
