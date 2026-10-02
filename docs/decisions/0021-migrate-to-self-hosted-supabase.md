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
  - Slices are PRs into a `supabase-migration` branch (no line limit since ADR 0024). `main` is frozen
    for the duration. One exception so far (owner, 2026-10-02): the security hotfix
    `gate-decoded-path` (PR #32). The login gate judged the raw path while Hono routed the
    decoded one, so `/%61pi/...` skipped login. It merged into `main` first (prod not deployed),
    then into this branch.
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
       on read, so a flood grows the `kv` table until restart (a periodic purge or a rate limit);
   17. handlers commit to the session hub, then mirror into the catalog; a failed mirror write
       now returns 500 for work already saved, and a client retry repeats it (Companion toggle,
       log events, youtube anchor). Catch and log after the hub commit, or re-derive (4c panel;
       owner: 4d);
   18. team ids are reusable and memberships/invites have no foreign key to the team, so a delete
       racing an invite can leave rows that a later team with the same id inherits (a foreign
       key with cascade, or a purge on create) (4c panel; owner: 4d);
   19. root (non-transaction) statements have no client-side deadline, so a paused db stalls
       every request up to the role's 30 s `statement_timeout` (4c panel);
   20. `getStudioSettingsBlob` writes a default while reading, inside SERIALIZABLE; concurrent
       first loads on an empty catalog conflict and can exhaust the retries (4c panel). Jittered
       backoff (`catalog-retry-backoff`) makes that rarer.

   Since 4c these hazards are live on dev and stage (real I/O); prod is on hold until cutover.
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
     and retried on serialization failure or deadlock, at most 5 runs with a full-jitter backoff
     below 20 × 2^(n−1) ms (owner, 2026-10-02, `catalog-retry-backoff`; first 3 tries, no wait). int8 is parsed
     to a number. It also delivers an async `close()`. Transactions run on single-connection
     clients the adapter manages, because postgres.js 3.4.9's `reserve()` and `begin()` crash the
     process after a lost connection (4b design A5-A7). A `COMMIT` with no reply raises
     `CatalogCommitUnknownError`;
   - 4c `catalog-on-postgres`: the wiring. Done (2026-10-01):
     - the server's catalog stores and `KvStore` share one `PostgresCatalogDb` built from the
       compose `PG*` env; no SQLite catalog is opened or migrated, and `onBroken` is gone;
     - the 16 `tx` bodies are audited as database-only, so a retry is safe;
     - NUL (owner, after the panel): one rule, 400 for any NUL that reaches a catalog statement;
       presence refuses a NUL `session_id`; the OAuth state with NUL is `state_invalid`; NUL in
       the Google `sub` or `email` is `token_invalid`, and name/picture claims are stripped;
     - `ORDER BY lower(name), name` replaces `COLLATE NOCASE`; `ON CONFLICT DO NOTHING` replaces
       `INSERT OR IGNORE`; no store uses `SUM`/`AVG`;
     - `CatalogCommitUnknownError` reaches the generic 500; that handler now logs a Postgres
       error by code, constraint and table only;
     - `start_offset_frames` is capped at `Number.MAX_SAFE_INTEGER` (422);
     - boot: `migrate` runs before the app in `make dev-up`/`stage-up`; the server waits up to
       30 s for the catalog, then exits 1; rotation is `make <env>-up` after the Infisical change;
     - start empty (owner, 2026-10-01): dev and stage begin with only the migration's seed shows;
       the old `catalog.db` and `sessions/*.db` stay untouched for the slice 11 import;
     - the server integration suite runs on a Postgres clone per test;
   - 4d `catalog-concurrency-hazards`: the hazards listed under slice 3. Done (2026-10-01), as one
     PR over the size budget (owner: `size-override`, every task in this PR):
     - #2: the Companion ack marks its command with one compare-and-set (`KvStore.replaceIf`);
     - #3, #4, #17: one ordered mirror writer per session (`ports.mirror`), which re-reads the hub
       when it writes and only warns on failure (owner: log and succeed). Local and YouTube imports
       now mirror, and the YouTube episode date is best-effort;
     - #5: the active-show repair is conditional; the anonymous profile writes in one transaction;
     - #6: the log-import job builds its own catalog, and its lines hide catalog and driver error
       text only;
     - #7: verified, no route holds a hub across an await; no change;
     - #8-#12, #18: each team admin write re-checks the caller's role with `FOR SHARE` inside its
       transaction. Create is one transaction that refuses an id with shows and purges leftover
       memberships, invites and settings (both planes). Role changes update existing rows only,
       and a raced removal gives 404. The admin plane stays outside last-admin protection, by
       spec (re-panel);
     - #13, and the gate half of #14: show create and the admin membership add check the team
       inside their transaction. Registry display names can still go stale across awaits
       (accepted, revisit below);
     - #15: concurrent first sign-ins for one sub both succeed (`ON CONFLICT DO NOTHING`, then the
       existing-user path);
     - #16: expired KV rows are purged every 10 minutes as well as at boot;
     - #19: root statements have a 5 s client deadline. One statement per root connection; an
       unsent one is withdrawn, a sent one is never cancelled and may still apply;
     - #20: settings defaults are written without a transaction (`ON CONFLICT DO NOTHING`, a
       compare-and-set repair), never for a team that no longer exists;
     - per-team indexes on `user_studio_memberships (studio_id)` and `shows (studio_id)` (owner,
       after the panel), mirrored in SQLite `0006` for schema parity (both retired in 4e). On small
       tables SERIALIZABLE still tracks reads by page, so writes in different teams can retry
       once.
   - 4e `retire-sqlite-catalog`. Done (2026-10-01), as one PR over the size budget (owner:
     `size-override`; about 600 counted lines, mostly deletions):
     - the SQLite catalog adapter, its migrator, the six SQLite migrations and their tests are
       deleted; the catalog has one implementation, on Postgres. `better-sqlite3` stays for the
       per-session databases (until slice 7) and the `DATA_DIR` lock;
     - the old SQL is kept in git: `c783b99` has 0001-0006 and `main` has 0001-0005 (owner:
       delete, history keeps it). 0006 (indexes only) never reached prod;
     - prod's legacy `catalog.db` was built by `main`, so its `_migrations` is expected to be
       exactly 0001-0005. Nothing in the repo confirms it. The slice 11 import must refuse a
       source whose `_migrations` set differs (a file below 0005 lacks the 0004 admin backfill and
       the 0005 `title_suffix` backfill), and must copy every column explicitly, so Postgres's
       `title_suffix` default `'date'` never replaces a backfilled `'episode'`;
     - the Postgres-versus-SQLite parity test became a recorded expectation of the catalog
       schema (full foreign keys and index definitions, seed shows), captured while parity still
       passed; a schema migration updates it in the same change;
     - the KvStore tests run on Postgres, including a new case for "a key/value call never joins
       a catalog transaction";
     - the dev mount and its env check, and the `api` image copy of the migrations, are gone.

   Follow-ups:
   - after the migration, revisit a typed catalog schema (`timestamptz`, `jsonb`, `boolean`)
     (owner, 2026-10-01);
   - **Revisit after the migration** (4d alternatives not taken, owner 2026-10-01):
     - `503` + `Retry-After` for timeouts and exhausted retries, instead of the generic `500`;
     - foreign keys from memberships, invites and shows to `studio_definitions` (built-ins seeded
       as rows, `23503` mapped), instead of in-transaction re-checks and the create purge;
     - a `live_revision` column with a hub counter, instead of the in-process mirror chain
       (needed once slice 8 runs several processes);
     - reconcile-on-read, or a retried dirty set, instead of log-and-succeed for mirror failures;
     - a rate limit on `/auth/google/start` and on team writes, instead of the periodic purge
       alone (a sustained flood can still exhaust SERIALIZABLE retries, and with 5 runs a
       contended request can do up to 5/3 the database work);
     - the 5 s root deadline's value, and a distinct timeout for root writes;
     - registry display names that go stale across awaits (#14);
     - an email-indexed user lookup, so an invite doesn't read all of `users`;
     - stale SQLite wording in the frozen `api-contract-freeze` spec: `SQLITE_FULL` as the example
       commit failure, and "the SQLite column `shows.next_episode`" (4e panel);
     - ~~two concurrent session creates for one show exhaust the SERIALIZABLE retries under
       load~~ resolved by `catalog-retry-backoff` (2026-10-02): lockstep re-runs exhausted 60/150
       transactions at 5 writers; jitter with 5 runs measured 0/240 at 8 writers;
     - (5a) a foreign key from `catalog.users` to `auth.users`;
     - (5a) an egress allowlist for GoTrue: `auth-egress` reaches the internet, the LAN and the
       host's bridge address, while GoTrue holds `JWT_SECRET` and its database password;
     - (5a) a sign-up allowlist and a per-user rate limit on the id_token grant (GoTrue limits
       `/token` per IP, and every exchange comes from the app's address);
     - (5a, slice 9) revoking the unused GoTrue sessions each sign-in leaves, and GoTrue's email
       linking of two *verified* Google accounts that share an address (the catalog refuses it,
       but GoTrue would merge them; consider manual linking);
     - (5a, slice 6) RLS must grant nothing to a bare `authenticated` role, since any Google
       user can hold one;
     - (5a) a service on a two-member app network (`db` on `catalog`, `auth` on `auth-app`) can
       reach the stage/prod `api` port;
   - `docker/supabase/init/roles.sql` may leave `SUPABASE_ROLES_PASSWORD` in
     `pg_stat_statements` and the DDL log at init.
5. Supabase Auth, the bootstrap owner, anonymous mode removed. Split (owner, 2026-10-02) into:
   - 5a `gotrue-sign-in`: GoTrue becomes the identity of record. Done (2026-10-02). Owner
     decisions:
     - **server bridge:** the browser flow, routes, cookie and Google redirect URI are unchanged;
       after verifying Google's ID token the server exchanges it with GoTrue's id_token grant
       (`http://auth:9999`, over a new two-member `auth-app` network; no Supabase key in the app),
       and the GoTrue user id becomes the catalog user's id. This reverses "supabase-js on the
       server is for Auth admin" above: the app holds no service-role key;
     - **verified emails only:** an ID token without `email_verified: true` gets
       `login_error=email_unverified` before GoTrue is called; GoTrue's auto-confirm stays off,
       so its email-based account linking acts only on verified addresses. The exchange also
       requires exactly one Google identity with the verified subject, and any id mismatch with
       the catalog gets `login_error=identity_unavailable` (the panel's critical finding);
     - GoTrue's tokens are discarded, not revoked; Companion keeps `API_TOKEN` (its device
       credential is slice 9's);
     - GoTrue gets egress over a new `auth-egress` network that only it joins; Google is its only
       provider; `GOOGLE_CLIENT_ID` (public) is required on stage and prod;
     - existing users, memberships, prefs, invites and login sessions are deleted (migration
       `20261003000000`). **Binding on slice 11:** the import must not bring back users,
       memberships, prefs, invites or `session:` KV rows (or must re-key them through GoTrue),
       and its parity check expects those tables empty;
   - 5b `require-login`: login is always required; `REQUIRE_LOGIN` and the anonymous branches
     are removed. Implemented 2026-10-02; live checks pending (the owner's dev Google client and
     `API_TOKEN`, then the dev and stage checks). Owner decisions:
     - **dev gets a real Google client** (redirect `http://localhost:8787/auth/google/callback`)
       and an `API_TOKEN` in Infisical `autologger-dev`; without the token the dev Companion
       gets `401`. `compose-run` refuses every stack, dev included, without both Google values;
     - **boot refuses** when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `PUBLIC_BASE_URL` is
       blank, and when `REQUIRE_LOGIN` is set to any value, so a stale `0` fails loudly;
     - **the open-network `503`s are deleted** (AI chat, AI v2, topic generation, event
       generation, YouTube import, Sheets log import): they fired only with login off.
       `HEAD /api/profile` is login-exempt like `GET`;
     - one PR with the `size-override` label (about 550-650 counted lines, mostly deletions);
     - the test harness signs in a narrowed default member (built-in studios and seeded
       sessions only), and a route-table test expects `401` from every non-exempt `/api` route.

     It builds on the hotfix `gate-decoded-path` (the gate judges the decoded path; a repo test
     now bans raw-path security decisions in middleware and routers). Moving every integration
     test onto the signed-in path exposed `40001` retry exhaustion in concurrent session creates,
     which triggered `catalog-retry-backoff`. Cutover and rollback:
     - the new image run with `main`'s compose (`REQUIRE_LOGIN: "1"`) refuses to boot and
       crash-loops under `restart: unless-stopped`. That fails closed but is an outage, so the
       cutover deploys the integration branch's compose with its image;
     - rolling back to the old image with the new compose is safe: the old server treats an
       unset `REQUIRE_LOGIN` as login required;
     - prod's `api` must not have `REQUIRE_LOGIN` set by hand (Infisical can't inject it).
   - 5c `owner-bootstrap`: the `owner` role (one per studio, in the database), the bootstrap
     owner (`BOOTSTRAP_OWNER_EMAIL`: that verified email becomes owner of every studio without
     one, at sign-in), and dropping the built-in studios.
6. RLS for the permission model above.
7. Session tables, revision, version checks and the audited overwrite.
8. Session leases.
9. Realtime replaces the WebSocket protocol.
10. Blobs to Supabase Storage.
11. The import script, parity check, cutover runbook and rollback plan. It must not import users,
    memberships, prefs, invites or login sessions (slice 5a above).

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
