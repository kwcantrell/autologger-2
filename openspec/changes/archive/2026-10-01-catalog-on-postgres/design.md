# Design: catalog-on-postgres

## Context

See proposal.md for the motivation.

**Current wiring.** `server/src/node/config.ts:46-52` builds the catalog in four steps:
`openCatalogDb(DATA_DIR/catalog.db)`, then `applyMigrations`, then
`AsyncSqliteCatalogDb({onBroken})`, then `KvStore` on the same adapter. Its `close()` is
synchronous. `server/src/main.ts:27-35` wires `onBroken` to a non-zero SIGTERM, and shutdown
(`:140-146`) calls `close()` under a 5 s failsafe.

**Already in place from 4a and 4b:**
- the compose `PG*` env (`docker/compose.dev.yaml:59-65`, the prod/stage `api`), and the
  `catalog` network;
- `PostgresCatalogDb`, which has no `onBroken` and an async `close()`;
- the `test/pg` harness, which gives each test its own clone.

## Goals / Non-Goals

**Goals:**
- One `PostgresCatalogDb` per server process.
- Every server integration test runs against it.
- The boot and ops order can't leave the app running against a missing schema.
- NUL never reaches Postgres as a 500, and no catalog error logs user values.

**Non-Goals (design level):**
- No change to `PostgresCatalogDb`'s transaction machinery, apart from the NUL guard.
- No pool tuning beyond the 4b defaults (`rootMax` 3 and `txSlots` 5 use 8 of the role's 20
  connections).
- No retry wrapper above the adapter.

## Assumptions

| # | Assumption | Command | Observed |
| - | --- | --- | --- |
| A1 | Postgres refuses NUL in any text bind, typed or untyped, with SQLSTATE `22021` | the scratch probe `probe4c.mjs` against a throwaway `supabase/postgres:17.6.1.136` | `NUL typed bind ERR 22021 invalid byte sequence for encoding "UTF8": 0x00`; `NUL untyped bind ERR 22021 …` |
| A2 | `COLLATE NOCASE` doesn't exist in Postgres. `ORDER BY lower(name), name` under `"C"` gives SQLite NOCASE's order, but breaks ties bytewise, where SQLite returned ties in row order | same probe, shows `b, A, a, B, _x` | pg NOCASE `ERR 42704 collation "nocase" … does not exist`; pg lower `["_x","A","a","B","b"]`; sqlite NOCASE `['_x','A','a','b','B']`; sqlite lower `['_x','A','a','B','b']` |
| A3 | `INSERT … ON CONFLICT DO NOTHING` reports 1 and then 0 affected rows on both engines, as `INSERT OR IGNORE` did | same probe | `pg on conflict counts 1 0`; `sqlite on conflict changes 1 0` |
| A4 | A missing schema or table is SQLSTATE `42P01` | same probe | `ERR 42P01 relation "nosuch.kv" does not exist` |
| A5 | There are exactly 16 production `tx` call sites, and the dialect sites are the 3 listed | `grep -rn "\.tx(" packages/catalog/src server/src --include=*.ts \| grep -v test \| wc -l`; `grep -rn "NOCASE\|OR IGNORE" …` | `16`; `showsStore.ts:178`, `authStore.ts:185`, `authStore.ts:274` |
| A6 | The compose app already gets `PGHOST=db`, `PGUSER=autologger_app`, `PGDATABASE=postgres` and `PGPASSWORD` | `docker exec autologger-dev-app env \| grep ^PG` (password masked) | `PGPORT=5432 PGDATABASE=postgres PGPASSWORD=<set> PGHOST=db PGUSER=autologger_app` |
| A7 | The running dev app image predates 4b and has no `postgres` module, so the dev image must be rebuilt | `docker exec -w /app autologger-dev-app node -e "require('postgres')"` | `MODULE_NOT_FOUND` |
| A8 | Baseline integration suite: 39 files, 596 tests, about 6.6 s wall time on 20 cores | `npx vitest run --project integration` (`4c-baseline-int.log`) | `Test Files 39 passed (39)`, `Tests 596 passed (596)`, `wall 6.61 s` |
| A9 | A template clone takes about 90 ms, and parallel clones work | 4a design A9 | `20 clones 1.77 s`; `8 parallel clones ok` |
| A10 | The app role's cluster-wide connection limit is 20 | `grep -n "connection limit" supabase/migrations/*` | `alter role autologger_app … connection limit 20;` |
| A11 | Vitest runs `globalSetup` once per project, so each project that names it starts its own container, and a wrapper setup that calls the shared one can `provide('pg')` | panel scratch two-project config (vitest 4.1.11) | `SHARED SETUP pg-…`, `SHARED SETUP integration-…`; `inject('pg')` returned the per-project value |
| A12 | `npm run dev` runs `bootGuardCli` and then `tsx watch`. If `main.ts` exits under `tsx watch`, the container keeps running and the server waits for a file change | `server/package.json` dev script; `server/src/bootGuardCli.ts` | recorded for risk R3 |
| A13 | No catalog SQL uses `SUM`, `AVG` or `TOTAL`, so the 4b `numeric` item (A17) is vacuous | `grep -rniE "\b(sum\|avg\|total)\(" packages/catalog/src packages/storage/src/kvStore.ts server/src --include=*.ts \| grep -v test` | no output |
| A14 | `PostgresCatalogDb` does no I/O at construction, and `close()` on one that never connected is quick | panel: TCP listener plus construct, then `close()` | `0 connections after 300 ms`; `close 2 ms`; later calls `CatalogAdapterBrokenError: catalog adapter is closed` |
| A15 | One adapter recovers on its own from no-listener, then no-schema, then ready | panel probe | `ECONNREFUSED` → `42P01` → `OK` |
| A16 | An attempt against an unreachable host takes `connect_timeout` (5 s) | panel probe on `10.255.255.1` | `CONNECT_TIMEOUT 5008 ms`; `ENOTFOUND 5 ms` |
| A17 | A postgres.js error carries an enumerable `detail` that echoes values; `query` and `parameters` are not enumerable | panel probe, `util.inspect` of a `23505` | `detail: 'Key (id)=(dup@example.com) already exists.'` |
| A18 | The `teams` family turns Zod failures into `ApiError(400)`, as the frozen contract requires | `sed -n 25,37p server/src/routers/teams.ts` | `throw new ApiError(400, msg)` |
| A19 | zod's `.int()` has no upper bound; `1e20` fails in `bigint` with `22003`, and `1e300` with `22P02` | panel probe | `true true`; `ERR 22003 … out of range for type bigint`; `ERR 22P02 …` |
| A20 | Vitest's default is 19 workers here. With the 4b pool (8 connections per adapter) that's 152 connections, under a raised limit of 200 and `max_connections=300` | panel: `availableParallelism-1` | `maxWorkers 19` |

## Decisions

### D1. Composition root: `createBindings` stays synchronous and builds one `PostgresCatalogDb`

- **Order.** `createBindings` first checks `DATA_DIR`, then the five `PG*` vars (throwing and
  naming only the variables), and only then takes the lock. A refusal never holds the lock and
  never creates directories.
- **Construction.** It builds one `PostgresCatalogDb` with the 4b defaults. Construction does no
  I/O (A14), so `createBindings` stays synchronous for its callers.
- **Close.** `close` becomes `async`: `registry.closeAll()`, then `await catalogDb.close()`,
  then `lock.release()` in a `finally`.
- **Removals.** `openCatalogDb`, `applyMigrations`, `CATALOG_MIGRATIONS_DIR` and the
  `onBroken` option leave the server. They stay in their packages for the SQLite tests until 4e.
- **Alternatives rejected:**
  - An async `createBindings` would ripple through every caller, for nothing.
  - Running migrations from the app is ruled out: the role has DML only (4a).

### D2. Boot: guard, bounded readiness wait, no `onBroken`

- **Guard.** `checkBootEnv` adds the `PG*` check after `DATA_DIR`, so `bootGuardCli` refuses
  before `tsx watch` starts.
- **Readiness wait.** `waitForCatalog(db, {budgetMs: 30_000})` (`server/src/waitForCatalog.ts`)
  retries `SELECT 1 FROM kv LIMIT 1` with a 500 ms to 2 s backoff.
  - It retries on any error: no listener, `42P01` before migrate, or `28P01` mid-rotation (A15).
  - Each attempt is raced against the remaining budget (A16), so the total stays about 30 s.
  - It logs each distinct `code` once, when it first appears, never a message.
  - When the budget runs out, it rejects, and `main.ts` exits 1.
- **`main.ts`.**
  - It awaits the wait before `purgeExpiredAtBoot`.
  - The `onBroken` handler goes away.
  - Shutdown awaits `close()` inside the existing 5 s failsafe. A transaction still running at
    SIGTERM can push the exit to the failsafe's exit 1. The server rolls it back, so that is
    harmless (R7).

### D3. Ops order and rotation

- **Start order.** `make dev-up` and `make stage-up` run `'compose run --rm migrate'` before
  `'compose up -d --build'`. `migrate` uses the pulled image and `depends_on: db:
  service_healthy`. compose-run stops at the first failing step (panel-verified).
- **Rotation**, documented in `docs/supabase.md`:
  1. set the new `APP_DB_PASSWORD` in Infisical;
  2. run `make <env>-up`, which applies migrate (`ALTER ROLE … PASSWORD`) and recreates the app,
     because its env changed.

  The window between the two steps is a few seconds. Inside it, any new or replaced catalog
  connection fails with `28P01` and its request gets a 500. The doc says so.

### D4. Dialect

- `showsStore.ts:178` becomes `ORDER BY lower(name), name` (A2). Ties are now bytewise, and the
  spec pins it.
- `authStore.ts:185,274` become `INSERT … ON CONFLICT DO NOTHING` (A3).
- Both forms are valid SQLite too.
- `SUM`/`AVG` are not used (A13).

### D5. NUL: one rule, `400` (owner, after the panel)

- **The rule.** `PostgresCatalogDb` checks the binds of every `all`, `first` and `run` before
  sending. A string containing `\u0000` rejects with `CatalogInvalidTextError`, exported from
  `@autologger/storage`.
  - Inside a transaction, that rejection is the transaction's first error, so the transaction
    rolls back.
  - `app.onError` maps it to `400 {detail: 'Text must not contain NUL characters.'}`.
  - The rule covers bodies, path params and query values alike. It matches the teams family's
    frozen 400 (A18).
- **Presence.** `POST /api/companion/presence` doesn't touch the catalog. It stores
  `session_id` in memory, and every later Companion request would then hit the 400. So the route
  refuses a NUL `session_id` itself with the same 400, before storing anything.
- **OAuth.**
  - `takeOauthState` returns `false` for a state with NUL, without querying. That gives the
    existing `state_invalid` redirect.
  - A NUL in the `sub` or `email` claim gives the existing `token_invalid` redirect (owner).
    Stripping `email` could make two addresses match one invite.
  - `given_name`, `family_name` and `picture` have NUL stripped.
- **Alternatives rejected (owner):**
  - Per-field 422 schemas: about 20 enumerated fields in the frozen contract, already wrong for
    teams.
  - Mapping SQLSTATE `22021` after the round trip.
- The SQLite adapter doesn't get the rule; it isn't wired, and 4e removes it.

### D6. Integration suite on Postgres

- **Vitest config.** The `integration` project gets
  `globalSetup: ['./src/test/pgIntegrationSetup.ts']` and `hookTimeout: 600_000`.
  - The wrapper runs the shared `test/pg/globalSetup.ts`.
  - Then, as admin, it runs `alter role autologger_app connection limit 200` in its own
    container only. The 4b pool defaults need about 152 connections across 19 workers (A20).
  - The `pg` project's container keeps 20, which `catalogSchema.pg.test.ts:280,301` asserts.
- **Harness.**
  - `resetTestEnv` becomes `async`: `createTestDatabase()`, then `createBindings` with the
    clone's app `PG*`.
  - `teardownTestEnv` awaits `close()`. Clones are never dropped (4a).
- **Changed tests:**
  - `config.test.ts` (unit, dummy `PG*`, no connection by A14):
    - missing `PG*` throws, naming the variable, before the lock;
    - no `catalog.db`;
    - the lock still refuses a second server;
    - `close()` returns a promise.
  - `bootOrder.int.test.ts`:
    - missing `PGPASSWORD` exits 1, naming it, and creates nothing;
    - `PGHOST` pointing at a closed port exits 1 without listening, after about 30 s.
  - `migrations.int.test.ts`: the SQLite runner only.
  - youtube-import reboot test: becomes `async` and awaits `close()` before re-creating on the
    same `DATA_DIR` and clone.

### D7. Retry audit (4b A19), closed

The panel re-read all 16 production `tx` bodies, and none has an effect outside the database.

| Site | Effect outside the database |
| --- | --- |
| `catalog.ts:68` `Catalog.tx` | none; it builds a new bound facade and registry copy for each attempt |
| `authStore.ts:125, 182, 199, 226, 408` | none |
| `showsStore.ts:232` | none |
| `sessionIndexStore.ts:148` | the id is created once, outside the body, and reused on re-run (correct) |
| `sessionIndexStore.ts:204, 262` | none; timestamps come from the caller |
| `studioRegistry.ts:120` | none; the read may write a default |
| `studioRegistry.ts:211, 235` | none in the body; the registry refresh runs after commit |
| `teams.ts:127` | none; the 409 is thrown after the transaction |
| `auth.ts:197` | none; the UUID and `nowIso` are inside the body and returned; the logs and cookie are outside |

`Catalog.tx` and the port's `tx` gain a doc comment: the body may run more than once and must
touch only the catalog. That stays a review rule; "database-only" can't be detected statically.

### D8. Value-free error logs

`app.onError`'s generic branch checks whether the error has a string `code` (postgres.js
errors do). If so, it logs `name`, `code`, `constraint_name` and `table_name` only, never
`detail` or `where`, because those echo values (A17). Other errors log as today. The response is
still the generic 500.

### D9. Bounded integer

`start_offset_frames` (create and update) gets `.max(Number.MAX_SAFE_INTEGER)`, so `1e20` is a
422 rather than a `22003` 500 (A19). That is the only request integer that reaches a catalog
`bigint`. `topic_level` is bounded already and goes to the session SQLite store.

## Risks / Trade-offs

- **R1. The slice 3 hazards go live on dev and stage.** → Prod is on hold, and 4d is next. The
  panel added four more, recorded in ADR 0021 for 4d:
  - 17. a 500 after the hub commit when the catalog mirror write fails, with retries
    duplicating the effect (owner: 4d);
  - 18. a team id recreated after a concurrent delete-and-invite inherits memberships or
    invites (owner: 4d; a foreign key, or a purge on create);
  - 19. root statements have no client-side deadline;
  - 20. `getStudioSettingsBlob`'s default write contends under SERIALIZABLE on an empty
    catalog.
- **R2. Dev and stage lose their catalog view** (owner: start empty). → The `catalog.db` and
  session files are kept for slice 11. Rollback is to redeploy the previous image.
- **R3. A dev app under `tsx watch` doesn't restart after exit 1 (A12).** → `dev-up` runs
  migrate first; recover with `make dev-restart`.
- **R4. The integration container's connection limit differs from the real role.** → Only that
  throwaway container is changed; the `pg` project still asserts 20.
- **R5. The integration suite gets slower.** → About 600 clones plus a second container. The
  actual time goes in the evidence. Clones (about 7.4 MB each) sit in the container until
  teardown.
- **R6. New observable responses** (NUL gives 400, an oversized integer gives 422). → Authorized
  by the `api-contract-freeze` delta. Before, they were a 500, or SQLite stored the value.
- **R7. Shutdown can end on the 5 s failsafe** while a transaction runs. → Postgres rolls it
  back server-side, so it's harmless.
- **R8. Log-import progress lines show raw catalog error messages to the user.** →
  Pre-existing behaviour, now with Postgres wording. Left for 4d's error-surface pass.

## Migration Plan

1. Merge into `supabase-migration`.
2. Dev: `make dev-up` runs migrate, then rebuilds the image (A7), then starts the app on an empty
   catalog that holds only the migration's seed shows.
3. Stage: `make stage-up` (the running stage api predates 4a's env, and `up` recreates it).
4. Rollback: check out the previous commit and run `make <env>-up`. `catalog.db` is untouched.
5. Prod is unaffected until cutover (slice 11).
