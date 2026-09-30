# Design: fix dependency vulnerabilities

Revised after the panel (see panel.md). Finding ids are in brackets.

## Context

One lockfile carries every advisory. On this host, npm 11 blocks dependency install scripts, so
there is no host `npm install` or `npm ci`. Two things follow:
- **Resolution** runs with `--package-lock-only --ignore-scripts`, which writes no `node_modules`,
  using npm 11 (node 24).
- **Everything that needs `node_modules`** runs in Docker `node:22` (npm 10), the same as CI and the
  images. npm 10 can't run `npm audit fix --package-lock-only` on this tree (it fails with `Cannot
  read properties of null (reading 'edgesOut')`), but its `npm ci` installs the npm 11 lock cleanly
  [F-NPM-VER].

## Decisions

1. **Lockfile-only resolution** with npm 11: `npm audit fix --package-lock-only --ignore-scripts`.
   Re-running it on the final lock leaves it byte-identical [A: verified].
2. **Floors** (owner) [A-4]:
   - `server/package.json`: `next ^15.5.26`, `hono ^4.13.11`, `@hono/node-server ^1.19.17`;
   - `web/package.json`: `next ^15.5.26`;
   - `packages/transcription/package.json`: `undici ^7.30.0`.

   These match the versions the fix already resolves, so the resolved tree doesn't change. Only
   the lock's workspace entries do.
3. **Global `postcss` override.** `"overrides": {"postcss": "^8.5.28"}`. The exact recipe
   [A-6]:
   - add the override;
   - `python3 -c` delete `packages["node_modules/next/node_modules/postcss"]` from the lock;
   - `npm install --package-lock-only --ignore-scripts`.

   A scoped `{"next": {"postcss": …}}` override was tried first, and npm kept the exact-pinned 8.4.31.
   - `next` uses `postcss` only in its build-time CSS pipeline, over this repo's own CSS
     (`web/postcss.config.mjs` → `@tailwindcss/postcss`).
   - `vite` resolves the same 8.5.28, and `npm run build` passes.
   - **Removal trigger** [S-6, F-POSTCSS-OVERRIDE]: drop the override in the change that moves
     `next` to 16. ADR 0019 records this.
   - **Accepting the residual instead** was rejected [S-6]. It is build-time only and not reachable,
     but it is the one high left, and it would block the audit gate.
4. **Audit gate** (owner): `npm audit --audit-level=high`.
   - It runs only at the `pr` stage (`scripts/lib/check_change.py` `STAGES`), so CI runs it on
     every PR, but not on push to main or in the Stop hook [A-2, S-3].
   - **Dev dependencies stay in scope** (no `--omit=dev`) [S-5]. Build-time tooling (`next`'s
     `postcss`) is where this change's high was, and dev tools run on developer and CI machines.
   - **Waiver** [F-AUDIT-DOS, A-1]: see ADR 0019.
5. **Dependabot** (owner) [S-2]. `.github/dependabot.yml` gains this entry:

   ```yaml
   - package-ecosystem: npm
     directory: /
     schedule:
       interval: weekly
     groups:
       npm-minor-patch:
         update-types: ["minor", "patch"]
   ```

   Security updates arrive as their own PRs.
6. **`uuid` accepted** (owner). `exceljs` is imported only by
   `packages/log-import/src/sheetsFetch.ts`, and calls only `uuid.v4()`. `--audit-level=high`
   won't surface a future `uuid` regression, which is a residual [F-UUID-FUTURE].
7. **ADR 0019, `docs/decisions/0019-dependency-audit-gate.md`** [S-1, S-7]. It records:
   - the gate;
   - the waiver path;
   - the `postcss` override and its removal trigger;
   - the `uuid` acceptance;
   - that the gate reverses ADR 0018's "audit stays blank".

   The rule lives in `config.yaml` and the ADR, not in a spec (`skip_specs`).
8. **Images after merge** (owner) [F-IMG-EXPOSURE]. `make prod-push` from clean `main`.
   - The PR states the exposure window: the deployed images keep 15.5.23 until they are rebuilt and
     deployed.
   - The deployment (`prod-up`) and cutover stay owner-owed.

## Risks

- **`hono` 4.13.x behaviour changes** [A-5, F-HONO-MINOR]:
  - `parseBody()` dot-notation nesting: `grep -rn parseBody server/src packages` has no non-test
    hits, so no route is affected;
  - the query parser stops at `#`: clients never send fragments;
  - `toSSG`: unused.

  The WebSocket upgrade path depends on `@hono/node-server` and `@hono/node-ws` identity semantics.
  Its tests are part of `npm test` (`server/src/upgradeDispatch.int.test.ts`), and the Playwright
  e2e covers the live UI.
- **`sharp` 0.35** is native. It is covered by `npm run build` and the image build at `prod-push`.
- **Audit gate churn:** `hono` alone had 7 advisories. The waiver path is the release valve.

## Assumptions

| Assumption | Command | Observed |
| --- | --- | --- |
| npm audit on main | `npm audit --json` (read-only) | 19: 1 critical (`next`), 9 high, 9 moderate |
| All Dependabot alerts are on the one lockfile | `gh api …/dependabot/alerts?state=open`, grouped by manifest | 46, all `package-lock.json`, 17 packages |
| The fix stays in range and is idempotent | scratch clone (npm 11): `npm audit fix --package-lock-only --ignore-scripts`, run twice (assumption tester) | the versions above; the second run is byte-identical |
| npm 10 can't resolve, but can install | `docker run node:22 npm audit fix --package-lock-only`, then `npm ci` on the npm 11 lock (failure and abuse, assumption tester) | `edgesOut` error; `npm ci` rc 0 |
| The global override resolves; the scoped one doesn't | scratch clone, both variants | global: one `postcss` 8.5.28, 2 moderate, `--audit-level=high` rc 0; scoped: nested 8.4.31 kept |
| The tree builds and passes tests | `docker run node:22`: `npm ci`, typecheck, test, build | all rc 0 |
| The Dockerfile installs work with the new lock | per-workspace `npm ci` as in `docker/Dockerfile` (assumption tester) | `next` 15.5.26 with `postcss` 8.5.28 overridden; server `hono` 4.13.11 |
| `sharp` 0.35 is accepted by `next` | `next@15.5.26` `optionalDependencies` | `sharp: ^0.34.3 \|\| ^0.35.4` |
| The lockfile's supply chain is clean | lock diff: resolved hosts, integrity fields, `hasInstallScript` (failure and abuse) | all registry.npmjs.org, all have integrity, no new install scripts |
| The node-server path traversal and the hono CORS ReDoS aren't reachable | `grep -rn serveStatic server/src`; no cors middleware | comments only |
| `exceljs` uses only `uuid.v4()` | `grep -rn uuid node_modules/exceljs/lib` | one file, `uuidv4()` with no arguments |
