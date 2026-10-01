# Design: async-catalog-stores

## Context

- 3a and 3b: every server catalog caller awaits, except the transaction-reachable code (the
  Google sign-up body `routers/auth.ts:197-221`, teams `wouldStripLastEnabledAdmin`, and the
  three `mutate` bodies).
- 3c: `AsyncCatalogDb` and `AsyncSqliteCatalogDb`, with a per-connection FIFO lock, joined
  nesting, first-error-wins, a 10 s deadline, root misuse rejected, and the connection marked
  broken after a failed `ROLLBACK`. `KvStore` runs on it.
- The five stores in `packages/catalog/src` still use the synchronous `CatalogDb`:
  - 62 `this.db.` sites;
  - about 73 methods;
  - 58 store facade members, plus 6 on `CatalogFacade`;
  - about 64 internal calls;
  - **6 store-internal transactions**: `authStore.ts:119,176`, `showsStore.ts:226`,
    `studioRegistry.ts:219`, `sessionIndexStore.ts:142,200`.
  - With the 2 router transactions that makes 8 bodies.
- Owner decisions (2026-10-01):
  - one atomic PR with `size-override`;
  - `KvStore.take` via `DELETE … RETURNING`;
  - async test seeds (this reverses the slice 3 "keep seeds synchronous" decision, after the
    panel showed that slice 4 forces it anyway).

## Assumptions and evidence

The panel probes are in the session scratchpad (`panel3d-assume/`, `panel3d-failure/`), run with
`node_modules/.bin/tsx`.

| # | Assumption | Command -> observed |
|---|---|---|
| A1 | `DELETE … RETURNING` works on host and container SQLite | `node -e …` -> `sqlite 3.53.2`, `first take { value: '1', expires_at: null }`, `second take undefined`; the container -> `3.53.2`. Through the 3c adapter: `take live 1 again null`, `take dead null`, two takes queued behind a held transaction -> `[ '1', null ]` |
| A2 | Store transaction bodies call only the database and their own store, and the router bodies use no cross-store reference | Sources read. `authUpdateUserProfile` -> `this.authGetUserById`; `updateShowFields` -> `this.getShowRow`; `createSessionForShow` -> `this.db.all`, `this.createSessionIndex`; the others -> `this.db.run`. Sign-up reaches only auth-store methods plus `studios.getSetting`; teams reaches only auth-store methods |
| A3 | The 8 bodies await nothing but catalog calls | No fetch, file, timer or KV call. The helpers called in them (`normalizeEmail`, the title derivation) are synchronous |
| A4 | `withDb` composes | `compose.mts`: `top-level update true`; nested inside a failing outer -> `after rolled-back outer, n = top` |
| A5 | Test usage | 606 seed calls (`grep -rnE "\bseed(Studio\|User\|Show\|Session\|edSession)\("`), 116 `catalogFor()` calls (about 40 of them writes), 12 direct `env.ports.catalog.first/all/run` calls in tests |
| A6 | The registry getters are memory-only | `studioRegistry.ts:78-90,159-168` read only `this.order` and `this.names` |
| A7 | **The adapter yields only microtasks, so in production a request's catalog awaits are not interleaved by another request** | `interleave.mts` (get-then-delete through the adapter): two `setImmediate` macrotasks -> 1 winner; 200 concurrent real HTTP requests -> 0 interleavings; the same tick -> 2 winners; a held transaction across a timer -> 2 winners |
| A8 | Store read-then-write sequences interleave once awaited in the same tick | `ensure.mts`: `ensurePrefs x2: [ 'ok', 'UNIQUE constraint failed: user_prefs.user_id' ]`, `createStudio x2: [ 'ok', 'UNIQUE constraint failed: studio_definitions.id' ]` |
| A9 | Self-`SIGTERM` leads to a restart in prod and stage, but not in dev | Prod and stage: `CMD tsx src/main.ts` with `restart: unless-stopped`. Dev: `npm run dev` is `tsx watch`, which keeps running after the child exits: `tsx watch exit status: 124 (still running at timeout)` |
| A10 | Catalog package tests use no database | `catalog.test.ts` uses a stub `CatalogDb`; the others test pure functions. The boundary test allows only `catalog -> domain, ports` |

A7 decides how this change is framed. 3d changes no production interleaving, so ADR 0021's
hazards stay latent until slice 4's real I/O. The same-tick and held-transaction tests are slice
4 guards.

## D1. The port

- `@autologger/ports`: the synchronous `CatalogDb` is deleted, and `AsyncCatalogDb` is renamed
  to `CatalogDb`. The stores' imports don't change.
- `@autologger/storage`: `catalogStore.ts` and its test are deleted. `AsyncSqliteCatalogDb`
  keeps its name.
- `config.ts` builds one adapter for `Ports.catalog` and `KvStore`.
- The README architecture tree, the storage barrel comment and the `config.ts` comment are
  updated.

## D2. The stores

- Every method that reaches the database is `async`, awaits each `this.db.*` and internal store
  call, and returns `Promise<…>` in its facade member.
- **Synchronous by design (A6):** `studioNamesDict`, `studioOrderTuple`, `isKnownStudio`,
  `listStudiosBrief`, `listStudiosBriefAllowed`.
- `refreshStudioRegistry` and `Catalog.init()` become async. A store method that refreshes after a
  write awaits the refresh before returning, as today.
- **Read-then-write sequences in a transaction (A8)**, each through `withDb` (D3):
  - `authEnsurePrefsRow`;
  - `authSeedPrefsFromGlobals`;
  - `adminCreateStudio` (existence check, then insert);
  - `adminDeleteStudio` (the show count moves inside its transaction, closing half of ADR hazard
    13);
  - `getStudioSettingsBlob` (read, then self-heal write).

  They are latent in production today (A7) and become live in slice 4. Wrapping them now costs
  a few lines in code this change rewrites anyway.

## D3. Transactions

- **Facade.** `CatalogFacade.tx<T>(fn: (cat: CatalogFacade) => Promise<T>): Promise<T>` runs
  `this.#db.tx(async (t) => fn(this.bound(t)))`. `bound(t)` is a `Catalog` over `t` with a copy of
  the request catalog's registry snapshot (no query).
  - None of the 8 bodies reads a registry getter today. The copy avoids an empty-registry trap.
  - The handle is a private `#db` field, so `Object.keys(catalog)` still lists only the five
    stores (`catalog.test.ts`).
- **Store-internal transactions.** Each store has `withDb(db)`, which returns the same store over
  another handle. `SessionIndexStore` rebinds its `studios` and `shows` dependencies with their
  own `withDb(db)`. A body runs as
  `return this.db.tx(async (t) => { const s = this.withDb(t); … await s.getShowRow(…) … })`.
  - Inside an enclosing transaction, `this.db` is a handle whose `tx` joins it (3c).
  - At top level it opens its own transaction.
  - A body that used `this.*` instead of `s.*` would hit the root guard and reject.
- **Router bodies.**
  - Sign-up: `uid = await catalog.tx(async (cat) => { … await cat.auth.… })`.
  - Teams guard: `guardedAgainstLastAdmin` becomes async and runs
    `await catalog.tx(async (cat) => { if (await wouldStripLastEnabledAdmin(cat, …)) {…};
    await mutate(cat); })`, where `mutate: (cat: CatalogFacade) => Promise<void>`.
  - The 3b `=> undefined` guard is replaced: the callback is now awaited inside the
    transaction.
- **Constraint (recorded):** a registry refresh inside `catalog.tx` updates only the tx
  catalog's copy. No body does this today.

## D4. OAuth state take (owner, 2026-10-01)

- **Port:** `KvStore.take(key): Promise<string | null>`.
- **Adapter:** `DELETE FROM kv WHERE key = ? RETURNING value, expires_at`. It returns `null` for
  no row, or for an expired one, which is removed as well (A1).
- **Caller:** `takeOauthState` becomes `(await kv.take(key)) !== null`.
- It is atomic on the SQLite connection, and it stays atomic on Postgres in slice 4.
- **Contract:** expired and missing states both give `state_invalid`, as today. A concurrent
  replay now does too, as `api-contract-freeze` already requires.
- **Not in scope (recorded):** `/auth/google/start` writes one KV row per hit, purged only at boot
  or on read. A flood grows the `kv` table until restart, and that predates this change. It goes on
  the slice 4 list.

## D5. A failed rollback stops the server

- `createBindings` takes `{ onBroken?: () => void }` and passes it to the adapter. The adapter
  calls it once, deferred with `setImmediate` and wrapped so it can never throw into `rollback()`.
- `main.ts` passes a callback that:
  - logs `console.error('[catalog] connection broken after a failed ROLLBACK; shutting down')`;
  - sets `process.exitCode = 1`, and the graceful path then exits 1 instead of 0;
  - sends the process `SIGTERM`, which runs the existing graceful path.
- The test harness passes nothing, so a test can never `SIGTERM` the vitest worker.
- **Restart:** prod and stage restart under `restart: unless-stopped` (A9). In dev, `tsx watch`
  keeps the container up with no server, and a developer restarts it with `make dev-restart`.
  The spec scopes the restart to the supervised deployments.
- **Adapter `close()` is deferred to slice 4.** `main.ts` already closes HTTP connections first,
  so the only gain would be a named error instead of a `TypeError` during shutdown. Postgres
  needs its own `sql.end()` semantics.

## D6. Promise hygiene

- **Production:** the file filter widens to non-test files under `packages/catalog/src`, which
  the server program already includes. The test asserts that at least one `packages/catalog/src`
  file is scanned, so a resolution change can't make the widening a silent no-op.
- **Tests (new rule):** a second pass over the server program's `*.test.ts` and `src/test/`
  files flags any `expect(x)` whose argument is promise-like, unless the chain continues with
  `.resolves` or `.rejects`. It has a fixture case in each direction. A missed `await` on
  `catalogFor().auth.authGetUserByGoogleSub(…)` followed by `expect(user).not.toBeNull()` then
  fails instead of passing vacuously.

## D7. Tests (owner, 2026-10-01: async seeds)

- **Seed helpers** in `server/src/test/helpers.ts` become `async` and keep calling the real store
  methods: `seedStudio`, `seedUser`, `seedShow`, `seedSession`, `seededSession`. All 606 call
  sites await.
  - There is no second connection, so nothing hangs on `SQLITE_BUSY` while a test holds a
    transaction.
  - The seed SQL can't drift from the stores' SQL.
- The 116 `catalogFor()` uses and the 12 direct `env.ports.catalog` reads await. Synchronous
  helper lambdas such as `membersOf` in `bootstrapMemberships.int.test.ts` become async. The 3
  `cat.init()` sites await.
- **Held-transaction tests** start their concurrent calls from the test's own context, never
  from inside the held transaction's callback. A call started inside it would inherit the
  transaction's `AsyncLocalStorage` state and be rejected as root misuse, instead of queueing.
- **Catalog package tests:** `catalog.test.ts` keeps its stub and its `Object.keys` assertion
  (D3 `#db`). The other package tests are pure functions and stay unchanged (A10).

## D8. Size

Counted as `git diff --numstat` added plus deleted lines, excluding tests, `openspec/` and
`docs/`. A modified line counts twice.

| Item | Modified lines |
|---|---|
| Signatures and return types | about 73 |
| Awaits on `this.db` | about 62 |
| Awaits on internal calls | about 64 |
| Facade members | about 64 |
| Transaction bodies and `withDb` (including the five new wraps) | about 60 |
| Routers | about 25 |
| Ports, storage, config and `main.ts` | about 35 |

Plus about 30 deleted lines. That gives about 380 modified lines, or **about 650-750 counted**.
It is over budget by the owner's decision. Task 3.2 records the measured number.

## D9. Spec changes (`core-ports-architecture`)

- **RENAMED and MODIFIED:** "Catalog persistence is synchronous…" becomes "…asynchronous…".
  The scenario "No async costume" is reworded: stores never wrap synchronous calls in `async`
  themselves.
- **MODIFIED:** "Catalog facade exposes only role-scoped stores". The facade's members are the
  five stores plus the lifecycle members `init` and `tx`.
- **MODIFIED:** "Key/value and presence ports are asynchronous" gains the atomic `take`.
- **MODIFIED:** "Server code never drops or misuses a promise". It now covers
  `packages/catalog/src` and test assertions.
- **MODIFIED:** "The SQLite catalog adapter serialises each connection". The stores share the
  adapter, and a failed rollback stops a supervised server.

The concurrent last-admin case stays as a test of team-management's existing requirement ("the
admin count and the mutation SHALL execute within a single catalog transaction"). It is not a
new architecture scenario.
