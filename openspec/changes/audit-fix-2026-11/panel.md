# Panel: audit-fix-2026-11
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-11-11

Reviewers report only critical and major findings (ADR 0024). Each ran as a separate fresh-context subagent.

- [x] [major] "The full suites" in tasks.md left out the `companion` and `media-worker` workspaces, `packages/ports`, and the root `node --test docker/scripts/*.test.mjs` pair, all of which the root `npm test` runs and which the bumped `vite`/`vitest`/`zod`/`undici` reach. Found by scope and simplicity. Evidence: `grep '"test"' package.json` -> `... npm run test -w companion && npm run test -w media-worker && ... npm run test -w packages/ports ...`. Resolved: tasks.md now defines the full suites as the root `npm test` (every workspace), plus `cd server && npx vitest run --project integration --project pg --maxWorkers=4`, plus `npm run typecheck`.

Verified (no findings):
- The recipe reproduces from scratch: 49 changed, 16 added, 0 removed, and `web/package.json` changes only the `diff` line.
- No major version moves. The one 0.x minor, `@oxc-project/types`, is now noted in A1.
- `npm audit` leaves only the two moderate hono advisories, and `--audit-level=high` exits 0.
- npm 10.9.9 on node v22.23.3 runs `npm ci` cleanly (`ci=0`, `ls=0`), and the new engines are satisfied.
- `diff` 8.0.4's `diffLines` keeps the `added`/`removed`/`count` shape that `wikiDiff.tsx` reads.
- `serveStatic` has no import anywhere; `@hono/node-server` is used only for `serve` and `RESPONSE_ALREADY_SENT`.
- Install scripts are unchanged: the same four packages, and none of the 16 added ones has one. Every added entry resolves to registry.npmjs.org with an integrity hash.
- The lightningcss and rolldown linux arm64/x64 glibc binaries cover the prod arm64/amd64 and stage amd64 builds. `vite`, `vitest`, `rolldown` and `lightningcss` are dev-only and absent from the `npm ci --omit=dev` server image.
- Stage names and `GITHUB_BASE_REF` match CI.

Residual, covered by task 1.5: no offline changelog review of zod 4.6.7, next 15.5.29 or vite 8.3.8. The full suites, typecheck and the frozen 422 shapes test cover it.
