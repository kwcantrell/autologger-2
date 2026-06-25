# Design: Decompose `Catalog` into composed domain stores

**Date:** 2026-06-25
**Status:** Approved (design), pending implementation plan
**Scope:** `src/db/d1.ts` only. `SessionDO` decomposition is explicitly deferred to a separate effort.

## Motivation

A graphify pass over the worker flagged `Catalog` (`src/db/d1.ts`) as the codebase's
#1 god node: a single class with **56 methods across 978 LOC**, the highest betweenness
centrality (0.237) of any node, and the lowest community cohesion (0.061). Its own method
prefixes (`auth*`, `admin*`, `profile*`, `shows*`, `session*`) confess that five distinct
domains are crammed into one class, and ~60% of the routers depend on it. This makes the
file hard to reason about, hard to test in isolation, and a single point every subsystem
routes through.

The goal is to restore cohesion by splitting `Catalog` into focused, independently-testable
domain stores **without changing any observable behavior** — the worker's JSON output must
stay byte-identical (the README's "Same JSON Shapes" frontend-compatibility invariant is the
acceptance bar).

## Approach (chosen: A — Facade + composition)

`Catalog` remains the public class behind the per-request `c.get('catalog')` context var,
but its body becomes thin: it constructs five domain stores and delegates each method to
them. This keeps the blast radius **inside `src/db/` plus new sibling files** — zero router
changes, zero context-var changes, no `middleware/auth.ts` wiring changes.

Two alternatives were considered and rejected for this pass:
- **B — Direct store injection** (drop the facade; per-domain context vars; rewrite all ~30
  router call sites). Cleaner end state but medium risk to the compatibility guarantee.
  Reachable later by retiring the facade's delegation shim.
- **C — Lighter touch** (extract only pure helpers + `profilePayload`). Minimal churn but
  `Catalog` stays a ~700-line multi-domain class; only a partial cohesion win.

## 1. Target module structure

`src/db/d1.ts` splits into focused siblings, each owning its SQL:

| New file | Owns | Constructor deps |
|---|---|---|
| `src/db/studioRegistry.ts` — `StudioRegistry` | `order`/`names` state, `init`/`refreshStudioRegistry`, `isKnownStudio`, `studioOrderTuple`/`studioNamesDict`, `listStudiosBrief`/`listStudiosBriefAllowed`, `getSetting`/`setSetting`, settings blobs (`getStudioSettingsBlob`, `saveStudioSettingsBlob`, `loadStudioProfile`, `resolveActiveStudio`, `allStudioSettingsForAllowedStudios`), plus `adminCreateStudio`/`adminDeleteStudio` (they mutate and refresh the registry) | `db` |
| `src/db/authStore.ts` — `AuthStore` | users CRUD, memberships, prefs, admin user ops (`authGetUserByGoogleSub` … `authSeedPrefsFromGlobals`, `authListUsersAdmin`, `authGetUserRowAny`, `authSetUserDisabled`, `authRemoveMembership`) | `db` |
| `src/db/showsStore.ts` — `ShowsStore` + pure shapers | shows CRUD (`getShowRow` … `updateShowFields`); the pure functions `showApiDict`, `showCategoriesApiShape`, `dropdownOptionsApiShape`, `hexColorsFromJson`, `categoriesListFromShowRow` | `db` |
| `src/db/sessionIndexStore.ts` — `SessionIndexStore` | sessions index + live projection (`getSessionStudioId` … `studioProfileForSession`, `projectSessionLive`, `getSessionShowCategories`, `createSessionIndex`, `updateSessionIndex`, `setSessionArchived`/`UiHidden`/`EpisodeDate`, `bumpShowNextEpisodeFromEpisodeString`) | `db`, `StudioRegistry`, `ShowsStore` |
| `src/db/profileAssembler.ts` — `ProfileAssembler` | the orchestrator: `profilePayload`, `authSection`, `profileStudioForUser`, `getEffectiveStudioForUser`, `resolveActiveShowIdForStudio` | `StudioRegistry`, `AuthStore`, `ShowsStore` |
| `src/db/d1.ts` — slimmed `Catalog` **facade** | constructs the five stores, exposes `init()`, **re-exports** `AuthUser`/`ProfileCtx`/`Row` types + the pure shapers, and delegates the method surface routers use | the five stores |

Net result: one 978-line multi-domain class becomes six files of ~80–250 LOC, each holding
a single purpose that fits in context at once.

### Boundary notes
- **Admin studio ops** (`adminCreateStudio`/`adminDeleteStudio`) live in `StudioRegistry`
  because they mutate `studio_definitions` and must call `refreshStudioRegistry()` afterward.
  `adminDeleteStudio` also deletes `user_studio_memberships` rows via its own `db` handle —
  acceptable cross-table reach for a delete that is conceptually a studio-definition removal.
- **`app_settings`** (`getSetting`/`setSetting`) stays inside `StudioRegistry` rather than its
  own module: it is only used by studio-config concerns (settings blobs, active studio/show
  pointers). A dedicated `SettingsStore` would be a one-method-pair file with no other client.

## 2. The facade (keeps blast radius at zero)

`Catalog` keeps its `constructor(db)`, `init()`, and **every method name routers already
call** (`catalog.authListUsersAdmin()`, `catalog.getSessionIndexRow()`,
`catalog.isKnownStudio()`, …). Each becomes a one-line delegate, e.g.
`authListUsersAdmin = () => this.auth.listUsersAdmin()`.

The five stores are also exposed as `readonly` properties (`catalog.auth`, `catalog.studios`,
`catalog.shows`, `catalog.sessions`, `catalog.profile`) — that is the forward-looking API.
The flat delegating methods are an explicit, clearly-commented **compatibility shim**; a later
effort can retire them to migrate toward Approach B. No router, context-var, or
`middleware/auth.ts` change is required now.

## 3. Data flow (unchanged per request)

`src/middleware/auth.ts` still does `new Catalog(env.DB)` → `await catalog.init()` →
`c.set('catalog', catalog)`. The `Catalog` constructor wires:

```
studios = new StudioRegistry(db)
auth    = new AuthStore(db)
shows   = new ShowsStore(db)
sessions = new SessionIndexStore(db, studios, shows)
profile  = new ProfileAssembler(studios, auth, shows)
```

All stores that need registry state hold a reference to the **same** `StudioRegistry`
instance, so the `order`/`names` loaded by `init()` is live everywhere. Routers continue to
call `c.get('catalog').<method>()` exactly as today.

## 4. Safety net — pure-function tests

Chosen verification strategy: unit-test the pure shapers + a facade smoke test; rely on
`tsc` and manual checks for SQL store methods.

- Add `vitest` (node environment — these functions never touch D1, so no
  `@cloudflare/vitest-pool-workers` needed). `package.json`: add `"test": "vitest run"` and a
  `vitest` devDependency.
- `src/db/showsStore.test.ts`: characterization tests locking the current output of
  `showApiDict`, `showCategoriesApiShape`, `dropdownOptionsApiShape`, `hexColorsFromJson`,
  `categoriesListFromShowRow` against representative rows — **written and green before the
  functions move**, so the move is provably behavior-preserving.
- `src/db/d1.test.ts`: a facade smoke test asserting `new Catalog(stubDb)` exposes every
  delegated method (`typeof === 'function'`), catching delegation typos across all 56 methods.
  Uses a minimal stub `D1Database` (no real queries executed).
- Everything else (SQL store methods, `profilePayload`) is verified by `tsc --noEmit` plus
  manual hits of `/api/profile` (logged-out, logged-in, OAuth-configured) and
  `/api/admin/users`.

## 5. Error handling & scope guards

- **No behavior change.** `ValidationError` (from `src/studio.ts`) is still thrown by the same
  logic, now living in `StudioRegistry` (admin studio ops) and `SessionIndexStore`
  (`updateSessionIndex`). `ApiError` is router-level and untouched. JSON output shapes stay
  byte-identical.
- **YAGNI:** not touching `SessionDO`; not changing SQL, schema, or output shapes; not
  migrating routers to per-store context vars (the optional future Approach B); no speculative
  cleanup.
- **Dead-code rider — resolved as not actionable.** Scoped to `Catalog`, graphify's "no
  caller" flags (`showApiDict`, `showCategoriesApiShape`, etc.) are **false positives**: all
  are imported by routers (`shows.ts`, `companion.ts`, `events.ts`); the AST extractor simply
  missed those import edges. There is nothing genuinely dead inside `d1.ts` to remove, so the
  rider is dropped rather than used to invent cleanup.

## 6. Sequencing (basis for the implementation plan)

Each step keeps the worker compiling and behavior-identical, so work can safely stop between
any two steps.

1. Add `vitest` + characterization tests for the 5 pure functions (green against current
   `d1.ts`).
2. Extract pure shapers → `showsStore.ts`; re-export them from `d1.ts`; tests stay green.
3. Extract `StudioRegistry`; `Catalog` constructs it and delegates; `tsc` green.
4. Extract `AuthStore`; delegate.
5. Extract `ShowsStore` methods; delegate.
6. Extract `SessionIndexStore` (depends on registry + shows); delegate.
7. Extract `ProfileAssembler` (depends on registry + auth + shows); delegate.
8. Add the facade smoke test; run `tsc --noEmit`; manually verify `/api/profile` +
   `/api/admin/users`.
9. Bump `version` in `src/.../package.json` (the worker's own manifest; currently `0.1.0`).
   Note: this worker subdirectory has no `pyproject.toml` and no `CHANGELOG.md` — the
   `CLAUDE.md` versioning rule (pyproject/README/CHANGELOG) applies to the Python parent
   project, not here. Creating a worker `CHANGELOG.md` is out of scope for this refactor.

## Acceptance criteria

- `Catalog`'s public surface (constructor, `init()`, all router-called methods) is unchanged;
  no router or middleware file is edited.
- `src/db/d1.ts` is reduced to the facade plus type/shaper re-exports; the five new store
  files each hold one domain.
- `tsc --noEmit` passes; `vitest run` passes (pure-function characterization + facade smoke).
- `/api/profile` (logged-out, logged-in, OAuth-on) and `/api/admin/users` return output
  identical to pre-refactor.
- `version` bumped in the worker's `package.json`.
