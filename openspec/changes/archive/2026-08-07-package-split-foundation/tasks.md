# package-split-foundation — Tasks

> Plan of record (post-panel, post-gate 2026-08-07). file:line anchors are orientation
> only — locate quoted code by content before editing. Every phase ends green:
> `npm run typecheck` + `npm test`. Pure file-move/import-rewrite commits stay separate
> from semantic reshapes. Importer counts below include test files unless stated
> otherwise.

## 1. Workspace scaffolding + enforcement

- [x] 1.1 Add `packages/*` to root `package.json` workspaces; create
  `packages/{domain,contract,ports}` skeletons (source-only `package.json` with
  `"exports"` pointing at `./src/*.ts`, per-package `tsconfig.json` for standalone
  `tsc --noEmit`, `@autologger/*` names — NO `composite`, NO project references).
  Verify `npm install` resolves the empty packages.
- [x] 1.2 Wire coverage: root `typecheck` script gains per-package `tsc --noEmit`;
  vitest projects enumerated explicitly (server's unit + integration tiers preserved
  verbatim with `setup.int.ts`, plus one project per package); `biome.json`
  `files.includes` and the root `lint` script gain `packages/**`. Prove test wiring
  with a deliberately failing test in each project (unit tier, integration tier, each
  package) — root `npm test` must fail for each; verify
  `npm run fixtures:capture -w server`'s `--project integration` selector still works.
  Record evidence in the `.apply/` ledger; remove the deliberate failures.
- [x] 1.3 Boundary repo test (package-architecture spec): parse each `packages/*`
  file's import specifiers; assert cross-package imports ⊆ manifest dependencies, no
  resolution into `server/src`/`web/src`, and the declared layer order
  (`contract → domain`, `ports → domain`, `ports → contract` only). Demonstrate the
  negative case (deliberate undeclared import fails the test), record in ledger,
  remove the violation.
- [x] 1.4 Verify dev loop: `npm run dev` boots (server on :8787 resolves package source
  via tsx); `npm test` + `npm run typecheck` + `npm run lint` green at repo root.

## 2. @autologger/domain

- [x] 2.1 Move `server/src/studio.ts`, `server/src/timecode.ts`, `server/src/db/shared.ts`
  into `packages/domain/src/` (git mv; keep file identities and origin headers). Export
  via package entry; temporary re-export shims at old paths permitted within this
  change only.
- [x] 2.2 Rewrite all server importers of the three modules (30 production files, plus
  their test importers) to `@autologger/domain`; move the modules' colocated tests with
  them; delete the temporary shims for these paths. Gate: typecheck + tests green;
  commit as a pure-move commit pair (move, then rewrites).

## 3. @autologger/contract (+ cycle break, zod peer, error-path pins)

- [x] 3.1 Move `server/src/schemas.ts` and `server/src/aiV2/catalog.ts` into
  `packages/contract/src/` with `zod` declared as a **peerDependency** (dev-installed
  for the package's own tests); rewrite importers (13 production schema importers;
  `session/dashboardStore.ts`, `aiV2/mcpTools.ts` path updates). Verify the
  `session ⇄ aiV2` directory cycle is gone and `npm ls zod` resolves exactly one copy
  (ledger evidence). Re-point the hand-mirror header comment in
  `web/src/pages/index/components/aiV2/widgetTypes.ts` (comment-only edit).
- [x] 3.2 Cross-package error-identity pins (package-architecture spec): integration
  tests asserting a request failing a contract-package schema returns `422` and a
  domain-package `ValidationError` returns `400`, through the real app. Gate:
  typecheck + tests green.

## 4. @autologger/ports + appEnv compose (+ types.ts retirement)

- [x] 4.1 Create interface-only definitions in `packages/ports/src/`: `Clock`
  (interface only — move `systemClock` to the composition side in `server/src/node/`),
  `BlobStore`, `KvStore`, `IdentityVerifier`, `PresenceRegistry`, `CatalogDb`, and the
  `Config` type. Concrete classes gain `implements` clauses in place;
  `auth/identity.ts` imports the `KvStore` interface from the package (this breaks the
  `auth ⇄ node` cycle — verify and record).
- [x] 4.2 Create `server/src/appEnv.ts` composing `Ports` (package base +
  `sessions: SessionHubRegistry`), `Variables` (`catalog: Catalog`, `user`,
  `apiTokenAuth`), and `AppEnv`. Rewrite all importers of `server/src/types` (35 files
  incl. tests) and `server/src/clock` to the package / `appEnv.ts`; delete
  `server/src/types.ts` and `server/src/clock.ts`; `git grep` proves no old specifier
  or shim remains (ledger evidence). Gate: typecheck + tests green.
- [x] 4.3 Characterization gate for the env-identity contract: run the existing
  Companion WS end-to-end path (real upgrade completes, messages delivered) — the
  `core-ports-architecture` scenario — and record the result.

## 5. createAnchoredEvent hub RPC

- [x] 5.1 TDD: characterization tests first — pin current `create_event` observable
  behavior against the pre-change code: anchor ordering among successive generated
  events, regenerate snapshot-id exclusion, monotone clamping, exactly one
  `event.changed` per successful insert, cap behavior (including the concurrent-calls-
  at-cap−1 scenario from the `auto-event-generation` delta), and failure paths
  returning `isError` tool results.
- [x] 5.2 Implement `SessionHub.createAnchoredEvent` (synchronous, zero-`await`, one
  `inTxn` transaction: `exportEvents → exclude → timecodeWallAnchors →
  wallTimeUtcForTimecode → store-level this.events.addEvent` — NOT the
  self-transactional `SessionHub.addEvent` delegate; follow the `anchorImportedTake`
  precedent). Rewire the `create_event` tool body in `aiMcpServer.ts` to call it
  **synchronously** (no `await` introduced anywhere in the handler), keeping
  parsing/`internal`-denial/allowlist/cap/metadata composition in the tool body. Gate:
  5.1 suite + full tests green; verify the handler still contains zero `await`
  expressions (delta-spec scenario).

## 6. Docs, sweeps, final gates

- [x] 6.1 Docs: update `README.md`'s annotated `server/src` tree (moved modules +
  `packages/` area, preserving the Python-origin column semantics) and `CLAUDE.md`'s
  Source layout section (workspaces list + `packages/`). Origin headers on moved files
  stay intact.
- [x] 6.2 Sweep: no temporary re-export shims remain; no import of retired paths
  (`server/src/types`, old `studio`/`timecode`/`schemas`/`aiV2/catalog`/`clock`/
  `db/shared` relative specifiers) anywhere in server/web/e2e/companion; package graph
  AND the `server/src` directory import graph acyclic (both former cycles —
  `session ⇄ aiV2`, `auth ⇄ node` — gone); boundary repo test green; Cloudflare-noun
  and decision-making-`Date.now()` sweeps re-run over `server/src` + `packages/**`
  (modified baseline scenarios). Record evidence in the ledger.
- [x] 6.3 Full suite: `npm run typecheck`, `npm test`, `npm run lint`.
- [x] 6.4 `npm run e2e` (chromium + login-gate) AND `npm run e2e:visual` — this change
  must be visually silent; any visual diff is a defect, not a re-bless.
- [x] 6.5 Fixture chain: run the server fixture-capture test and web conformance tests;
  confirm no fixture content changed (package-architecture spec scenario).
