# Catalog roles: every catalog statement runs as a user or a system role

Tier: 2
Tier reason: a catalog migration that creates roles, moves every table privilege and enables
row-level security; authorization plumbing (the request catalog is bound to the signed-in user,
system callers are explicit); concurrency (the adapter's transaction and root-statement paths
change, and every retry must re-apply the role); touches `supabase/migrations/**`,
`server/src/routers/**` and `**/auth/**`.

Approved-by: Kalen created: 2026-10-02

## Why

ADR 0021 slice 6 puts Postgres row-level security under the 6a permission model (merged in
PR #38). Today `autologger_app` holds plain CRUD on every table in schema `catalog`, and nothing
in the database knows who the caller is, so a policy has nothing to read and a forgotten check in
the app reaches every row. Before any real policy can land, every catalog statement has to run
under a role that says whether it serves a signed-in user (and which one) or a named system
task, and a path that forgets to say so has to fail closed. This change is that plumbing, with
policies that allow everything, so behaviour does not change; slice 6b-2 `catalog-policies`
writes the real policies on top of it.

## Owner decisions (owner, 2026-10-02)

These are the human owner's binding decisions for this slice:
1. **Split 6b in two.** 6b-1 `catalog-roles` (this change) is the plumbing, with policies that
   allow everything, so behaviour does not change. 6b-2 `catalog-policies` adds the real
   policies.
2. **A system path through a second role.** A NOLOGIN `catalog_system` role is reached only
   through an explicit `catalog.system('<reason>')` handle. A repo test lists every caller.
   `autologger_app` keeps no table grants, so a path that forgets to bind a role fails closed.
3. **Policy strictness (6b-2):** reads at team level, writes at access level. The 6a app gates
   stay as the precise check. (Context only for this change.)
4. **A dedicated NOLOGIN user role** (decided in 6a), not `authenticated`. The bare
   `authenticated` role gets nothing and the catalog stays invisible to PostgREST.

After the adversarial panel (owner, 2026-10-02):

A. **Rollback is documented SQL, not a file.** No `supabase/rollback/` script and no rollback
   test. The complete rollback SQL lives in design "Risks / Trade-offs" and in ADR 0021's 6b-1
   entry: revoke both memberships, restore `autologger_app`'s table grants and default
   privileges, drop the `_user_all`/`_system_all` policies, disable row-level security, drop
   `catalog.app_user_id()`, and delete the `20261006000000` row from
   `supabase_migrations.schema_migrations`, so a later deploy re-applies the migration (the
   roll-forward path).
B. **Performance is a concurrency probe, not retry counting.** Retry counting belongs to 6b-2.
   This slice probes N = 20 parallel signed-in request mixes (including the middleware's three
   or more root calls) against one adapter on a `pg` test database, before the bindings and
   after, measuring root-call p95 latency and the `CatalogRootTimeoutError` rate. Pipelining
   `BEGIN`, the role and user-id preamble and the statement (and `COMMIT` for a root statement)
   is mandatory. Stop and ask the owner if root p95 more than doubles, or if any root timeout
   appears in the probe. The suite wall time against 6a is reported as information only.
C. **No database-side trace of the system reason in 6b-1.** A post-migration follow-up, recorded
   in ADR 0021: the owner wants full database-side logging and auditing after the migration (the
   system reason and the user visible in `pg_stat_activity` and the database log).
D. **`postgres`'s automatic admin membership** in the two catalog roles stays; it is recorded
   under ADR 0021's "reach of `postgres`" follow-up.

## For the approver

Design proposes these; the owner confirms them at approval:
- **Root statements run as a short `READ COMMITTED` transaction on adapter-owned root
  connections** (design D5). A catalog statement outside a transaction keeps today's root rules
  (no retry, the 5-second root deadline, no cancel once sent, the "may still apply" timeout),
  resolves only once its `COMMIT` is confirmed, and runs on dedicated single-connection clients
  managed like the transaction slots (never postgres.js `reserve()`), rather than taking the
  transaction rules
  (`SERIALIZABLE`, retries, the 10-second deadline). The plan said "with the existing retry and
  deadline rules"; this reads that as the root path's existing rules, because the session mirror's
  write ordering depends on them.
- **A `42501` maps to `500` in this slice** (design D8). Policies allow everything, so a
  permission error can only come from a missing binding, which is a bug. Mapping it to each
  route's masked `404` or `403` moves to 6b-2, where a policy can deny.
- **Key/value runs on one system binding, `kv`** (design D9). Login sessions, OAuth state and
  the Companion's last command are system data, and the purge runs at boot and on a timer. That
  covers the plan's boot-purge and purge-timer call sites with one reason.
- **Team creation and team invites run entirely as system** (design D10). A transaction has one
  binding. The create's purge of leftover memberships and invites, and the invite's lookup of
  users by email (followed by their memberships), touch rows no user policy will allow, and both
  run inside a transaction with a role check. The plan named only "insertStudioDefinition's
  purge" and "authListUsersByEmailNorm"; the whole transaction is the smallest unit that can
  carry each. 6b-2 may move them to `SECURITY DEFINER` helpers.
- **The anonymous profile needs no system binding** (design D10). The plan listed it, but
  `GET /api/profile` with no user sends no statement after the middleware's resolution (the
  registry snapshot is already loaded), so it keeps the unbound catalog and fails closed if it
  ever starts querying.
- **The 4a migration's guard is edited in place** (design D3). `migrate.sh` records versions per
  database, so an applied file never re-runs there. But roles are cluster-wide, and the test setup
  (and any second database in a cluster) runs the 4a file after another database already gave
  `autologger_app` its two memberships. The plan said `migrate.sh` "re-runs the guard file"; the
  real trigger is the second database.

## What Changes

- **Database (migration `supabase/migrations/20261006000000_catalog_roles.sql`):**
  - two NOLOGIN roles, `catalog_user` and `catalog_system` (no `BYPASSRLS`, `CREATEDB`,
    `CREATEROLE`, `REPLICATION` or superuser), each granted to `autologger_app` `with inherit
    false, set true` and no admin option;
  - the table privileges move: `autologger_app` loses `SELECT`, `INSERT`, `UPDATE`, `DELETE` on
    every catalog table (it keeps `USAGE` on the schema, so a forgotten role is a clear
    `permission denied for table …`), and both new roles get them, with default privileges for
    tables later migrations create;
  - the helper `catalog.app_user_id()` (the transaction's user id, or null), executable by the
    two roles only;
  - row-level security enabled on every catalog table, with one permissive allow-all policy per
    role; 6b-2 replaces the `catalog_user` policies;
  - the role guard becomes "exactly these two memberships, each `inherit false, set true`, no
    admin", in this migration and, relaxed to "no other membership", in the 4a file.
- **Adapter.** A signed-in or system binding is required for every statement. Each transaction,
  and each run of it after a retry, sets the role and the user id for that transaction only.
  A statement outside a transaction runs as a short transaction that does the same, on
  adapter-owned single-connection root clients, and resolves only after its `COMMIT` is
  confirmed. The preamble is pipelined with `BEGIN` (and, at the root, with the statement and
  `COMMIT`). A permission error (`42501`) becomes a distinct forbidden error.
- **Catalog facade.** A catalog is either bound to a user, bound to the system with a reason, or
  unbound; an unbound catalog rejects every query with a distinct programming error, which the
  server answers with its generic `500` and a log line.
- **Server.** The auth middleware resolves the caller on a system catalog (`auth-resolve`) and
  then hands routes a catalog bound to the signed-in user, keeping the request's team-registry
  snapshot. A request with no user gets an unbound catalog. Every system caller names a reason:
  boot wait, key/value, the session mirror, the log-import job, the OAuth callback, the bootstrap
  claim, the support plane (`/api/admin/*`), token-only Companion calls, the access-loss socket
  check, the team-invite transaction (it looks users up by email) and team creation.
- **A repo test lists every system call site** with its reason against an allowlist, so a new
  one fails until it is reviewed.
- **No HTTP or WebSocket change.** Every existing suite passes unchanged; that is the "no
  behaviour change" proof.
- **Docs:** ADR 0021 gets the 6b-1 entry (these owner decisions, the rollback SQL, the
  follow-ups C and D) and the 6b-2 outline, and its "Data access" decision bullet (which still
  says `set local role authenticated` with JWT claims) is corrected; `docs/supabase.md`'s role
  table gains the two roles and its "Catalog time limits" paragraph describes the root short
  transaction.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `catalog-database`: MODIFIED "The app connects as a least-privilege role" (two memberships, no
  table privilege, the relaxed guard) and "The catalog is not exposed through the Supabase API
  roles" (no API role can assume a catalog role); ADDED "Catalog roles for user and system
  callers" and "Row-level security is enabled on every catalog table".
- `core-ports-architecture`: MODIFIED "Catalog facade exposes only role-scoped stores" (bound,
  system and unbound catalogs), "Port types are interfaces in a dedicated package with app-level
  composition" (the root port), "Persistence facades are consumed through package-exported
  interfaces" (the factory takes the root), "The Postgres catalog adapter" (bindings, the
  per-transaction role, retries re-apply it, the forbidden error) and "Root catalog statements
  are time-bounded" (a root statement is a short transaction); ADDED "Every catalog call is bound
  to a caller" (the fail-closed rule, the middleware binding and the system allowlist).

`api-contract-freeze` needs no delta: no route, status, shape or message changes (design D13).
`local-container-environments` and `container-deployment` need none either: `migrate.sh`, the
compose files and the app's login role are unchanged, and the new roles never log in.

## Non-goals

- **Real policies** (6b-2 `catalog-policies`): reads at team level, writes at access level, the
  `SECURITY DEFINER` helpers (`member_studios`, `admin_studios`, `granted_shows`), the allow/deny
  matrix test, and moving some system call sites back to user scope.
- **Mapping `42501` to a route's `404` or `403`** (6b-2, when a policy can deny).
- **Any change to the 6a app gates**; they stay the precise check.
- **Exposing the catalog to PostgREST** or granting anything to `anon`, `authenticated` or
  `service_role`.
- **Restricting `postgres`**, which owns the tables and has `BYPASSRLS`, or the services that use
  it (`db`, `migrate`, realtime).
- **Session content** (per-session SQLite until slice 7).

## Impact

- **Database:** one new migration and an edit to the role guard in
  `20261001000000_catalog_schema.sql` (design D3); `catalogSchema.pg.test.ts` (memberships,
  privileges, RLS), the other `pg` suites that query as the app role, and `test/pg/testDb.ts`
  (connections that assume a catalog role).
- **Packages:** `ports` (the root port), `storage` (`PostgresCatalogDb` bindings, the root
  transaction, the forbidden error, `KvStore` on a system binding), `catalog` (`createCatalog`,
  `system`, `forUser`, `unbound`, the unbound error).
- **Server:** `middleware/auth.ts`, `node/config.ts`, `main.ts`, `waitForCatalog.ts`,
  `app.ts` (log line), routers `auth`, `admin`, `companion`, `profile`, `teams`, `logImport`,
  `_helpers.ts`; the test harness, helpers and `gatedCatalog.ts`.
- **Contract:** none.
- **Operators:** no new env var or secret; the roles are NOLOGIN. The migration applies on the
  next `migrate` run, and the app must be recreated right after it (the old app can't read the
  catalog once it runs). Rolling back needs the documented rollback SQL before the old image
  (owner decision A; design "Risks / Trade-offs").
- **Performance:** each root statement becomes a short transaction and each transaction gains a
  preamble, both pipelined so they add no round trip; root calls queue for 3 dedicated root
  connections, as they queued for the 3 pooled ones. The concurrency probe (owner decision B)
  compares root p95 and root timeouts before the bindings (task 1.2) and at the end (task 8.3).

## After merge

These are outside tasks.md, because they need the merged branch or `make stage-up` permission:
- **Dev live check** (`make dev-up`):
  - the migration applied: `catalog_user` and `catalog_system` exist, and `autologger_app` holds
    exactly those two memberships;
  - sign-in works, the team page loads, a session opens and records, the support plane
    (`/api/admin/*` with `ADMIN_TOKEN`) answers, and a Companion call with `API_TOKEN` works;
  - `docker exec … psql` as `autologger_app` with no role set gets `permission denied for table
    users`, and after `set role catalog_user` the select works;
  - the app log shows no `CatalogUnboundError` or `CatalogForbiddenError` after the walk-through.
- **Stage live check**, with the owner's permission for `make stage-up`: the same probes.
- **Prod:** prod runs `main` until slice 11's cutover, so no prod step here.
