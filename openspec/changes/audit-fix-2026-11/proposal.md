# Audit fix 2026-11: clear the high and critical npm audit advisories on main

Tier: 2
Tier reason: a security fix to production runtime dependencies (`next` in the web runtime, `undici`
in the transcription client, `zod` validating every request body, `body-parser` under the MCP
SDK's `express`), as the precedents `fix-dependency-vulns` and `audit-fix-2026-10` (both tier 2)
were. It changes only the lockfile and one exact pin. No spec, route or contract change is intended.

Approved-by: Kalen 11-11-2026

## Why

`npm audit --audit-level=high` fails on `main` (beed639b), so CI's `audit` gate fails on every PR into
it. #139 (`youtube-playlist-import`) and #140 (`batch-autogenerate`) are red on that gate alone;
neither changes a manifest, and their lockfiles are byte-identical to main's. The owner chose to
fix the dependencies first, as their own change (2026-11-11).

`npm audit` on beed639b reports `13 vulnerabilities (1 low, 7 moderate, 4 high, 1 critical)`:

| Package | Severity | Path | Fix |
|---|---|---|---|
| `next` 15.5.26 | critical | web runtime | 15.5.29 (`npm audit fix`) |
| `undici` 7.30.0 | high | `packages/transcription` (direct), `jsdom` | 7.30.2 |
| `vite` 8.1.4 | high | web build and dev server | 8.3.8 |
| `zod` 4.6.5 | high | request schemas (`packages/contract`, server) | 4.6.7 |
| `body-parser` 2.3.0 | high | `@modelcontextprotocol/sdk` → `express` | 2.4.0 |
| `qs`, `fast-uri`, `ip-address` | moderate | transitive (express, ajv, socks) | patch releases |
| `vitest`, `@vitest/mocker` | moderate | test tooling | 4.1.12 |
| `diff` 8.0.2 | low | `web` (exact pin), the wiki diff view | 8.0.4 |
| `@hono/node-server` 1.19.17 | moderate | server HTTP adapter | **2.x only** (major) |
| `@hono/node-ws` 1.3.1 | moderate | flagged only through `@hono/node-server` | none without the major |

## What Changes

- **`npm audit fix` without `--force`:** patch and minor releases of the packages above, plus
  their own dependencies (49 locked versions change, 16 platform-specific optional packages are
  added, none removed; design A1). This is a lockfile-only change.
- **`diff` 8.0.4:** `web/package.json` pins `diff` exactly, so `npm audit fix` leaves it alone. The pin
  moves from `8.0.2` to `8.0.4`, a patch release.

## Non-goals

- **`@hono/node-server` 2.x** (and `@hono/node-ws`): a major upgrade of the server's HTTP layer,
  left to its own change. The advisory (GHSA-rmxm-3fg6-px4f) is in `serveStatic`, which the server
  no longer uses (design A5). After this change `npm audit` reports `2 moderate severity
  vulnerabilities`, both this one.
- `npm audit fix --force`, any other upgrade, and the open Dependabot PRs (#138, #11, #12, …).
- Code, spec, route or contract changes.

## Impact

- **Files:** `package-lock.json`, `web/package.json` (one pin).
- **Runtime:** `next` (web), `undici` (Deepgram uploads in `packages/transcription`), `zod` (every
  request schema), `body-parser`/`qs` (the MCP SDK's express). All are covered by existing
  suites, run in full (tasks 1.5).
- **Operators:** the next `make <env>-up` rebuilds the images with the new lockfile.
- **Follow-up:** once merged, #139 and #140 rebase on it, tick V.1 and 8.3, and go green.
