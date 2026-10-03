# Design

## Context

See proposal.md for the why and the owner decisions (owner, 2026-10-02). The current state:

- **One login role with every table privilege.** The 4a migration
  (`supabase/migrations/20261001000000_catalog_schema.sql:125-156`) creates `autologger_app`,
  refuses any role membership of it (lines 139-143), and grants it `SELECT`, `INSERT`, `UPDATE`,
  `DELETE` on every catalog table, plus default privileges for later tables. No table has
  row-level security.
- **The adapter** (`packages/storage/src/postgresCatalogStore.ts`) has two paths. Root calls
  (`all`/`first`/`run` → `rootQuery`, line 330) run as single autocommit statements on a 3-connection
  root pool with `max_pipeline: 1`, a 5-second client deadline, no retry and no cancel once sent
  (the timeout error carries `settled`). Transactions (`tx` → `attempt`, line 386) take one of 5
  single-connection slots, send `BEGIN ISOLATION LEVEL SERIALIZABLE` (line 405), run the body,
  retry `40001`/`40P01` up to five runs with jittered backoff, and release the slot only after a
  confirmed `COMMIT` or `ROLLBACK`. `guardRoot` (line 369) refuses the root handle inside an open
  transaction; a nested `tx` joins.
- **The request catalog** is made before the user is known (`server/src/middleware/auth.ts:16-22`):
  `createCatalog(c.env.ports.catalog)`, `init()` (the studio-registry snapshot), then
  `resolveSessionUser` (KV lookup, then `authGetUserById`). `Catalog.tx` rebinds the stores with
  `studios.withDb(t)` so the snapshot travels (`packages/catalog/src/catalog.ts:69-71`). Routes
  reach it through `c.get('catalog')` (54 production uses).
- **Catalogs made outside the middleware:** the session mirror's `createCatalog(catalogDb).sessions`
  (`server/src/node/config.ts:56`), the KV store on the root adapter (`config.ts:54`), boot's
  `waitForCatalog` and the KV purges (`server/src/main.ts:44,51,52`), and the log-import job
  (`server/src/routers/logImport.ts:160`). Test helpers use `new Catalog(env.ports.catalog)`.
- **Callers with no user:** `GET /api/profile` signed out, `/auth/google/start` and `/callback`,
  `/api/admin/*` (`ADMIN_TOKEN`), token-only `/api/companion/*`, and boot. Signed-in requests also
  touch other users' rows: the access-loss socket check (`routers/_helpers.ts:103`), the invite
  transaction's lookup by email followed by memberships for the matches (`routers/teams.ts:232-241`),
  team creation's purge of leftover memberships and invites (`teams.ts:125-134`,
  `studioRegistry.ts:244-258`), and the bootstrap claim (`routers/auth.ts:279`).
- **Tests.** The `pg` project's global setup migrates two databases in one cluster (`postgres`, then
  `autologger_template`; `test/pg/globalSetup.ts`), and each test clones the template. Several
  `pg` suites query as `autologger_app` directly (`db.app`), and `authCreateUser`, `kvStore` and
  the adapter suites build `new PostgresCatalogDb(app)`. The integration project runs the real
  bindings over a Postgres clone per test, so it exercises every route as `autologger_app`.

## Goals / Non-Goals

**Goals:**
- Every statement the server sends runs as `catalog_user` (with the user id) or `catalog_system`
  (with a reviewed reason), set per transaction; nothing else can read a catalog table.
- A path that forgets to bind fails closed twice: in the catalog package (a typed error before
  anything is sent) and in the database (`42501`).
- No observable behaviour change: the policies allow everything, the root path keeps its
  timeout semantics, and every existing suite passes unchanged.
- A new system call site cannot land unreviewed; a new table cannot land without RLS.

**Non-Goals:** see proposal.md. Design-level: no change to the transaction contract, the retry
policy, the pool sizes, or the 6a gates; no attempt to make a transaction mix bindings.

## Decisions

### D1. Migration `20261006000000_catalog_roles.sql`
No transaction-control lines: `migrate.sh` refuses a line that *starts* with `begin`, `end` and
the like, so every `begin`/`end` inside a DO block is indented, as in 4a. The file reaches its
final form in two steps on this branch (D16); the final form is:

```sql
-- role:begin
do $$
  begin
    if not exists (select from pg_roles where rolname = 'catalog_user') then
      create role catalog_user nologin;
    end if;
    if not exists (select from pg_roles where rolname = 'catalog_system') then
      create role catalog_system nologin;
    end if;
  end
$$;
alter role catalog_user nologin nocreatedb nocreaterole nobypassrls;
alter role catalog_system nologin nocreatedb nocreaterole nobypassrls;
grant catalog_user to autologger_app with inherit false, set true;
grant catalog_system to autologger_app with inherit false, set true;
do $$
  begin
    -- the strict guard (D3)
  end
$$;
-- role:end

revoke all on all tables in schema catalog from autologger_app;              -- step 2 (D16)
alter default privileges for role postgres in schema catalog                  -- step 2 (D16)
  revoke select, insert, update, delete on tables from autologger_app;
grant usage on schema catalog to catalog_user, catalog_system;
grant select, insert, update, delete on all tables in schema catalog to catalog_user, catalog_system;
alter default privileges for role postgres in schema catalog
  grant select, insert, update, delete on tables to catalog_user, catalog_system;

create or replace function catalog.app_user_id() returns text language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '') $$;
revoke all on function catalog.app_user_id() from public;
grant execute on function catalog.app_user_id() to catalog_user, catalog_system;

-- RLS on every catalog table, one allow-all policy per role (D2).
do $$
  declare t text;
  begin
    for t in select tablename from pg_tables where schemaname = 'catalog' order by 1 loop
      execute format('alter table catalog.%I enable row level security', t);
      execute format('create policy %I on catalog.%I for all to catalog_user using (true) with check (true)', t || '_user_all', t);
      execute format('create policy %I on catalog.%I for all to catalog_system using (true) with check (true)', t || '_system_all', t);
    end loop;
  end
$$;
```
- **Step 1** (task 2.2) omits the two `-- step 2` statements and adds a third interim policy per
  table, `<table>_app_all … to autologger_app using (true) with check (true)`, so the
  still-unbound server keeps working under RLS (A11: with RLS on and no policy for the role, it
  would see no rows). **Step 2** (task 6.3) removes the interim policy from the loop and adds the
  two revokes. The file is unmerged in between, so editing it is safe for test databases (each
  run migrates fresh). A dev database migrated between the steps would keep step 1's recorded
  text, so `make dev-up` is not run on this branch before task 6.3 (dev's live check is after
  merge anyway).
- `autologger_app` keeps `USAGE` on the schema, so an unbound statement fails with
  `permission denied for table users` (A6), not a confusing `relation does not exist`.
- The re-grant in a second database is a no-op with a notice (A5); `postgres` holds an automatic
  admin membership in both roles because it created them (A4), which the guard allows (D3) and
  the owner keeps (owner decision D).
- `create or replace` lets the migration re-apply after the documented rollback (owner decision
  A). `app_user_id()` has no `SET search_path` (it calls only `pg_catalog` functions), so 6b-2's
  policies can inline it. `current_setting('app.user_id', true)` reads `''` once the setting was
  used on the connection (A8), hence `nullif`.
- **PUBLIC `EXECUTE`.** A per-schema `alter default privileges … revoke execute on functions from
  public` does nothing (per-schema defaults only add to the global ones; A12), and the global
  form would change the default for every `postgres`-created function in the database, including
  Supabase's. So each migration revokes `EXECUTE` from `public` on the functions it creates, and a
  `pg` test checks every function in schema `catalog` (catalog-database "Catalog functions are not
  executable by public").

*Alternative:* `FORCE ROW LEVEL SECURITY`. Not needed: the tables are owned by `postgres`, which
has `BYPASSRLS` anyway (A21), and the app never owns a table.

### D2. Policies and the RLS check
Policies are named `<table>_user_all` and `<table>_system_all` so 6b-2 can `drop policy` them by
name. The loop covers the ten tables that exist now; a later migration must add its own (spec
"Row-level security is enabled on every catalog table"). The `pg` test lists `pg_class` rows of
schema `catalog` with `relkind = 'r'`, checks `relrowsecurity`, and checks `pg_policies` has a
policy whose `roles` include `catalog_user` and one for `catalog_system` per table. So 6b-2, or any
slice that adds a table, cannot forget.

Allow-all policies read no table, so they add no SIREAD dependencies (the extra `40001`s seen in
exploration came from policies that read tables, A21).

### D3. The role guards, and why the 4a file is edited
`migrate.sh` records each version per database and skips recorded ones (A1), so an applied file
never re-runs in its database. But roles are cluster-wide: the `pg` global setup migrates
`postgres` first and `autologger_template` second (A2), and when the 4a file runs in the second
database, `autologger_app` already holds the two memberships from the first. Today's 4a check then
fails (A3). So:
- **4a's DO block is relaxed in place** to "no membership other than `catalog_user` or
  `catalog_system` with `inherit false, set true` and no admin option" (a join of
  `pg_auth_members` to `pg_roles`, columns `admin_option`, `inherit_option`, `set_option`, A4).
  On a fresh database it behaves as before (the roles don't exist yet, so there is no membership).
  Databases where 4a is already applied (dev, stage) never re-run it; their recorded
  `statements` text keeps the old guard, which nothing compares against the file.
- **The 6b-1 migration's guard is strict:** `autologger_app` holds exactly two memberships and
  both conform; the two roles are not members of any role; the only members of either role are
  `autologger_app` and `postgres`; neither role can log in, bypass RLS, or is a superuser or
  replication role.
- **Testing the guards without touching the shared role.** Roles are cluster-wide and `pg` tests
  run in parallel, so a test must not give `autologger_app` a third membership. The guard tests
  copy each DO block's text, substitute a scratch role name (`t_guard_<hex>`) for
  `autologger_app`, create that role with the memberships under test, run the block, expect the
  error (or none), and drop the scratch roles.

*Alternative:* a new migration that runs before 4a. Impossible: versions apply in order and 4a is
the first. *Alternative:* make the `pg` setup migrate one database and clone it. That changes
catalog-database "Catalog tests run against the pinned Postgres image" and leaves real second
databases (a restore, a scratch copy) broken.

### D4. The port and the adapter's bindings
In `@autologger/ports`:
```ts
export interface CatalogRoot {
  bindUser(userId: string): CatalogDb;   // catalog_user, app.user_id = userId
  bindSystem(reason: string): CatalogDb; // catalog_system, app.user_id = ''
  close(): Promise<void>;
}
```
`Ports.catalog` becomes `CatalogRoot`. `PostgresCatalogDb implements CatalogRoot`; a private
`BoundHandle implements CatalogDb` carries a `Binding = { kind: 'user'; userId } | { kind:
'system'; reason }` and calls the adapter's paths with it. At the end of the branch (task 6.1)
`PostgresCatalogDb` has no public `all`/`first`/`run`/`tx`, so an "unbound root statement" cannot
be written against the adapter: it fails to compile, which is stronger than the plan's runtime
throw. Until then the old unbound methods stay, running on the same paths with no preamble, so
every commit stays green (D16). The runtime fail-closed handle lives in the catalog package (D7).
`bindUser('')`, a non-string id, or a reason not matching `^[a-z][a-z0-9-]*$` throws a
`TypeError` at bind time.

**The preamble.** One prepared statement, run after `BEGIN` and before the body, on every run
(so a retry re-applies it):
```sql
select set_config('role', $1, true), set_config('app.user_id', $2, true)
```
with `$1` the role name chosen from the binding's kind (never caller text) and `$2` the user id
or `''`. `set_config('role', …, true)` is `SET LOCAL ROLE` with bind parameters (A7). In a
`SERIALIZABLE` transaction this `SELECT` takes the snapshot, immediately before the body's first
statement, and reads no relation, so it adds no predicate lock.

**Pipelining is mandatory** (owner decision B). On a single-connection client, postgres.js writes
queries issued without awaiting back to back. The transaction path issues `BEGIN` and the
preamble together and awaits both (one round trip, as `BEGIN` alone was); the root path issues
`BEGIN`, the preamble, the statement and `COMMIT` together (D5). If an earlier message fails, the
later ones fail with `25P02` and `COMMIT` is answered `ROLLBACK`; the caller receives the first
error. A unit test asserts every message of the group is issued before the first reply arrives.

*Alternatives:* `SET LOCAL ROLE` text plus a separate `set_config` (two messages, and the role
can't be a bind parameter); session-level `SET ROLE` on per-role pools (leaks across commit,
exploration A21, and still needs a per-transaction user id).

### D5. Root statements: a short `READ COMMITTED` transaction on adapter-owned root slots
**Not `reserve()` or `begin()`.** postgres.js crashes the process when a reserved connection's
socket has closed and anything is sent on it, and `release()` hands back a connection still inside
a transaction (A23; the archived `postgres-catalog-adapter` design A5, A6 and D3; the adapter's
header comment). The panel reproduced both with the D5 draft: a killed backend mid-short-
transaction gave `UNCAUGHT Cannot read properties of null (reading 'write')`, and a release inside
the transaction ran later pooled queries as `catalog_user` inside it.

**Root slots.** The shared root pool (`max: rootMax`, `max_pipeline: 1`) is replaced by `rootMax`
root slots, each a dedicated `max: 1` client made by the same `slotClient()` as the transaction
slots: `onclose` marks a lost connection, a client whose transaction state is unknown is retired
(ended and replaced) and never released, and a slot returns to the free list only after a
confirmed `COMMIT` or `ROLLBACK` reply. Root slots have their own FIFO wait queue, so root calls
never queue behind transactions and transactions never queue behind root calls. **Count:**
`rootMax` keeps its default of 3, so the app still opens at most 3 + 5 = 8 of its 20 allowed
connections and root concurrency is what the 3 pooled connections gave (each carried one
statement at a time). The concurrency probe (D14) is what would show that 3 is too few.

**One call.** A bound `all`/`first`/`run` outside a transaction takes a root slot within its
deadline, then issues pipelined `BEGIN ISOLATION LEVEL READ COMMITTED`, the preamble, the
statement and `COMMIT`. It resolves with the statement's result **only after the `COMMIT` reply
says `COMMIT`**. A failing `COMMIT` (a deferred foreign key, for example) rejects the call with
that error, and nothing persists, as an autocommit statement's commit failure did. A failing
statement rejects with its error (the `COMMIT` is then answered `ROLLBACK`, which confirms the
end). Semantics stay the root path's, not the transaction path's:
- **Isolation.** `READ COMMITTED` is today's autocommit level (A15), so no root statement starts
  failing with `40001`, and catalog-database "Settings defaults are race-free…" (which forbids a
  transaction that concurrent first reads can conflict on) still holds. Pinned explicitly so a
  changed server default can't alter it.
- **No retry**, as today.
- **Deadline.** The 5-second root deadline covers the wait for a root slot and the whole short
  transaction. If it passes before the group was sent, the call leaves the queue and never runs.
  If the group was sent, no cancel is sent, as today; the caller gets
  `CatalogRootTimeoutError('…may still apply')`; the adapter keeps waiting for the replies in the
  background, bounded by the role's `statement_timeout` (30 s) and
  `idle_in_transaction_session_timeout` (15 s) plus a grace, then releases the slot on a
  confirmed end or retires the client; `settled` resolves when that has happened. The session
  mirror's ordering (catalog-database "Session live projection is mirrored in order") keeps
  working off `settled`.
- **Lost connection.** A connection that closes mid-call (backend killed, network reset) rejects
  the call (`CONNECTION_CLOSED`), sends nothing more on that client, retires it, and puts a fresh
  client in the slot; the process keeps running and the next call succeeds.
- **One short transaction per root slot at a time.**
- `guardRoot` still refuses a root call inside an open transaction, for every binding.

*Alternative:* run root statements through `attempt()` on the transaction slots with a
`READ COMMITTED` begin and one try. Rejected: root calls would queue behind the 5 transaction
slots, inherit the transaction path's cancel-at-deadline (the spec'd "no cancel, outcome unknown,
`settled`" contract would change), and move to the 10-second deadline. The root slots reuse the
slot machinery (`slotClient`, `retire`, `recycle`) without those rules. *Alternative:* one
simple-protocol string (`set_config(...); <stmt>`) in one round trip. Rejected: the simple
protocol takes no bind parameters, so values would be inlined into SQL.

### D6. No role carries over: hygiene without an extra round trip
No `RESET ROLE` on release. The invariants that make it unnecessary:
1. the adapter sends no session-level `SET` (a unit test asserts every control or preamble message
   the adapter itself issues sets roles and settings only with `set_config(…, true)`);
2. `SET LOCAL` and `set_config(…, true)` end with the transaction, including rollback, error and
   savepoint rollback (A7, A10, A21);
3. every client (transaction slot or root slot) returns to its free list only after a confirmed
   `COMMIT` or `ROLLBACK` reply; a lost connection, a failed or unanswered `COMMIT`, or an
   unconfirmed `ROLLBACK` retires the client (D5).

The `pg` tests check the result rather than the reasoning: with a `connect` wrapper (the
adapter's existing injection point) a test records every client the adapter opens, runs a mixed
workload (user and system, commit, rollback, a failing statement, a `40001` retry, root
statements), and then queries each live client directly for `current_user` and
`current_setting('app.user_id', true)`: `autologger_app` and `''`/null everywhere. Two more kill a
root slot's backend (`pg_terminate_backend`) mid-short-transaction and make a root `COMMIT` fail
(deferred foreign key) or stall past the deadline: the call rejects, the process survives, the
client is retired, no open transaction reaches another caller, and the next call succeeds on a
fresh client.

### D7. The catalog facade: `createCatalog(root)`, `forUser`, `system`, `unbound`
- `createCatalog(root: CatalogRoot): CatalogFacade` returns an **unbound** `Catalog`: its stores
  sit on `UNBOUND_DB`, a `CatalogDb` whose `all`/`first`/`run`/`tx` reject with
  `CatalogUnboundError` (exported by `@autologger/catalog`) without touching the root. `init()`
  rejects too.
- `catalog.forUser(userId)` → `new Catalog(root.bindUser(userId), { root, studios })`,
  `catalog.system(reason)` → the same with `root.bindSystem(reason)`, and `catalog.unbound()` →
  the same on `UNBOUND_DB`. Each carries `this.studios.withDb(handle)`, the current registry
  snapshot, without a query.
- `Catalog.tx` keeps the binding (the bound handle's own `tx`) and the root.
- The `Catalog` constructor becomes `(db: CatalogDb, opts?: { root?: CatalogRoot; studios?:
  StudioRegistry })`. A `Catalog` with no root (package unit tests) throws on `forUser`/`system`.
- `CatalogFacade` gains the three members as property-style function types (core-ports-architecture
  "Persistence facades…").

The server's `onError` needs no new case: an unbound error falls to the generic `500` and is
logged by `console.error('unhandled error', …)` with its name (spec scenario "A request with no
user fails closed").

### D8. The forbidden error
`CatalogForbiddenError` (in `packages/storage/src/catalogErrors.ts`) wraps a `PostgresError` with
code `42501`, raised by both the root path and `TxHandle.statement`, with fields `code: '42501'`,
`table_name` (from the error, when present) and `binding` (`'user'` or `'system:<reason>'`; never
the user id). It is not retryable (only `40001`/`40P01` are) and it fails the transaction like any
statement error. `app.ts`'s `redactDatabaseError` logs it as `{ name, code, table_name, binding }`,
so the message (which can name values) stays out of logs. **In 6b-1 every route answers it with
the generic `500`**: the policies allow everything, so it can only come from a missing grant or
binding, which is a bug. Mapping it to a route's masked `404` or `403` belongs to 6b-2, where a
policy can deny (proposal "For the approver").

### D9. The middleware and KV
```ts
const sys = createCatalog(c.env.ports.catalog).system('auth-resolve');
await sys.init();
const user = await resolveSessionUser(c.env.ports.kv, sys, cookie);
c.set('user', user);
c.set('catalog', user ? sys.forUser(user.id) : sys.unbound());
```
The registry snapshot is loaded once, on the system catalog, and both derived catalogs carry it.
The KV store is built once in `config.ts` as `new KvStore(catalogDb.bindSystem('kv'), clock)`, so
login sessions, OAuth state, the Companion's last command, and the boot and periodic purges all
run as `system:kv`. `KvStore` already runs on root statements only (a key/value call never joins
a catalog transaction), which is unchanged.

### D10. System call sites
| File | Reason | What runs there | 6b-2 note |
| --- | --- | --- | --- |
| `middleware/auth.ts` | `auth-resolve` | registry `init()`, `authGetUserById` | stays |
| `node/config.ts` | `kv` | the KV store (D9) | stays |
| `node/config.ts` | `session-mirror` | the mirror's session-index writes | stays |
| `main.ts` | `boot-wait` | `waitForCatalog` | stays |
| `routers/logImport.ts` | `log-import-job` | the detached job (keeps the 6a per-sheet access re-check) | could bind the creator |
| `routers/auth.ts` | `oauth-callback` | user lookup, create, profile update | stays |
| `routers/auth.ts` | `bootstrap-claim` | `authClaimOwnerlessStudios` transaction | stays |
| `routers/admin.ts` | `support-plane` | every `/api/admin/*` handler, via an `adminCatalog(c)` helper that checks `ADMIN_TOKEN` first | stays |
| `routers/companion.ts` | `companion-token` | token-only calls (no user), via a `companionCatalog(c)` helper; cookie callers keep the user catalog | slice 9 credential |
| `routers/_helpers.ts` | `access-loss-check` | `closeSocketsAfterAccessLoss` (reads another user's access); its `showIds` thunk receives that catalog, so the admin path no longer reaches the unbound request catalog | helper function |
| `routers/teams.ts` | `team-invite` | the whole invite transaction (role check, lookup by email, memberships for matches, invite rows) | `SECURITY DEFINER` lookup |
| `routers/teams.ts` | `team-create` | the whole create transaction (cap, definition, purge, owner membership) | `SECURITY DEFINER` purge |

- **A transaction has one binding** (spec "One binding per transaction"). The invite and create
  transactions run with the role checks inside them (`requireTeamRoleIn`, the cap), so making the
  whole transaction system changes no authorization; the user's role is still checked against
  committed state. Calling a system catalog from inside the user transaction would be refused by
  `guardRoot`.
- **The anonymous profile is not a system site.** `profilePayload(null, …)` sends no statement
  (A17): the settings loop skips every team for an empty allowed set, and `authSection(null)`
  returns early. It keeps the unbound catalog and would fail closed if it started querying.
- **OAuth start and logout** use only KV, so they need no reason of their own.

### D11. The system allowlist repo test
`server/src/catalogSystem.repo.test.ts` (unit project, like the other `*.repo.test.ts`):
- walks `server/src/**/*.ts` and `packages/*/src/**/*.ts`, skipping `*.test.ts`, `**/test/**` and
  `.d.ts`;
- finds every `.system(` and `.bindSystem(` call; one whose first argument is not a single-quoted
  string literal (`/^'[a-z][a-z0-9-]*'$/` after trimming) is a violation;
- compares the set of `{ file, reason }` pairs with `ALLOWLIST: readonly { file: string; reason:
  string; why: string }[]` held in the test, and reports both directions (unlisted, stale);
- requires `.forUser(` and `.bindUser(` to appear only in `server/src/middleware/auth.ts` (and the
  implementing modules `packages/catalog/src/catalog.ts`, `packages/storage/src/postgresCatalogStore.ts`);
- exports its scan function and tests it against synthetic trees (a compliant file, an unlisted
  reason, a variable reason, a stale entry, a stray `forUser`), following the mutation-coverage
  convention of `packageBoundaries.repo.test.ts`, so the check cannot go vacuous.

It is a textual scan: an alias (`const s = c.system; s('x')`) or a dynamic import would slip past
it, as the boundary check states for itself. The database's refusal of the bare login role is the
backstop.

### D12. Tests and test plumbing
- **`test/pg/testDb.ts`:** `TestDatabase` gains `user` and `system` connection options that log in
  as `autologger_app` and switch role at connection start (`connection: { options: '-c
  role=catalog_user' }`, A9). This is a session-level switch on a test-only connection, which is
  fine for a client that never returns to a pool. `app` stays the bare login role, refused on
  every table after task 6.3.
- **Existing `pg` suites that query as `db.app`** move to `db.system` where they test schema or
  constraints: `catalogSchema` (except the refusal and role tests), `showGrants`, `teamOwner`,
  `harness.pg`. `new PostgresCatalogDb(app)` becomes `new PostgresCatalogDb(app).bindSystem('test')`
  in `authCreateUser.pg`, `kvStore.pg` and the adapter suites. The catalog transaction contract
  suite (`packages/storage/src/test/catalogDbContract.ts`) runs twice, on a user-bound and a
  system-bound handle, and gains a root-path case: a root `run` inserting a `catalog.c` row whose
  deferred foreign key fails at commit rejects with `23503` and leaves no row. Its fixture tables
  (`catalog.t`, `p`, `c`) get the two roles' grants through the new default privileges and have no
  RLS, which is fine for a contract test.
- **`catalogSchema.pg.test.ts`:** "no memberships" becomes "exactly the two memberships"; the
  read/write test runs per catalog role; new tests for the roles' attributes, the members of the
  two roles, `pg_has_role(…, 'SET')` false for the API roles and `authenticator`, `public`
  execute on catalog functions, RLS on every table, both guards (D3), and (task 6.2) the
  bare-role refusal and the absence of any policy for `autologger_app`.
- **Unit (adapter, fake `connect`):** the bound transaction issues `BEGIN` and the preamble
  together, then the body, on each run; the bound root statement issues `BEGIN ISOLATION LEVEL
  READ COMMITTED`, the preamble, the statement and `COMMIT` together on one root-slot client and
  resolves only after the `COMMIT` reply; a malformed binding throws; a `42501` reply becomes
  `CatalogForbiddenError` without a retry; the adapter's own control and preamble messages contain
  no session-level `SET` (the check excludes the body's SQL, which may legitimately contain
  `UPDATE … SET role = …`); a system-bound statement issued inside an open user-bound transaction
  rejects with `CatalogTxMisuseError` and the transaction rolls back (spec "A system handle inside
  a user transaction is refused").
- **Test files that call the root adapter directly.** 51 calls in 19 integration files use
  `env.ports.catalog.first|all|run|tx(…)` (A24): `routers/apiResponseFixtures.int`, `auth.int`,
  `events.generate.int`, `mirrorFailure.int`, `nulText.int`, `sessions.int`,
  `sessions.localAudioImport.int`, `sessions.race.int`, `sessions.youtubeImport.int`,
  `shows-profile.int`, `teams.race.int`, `transcribe.int`; `test/authStore.int`,
  `catalogDialect.int`, `catalog.int`, `gatedCatalog.int`, `SessionHub.int`,
  `settingsDefaults.int`, `smoke.int`. Once `Ports.catalog` is a `CatalogRoot` they no longer
  compile. A test-only helper `testDb()` in `server/src/test/helpers.ts` returns
  `env.ports.catalog.bindSystem('test')`, and each call becomes `testDb().first(…)` etc.; a test
  that hands a gated or wrapped catalog to `envWith` passes a `CatalogRoot` wrapper instead. These
  are plumbing edits: no assertion about an HTTP status, body, header or WebSocket message
  changes.
- **Integration:** `catalogFor()` and the harness's `defaultUser()` use
  `createCatalog(env.ports.catalog).system('test-seed')` (tests are exempt from the allowlist);
  `GatedCatalog` wraps a `CatalogRoot` (it gates the handles `bindUser`/`bindSystem` return) and
  can record each statement's binding. New suites: a signed-in request's route statements run as
  its user and the resolution as system (via the recording root); a test-only route mounted under
  `/api/admin/` (no login required) that queries `c.get('catalog')` with no user answers `500`
  and logs `CatalogUnboundError`; the anonymous profile stays `200`. Everything else runs
  unchanged.

### D13. No contract change
Every route keeps its statuses, bodies and messages: the policies allow everything, every caller
is bound, and the only new failure (`500` from an unbound or forbidden call) is a bug path that no
correct request reaches. The integration suite, which asserts the frozen surface (fixtures,
`apiResponseFixtures.int`, the route-table tests), is the proof. So `api-contract-freeze` gets no
delta and the README endpoint table is untouched.

### D14. Measuring the cost: a concurrency probe (owner decision B)
Retry counting is out (it belongs to 6b-2). The probe is
`server/src/test/pg/catalogRootProbe.pg.test.ts`, skipped unless `CATALOG_ROOT_PROBE=1`. On a
cloned test database it seeds a user, a team, a show, a session and a KV login session, builds
one `PostgresCatalogDb` as `autologger_app` with the server's pool sizes, and runs N = 20
concurrent request mixes for 10 rounds (200 requests). Each request does what the middleware does
(KV session lookup, user read, registry load: three root calls), then one of a rotating route mix
through the real stores: the profile payload, the session list of a show, a show read, and one
write transaction (a session update). A wrapper around the handles times every root call and
counts `CatalogRootTimeoutError`. It prints one JSON line: root calls, p50, p95, max, timeouts,
transactions, wall time.
- **Before** (task 1.1-1.2): written and run on this branch before any adapter change (the code
  of 72ddd0f), using today's unbound API.
- **After** (task 8.3): the same probe with the middleware's calls on `system('auth-resolve')`
  and `bindSystem('kv')` and the route mix on `forUser(id)`, on the finished branch.
- Each is run 5 times; the medians are compared. **Stop condition:** if the median root p95
  more than doubles, or any run after shows a root timeout, the implementer stops and asks the
  owner before task 8.4.
- **Information only:** the suite wall time of 5 integration-plus-`pg` runs (task 8.2) beside the
  6a logs (A19: 50.3-55.6 s for 800 tests).

### D15. Docs
- **ADR 0021, item 6:** the 6b entry splits into 6b-1 `catalog-roles` (owner decisions 1-4 and
  A-D, the approver confirmations, the complete rollback SQL from "Risks / Trade-offs", D3's note
  on the edited 4a guard) and 6b-2 `catalog-policies` (team-level reads, access-level writes, the
  `SECURITY DEFINER` helpers with `EXECUTE` revoked from `public`, the allow/deny matrix, the
  `40001` retry measurement, moving system sites back toward user scope, and mapping `42501` to
  the routes' masked responses). Follow-ups recorded there: the post-migration database-side
  logging and auditing the owner wants (system reason and user visible in `pg_stat_activity` and
  the database log; owner decision C), and `postgres`'s automatic admin membership in the two
  roles under the existing "reach of `postgres`" note (owner decision D).
- **ADR 0021's "Data access" decision bullet** still says the app runs `set local role
  authenticated` with the caller's JWT claims; it changes to: each transaction runs `set_config('role',
  'catalog_user' | 'catalog_system', true)` and `set_config('app.user_id', …, true)`, so RLS
  applies, and `authenticated` gets nothing (owner decision 4).
- **`docs/supabase.md`:** the role table's `autologger_app` row becomes "no table privileges;
  member (set only) of `catalog_user` and `catalog_system`", and the two NOLOGIN roles get a row;
  the "Catalog time limits" paragraph says a statement outside a transaction is a short
  `READ COMMITTED` transaction on one of 3 dedicated root connections, resolved after its commit,
  withdrawn if still queued at its 5 s deadline, and otherwise left to the role's timeouts.

### D16. Every commit stays green
The work is ordered so the full suites pass after each group:
- group 1: the concurrency probe and its baseline, on the unchanged code;
- group 2: the migration's step 1 (D1): the roles, their grants, the helper, RLS with the role policies
   **and** an interim allow-all policy for `autologger_app`, which also keeps its table grants;
- group 3: the adapter: root slots, bindings and the preamble, with the old unbound methods still there;
- group 4: the catalog facade;
- group 5: the server wiring, the system sites, the allowlist test and the 19 test files; `Ports.catalog`
   becomes `CatalogRoot`, and every production statement is now bound;
- group 6, lock-down: remove the adapter's unbound methods, and the migration's step 2 (revoke the bare
   role's grants and default privileges, drop the interim policy); the bare-role refusal tests;
   the full suites;
- group 7: docs;
- group 8: verification.

## Assumptions

Probe setup (2026-10-02): a throwaway container of the pinned image (`docker run … supabase/postgres:17.6.1.136 …`,
named `cr-probe`, removed afterwards; dev and stage untouched), migrated with `docker/supabase/migrate.sh`
into `postgres` and `autologger_template` exactly as `test/pg/globalSetup.ts` does, then scratch
databases `p1`/`p2` cloned from the template and given a draft of D1 (roles, grants, the helper, RLS
with policies on `users` and `kv` only).

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | `migrate.sh` tracks versions per database and skips applied files | `docker exec … -e PGDATABASE=p1 cr-probe sh /migrate.sh` (second run) | `skipped 20261005000000` … `0 applied` |
| A2 | The `pg` setup migrates two databases in one cluster | `grep -n "for (const db of" test/pg/globalSetup.ts` | `for (const db of ['postgres', 'autologger_template'])` |
| A3 | 4a's guard fails once `autologger_app` has memberships | run 4a's `role:begin…role:end` block in `p1` after the draft | `ERROR:  autologger_app must not be a member of any role` |
| A4 | Membership options are visible; the creator gets admin | `select roleid::regrole, member::regrole, admin_option, inherit_option, set_option from pg_auth_members …` | `catalog_user\|autologger_app\|f\|f\|t`, `catalog_system\|autologger_app\|f\|f\|t`, `catalog_user\|postgres\|t\|f\|f` |
| A5 | Re-granting in a second database is harmless | draft applied to `p2` | `NOTICE:  role "autologger_app" has already been granted membership in role "catalog_user" by role "postgres"`, exit 0 |
| A6 | The bare login role, keeping schema `USAGE`, is refused per table | `psql -U autologger_app -d p1 -c "select count(*) from users"` (and `catalog.users`) | `ERROR:  permission denied for table users` (both) |
| A7 | `set_config('role', $1, true)` with binds works in postgres.js and ends with the transaction | node script: `sql.begin(t => t.unsafe("select set_config('role', $1, true), set_config('app.user_id', $2, true)", ['catalog_user','u-1']) …)` | `tx { u: 'catalog_user', id: 'u-1' } after { u: 'autologger_app', id: '' }` |
| A8 | After use, `app.user_id` reads `''`, not null | same script, after commit | `id: ''` |
| A9 | A test connection can switch role at startup | node: `postgres({ …, connection: { options: '-c role=catalog_system' } })` | `startup { u: 'catalog_system', n: 0 }` |
| A10 | Savepoint rollback undoes `SET LOCAL ROLE` | `begin; savepoint s; set local role catalog_system; rollback to s; select current_user;` | `autologger_app` |
| A11 | RLS with no policy for a role hides rows and refuses inserts | as `catalog_user` on `kv` (system policy only): `select count(*)`, `insert` | `0`; `ERROR:  new row violates row-level security policy for table "kv"` |
| A12 | Per-schema default privileges can't revoke `public` `EXECUTE` | draft's `alter default privileges … in schema catalog revoke execute on functions from public`, then `create function catalog.zz()`; `select proacl …`, `has_function_privilege('anon','catalog.zz()','execute')` | `zz\|` (null ACL); `t` |
| A13 | Only the catalog roles can run the helper | `has_function_privilege` for `anon`, `autologger_app`, `catalog_user` on `catalog.app_user_id()` | `f\|f\|t` (inherit false: the login role holds nothing) |
| A14 | The app role still can't switch to `postgres` | `begin; select set_config('role','postgres',true);` | `ERROR:  permission denied to set role "postgres"` |
| A15 | Autocommit statements run at `READ COMMITTED` | `show default_transaction_isolation` | `read committed` |
| A16 | Table default privileges move to the two roles | `select defaclrole::regrole, defaclobjtype, defaclacl from pg_default_acl …` in `p2` | `postgres\|r\|{catalog_user=arwd/postgres,catalog_system=arwd/postgres}` |
| A17 | The anonymous profile sends no statement after the middleware | read `packages/catalog/src/profileAssembler.ts:119-135`, `:85`, `studioRegistry.ts:180-186` | `if (user === null) return { … studio_settings: await this.studios.allStudioSettingsForAllowedStudios(new Set()) …}`; the loop `continue`s for every id; `authSection` returns early for `null` |
| A18 | The pinned postgres.js is 3.4.9, whose `reserve()` exists but is unsafe here (A23), so D5 does not use it | `grep -n '"version"' node_modules/postgres/package.json; grep -n reserve node_modules/postgres/types/index.d.ts` | `3.4.9`; `reserve(): Promise<ReservedSql<TTypes>>` |
| A19 | 6a baseline | `grep -h "Tests \|Duration" <scratchpad>/6a-flake-{1..5}.log` | `Tests  800 passed (800)`; `Duration  55.31s`, `55.31s`, `50.32s`, `55.63s`, `50.48s`; no retry counts recorded |
| A20 | The invite and team-create writes touch other users' rows inside one user transaction | `sed -n 125,134p;232,241p server/src/routers/teams.ts` | `await catalog.tx(async (cat) => { … insertStudioDefinition … })`; `await c.get('catalog').tx(async (catalog) => { … authListUsersByEmailNorm … authAddMembershipWithRole(String(m.id), …)` |
| A21 | Exploration probe facts (plan Context, not re-run here): plain `SET ROLE` leaks across commit; `postgres` is not superuser but has `BYPASSRLS`; policy reads add SIREAD dependencies; a blocked `UPDATE`/`DELETE` changes 0 rows; `auth.uid()` is absent in template-made databases; `ALTER ROLE … SET` on `catalog_user` does not apply | recorded in `/home/spark/.claude/plans/parsed-honking-lobster.md` | as stated there |
| A23 | postgres.js `reserve()` crashes the process after its socket closes, and `release()` returns a connection still in a transaction | archived `openspec/changes/archive/2026-10-01-postgres-catalog-adapter/design.md` A5, A6 (`grep -n reserve …`); panel reproduction on the D5 draft | `TypeError: Cannot read properties of null (reading 'write') at connection.js:255`; `runs inside it = true`; panel: `UNCAUGHT Cannot read properties of null (reading 'write')`, and later pooled queries ran as `catalog_user` inside the released transaction |
| A24 | 19 integration files call the root adapter directly | `grep -rn "env\.ports\.catalog\.\(first\|all\|run\|tx\)" server/src packages \| wc -l`; `… -l` | `51`; the 19 files listed in D12 |
| A22 | 54 production `c.get('catalog')` uses, none changed by the binding except D10's | `grep -rn "c.get('catalog')" server/src --include=*.ts \| grep -v .test.ts \| wc -l` | `54` |

## Risks / Trade-offs

- **[A no-user path that queries the request catalog now answers `500`]** → that is the
  fail-closed design. The integration suite exercises every route; D10 lists the no-user paths
  found by reading the middleware's login rule (`apiRequestRequiresLogin`), the OAuth router and
  the admin plane; the dev and stage walk-through (proposal "After merge") checks the log for
  `CatalogUnboundError`.
- **[Root statements cost more]** (four messages instead of one) → they are pipelined into one
  round trip (D4, D5), and the concurrency probe compares root p95 and timeouts against the
  pre-binding code with a stop condition (D14). Every request makes at least three root calls as
  system (KV lookup, user read, registry), so this is the cost to watch.
- **[Root slots behave differently from the pooled root connections]** → they reuse the
  transaction slots' proven machinery (loss tracking, retire on unknown state), the count is
  unchanged (3), and new `pg` tests kill a backend and fail a `COMMIT` mid-call (D6).
- **[A short root transaction can hold row locks a little longer]** → it holds them only for its
  one statement plus `COMMIT`; the role's 15-second idle-in-transaction timeout bounds a stalled
  client.
- **[System binding is broad]** (team create and invite run entirely as system) → the role checks
  stay inside those transactions, the allowlist names each site, and 6b-2 can narrow them with
  helpers.
- **[The allowlist test is textual]** → stated limits (D11); the database refuses the bare role.
- **[An edited applied migration]** → only new databases run it; dev and stage keep the old
  recorded text; nothing compares it (D3).
- **[A migration file edited between its two steps]** → only test databases apply it on this
  branch; `make dev-up` is not run before task 6.3 (D1).
- **[Deploy order: migration before app]** → the migration takes the table privileges away from
  the bare login role, so the old app fails every catalog call until the new app runs. On dev the
  app hot-reloads from the branch; on stage the `migrate` run and the app recreate happen in the
  same `make stage-up`, so the window is that command's restart. Prod is not on this branch until
  slice 11's cutover, where the catalog is created fresh.
- **Rollback** (owner decision A: documented SQL, no script file, no rollback test). Reverting
  the code alone leaves an app without bindings facing tables it can't read (and, with RLS on and
  no policy for it, seeing no rows, A11). Run as `postgres` in one transaction
  (`psql -X -v ON_ERROR_STOP=1 --single-transaction`), then deploy the previous image:
  ```sql
  revoke catalog_user, catalog_system from autologger_app;
  grant select, insert, update, delete on all tables in schema catalog to autologger_app;
  alter default privileges for role postgres in schema catalog
    grant select, insert, update, delete on tables to autologger_app;
  do $$
    declare t text;
    begin
      for t in select tablename from pg_tables where schemaname = 'catalog' loop
        execute format('drop policy if exists %I on catalog.%I', t || '_user_all', t);
        execute format('drop policy if exists %I on catalog.%I', t || '_system_all', t);
        execute format('alter table catalog.%I disable row level security', t);
      end loop;
    end
  $$;
  drop function if exists catalog.app_user_id();
  delete from supabase_migrations.schema_migrations where version = '20261006000000';
  ```
  Deleting the version row is the roll-forward path: the next `migrate` run re-applies the
  migration (its role creation, grants and guard are idempotent, the function uses
  `create or replace`, and the policies were dropped). The two NOLOGIN roles and their table
  grants stay; they are harmless without members. The same SQL goes into ADR 0021's 6b-1 entry.

## Migration Plan

1. Merge to `supabase-migration`; dev applies the migration on its next `make dev-up` (the
   `migrate` service), then the hot-reloaded app binds every call.
2. Stage (with the owner's permission for `make stage-up`): `migrate`, then the app recreate.
3. Live checks in proposal "After merge".
4. Rollback: the SQL in "Risks / Trade-offs", then deploy the previous image; a later deploy of
   this change re-applies the migration.

## Owner decisions after the panel (owner, 2026-10-02)

The proposal's decisions 1-4 stand. After the adversarial panel the owner added A-D, which this
design implements and which replace the former open questions:
- **A. Rollback is documented SQL** ("Risks / Trade-offs", and the ADR entry), with the version
  row deleted so a redeploy rolls forward; no script file, no rollback test.
- **B. A concurrency probe instead of retry counting** (D14), mandatory pipelining (D4, D5), and
  the stop condition "root p95 more than doubles or any root timeout in the probe" (former OQ1).
- **C. No database-side trace of the system reason in 6b-1** (former OQ2); post-migration
  follow-up for full database-side logging and auditing, recorded in ADR 0021 (D15).
- **D. `postgres`'s automatic admin membership stays** (former OQ3); recorded under ADR 0021's
  "reach of `postgres`" follow-up (D15).

Panel fixes folded in without a scope change: root statements on adapter-owned root slots, never
`reserve()` (D5, A23); a root call resolves only after its confirmed `COMMIT` (D5); the ADR "Data
access" bullet and `docs/supabase.md` "Catalog time limits" edits (D15); a test for a system handle
inside a user transaction (D12); an order that keeps every commit green (D16); the 19 test files
that call the root adapter directly (D12, A24); indented `end` lines in the migration's DO blocks
(D1); the session-level-`SET` check limited to the adapter's own messages (D12).
