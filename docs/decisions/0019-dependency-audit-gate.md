# 0019: Gate PRs on high and critical npm advisories, with a waiver path

- Date: 2026-09-29
- Status: Accepted (amends ADR 0018, which left `audit` blank)
- Rule: `lifecycle.commands.audit: npm audit --audit-level=high` (check `audit`, `pr` stage); the `postcss` override in `package.json`; the npm entry in `.github/dependabot.yml`

## Context

At adoption (ADR 0018), `npm audit` failed on main, so the `audit` gate was left blank, and
Dependabot watched only GitHub Actions. Nothing watched npm. When the dependency graph was
turned on, main showed 19 advisories:
- a critical unauthenticated RCE in `next` 15.5.23;
- `hono`, `@hono/node-server` and `undici` in the API image.

The change `fix-dependency-vulns` fixed all but 2 moderate.

## Decision

- **The gate:** `npm audit --audit-level=high` runs on every PR (the `pr` stage). Dev dependencies
  count too, because build and test tooling runs on developer and CI machines.
- **The waiver:** a high or critical advisory with no fix blocks every PR until it's handled. In
  that case, a reviewed tier 2 PR relaxes `lifecycle.commands.audit` (for example to
  `--audit-level=critical`, or blank). It gives a dated reason in this ADR's log and in the PR. A
  later PR restores the gate once a fix exists. The gate is never bypassed with a label.
- **Dependabot:** npm is watched weekly, with minor and patch updates grouped. Security updates
  arrive as their own PRs.
- **The `postcss` override** (`"postcss": "^8.5.28"`) lifts `next` 15's exact pin on the vulnerable
  8.4.31. It is removed in the change that moves `next` to 16.
- **`uuid` and `exceljs` are accepted.** The `uuid` advisory (<11.1.1) affects only its v3, v5 and
  v6 generators when a buffer is passed. `exceljs` 4.4.0, the only dependent, calls only `v4()`.
  The only fix is downgrading `exceljs` to 3.x. A high-level gate won't show a future `uuid`
  regression, so this is a residual.

## Evidence

- `npm audit` on main: 19 (1 critical, 9 high, 9 moderate). After the fix: 2 moderate, and
  `--audit-level=high` exits 0.
- The fix-dependency-vulns panel: two reviewers raised the risk of the gate blocking every PR,
  which is why there is a waiver.

## Consequences

- A new high advisory fails PRs, docs-only ones included, until it is fixed or waived. That cost
  is intended: the RCE sat unnoticed because nothing failed.
- Waiver log: none yet.
