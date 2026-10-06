# Design: audit-fix-2026-10

## Context

One lockfile carries the four advisories (proposal.md). As in `fix-dependency-vulns` (F-NPM-VER):
the host has npm 11.19 (node 24), which blocks install scripts, while CI and the images use
`node:22` (npm 10). So:
- **resolution** runs on the host with `--package-lock-only --ignore-scripts` (no `node_modules`
  written);
- **the lockfile is checked** with `npm ci` in Docker `node:22-bookworm-slim`, the images' base
  (`docker/Dockerfile:13`), before the host's own `node_modules` are refreshed with `npm ci`.

## D1. The recipe

1. `npm audit fix --package-lock-only --ignore-scripts` (exits 1 while `uuid` is still flagged).
2. `package.json` `overrides` gains `"uuid": "^11.1.1"` (global: `exceljs` is the only `uuid`
   consumer, A3, and `^11` stays below an ESM-only major).
3. `npm update uuid --package-lock-only --ignore-scripts`. A plain `npm install` keeps the locked
   8.3.2 in this workspace tree and leaves `npm ls uuid` "invalid" (panel finding), so the update
   step is required, and the checks read the lockfile itself, not only `node_modules`.

## Assumptions and evidence

| # | Assumption | Command | Observed |
| - | --- | --- | --- |
| A1 | Steps 1-3 change exactly three versions in the lockfile | scratch copy of every tracked `package.json` and `package-lock.json` (`scratchpad/af-recipe`), steps 1-3, then `jq -r '.packages["node_modules/<pkg>"].version' package-lock.json` | after step 2's `npm install --package-lock-only`: `uuid 8.3.2`; after step 3: `uuid 11.1.1`, `proxy-addr 2.0.8`, `source-map-js 1.2.2`; the panel's diff of a full scratch clone: only these three version changes plus `funding`/`license` metadata lines |
| A2 | The result is clean | `npm audit --package-lock-only` (same scratch) | `found 0 vulnerabilities` |
| A3 | `exceljs` is the only `uuid` consumer and uses only `v4` | `npm ls uuid --all`; `grep -rn "require('uuid')" node_modules/exceljs/lib` | only `exceljs@4.4.0 → uuid@8.3.2`; one hit, `const {v4: uuidv4} = require('uuid')` in `cf-rule-ext-xform.js` |
| A4 | npm 10 installs the npm 11 lockfile, and `uuid` 11 serves `exceljs` a CommonJS `v4` | `docker run node:22-bookworm-slim`: `npm ci --ignore-scripts`; `npm ls uuid proxy-addr source-map-js`; `node -e` resolving `uuid` from `exceljs` and calling `v4()` | `10.9.9`, `ci=0`; `uuid@11.1.1 overridden`, `proxy-addr@2.0.8`, `source-map-js@1.2.2`; `v4 via exceljs: d893b54c-…` |
| A5 | The server does not use `express`'s proxy trust | `grep -rn "trust proxy\|from 'express'" server/src --include=*.ts \| grep -v test` | nothing; proxy trust is the app's own (`server/src/env.ts:78`, `server/src/middleware/ipAllowlist.ts:165`) |

## Risks / Trade-offs

- **The `v4` call is not exercised by the suites:** production only reads `.xlsx`
  (`packages/log-import/src/sheetsFetch.ts:46`), and `v4` runs only when writing dataBar or iconSet
  conditional formatting. → Task 1.3 calls `v4()` through `exceljs`'s resolution directly.
- **A global override** would also force `uuid` 11 on a future second consumer. → Accepted while
  `exceljs` is the only one (A3); a later consumer's install would show the conflict.
