# persistence-package-extraction — Tasks

> Gated 2026-08-07 (panel + escalations ratified; see design.md Panel & review log).
> Anchors are orientation only — locate code by content before editing. Every phase
> ends green:
> `npm run typecheck` + `npm test` (root — includes web-docs). Mechanical move/rewrite
> commits stay separate from semantic commits (interfaces, factory, appEnv, wiring,
> boundary-test deltas).

## 1. Branch + scaffolding

- [x] 1.1 Branch off `main`; first commit is the gated OpenSpec artifacts for this
      change (version-pins the plan of record before any dispatch).
- [x] 1.2 Scaffold `packages/storage`, `packages/catalog`, `packages/session-core`
      (package.json with `"exports"` → `./src/*.ts`, tsconfig per step-1 pattern —
      plain `tsc --noEmit`, no `-b`/composite; deps per design D1/D5: storage→ports,
      catalog→domain+ports, session-core→domain+contract+ports; `better-sqlite3` as
      peerDependency of storage + session-core). Root `typecheck` script gains the
      three projects; each package gets its own `vitest run` test script chained
      from the root `test` script (`npm run test -w packages/<name>`, the existing
      step-1 mechanism — no root vitest "projects" config; server's two-tier
      `vitest.config.ts` untouched); verify `biome.json` `packages/**` coverage
      already applies (no re-add).
- [x] 1.3 Execution proof: drop a deliberately failing test into each new package,
      observe root `npm test` fail three times, remove; record in the apply ledger
      (step-1 discipline; also re-confirm server unit + integration tiers and
      `fixtures:capture --project` selector still run).

## 2. Storage extraction

- [x] 2.1 Boundary-test delta (same commit series, lands first): add
      `storage → ports` to `ALLOWED_LAYER_EDGES` in
      `packageBoundaries.repo.test.ts` (design D6 — the phase gate is red without
      it).
- [x] 2.2 `git mv` `node/blobStore.ts`, `node/kvStore.ts`, `node/catalogStore.ts`,
      `node/migrate.ts` (+ unit tests except `migrate.test.ts`, see 2.3) into
      `packages/storage/src/`; rewrite the `InvalidRangeError` imports in `app.ts` +
      `routers/audio.ts`, the composition-root imports in `node/config.ts`, and
      **web-docs' `erSchema.ts` `applyMigrations` import** to `@autologger/storage`
      (same commit — no shim window for the 416 `instanceof` path); add the storage
      workspace entry to `web-docs`'s `extractImports.ts` + model component +
      snapshot regen so web-docs tests stay green (design D9).
- [x] 2.3 Split `migrate.test.ts` (design D2): ordering/idempotency/interrupted-run
      coverage rewritten against synthetic fixture `.sql` files inside the storage
      package (it currently resolves real migrations via `process.cwd()` and asserts
      the five real filenames — both break in a package cwd; pointing at catalog
      would mint a forbidden L1→L1 edge). The real-set assertion is owned by 3.5.
- [x] 2.4 Semantic edit: make `KvStore`'s `clock` parameter required (drop the
      `systemClock` default import); update test call sites; resolve the
      fakeClock/fakeCore helper homes for the moved tests per design D2 (enumerate
      all `test/fakeCore` + `test/fakeClock` importers first; no orphaned server
      test).
- [x] 2.5 Gate: full root typecheck + test; integration 416 range-error path
      exercised (spec scenario: cross-package `InvalidRangeError` identity → 416).

## 3. Catalog extraction

- [x] 3.1 Boundary-test delta: add `catalog → domain` / `catalog → ports` to the
      allowed edges (and prune `db` from `SERVER_SRC_LAYER_DIRS` when the directory
      empties, restating any affected positive pins — design D6).
- [x] 3.2 `git mv` `db/` production modules (`catalog.ts`, five stores,
      `profileAssembler.ts`, `sessionTitleDerivation.ts`) + unit tests into
      `packages/catalog/src/`; `git mv` `db/migrations/*.sql` into the package;
      export the resolved migrations dir path and the `createCatalog(db: CatalogDb)`
      factory (returns the facade type once 5.x lands; returns the class type until
      then) from the package.
- [x] 3.3 Rewrite db-importers (`appEnv.ts`, `auth/identity.ts`,
      `middleware/auth.ts`, routers, `test/helpers.ts`) to `@autologger/catalog`;
      wire `config.ts` `applyMigrations(db, <catalog package's exported dir>)`,
      deleting the local `MIGRATIONS_DIR` URL resolution; update **web-docs'**
      hard-coded `server/src/db/migrations` paths (`erSchema.test.ts`,
      `scripts/check.ts`) to the package's exported dir; extractor entry + model
      component + snapshot regen (design D9).
- [x] 3.4 Relocate `db/` int tests (`catalog.int.test.ts`, `authStore.int.test.ts`,
      `changesReaders.int.test.ts`) to `server/src/test/` with imports pointing at
      the package; tier + `setup.int.ts` wiring untouched.
- [x] 3.5 Gate: full root typecheck + test, plus the two migration scenarios (fresh
      `DATA_DIR` migrates the full ordered set via the package path — same name
      set/order in `_migrations`, same schema; already-migrated `DATA_DIR`
      untouched) under vitest, **and one `npm run start` boot against a fresh
      `DATA_DIR`** proving the `import.meta.url` package path under tsx (design
      risk row — don't defer tsx proof to e2e).

## 4. Session-core extraction

- [x] 4.1 Move `isAutoGeneratedMetadataJson` from `routers/events.ts` to
      `@autologger/domain`; rewrite the router + `eventStore.test.ts` imports
      (kills the only session→server edge before the move).
- [x] 4.2 Boundary-test delta: add `session-core → {domain, contract, ports}` to the
      allowed edges; retire the `aiV2 → session` positive directory pin (the edge
      becomes a bare-specifier package import); prune `session` from
      `SERVER_SRC_LAYER_DIRS`; restate surviving positive pins (`node → auth`);
      update the stale `eventStore.test.ts → routers/events` scope comment (design
      D6). **Partial per ledger:** the allowed-edges addition and the stale-comment
      update landed now; the `aiV2 → session` pin retirement and `session` prune are
      handed off to task 4.3 (still real/true until the module move) — see
      `.apply/task-4.1-4.2-report.md`.
- [x] 4.3 `git mv` `session/` production modules + unit tests into
      `packages/session-core/src/`; move `fakeRuntime` (and the fake-clock helper
      per the 2.4 inventory) into the package as non-exported test infrastructure;
      `DEFAULT_CLOCK` stays a local literal in the hub module. Same commit: rewrite
      session-importers (routers, `aiV2/`, `logImport/`,
      `node/generateTranscript.ts`, `node/config.ts`, `appEnv.ts`,
      `test/fakeCore`-dependents, **web-docs' `erSchema.ts`
      `sqliteSessionSql`/`SessionCore` imports**) to `@autologger/session-core` — no
      shim window for the `DashboardValidationError`/`DashboardBoundsError` 422
      `instanceof` path (design risk row); extractor entry + model component +
      snapshot regen (design D9).
- [x] 4.4 Relocate `SessionHub.int.test.ts` + `rowsWrittenReaders.int.test.ts` to
      `server/src/test/` (imports → package; tier untouched).
- [x] 4.5 Gate: full root typecheck + test; verify the zero-await `create_event`
      source pin (in `aiMcpServer.test.ts`, reading `routers/aiMcpServer.ts` — which
      does not move) still passes untouched, and the boundary test passes **with**
      its planned 4.2 delta; dashboard-config invalid-write 422 int pin green
      (cross-package identity).

## 5. Facade interfaces + appEnv allowance retirement

- [x] 5.1 Author the catalog facade interfaces in `@autologger/catalog` (Catalog
      facade + five store interfaces), **property-style function-type members**
      (design D3 — method syntax is bivariant in parameters and defeats the
      compiler-checked-drift scenario); concrete classes declare `implements`;
      `createCatalog`'s return type becomes the facade interface. See
      `.apply/task-5.1-5.2-report.md`.
- [x] 5.2 Author the session-core facade interfaces (hub RPC surface + registry
      facade exactly `get`/`evictIdle`/`startSweeper`, per the consumption
      criterion), property-style members; `SessionHub`/`SessionHubRegistry` declare
      `implements`; excluded members (`lastTouchedMs`, `close`, `hasArmedAlarm`,
      `socketCount`; registry `closeAll` + internals) enumerated in the commit
      message; no facade member's declared parameter/return type names a concrete
      class, store, registry, or `Database` (no-passthrough scenario). Audit found
      three more excluded hub members beyond the named minimum (`presence`,
      `listDashboards`, `stopTakeWithDuration` — zero external call sites); see
      `.apply/task-5.1-5.2-report.md`.
- [x] 5.3 Retire the allowance: `appEnv.ts` types `Ports.sessions` /
      `Variables.catalog` with the facade interfaces and imports no concrete class;
      `middleware/auth.ts` constructs via `createCatalog` (per-request
      construct-then-`init()` lifecycle byte-identical — design D3); rewrite all
      remaining non-composition-root production references to concrete persistence
      classes (`node/config.ts` becomes the sole production namer, spec scenario);
      update the appEnv header comment. See `.apply/task-5.3-5.4-report.md`.
- [x] 5.4 Gate: full root typecheck + test; frozen-surface conformance fixtures
      unchanged; excluded-member compile-failure spot check (a
      `Ports.sessions`-typed reference to `lastTouchedMs` fails `tsc --noEmit`,
      recorded in the ledger). See `.apply/task-5.3-5.4-report.md`.

## 6. Boundary + toolchain enforcement (new checks only — per-phase deltas landed in 2–4)

- [x] 6.1 Extend `packageBoundaries.repo.test.ts` with the genuinely new checks
      (design D6): no-L1→L1-sibling assertion; third-party bare-specifier vs
      manifest check over package **production** source (`dependencies` +
      `peerDependencies`; `*.test.ts` and the reviewed per-package
      test-infrastructure exemption list may use devDependencies); interface-only
      assertion (among `server/src` production files, only `node/config.ts` may
      import the concrete persistence identifiers from the two packages — tests
      exempt). See `.apply/task-6.1-6.3-report.md` (also fixed a pre-existing
      `packages/ports` jose peerDependency gap the package-general third-party
      check surfaced).
- [x] 6.2 Negative-case demonstrations, recorded in the apply ledger: (a) undeclared
      third-party specifier in a package fails; (b) an L1→L1 import fails; (c) a
      non-composition-root concrete import in a `server/src` production file fails;
      then revert all three. See `.apply/task-6.1-6.3-report.md`.
- [x] 6.3 Single-copy gates as JSON-parsed properties (design D8): exactly one
      resolved copy in `npm ls zod --json` and `npm ls better-sqlite3 --json`
      (exit codes are not the criterion — record the pre-existing
      `@anthropic-ai/claude-agent-sdk` zod-4 peer-range ELSPROBLEMS as an
      environmental fact in the ledger). See `.apply/task-6.1-6.3-report.md`.

## 7. Docs, atlas, final gates

- [x] 7.1 Atlas finalization: verify the three package components + per-phase edge
      updates landed coherently; final per-edge attribution review of the full edge
      snapshot diff (every vanished/new edge tied to a design decision); root
      `npm run docs:check` green.
- [x] 7.2 Update README annotated tree + endpoint-table-adjacent architecture prose
      and CLAUDE.md source layout for the new package homes (origin headers
      preserved verbatim on moved files).
- [x] 7.3 Whole-branch layered scoped audit per SKILL.md step 7 (contract/seam
      diffs of surface-touching phases, full diffs of deferred phases, materialized
      file list + stray-file scan, seam call-site checks against declared
      properties).
- [x] 7.4 Final gates: `npm run typecheck`, `npm test`, `npm run lint`,
      `npm run e2e` (chromium + login-gate) AND `npm run e2e:visual` (no UI change —
      any visual diff is branch-induced signal to investigate, not re-bless),
      `npm run docs:check`.
