# Fix dependency vulnerabilities

Tier: 2
Tier reason: security fixes to production runtime dependencies (`next`, `hono`, `@hono/node-server`, `undici`) that can change the frozen HTTP/WS behaviour; edits `openspec/config.yaml` and `.github/` (high-risk paths).

Approved-by: Kalen 2026-09-29

## Why

`npm audit` on main reports 19 advisories: 1 critical, 9 high, 9 moderate. Derivation:
`npm audit --json | jq .metadata.vulnerabilities`.

Dependabot reports 46 open alerts on the same lockfile and the same 17 packages. Derivation:
`gh api repos/kwcantrell/autologger-2/dependabot/alerts?state=open`, grouped by package.

The critical one is an unauthenticated remote code execution in `next` 15.5.23, the web image's
server. The runtime server stack also has advisories:
- `hono` 4.12.29: 7 advisories, including CORS ReDoS and `memo()` leaking across requests;
- `@hono/node-server` 1.19.14: path traversal in `serveStatic`, which this app doesn't use;
- `undici` 7.28.0: response desync, cross-user disclosure.

Nothing watches npm dependencies:
- the lifecycle's `audit` gate is blank (ADR 0018);
- `.github/dependabot.yml` covers only GitHub Actions.

## What Changes

- **Lockfile fixed within existing ranges** (`npm audit fix --package-lock-only`, run with npm 11):
  - `next` 15.5.23 → 15.5.26;
  - `hono` 4.12.29 → 4.13.11 (4.13.5 or later is needed for three of its advisories);
  - `@hono/node-server` 1.19.14 → 1.19.17;
  - `undici` 7.28.0 → 7.30.0;
  - `sharp` 0.34.5 → 0.35.5 (`next` accepts `^0.34.3 || ^0.35.4`);
  - `tar`, `qs`, `fast-uri`, `ip-address`, `nanoid`, `browserslist`, `colord`,
    `baseline-browser-mapping`, `vitest` and `@vitest/mocker` to patched versions.
- **Dev-only side effect.** The optional peer `eslint` moves from 10.8.0 to 9.39.5, and its family
  moves with it: the root `brace-expansion` 5 → 1.1.21, `minimatch` 10 → 3, `balanced-match`,
  `espree` and `@eslint/*`. That adds 20 dev packages and removes 5. The old lock broke
  `@companion-module/tools`' `^9.36.0` peer range. Nothing runs eslint; the repo lints with biome.
- **Floors raised** to the patched versions, so a lockfile regeneration can't slip back:
  - `next ^15.5.26` (server, web);
  - `hono ^4.13.11` and `@hono/node-server ^1.19.17` (server);
  - `undici ^7.30.0` (packages/transcription).
- **A root override, `"postcss": "^8.5.28"`.** `next` 15 pins `postcss` at exactly 8.4.31 (high:
  XSS and file read), and npm's only fix is `next` 16. The override is removed when `next` 16 lands.
- **The audit gate is turned on:** `lifecycle.commands.audit: "npm audit --audit-level=high"`, with
  a waiver path recorded in the new ADR 0019.
- **Dependabot watches npm:** a weekly entry, with minor and patch updates grouped.

This takes 19 advisories to 2 moderate (`exceljs` and `uuid`, below).

## Decisions (owner, 2026-09-29, after the panel)

- **Audit gate at `high`, with a waiver** (ADR 0019). When a high or critical advisory has no fix:
  - a reviewed tier 2 PR blanks or relaxes `commands.audit`, with a dated reason;
  - a later PR restores it once a fix exists.
- **Dependabot npm entry:** weekly, grouped.
- **Floors raised** (above).
- **Images rebuilt after merge.** Claude runs `make prod-push` from clean `main` and reports the new
  tag. No `prod-up`, and no deployment change; the cutover stays owner-owed.
- **`exceljs` and `uuid` accepted as unreachable.** `exceljs` 4.4.0 (the only `uuid` dependent)
  calls only `uuid.v4()`, with no buffer. The advisory affects v3, v5 and v6 with a buffer. The only
  fix is downgrading `exceljs` to 3.4.0. The two Dependabot alerts stay open until the owner
  dismisses them.

## Non-goals

- `next` 16.
- The prod deployment and cutover.
- `npm run lint` as a gate.
- Dismissing Dependabot alerts.

## Impact

- `package.json` (the override), four workspace `package.json` floors, `package-lock.json`,
  `openspec/config.yaml` (one line), `.github/dependabot.yml`, and ADR 0019.
- The HTTP/WS contract must not change. The server integration suite and the Playwright e2e are
  the checks.
- The lockfile is excluded from the size budget; the rest is a few dozen lines.
