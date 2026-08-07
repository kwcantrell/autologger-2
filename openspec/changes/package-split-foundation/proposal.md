# package-split-foundation — Proposal

## Why

The server (17.9k production lines) and web (26.3k) workspaces are internally monolithic:
`server/src/types.ts` imports six concrete implementation classes to name `Ports` and is
imported by 25 production files, so **every router type-depends on every subsystem**; the
repo's two directory-level import cycles (`session ⇄ aiV2` through
`session/dashboardStore.ts` → `aiV2/catalog.ts`, and `auth ⇄ node` through
`auth/identity.ts`'s `KvStore` type import) both run through modules this change moves;
and all module boundaries are comment-enforced. The owner has decided (exploration
2026-08-07) to decompose both workspaces into fine-grained npm workspace packages — a
**modular monolith** with two goals: hard boundaries, and service-shaped seams at the
three realistic future-worker candidates (transcription, YouTube import, AI runtime).

This change is the **foundation** of that campaign: the mechanical groundwork every later
package extraction depends on. Doing it first is what makes the successors cheap —
the codebase has zero file-level import cycles, both directory-level cycles die inside
this change, and several modules (`studio.ts`, `timecode.ts`) are already dependency-free
— so the window where this is a cheap move is now, before queued work
(`ai-session-analyst`, 30 tasks) deepens the `routers/` tangle.

## What Changes

- **Workspace scaffolding.** A top-level `packages/` directory joins the npm workspaces.
  Packages are **source-only** (`"exports"` pointing at `./src/*.ts` — the server already
  runs via `tsx` on source; no build step, no committed artifacts), typechecked by
  per-project `tsc --noEmit` (NOT `tsc -b` project references — panel-verified
  incompatible with no-emit packages), tested via explicitly enumerated vitest projects
  that preserve the server's two-tier unit/integration setup, and linted (`biome.json`
  and the root lint script gain `packages/**` coverage).
- **Boundary enforcement is a repo test, not the compiler.** Panel-verified: npm
  workspace hoisting resolves undeclared cross-package imports and `tsc` never reads
  manifest `dependencies` — so layering is enforced by a repo-invariant test (in the
  established `*.repo.test.ts` idiom) asserting each package's import specifiers are a
  subset of its manifest dependencies and that the layer graph holds, demonstrated
  against a deliberate violation.
- **`@autologger/domain`** (L0): `studio.ts`, `timecode.ts`, and `db/shared.ts` move in —
  the pure, dependency-free domain modules (20/12/8 production importers).
- **`@autologger/contract`** (L0): `schemas.ts` and `aiV2/catalog.ts` move in. This
  **breaks the `session ⇄ aiV2` directory cycle** and makes the contract package the
  single home of dashboard-config validation. `zod` is declared as a **peerDependency**
  so a second zod instance can never break the app's `instanceof ZodError` → 422 mapping;
  the 422 and `ValidationError` → 400 error paths get explicit cross-package pin tests.
- **`@autologger/ports`** (L0): interface-only port definitions (`Clock`, `BlobStore`,
  `KvStore`, `IdentityVerifier`, `CatalogDb`, `PresenceRegistry`) plus the `Config` type
  — no runtime implementations (`systemClock` moves to the composition side).
  `server/src/types.ts` is retired: a small app-level `server/src/appEnv.ts` composes
  `Ports`/`Variables`/`AppEnv` over the package's interfaces, keeping the concrete
  `SessionHubRegistry`/`Catalog` handle types at app level (gate ruling 2026-08-07:
  interface-extracting the ~52-method hub and ~71-method catalog facades is **named
  residual work** owned by the session-core and catalog extraction changes). Routers stop
  type-depending on the blob/kv/presence/identity implementations; the `auth ⇄ node`
  cycle dies with the `KvStore` interface move.
- **`createAnchoredEvent` becomes a `SessionHub` RPC**: `create_event`'s
  read-filter-anchor-insert block moves from the tool body into one synchronous,
  transactional hub method (calling the *store-level* `events.addEvent` to avoid nested
  self-transactional delegates) — upgrading a comment-enforced interleaving invariant
  into a single better-sqlite3 transaction. The tool body keeps parsing, allowlisting,
  cap enforcement, and metadata composition, calls the RPC synchronously (no `await`
  introduced anywhere in the handler), and stays byte-identical in observable behavior.
- **SessionToolPort is deferred** (gate ruling 2026-08-07, panel consensus): the AI tool
  bodies keep their direct `SessionHubRegistry` access in this change. The port design —
  including the panel's hardening requirements (factory-minted session binding, cap
  reservation, consistent-read bundles, exact-surface pinning) — is recorded in
  `design.md` as input to the AI-runtime extraction change, where the first real
  consumer (`ai-session-analyst`, whose gated spec needs range/slice and paged/enriched
  reads) can cut the interface against actual requirements.
- **No other file moves.** `routers/`, `session/`, `node/`, `db/`, `auth/`, `logImport/`
  stay in `server/src`; extracting them is successor-change work.

## Capabilities

### New Capabilities
- `package-architecture`: the normative workspace-package layout and layering rules —
  down-only imports across the layer graph enforced by a repo test, source-only package
  mechanics (no build step, no committed artifacts, full lint/test/typecheck coverage),
  no duplicated runtime dependencies where the app does nominal `instanceof` checks,
  each process-wide singleton living in exactly one package, the contract package as the
  single home of wire request schemas and the dashboard catalog/validator, and
  preservation of the cross-workspace fixture chain.

### Modified Capabilities
- `core-ports-architecture`: port types become **interfaces in a dedicated L0 package**
  with app-level composition of `AppEnv` (`server/src/appEnv.ts`; no permanent
  `types.ts` shim); two existing sweep scenarios (Cloudflare nouns, decision-making
  `Date.now()`) are re-scoped to cover `packages/**` alongside `server/src`.
- `auto-event-generation`: adds the requirement that `create_event`'s anchor-basis read
  and insert execute as **one transaction** (`SessionHub.createAnchoredEvent`) with
  observable behavior unchanged, and pins the handler's zero-`await` atomicity (cap
  check → insert → counter increment) so a future async conversion must confront it
  explicitly.

## Impact

- **Contract impact: none.** No HTTP/WS observable change — no route, JSON shape, status
  code, export body, or WS emission changes. MCP tool results stay byte-identical.
  `fixtures/api-responses/` capture and web conformance tests run unchanged. The 422/400
  error mappings are explicitly pin-tested across the package boundary.
- **Code:** ~70 server files (including tests) get import-specifier rewrites (`types`,
  `clock`, `studio`, `timecode`, `schemas`, `aiV2/catalog`, `db/shared`); root
  `package.json` workspaces + scripts; per-package `package.json`/`tsconfig.json`;
  `biome.json`; vitest project wiring; new `server/src/appEnv.ts`; the new boundary repo
  test; `SessionHub.createAnchoredEvent` + the `create_event` tool-body call-site
  switch.
- **Docs:** `README.md`'s annotated `server/src` tree and `CLAUDE.md`'s Source layout
  section are updated for the moved modules and the `packages/` area (both are
  normatively-read documents).
- **Web:** unaffected at runtime. `web/src/pages/index/components/aiV2/widgetTypes.ts`'s
  hand-mirror header comment re-points at the contract package (comment-only);
  `clientAggregates.pinning.test.ts` is untouched (`aiV2/aggregates.ts` does not move).
- **Tests:** moved modules' tests move with them and provably keep running (a
  deliberately-failing-test check gates the vitest wiring); characterization pins for
  `createAnchoredEvent` behavior parity land before the reshape.

## Non-Goals

- **No package extraction beyond the three L0 packages.** session-core, catalog,
  storage, auth, ai-runtime, transcription, media-import, and all web packages are
  successor changes.
- **No SessionToolPort implementation.** Deferred to the AI-runtime change (gate ruling
  2026-08-07); AI tool bodies keep direct registry access here, and no port interface
  ships in this change.
- **No hub/catalog facade interfaces.** `SessionHubRegistry`/`SessionHub` and `Catalog`
  keep concrete typing at app level — named residuals owned by the session-core and
  catalog extraction changes.
- **No router surgery.** `transcribe.ts`/`sessions.ts`/`events.ts` keep their welded
  route bodies.
- **No worker processes.** The single-Node-process invariant is untouched.
- **No shared server/web contract package.** Web keeps hand-written `api/types.ts` and
  the fixture-conformance chain per the `web-api-response-conformance` gate ruling.
- **No `env.ts` split.** Config readers stay in `server/src/env.ts`; slicing the
  `Config` surface per feature is recorded as a residual for the feature-package
  successor changes.
- **No behavior change anywhere** — any observable difference (HTTP, WS, MCP tool
  results, logs consumed by tests) is a defect.
