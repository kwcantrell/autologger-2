# Comprehensive test suite (hybrid) — design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Scope:** Test-only. No production-code changes — tests characterize *current* behavior, including known quirks. Adds dev dependencies and a vitest config.

## Background

A coverage inventory (graphify graph + filesystem) shows **10 of 36 source modules** have a sibling test, and **every existing test is pure-function / fake-based**: row mappers (`audioRowToMeta`, `showApiDict`, `wordRow`, …), shapers, the `Catalog` facade-surface check (using a `{}` stub `D1Database`, `init()` never called), and the fake-`SessionCore` tests added for `leaseStore`/`transportStore`. Nothing exercises a real D1 database, a real Durable Object, KV/R2, or the HTTP layer. There is no vitest config (node defaults) and `@cloudflare/vitest-pool-workers` is not installed.

The untested surface — all 11 routers, auth/OAuth, both middleware, the D1 SQL stores, `studio.ts`, `timecode.ts` — is also where a prior audit found the highest-risk issues (cross-tenant scoping, SQL/migration correctness, the recording-lease alarm against real storage).

## Goals

1. Stand up a **hybrid** test harness: node-vitest for pure logic, `@cloudflare/vitest-pool-workers` for integration against real bindings — without disturbing the existing suite.
2. Comprehensively cover the **pure tier** (logic that fakes test exactly and cheaply).
3. Integration-test the **audit's danger zones** (D1 tenancy/SQL/migrations, SessionDO real-storage + lease alarm, core router auth/tenancy/validation/caps).
4. Provide reusable seed/auth helpers so integration tests stay declarative.

## Non-goals (deferred to a follow-up spec)

- `oauth_google.ts` end-to-end (Google JWKS verification needs mocked key material).
- Exhaustive endpoint-by-endpoint integration coverage of every route.
- Companion presence/command relay edge cases beyond the core happy/authz paths.
- Frontend, the `companion-module-autologger` package, load/performance testing.
- Any production-code change. Where a known quirk exists (e.g. drop-frame separator over non-drop-frame math in `timecode.ts`, `SESSION_DAYS` accepting non-positive values), tests assert the **current** behavior so a future fix is a deliberate, visible change.

## Architecture — test infrastructure

A **vitest workspace with two projects**, split by filename so existing files are untouched:

- **node project** — glob `src/**/*.test.ts`, excluding `src/**/*.int.test.ts`. Default node environment. All 10 current test files remain here unchanged. New pure-tier tests are added here as `*.test.ts`.
- **workers project** — glob `src/**/*.int.test.ts`. Runs inside `workerd` via `@cloudflare/vitest-pool-workers`, reading `wrangler.jsonc` for the real `DB` (D1), `SESSION_DO` (DO), `AUTH` (KV), and `AUDIO` (R2) bindings.

Config sketch (`vitest.config.ts` at repo root, using `defineWorkersConfig`):

- `test.projects` (or workspace) with the two entries above.
- The workers project sets `poolOptions.workers.wrangler.configPath = './wrangler.jsonc'` so bindings are auto-derived, and `poolOptions.workers.miniflare.bindings.TEST_MIGRATIONS = await readD1Migrations('src/db/migrations')`.
- `poolOptions.workers.isolatedStorage = true` so each test file/test gets clean D1/DO/KV/R2 state.

Integration setup file (`src/test/setup.int.ts`, referenced by the workers project's `setupFiles`):

```ts
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
```

Integration tests drive:
- **Routers** via `app.request(path, init, env)` (import the Hono `app` from `src/index.ts`) or `SELF.fetch(...)`.
- **D1 stores** by constructing `new Catalog(env.DB)` / the individual stores against `env.DB`.
- **SessionDO** via `env.SESSION_DO.get(id)` + `runInDurableObject(stub, (instance, state) => ...)` from `cloudflare:test`, or by calling the DO's RPC methods through its stub.

**Compatibility risk (explicit):** `@cloudflare/vitest-pool-workers` must match the installed `vitest@2.1.9`. The implementation plan's **first task is a single harness smoke test** (apply migrations, run one trivial `app.request('/')` assertion) to confirm the toolchain boots before the bulk of tests are written. If versions conflict, pin a compatible `vitest` + pool-workers pair there.

## Pure tier — coverage (node, `*.test.ts`)

- **`timecode.ts`** — `fromTotalFrames`/`toTotalFrames` round-trip across 24, 25, 29.97, 30, 59.94, 60 fps; `formatSmpte` separator (`;` for 29.97 within tolerance, `:` otherwise) — characterized as current behavior; hour wrap at 24; frame-0 and large-frame-count boundaries; `parseUtcMs`/`isoZ`/`transportTimecode`.
- **`studio.ts`** — `validateEventPalette` (pad-to-9, clamp-to-9, `[]`→defaults, non-array→defaults), `validateCategoriesList`, `defaultCategoriesForNewStudio` (fresh ids per call — the shared-mutable-default guard), `blobToProfile`/`profileToBlob` round-trip, color-palette and category-kind helpers, migration helpers.
- **`env.ts`** — `requireLoginEnabled`, `newUserAllTeamsEnabled`, `cookieSecureForRequest`, `sessionTtlDays` (incl. the non-positive / huge-value edge), `sessionCookieName`, `oauthConfigured`, `publicBaseUrl`.
- **`middleware/ipAllowlist.ts`** (pure functions only) — `ipv4ToBigInt`, `ipv6ToBigInt`, `maskValue`, `parseIpAllowlist`, `ipInAllowlist` (v4, v6, CIDR matches and misses), `effectiveClientIp` header precedence (`CF-Connecting-IP` > `True-Client-IP` > first `X-Forwarded-For`), `netsForEnv` caching. The middleware handler's 403 response is covered in the integration tier.
- **`schemas.ts`** — extend `schemas.test.ts` to every schema: min/max bounds, enums, `nullish`, `default`s, the `metadata` size cap, `frame_rate` bounds, `timecode_hms` length, companion/admin/transcript/topic bodies.
- **`auth/identity.ts`** (pure helpers only) — `randomToken` (length/charset), `normalizeOauthStateParam`, `bearerToken` parsing, `apiRequestRequiresLogin` path logic. KV-touching helpers (`createLoginSession`, `takeOauthState`, `requestHasValidAdminToken` needing `env`) are integration.
- **D1 row mappers** — the remaining exported pure mapper/shaper functions in `authStore.ts`, `profileAssembler.ts`, `sessionIndexStore.ts`, `studioRegistry.ts` (the plan enumerates exact names after reading each store).

## Integration tier — coverage (workers, `*.int.test.ts`)

- **D1 stores** (real `env.DB`, migrations applied):
  - `studioRegistry`: create/delete studio, `setSetting` upsert, `saveStudioSettingsBlob` round-trip, `listStudiosBrief`, `adminDeleteStudio` blocks when shows exist + batch atomicity.
  - `authStore`: create Google user, get by sub/id, memberships add/remove/list, prefs get/set, disabled flag, `authUserHasStudio`.
  - `showsStore`: `createShow`, `listShowsForStudio`, `updateShowFields`, `getShowRow`.
  - `sessionIndexStore`: `createSessionIndex` + episode bump, `getSessionStudioId` (incl. orphaned-show → null), `listSessionsForShow` ordering, `projectSessionLive`, archived/hidden flags, `studioProfileForSession`.
  - `profileAssembler`: `profilePayload` end-to-end against seeded studios/shows/users.
  - `Catalog`: `init()` applies schema; a delegated method actually round-trips through D1.
  - Tenancy/SQL: a query scoped by studio returns only that studio's rows (cross-tenant isolation).
- **SessionDO** (real `ctx.storage.sql` + real alarm, via `runInDurableObject` or stub RPC):
  - `initSchema` creates tables; events add/update/delete with `events_stream_revision` bumps; transport start/stop persistence and elapsed-frame accumulation; audio add/list/delete + ordinal allocation; topic & transcript CRUD; `maybeRelinkOrphans`.
  - **Lease alarm end-to-end:** claim → `setAlarm` scheduled → `alarm()` fires `expireIfStale` → stale lease freed; live lease re-arms (complements the node fake test against real storage).
- **Routers** (via `app.request()`):
  - Auth gating: with `REQUIRE_LOGIN=1`, unauthenticated `/api/*` → 401/redirect; `/api/admin/*` requires the admin Bearer token (503 when unconfigured, 401 on mismatch).
  - Tenancy: `requireSession` returns 404 for a session outside the caller's studio.
  - Validation: malformed bodies → 422 (zod), incl. the metadata cap and `frame_rate` bounds.
  - Caps: oversized audio upload → 413.
  - Events: log creates an event, pagination, update/delete, revision change.
  - Audio: upload → R2 `put` → ranged download; metadata rollback when the R2 write fails.
  - Exports: CSV and JSONL shape.
  - Companion: presence registration + command relay happy path (current behavior, including the global-`primarySession` scoping noted in the audit).
  - sessions / shows / profile / admin: CRUD happy paths + an authz-failure case each.
- **Middleware:** `ipAllowlist` → 403 when the client IP is not allowlisted; the auth gate redirect/401 when login is required.

## Shared test helpers

`src/test/helpers.ts` (importable by integration tests):
- `seedStudio(env, opts)`, `seedUser(env, opts)`, `seedShow(env, opts)`, `seedSession(env, opts)` — insert minimal valid rows via the stores / D1 and return ids.
- `loginCookie(env, userId)` — write a login session into the `AUTH` KV namespace and return a `Cookie: <name>=<sid>` header string.
- `adminHeaders()` — `{ Authorization: 'Bearer <ADMIN_TOKEN>' }` matching the test env's configured token.
- `src/test/setup.int.ts` — the migrations `beforeAll` shown above.

Test env vars (`REQUIRE_LOGIN`, `ADMIN_TOKEN`, `GOOGLE_CLIENT_ID`, `IP_ALLOWLIST`, etc.) are set per-test via the `env` argument to `app.request` or in the workers project's `miniflare.bindings`, so each scenario controls its own gating.

## Error handling & edge cases (asserted, not just happy paths)

Tests explicitly cover error responses — 401/403/404/413/422 and 503 (admin unconfigured) — plus the R2-write-failure rollback, bad-JSON metadata, orphaned-session studio resolution, and empty/oversized payloads. The pure tier asserts defensive coercions (non-finite numbers, empty arrays, malformed enums) at their current behavior.

## Verification

- `npm run test` runs **both** projects green (existing 35 + new pure + new integration).
- `npm run typecheck` clean (the `cloudflare:test` module types are pulled in via the pool-workers types in `tsconfig`).
- The harness smoke test (plan Task 1) passes before bulk test authoring begins.

## Versioning

Test-only change (new dev-deps + vitest config + test files); no user-visible/API/data/operational behavior changes, so **no version bump** per repo convention. `package.json` changes only in `devDependencies`.

## Risks & rollback

- **Toolchain compatibility** (pool-workers ↔ vitest) — mitigated by the Task 1 smoke test and a pinned-version fallback. If pool-workers cannot be made to boot in this environment, the integration tier is dropped to fake-based node tests and the spec is revised (the pure tier is unaffected and ships regardless).
- All additions are isolated to new files + `vitest.config.ts` + `package.json` devDeps; revert is clean.
- Integration tests use `isolatedStorage`, so they cannot corrupt each other or any real data (Miniflare-backed, in-memory).
