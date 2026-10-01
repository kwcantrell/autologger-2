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
     - 1.2b `supabase-services`: auth, rest, realtime, storage, meta and Studio, plus Supabase's
       init SQL. The gateway is Caddy with the legacy HS256 keys (`JWT_SECRET`, `ANON_KEY`,
       `SERVICE_ROLE_KEY`). The gateway and Studio each get their own `127.0.0.1` port per
       environment;
   - 1.3 `postgres-backups`;
   - 1.4 `retire-host-dev`.

   A follow-up, `node-stack-tooling`, ports `check-envs.sh`, `compose-env.sh` and the rest of
   `make-guards.sh` to Node (the owner decided all stack tooling moves to Node). It also amends
   the "Static invariant check" tooling clause (currently docker, jq and a POSIX shell) and moves
   `test_check_envs.sh` into `node --test`.
2. Companion Realtime spike (a finding, not code).
3. Async storage ports, still on SQLite.
4. Catalog schema and the postgres.js adapter.
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
