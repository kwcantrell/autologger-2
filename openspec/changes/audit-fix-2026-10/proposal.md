# Audit fix 2026-10: clear the four npm audit advisories on supabase-migration

Tier: 2
Tier reason: a security fix to production runtime dependencies (`proxy-addr` in the server's
dependency tree through `@modelcontextprotocol/sdk` → `express`; `uuid` under the log import's
`exceljs`), as the precedent `fix-dependency-vulns` (tier 2) was. A lockfile change and one `overrides` entry; no spec, route or
contract change is intended.

Approved-by: Kalen

## Why

`npm audit --audit-level=high` fails on `supabase-migration` (31a23d7), so CI's audit gate fails
every PR into it; slice 7c-1's final check found it (2026-10-06). This branch's lockfile has not
changed since the last green audit, so the advisories are new. The owner chose to fix the
dependencies first, as their own change.

| Package | Severity | Advisory | Path |
|---|---|---|---|
| `proxy-addr` 2.0.7 | critical | GHSA-jqcg-44mw-7w3h, IP spoofing via an IPv4-mapped IPv6 trust subnet | `@modelcontextprotocol/sdk` → `express` (server runtime) |
| `source-map-js` 1.2.1 | high | GHSA-68fv-2mgg-jv7q, event-loop denial of service through indexed section offsets | `next` → `postcss`; `@tailwindcss/node`; `jsdom` → `css-tree` (build and test tooling) |
| `uuid` 8.3.2 | moderate | GHSA-w5hq-g745-h8pq, missing buffer bounds check in v3/v5/v6 with `buf` | `exceljs` 4.4.0 (the Sheets log import) |

`npm audit` reports `4 vulnerabilities (2 moderate, 1 high, 1 critical)` (the second moderate is
`exceljs` itself, listed for depending on `uuid`).

## What Changes

- **`proxy-addr` 2.0.8 and `source-map-js` 1.2.2** through `npm audit fix`: patch releases, a
  lockfile-only change.
- **`uuid` through an override:** `package.json` `overrides` gains `"uuid": "^11.1.1"`, beside the
  existing `postcss` override. `exceljs` only calls `require('uuid').v4()`
  (`node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:1`), and `uuid` 11 still
  exports `v4` with a CommonJS build. `npm audit fix --force` would instead downgrade `exceljs` to
  3.4.0, a breaking change to the log import's reader.

## Non-goals

- Any other upgrade, `npm audit fix --force`, or a change to `exceljs` itself.
- The npm `allowScripts` warnings for `better-sqlite3` and `esbuild` install scripts.
- Code, spec, route or contract changes.

## Impact

- **Files:** `package.json` (one override), `package-lock.json`.
- **Runtime:** `proxy-addr` 2.0.8 under the MCP SDK's `express` (the server's own proxy trust is
  its own code and does not use it, design A5); the log import's `.xlsx` reading (`exceljs` with
  `uuid` 11). Both are covered by existing suites; `v4` is checked directly (design Risks).
- **Operators:** the next `make <env>-up` rebuilds the images with the new lockfile.
- **Follow-up:** once merged, `supabase-7c1-session-row-versions` rebases on it and finishes its
  task 7.3.
