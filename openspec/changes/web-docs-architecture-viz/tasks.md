# Tasks: web-docs-architecture-viz

> Panel + gate passed 2026-08-07 (rulings folded back; see design.md Panel & review log).
> Anchors are orientation only — locate code by content before editing.

## 1. Workspace scaffold & root wiring

- [x] 1.1 Create `web-docs/` workspace: `package.json` with devDeps — `typescript` and
      `mermaid` **exact-pinned**, `tsx`, `jsdom`, `vite`, `react`, `react-dom`, `vitest`,
      `better-sqlite3` at `server/`'s exact specifier — plus `tsconfig.json`,
      `biome.json` (the `web/` pattern), and a Vite + React shell rendering a placeholder
      page, dev server loopback-bound on port 5175. Verify `npm install`,
      `npm run typecheck -w web-docs`, `npm run lint -w web-docs`.
- [x] 1.2 Wire root `package.json`: add `web-docs` to `workspaces`; append web-docs legs
      to root `typecheck`, `lint`, and `test` (test leg = workspace unit tests only); add
      root `docs:check` script (extraction + all gates against the live tree). Root
      `dev`/`build`/`start` untouched. Then assert via `git diff package-lock.json` that
      no entry outside `web-docs`' own subtree changed resolution. Verify root
      `npm run typecheck` and `npm run lint` pass end-to-end.

## 2. Component model & coverage gate

- [x] 2.1 TDD the model schema + coverage gate: types for components (name, `kind`:
      runtime | datastore | external | tooling | test-harness, description, globs,
      capabilities, authoredDiagrams), declared relationships with evidence rules,
      capability scopes (component | cross-cutting + set | process), and the reasoned
      exclusion list, in `web-docs/model/components.ts`. Coverage enumerates tracked
      `.ts`/`.tsx` via `git ls-files`: orphan (not excluded) and overlap each fail naming
      the file and nearest component; no glob may be a bare workspace source root
      (fixture-tree unit tests).
- [x] 2.2 Author the real component model covering the whole tracked tree — module
      clusters (routers, session spine, catalog DB, node infra, auth, aiV2, logImport,
      middleware, web SPA, companion, e2e), `server/src/test/` as a `test-harness`
      component, `fixtures/api-responses/` as the contract-fixtures component, homes for
      the 12 loose top-level `server/src` files (`app.ts`, `main.ts`, `env.ts`,
      `clock.ts`, `schemas.ts`, `studio.ts`, `timecode.ts`, `types.ts` + tests),
      datastore nodes (catalog DB, session DBs, blob store) and gated external nodes
      (DeepGram, Claude CLI, yt-dlp, Google JWKS), and exclusions (workspace
      vite/vitest configs, root `playwright.config.ts`, `scripts/`). Verify the coverage
      gate passes via `docs:check` against the live repo.

## 3. Edge extraction, classification & snapshot gate

- [x] 3.1 TDD file-level import extraction: `ts.Program` built from the mapped-file list
      (never tsconfig `include`/`exclude`), per-workspace `compilerOptions` for
      resolution across the four regimes (server Bundler + `scripts/`; web bundler +
      `paths` aliases + `.ts` extensions; companion NodeNext `.js`→`.ts`; e2e). Literal
      dynamic `import()` captured; non-literal dynamic imports collected as warnings
      with call sites; unresolvable non-TS specifiers (CSS/images/assets) ignored; an
      import resolving to an unmapped, unexcluded in-repo file fails naming both files
      (fixture-based unit tests). Extractor runs under `tsx`.
- [x] 3.2 TDD component-edge projection, `production`/`test` classification (test file
      or test-harness endpoint ⇒ test edge — the live `web → server/src/aiV2/
      aggregates.ts` test-only import is the characterization case), and the snapshot
      gate: derived set diffed against committed
      `web-docs/model/edges.snapshot.json`; new or vanished edge fails naming the edge,
      underlying imports, and the regeneration command (`npm run snapshot -w web-docs`).
      Generate and commit the initial reviewed snapshot; verify via `docs:check`.

## 4. Relationship evidence & capability accounting gates

- [x] 4.1 TDD relationship evidence checks (each a named file + literal rule): web→server
      (`web/src/api/client.ts` fetch/WS), companion→server (`companion/src/api.ts`
      base-URL fetch), server→web static-serve (`serveStatic` call site), e2e
      process-spawn (harness spawn sites), datastore/external call sites with
      config-gate labels. Unevidenced declared relationship fails naming relationship +
      rule. Declare the real relationships; verify via `docs:check`.
- [x] 4.2 TDD capability accounting: every baseline `openspec/specs/` dir attached /
      cross-cutting / process, else fail naming it; dangling model refs fail;
      capabilities named only by active-change deltas resolve as **pending** (no
      failure). Account for all 17 baseline capabilities (cross-cutting:
      `api-contract-freeze`, `web-api-response-conformance`, `web-ui-system`,
      `core-ports-architecture` as declared sets; process: `sdlc-process`) and verify
      `web-docs-site` itself surfaces as pending, via `docs:check`.

## 5. Spec, schema, and change extraction

- [x] 5.1 TDD the spec-markdown parser: capability → requirements → scenarios tree from
      `### Requirement:` / `#### Scenario:` headings, with the count-equality gate
      (parsed counts equal direct heading counts; unclassifiable heading in a
      Requirements section fails naming the capability). Fixtures + live-repo smoke.
- [x] 5.2 TDD ER extraction: catalog via exported `applyMigrations(db, dir)` on a bare
      in-memory better-sqlite3 handle; session via `SessionCore` over a second handle
      (`sqliteSessionSql` adapter + inert stubs, per `server/src/test/fakeCore.ts`) then
      `initSchema()`; introspect `sqlite_master`/`pragma table_info`/
      `foreign_key_list`; emit `erDiagram` sources excluding `sqlite_%` and
      `_migrations`, schema only. Assert catalog tables/columns/FKs and session tables/
      columns present; no DDL text parsing.
- [x] 5.3 TDD the overlay extraction: active changes = git-tracked `proposal.md` dirs
      under `openspec/changes/` (archive excluded); partial/untracked dirs skipped with
      a warning; touched capabilities from delta dirs; component-scoped ⇒ tint,
      cross-cutting ⇒ listed untinted, unknown ⇒ pending; delta-less changes listed
      untinted.

## 6. Diagram generation, validation & atlas assembly

- [ ] 6.1 TDD mermaid source generation: L0 flowchart (kind-styled nodes with
      tooling/test-harness and test-edge toggles, production snapshot edges,
      relationships rendered distinctly, navigation ids, overlay tints; all
      disk-derived strings escaped), per-component L1 module graphs (subdirectory
      grouping above threshold, test files elided by default with counts). Renderer
      assertion: L0 source contains every snapshot production edge + declared
      relationship.
- [ ] 6.2 Author the two v1 state diagrams in `web-docs/diagrams/` from code reads:
      recording lease (grant → heartbeat → stale-holder takeover → expiry, alarm
      re-arm; `leaseStore.ts`) and SessionHub registry (constructed → active →
      evicted-and-reconstructed under the triple idle guard; `SessionHubRegistry`).
      Attach in the model. No transcript diagram (deferred pending
      `transcript-gen-lock-status`).
- [ ] 6.3 TDD diagram validity + atlas assembly: jsdom-bootstrapped mermaid parse
      (no browser-downloading deps), structural checks (non-empty; authored diagrams
      have ≥1 state and ≥1 transition; every navigation id resolves to a component
      route), per-diagram node/edge budgets as hard failures, shared mermaid config
      embedded in `atlas.json`; determinism tests (two runs byte-identical; sorted
      iteration; no absolute paths/hostnames in atlas; no reads of git-ignored
      artifacts). `atlas.json` gitignored, regenerated by build and dev-server start.

## 7. Site pages

- [ ] 7.1 L0 page: render from `atlas.json` with `securityLevel: 'strict'`,
      `htmlLabels: false`; node navigation via post-render DOM handlers; kind/test
      toggles; active-changes sidebar (links, pending capabilities); tint legend; About
      page listing exclusions and process capabilities.
- [ ] 7.2 L1 component pages: module graph with grouping + elided-test counts and
      toggle, capability list with requirement counts linking into the browser,
      in-flight changes touching the component.
- [ ] 7.3 L2 views: catalog + session ER pages (labeled mechanical; sparsity note),
      authored state diagrams labeled "authored", requirement/scenario browser rendering
      parsed text as text nodes. Tests: extraction-level vitest plus one routing smoke
      with the mermaid module stubbed (mermaid `render()` cannot run under jsdom).

## 8. Final gates & docs

- [ ] 8.1 Full gates: root `npm run typecheck`, `npm test`, `npm run lint`,
      `npm run build -w web-docs`, root `npm run docs:check`. **`npm run e2e` and
      `npm run e2e:visual` are both skipped — declared proportionality: task 8.2's
      `git diff --stat main` proves no `server/`, `web/`, or `companion/` source
      changed on this branch, so app behavior and visual baselines cannot legitimately
      move.**
- [ ] 8.2 Docs + process encodings: README web-docs section (what the site shows, drift
      gates, `npm run dev -w web-docs` / `build` / `docs:check`); CLAUDE.md — layout
      pointer + SDLC final-gates line (run `docs:check` at branch completion/archive;
      attach newly archived capabilities in the web-docs model in the archive commit);
      matching step in `.claude/skills/openspec-archive-change/SKILL.md` with a
      parse/load verification of the edited skill (machine-parsed governance file).
      Verify no server/web/companion source file changed (`git diff --stat main`).
