# 0021: Migrate storage from better-sqlite3 to self-hosted Supabase

- Date: 2026-09-30
- Status: Accepted
- Rule: none. This records a direction; each slice below is its own tier 2 OpenSpec change.

## Context

Today everything runs in one Node process:
- `DATA_DIR/catalog.db` is a single SQLite file;
- each session has its own `sessions/<id>.db`;
- audio blobs are on the filesystem;
- an in-memory `SessionHub` per session fans out over WebSocket.

The storage seam is synchronous by design: `CatalogDb` is documented as a "permanent invariant",
and `SessionHub` RPC bodies have zero awaits. The owner wants these things, none of which that
design can provide:
- more than one server process;
- row level security (RLS);
- real user accounts;
- managed backups;
- live updates through Supabase Realtime.

The app currently runs anonymously. Any non-null user id in live data is test data.

## Decision

Move all storage to a **self-hosted Supabase** instance per environment (dev, stage, prod), with
Postgres as the source of truth. Build it in slices on an integration branch, then cut over once.

- **Data access:** the server keeps the Hono HTTP API. It queries through postgres.js and, in each
  transaction, runs `set local role authenticated` with the caller's JWT claims, so RLS applies
  to server traffic and transactions still work. supabase-js on the server is for Auth admin,
  Storage and Realtime only.
- **Schema:**
  - one set of tables keyed by `session_id` (no per-session databases);
  - `timestamptz` and `jsonb`;
  - migrations in `supabase/migrations/`.
- **Auth:**
  - Supabase Auth with the Google provider; login is required and anonymous mode is removed;
  - existing users and memberships are dropped;
  - a bootstrap step makes the owner the owner of every studio;
  - the built-in studios (`test-studios`, `test-studio-2`) are dropped.
- **Permissions:**
  - Roles are `owner`, `admin` and `member`.
  - Each studio has exactly one owner, enforced in the database. The creator becomes owner, and
    leaving requires transferring ownership. The owner promotes and demotes admins.
  - Owners and admins see and edit every show in the studio. Members see the show list only.
  - Show access comes from a per-show grant with `can_write`, which covers every write for now.
  - Finer-grained permissions and access requests come after the migration.
- **Concurrency:**
  - `sessions.revision` is bumped inside every write transaction.
  - Edits are version-checked. A losing edit gets `409` with the current row, and the UI asks
    whether to overwrite. An overwrite is audited: who, what, and when.
  - A `session_leases (session_id, kind, holder, expires_at)` table, taken with a conditional
    upsert, is the only authority for recording and auto-generate. Leases have a TTL and a
    heartbeat. Realtime Presence only shows lease state and releases a lease early when its
    holder leaves.
- **Live updates:** Supabase Realtime replaces the WebSocket protocol. Whether Companion can join
  a Realtime channel is unknown. A spike decides this, and a Companion-only relay is the fallback.
  The slice 2 spike found that it can (ADR 0023, direct mode recommended for slice 9).
- **Blobs:** audio moves to Supabase Storage. Consumers that need a real file path spool the
  audio to scratch first.
- **Operations:**
  - Dev, stage and prod run only through the compose stacks; native `npm run dev` is retired.
  - Backups: a nightly `pg_dump -Fc` plus the Storage volume, shipped offsite with restic and
    restore-tested monthly. Up to 24 hours of data loss is accepted.
  - Secrets live in a shared Infisical instance, with a separate machine identity per environment.
- **Tests:** tests run against the `supabase/postgres` image (it provides `auth.uid()` and the
  `anon` and `authenticated` roles), with rollback per test. `e2e:container` is set aside during
  the migration.
- **Rollout:**
  - Slices are PRs into a `supabase-migration` branch, each under 400 lines. `main` is frozen
    for the duration.
  - Cutover is one PR into `main` with a whole-branch audit, followed by a downtime window.
  - The SQLite-to-Postgres import and parity check are rehearsed on dev against the disposable
    `server/data` copy (ADR 0022). At cutover, the owner runs them on the deploy host against
    the prod container volume.

Slice order:
1. Compose stack, migrations scaffold, backup, Infisical, dev only through compose. Split
   (owner, 2026-09-30) into:
   - 1.1 `infisical-secrets`: stack secrets from Infisical through a Node wrapper over its HTTP
     API;
   - 1.2 `supabase-compose-stack`, split (owner, 2026-09-30) into:
     - 1.2a `supabase-db`: Postgres in every stack, the `supabase/migrations/` runner, and the
       `POSTGRES_PASSWORD` generator;
     - 1.2b `supabase-services`: auth, rest, realtime and storage, plus Supabase's init SQL.
       - The gateway is Caddy with the legacy HS256 keys (`JWT_SECRET`, `ANON_KEY`,
         `SERVICE_ROLE_KEY`), on its own `127.0.0.1` port per environment. It is the only
         Supabase port.
       - The service roles get their own password, separate from the superuser's.
       - Studio and postgres-meta are deferred to a later slice (owner, 2026-09-30, after the
         panel);
   - 1.3 `postgres-backups`;
   - 1.4, run before 1.3 (owner, 2026-09-30), split into:
     - 1.4a `retire-e2e`: retire the Playwright e2e harness; the router's security cases are
       kept as `docker/scripts/test_router.sh`. **Size exception:** 1,410 counted lines,
       almost all deletions. The owner accepted this one exception to the under-400 rule;
     - 1.4b `retire-host-dev`: the server refuses to boot outside a compose stack, `DATA_DIR` is
       required and locked (one server per data directory), `server/.env` is never loaded, and
       dev docs move to the stack. LAN device testing is unavailable until a follow-up makes stage
       reachable through the upstream proxy. The single-process production topology goes to the
       follow-up `retire-single-process-prod`.

   A follow-up, `node-stack-tooling`, ports `check-envs.sh`, `compose-env.sh` and the rest of
   `make-guards.sh` to Node (the owner decided all stack tooling moves to Node). It also amends
   the "Static invariant check" tooling clause (currently docker, jq and a POSIX shell) and moves
   `test_check_envs.sh` into `node --test`.
2. Companion Realtime spike (a finding, not code). Done: ADR 0023.
3. Async storage ports, still on SQLite. Scope (owner, 2026-10-01): the catalog, key/value and
   presence ports. The session hub goes async in slice 7, when sessions move to Postgres.
   Converted top-down, because the catalog stores call each other synchronously:
   - 3a `async-session-callers`: KV and presence ports async; the session-side routers await
     the catalog; a type-checked test forbids dropped or misused promises in `server/src`;
   - 3b `async-catalog-callers`: the teams, admin, profile, shows and auth callers await the
     catalog. Code that runs inside a catalog transaction (the Google sign-up body and the teams
     last-admin guard with its `mutate` callbacks) stays synchronous until 3d converts it, and
     the memory-only registry getters stay synchronous for good;
   - 3c `async-catalog-adapter`: the `AsyncCatalogDb` port and its SQLite adapter (one FIFO lock
     per connection, a transaction-scoped handle, a nested `tx` joins the enclosing transaction,
     any error fails the whole transaction, a 10-second deadline, misuse rejects). `KvStore`
     moved onto it, so KV waits for an open transaction instead of joining it;
   - 3d `async-catalog-stores`: the five stores run on the adapter (`CatalogFacade.tx` binds a
     body's stores to the transaction; store transactions join it), and the synchronous port is
     deleted. Owner decisions (2026-10-01):
     - one atomic PR with the `size-override` label (about 650-750 counted lines);
     - the OAuth state is consumed with `KvStore.take` (one `DELETE … RETURNING`);
     - test seed helpers become async and call the real stores (reversing the slice 3
       decision, since slice 4's async-only driver forces it).

     A failed `ROLLBACK` stops the server with exit code 1. The adapter `close()` is deferred to
     slice 4. Slice 3 is done.

   **Slice 4 hazards** (async-session-callers design D6, async-catalog-callers design D6,
   async-catalog-stores design A7). These stay latent through slice 3. The SQLite adapter yields
   only microtasks, so in a running server a request's chain of catalog awaits still finishes
   before another request's I/O callback runs (measured in 3d: 0 interleavings across 200
   concurrent HTTP requests). They go live with slice 4's real I/O. The concurrency tests that
   force interleaving (same tick, or a held transaction) guard that future, not today's
   behaviour.
   1. ~~the OAuth state get-then-delete needs an atomic take~~ Done in 3d (`KvStore.take`);
   2. the Companion ack's read-modify-write needs one conditional update;
   3. projection mirror writes can land out of order (guard on `events_stream_revision`);
   4. re-audit the events generate `finally` (release, then mirror; still safe while the adapter
      yields only microtasks);
   5. sessions' active-show read-then-write and show-check-then-create need transactions or
      constraints;
   6. the log-import job uses the request's catalog handle inside a detached job;
   7. never hold a session hub across an await;
   8. every `requireTeamAdmin` gate reads the role outside the transaction that then writes, so a
      demoted admin's in-flight request still completes (re-check inside the transaction, or
      RLS in slice 6);
   9. team creation counts the cap, then creates the studio, then adds the admin membership, with
      no transaction (one transaction, cap re-checked inside);
   10. the pending-invite cap is count-then-upsert (a transaction or a constraint);
   11. a role promotion reads the current role, then writes (a conditional update);
   12. member removal checks existence outside the guarded transaction (move it inside);
   13. team delete versus show create: 3d moved the delete's show count inside its transaction;
       show create still checks the studio, then creates (a transaction or a foreign key);
   14. the registry getters need `init()` first, and the snapshot goes stale across awaits within
       one request (refresh after writes, or read names in the response query);
   15. concurrent first Google sign-ins with one `sub` hit the unique constraint as a 500. Under
       the transaction contract (any error fails the transaction) the remedy must run outside the
       transaction (catch the conflict, then retry the lookup) or use
       `INSERT … ON CONFLICT DO NOTHING`;
   16. `/auth/google/start` writes one KV row per hit, and expired rows are purged only at boot or
       on read, so a flood grows the `kv` table until restart (a periodic purge or a rate limit).
4. Catalog schema and the postgres.js adapter. Split (owner, 2026-10-01) into:
   - 4a `catalog-pg-schema`:
     - the catalog in Postgres schema `catalog` (not `public`, which the image grants to the API
       roles), as a faithful port: text timestamps, 0/1 flags, JSON text, `bigint` integers,
       `COLLATE "C"`;
     - the least-privilege role `autologger_app` (DML only, 20 connections, timeouts), whose
       password `APP_DB_PASSWORD` the migrations runner sets with logging and
       `pg_stat_statements` off;
     - the app's path: a two-member `catalog` network (`db` and the app). Owner, after the
       panel: the shared `db` network would have let the Supabase services reach the app;
     - tests against the pinned image, with a database cloned from a template per test. That
       replaces "rollback per test" above (owner decision), because the code under test opens
       its own transactions;
   - 4b `postgres-catalog-adapter`: postgres.js behind `CatalogDb`. Every `tx` is `SERIALIZABLE`
     and retried on serialization failure or deadlock, at most 3 tries (owner). int8 is parsed
     to a number;
   - 4c `catalog-on-postgres`: the wiring. Its open items from 4a:
     - text containing a NUL byte (Postgres refuses it): 400 or strip;
     - `ORDER BY … COLLATE NOCASE` has no Postgres equivalent;
     - an async `close()`;
     - the boot order (migrate before the app) and password rotation (migrate, then recreate
       the app);
   - 4d `catalog-concurrency-hazards`: the hazards listed under slice 3. The owner may swap 4c
     and 4d;
   - 4e `retire-sqlite-catalog`.

   Follow-ups:
   - after the migration, revisit a typed catalog schema (`timestamptz`, `jsonb`, `boolean`)
     (owner, 2026-10-01);
   - `docker/supabase/init/roles.sql` may leave `SUPABASE_ROLES_PASSWORD` in
     `pg_stat_statements` and the DDL log at init.
5. Supabase Auth, the bootstrap owner, anonymous mode removed.
6. RLS for the permission model above.
7. Session tables, revision, version checks and the audited overwrite.
8. Session leases.
9. Realtime replaces the WebSocket protocol.
10. Blobs to Supabase Storage.
11. The import script, parity check, cutover runbook and rollback plan.

## Evidence

- `packages/ports/src/catalogDb.ts` and `packages/session-core/src/SessionHub.ts` document the
  synchronous invariants this reverses.
- `packages/catalog/migrations/0004_team_roles_and_invites.sql` has only `admin` and `member`
  roles and studio-level invites. `owner` and per-show grants are new.
- The owner's answers in the 2026-09-30 migration interview.
- ADR 0022: `server/data` is a disposable copy, usable for rehearsals and for timing
  auto-generate runs to set the lease TTL.

## Consequences

- Every slice is tier 2 (contracts, auth, concurrency, migrations).
- The HTTP/WS contract changes: auth endpoints, WebSocket replaced by Realtime, and new `409`
  conflicts. Each change needs a delta amending `api-contract-freeze`.
- The dev loop gains roughly 10 containers per stack. Offline native dev goes away.
- Self-hosting makes backups, upgrades and secret rotation the owner's job.
- Main is frozen until cutover, and the only prod feedback comes at cutover.
- Revisit if:
  - the Companion spike fails and a relay would keep the old WebSocket protocol alive anyway; or
  - measured write latency hurts live recording.
