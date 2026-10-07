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
  transaction, runs `set_config('role', 'catalog_user' | 'catalog_system', true)` and
  `set_config('app.user_id', …, true)` (slice 6b-1), so RLS applies to server traffic and
  transactions still work. The `authenticated` role gets nothing in the catalog. supabase-js on the
  server is for Auth admin, Storage and Realtime only.
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
  **Amended by slice 9a (owner, 2026-10-07):** the WebSocket protocol stays. A Postgres `NOTIFY`
  bridge (the session frame bus) carries every frame to every server process, so the server can
  run as several processes with the web and the Companion unchanged. Replacing the WebSocket with
  Realtime is deferred, not planned.
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
   - 1.3 `postgres-backups`. Not built yet, and a **cutover blocker** (owner, 2026-10-03): from
     slice 7b-1 session content lives in Postgres too, and nothing backs it up. It is done as its
     own change before slice 11;
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
   7. ~~never hold a session hub across an await~~ Replaced in 7a by the rule below
      (async-session-hub design D6): a handler may hold a hub across that hub's own calls, and
      re-resolves it after a long non-hub `await`;
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
     - ~~a `live_revision` column with a hub counter, instead of the in-process mirror chain
       (needed once slice 8 runs several processes)~~ resolved by 7b-1: the projection commits
       with the session write;
     - ~~reconcile-on-read, or a retried dirty set, instead of log-and-succeed for mirror
       failures~~ resolved by 7b-1: a projection failure fails the write;
     - a rate limit on `/auth/google/start`, on team writes and on session writes, instead of the
       periodic purge alone (a sustained flood can still exhaust SERIALIZABLE retries, and with 5
       runs a contended request can do up to 5/3 the database work; one member can fill the
       4-connection session pool and slow every session's calls to the 10-second deadline, 7b-1);
     - the 5 s root deadline's value, and a distinct timeout for root writes;
     - registry display names that go stale across awaits (#14);
     - an email-indexed user lookup, so an invite doesn't read all of `users`;
     - stale SQLite wording in the frozen `api-contract-freeze` spec: ~~`SQLITE_FULL` as the
       example commit failure~~ (replaced at the 7b-1 archive), and "the SQLite column
       `shows.next_episode`" (4e panel);
     - ~~two concurrent session creates for one show exhaust the SERIALIZABLE retries under
       load~~ resolved by `catalog-retry-backoff` (2026-10-02): lockstep re-runs exhausted 60/150
       transactions at 5 writers; jitter with 5 runs measured 0/240 at 8 writers;
     - the Postgres session adapter's fixed per-transaction overhead (about 2.2 ms for an empty
       locked transaction against about 0.4 ms for a hand-written 9-round-trip one; root
       statements about 0.4 ms against 0.03 ms raw): profile and optimise it; it also lengthens
       how long a session call holds a pool slot (the 7b-1 panel's saturation risk) (owner,
       2026-10-03);
     - the 7b-2 user-bound session path (median `addEvent` 11.9-15.5 ms against 7b-1's 5.3-5.4 ms,
       above the 10 ms stop rule, accepted by the owner 2026-10-03): investigate once database-side
       observability exists (per-statement timings, plans), not before. Since 7c-1 (owner,
       2026-10-06) no slice has a latency stop rule: latency changes are measured and recorded, and
       accepted until observability exists after the migration;
     - (7c-1, owner 2026-10-06) the storage test "8 contending read-modify-write transactions all
       commit" fails intermittently: about 0.5% of eight same-row `SERIALIZABLE` writers exhaust
       five runs (41/7,200 on the current code, 33/7,200 at the retry-backoff merge, so not a
       regression of the role or policy slices); revisit the retry budget with observability;
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
   - 5c `owner-bootstrap`: the `owner` role, the bootstrap owner and the built-in studios as
     data. Implemented 2026-10-02 on `supabase-5c-owner-bootstrap`; verification, merge and the
     live dev and stage checks are pending (the owner sets `BOOTSTRAP_OWNER_EMAIL` first). Owner
     decisions (owner, 2026-10-02):
     - **one change;**
     - **the built-ins become real teams:** a migration (`20261004000000`) inserts
       `studio_definitions` rows for `test-studios` and `test-studio-2` with the same ids and
       names, so their shows, sessions and settings survive; they start with no owner. Every
       built-in constant, `DEFAULT_STUDIO_ID` and both global active team/show defaults go;
     - **the owner anchors the team:** the owner can't leave, be removed or be demoted
       (`409 Transfer ownership first.`); only the owner changes roles, removes admins and
       deletes the team; admins keep rename, invites and removing members. Last-admin protection
       is retired;
     - **transfer:** `POST /api/teams/:id/owner {user_id}` makes an existing member owner and the
       old owner admin in one transaction; the support plane's membership upsert also accepts
       `role: "owner"` and demotes the current owner to admin in the same transaction;
     - **`BOOTSTRAP_OWNER_EMAIL` is required in every stack:** boot and `compose-run` refuse a
       blank value, and boot also refuses a non-ASCII one and logs a masked form (domain and a
       short hash);
     - **the bootstrap owner claims every ownerless team** at each sign-in whose verified email
       matches it exactly in ASCII (trimmed, `A`-`Z` folded, any non-ASCII character refused);
       existing admins stay admins, no migration promotes anyone, and a failed claim is logged
       and the sign-in still succeeds.

     After the adversarial panel (owner, 2026-10-02):
     - **A. takeover accepted:** on dev and stage the bootstrap owner's first sign-in claims every
       ownerless team, including teams other users created after 5a (stage: `my-crew2`,
       `my-studio`, `my-crew`); each claimed team id is logged;
     - **B.** `enabled_admin_count` keeps its meaning (enabled `admin` rows only; the owner is not
       counted, so a new team reports `0`); the web no longer reads it;
     - **C.** a role-less support upsert never demotes the owner (`409 Explicit role required to
       change the team owner.`); an explicit `admin`/`member` upsert or a membership delete still
       applies and leaves the team ownerless until the bootstrap claim;
     - **D.** transfer returns `200 {ok: true}`; a disabled target gets `400`, a non-member `404`,
       and a self-transfer is `200` with no change.

     This refines the permission model above: "exactly one owner, enforced in the database"
     becomes **at most one owner in the database** (a check constraint on the role and a partial
     unique index on `(studio_id) where role = 'owner'`), with "exactly one" kept by the
     application for teams that have an owner. Ownerless teams are legal: the former built-ins
     before the claim, teams the admin plane creates, and teams whose owner support removed. And
     "the built-in studios are dropped" becomes **the built-ins are ordinary teams**: the
     `builtin` field stays in the admin plane's frozen shapes, always `false`. Cutover: prod's
     catalog is created at cutover, so the teams start ownerless and the first bootstrap sign-in
     claims them; the image refuses to boot without `BOOTSTRAP_OWNER_EMAIL`, so **prod's
     Infisical needs `BOOTSTRAP_OWNER_EMAIL` before the first deploy of this image**, and the
     owner of `test-studios` is checked right after the first prod sign-in.
6. RLS for the permission model above. Split (owner, 2026-10-02) so the rule lands in the app
   first and Postgres mirrors it next:
   - 6a `show-grants`: the permission model in the app. Implemented 2026-10-02 on
     `supabase-6a-show-grants`; verification, merge and the live dev and stage checks are
     pending. Owner decisions (owner, 2026-10-02):
     1. **split 6a / 6b:** 6a is the permission model in the app, 6b `catalog-rls` is Postgres
        row-level security that mirrors it;
     2. **6b uses a dedicated NOLOGIN catalog role** that only `autologger_app` can `SET ROLE`
        to; the bare `authenticated` role gets nothing and the catalog stays invisible to
        PostgREST (recorded here, applied in 6b);
     3. **member view:** a member without a grant sees the show list and each show's session list
        (titles) but can't open a session (masked `404`, like a non-member); only owners and
        admins create shows and change team or show settings (`403`);
     4. **a grant means full access:** a `(user, show)` row gives full session access in that
        show (open, record, edit, create sessions, imports); `can_write` is stored and always
        true for now, and the web gets no read-only mode;
     5. **owners and admins manage grants on the team page**, through
        `PUT|DELETE /api/teams/:id/shows/:showId/grants/:userId`; a member's grants are deleted
        when they leave or are removed, or the show is deleted;
     6. **Companion:** posting presence requires access to that session; the other Companion
        routes keep acting as a system caller on the session its presence holder can access; a
        real device credential comes in slice 9.

     After the adversarial panel (owner, 2026-10-02):
     - **E. open WebSockets close when access is lost:** a revoke, a removal or leave, or a
       demotion to member closes that user's sockets on the affected sessions (close code
       `4403`) after the write commits, in this process; the reconnect gets the masked `404`;
     - **F. imports re-check access:** the log-import job before each sheet (it stops with
       `Access revoked; stopping.`, and events already written stay), the YouTube import once
       after its download and before any write;
     - **G. the session list for a caller without access** keeps its shape but carries titles
       and dates only (content and live-state fields blanked);
     - **H. cuts:** no `GET …/grants` route; `can_access` is on profile `shows[]` only, not on
       the `/api/shows` routes.

     This refines the permission model above: "Members see the show list only" becomes
     **members see the show list and each show's session titles**, without content (design
     OQ9). And "a per-show grant with `can_write`" stores `can_write` as a 0/1 flag
     (`bigint not null default 1`), like the catalog's other flags until the typed-schema
     follow-up (design OQ7). Cutover: prod's catalog is created at cutover with no grants, so
     **members start with no show access**; the owner grants shows after the slice 11 import.
     Owners and admins keep every show. **Follow-up for slices 8/9:** 6a closes sockets only in
     the one server process. With several processes (slice 8's leases) or Realtime (slice 9),
     drive the close from the database: a row trigger with `pg_notify` and a `LISTEN`ing server,
     or Realtime RLS authorization. Spike first how promptly Realtime re-checks policies on a channel a client
     has already joined. **Resolved by slice 9a:** the close is published on the session frame bus
     inside the revoking transaction, so every process closes the sockets, and a revoke whose
     close cannot be published fails and changes nothing; no trigger and no Realtime.
   - 6b-1 `catalog-roles`: every catalog statement runs as a user or a named system task, with
     row-level security on and policies that allow everything, so behaviour does not change.
     Implemented 2026-10-02 on `supabase-6b1-catalog-roles`. Owner decisions (owner, 2026-10-02):
     1. **split 6b in two:** 6b-1 is the plumbing with allow-all policies; 6b-2
        `catalog-policies` adds the real policies;
     2. **a system path through a second role:** a NOLOGIN `catalog_system` role, reached only
        through an explicit `system('<reason>')` handle; a repo test lists every caller against an
        allowlist; `autologger_app` keeps no table grants, so a path that forgets to bind fails
        closed;
     3. **policy strictness (6b-2):** reads at team level, writes at access level; the 6a app gates
        stay as the precise check;
     4. **a dedicated NOLOGIN user role** (`catalog_user`, decided in 6a), not `authenticated`;
        the bare `authenticated` role gets nothing and the catalog stays invisible to PostgREST.

     After the adversarial panel (owner, 2026-10-02):
     - **A. rollback is documented SQL, not a file** (below), with the migration's history row
       deleted so a later deploy re-applies it;
     - **B. performance is a concurrency probe, not retry counting:** N = 20 parallel signed-in
       request mixes against one adapter, root-call p95 and root timeouts before and after the
       bindings; pipelining `BEGIN`, the preamble and the statement (and `COMMIT` at the root) is
       mandatory; stop and ask if root p95 more than doubles or any root timeout appears;
     - **C. no database-side trace of the system reason in 6b-1** (follow-up below);
     - **D. `postgres`'s automatic admin membership** in the two roles stays (follow-up below).

     Approver confirmations (design, confirmed at approval): a statement outside a transaction
     runs as a short `READ COMMITTED` transaction on adapter-owned single-connection root clients
     (never postgres.js `reserve()`), keeps the root rules (no retry, 5 s deadline, no cancel once
     sent, "may still apply") and resolves only after its `COMMIT` is confirmed; a `42501` maps to
     the generic `500` in this slice; key/value runs on one system binding, `kv`; team creation
     and team invites run entirely as system; the anonymous profile needs no system binding; the
     4a migration's role guard is edited in place.

     What it does: two NOLOGIN roles `catalog_user` and `catalog_system`, granted to
     `autologger_app` `with inherit false, set true`; `autologger_app` keeps only `USAGE` on schema
     `catalog`; the helper `catalog.app_user_id()`; RLS on every catalog table with
     `<table>_user_all` and `<table>_system_all` allow-all policies. The adapter hands out
     `bindUser(id)` / `bindSystem(reason)` handles; each transaction (and each retry) sends
     `select set_config('role', $1, true), set_config('app.user_id', $2, true)` pipelined with
     `BEGIN`. The auth middleware resolves the caller as `system:auth-resolve` and hands routes a
     user-bound catalog, or an unbound one that refuses every statement. The system reasons are
     `auth-resolve`, `kv`, `session-mirror`, `boot-wait`, `log-import-job`, `oauth-callback`,
     `bootstrap-claim`, `support-plane`, `companion-token`, `access-loss-check`, `team-invite`
     and `team-create`.

     **The edited 4a guard.** Roles are cluster-wide, so when the migrations run in a second
     database of a cluster (the `pg` test setup migrates `postgres` and then
     `autologger_template`), `autologger_app` already holds the two memberships and 4a's old
     "no membership" check failed. 4a's guard is relaxed in place to "no membership other than
     `catalog_user` or `catalog_system`, set only, no inherit, no admin option". `migrate.sh`
     never re-runs an applied file, so dev and stage keep the old recorded text.

     **Rollback** (owner decision A). Run as `postgres` in one transaction
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
     `create or replace`, and the policies were dropped). The two NOLOGIN roles and their grants
     stay; they are harmless without members.

     Implementation notes (2026-10-02):
     - the adapter's `rootSettleMs` constructor option (default 46 s) is design D5's bound on a
       timed-out root call's background wait (30 s `statement_timeout` + 15 s
       `idle_in_transaction_session_timeout` + a grace), made configurable for tests;
     - a `SERIALIZABLE` transaction's snapshot is now taken by the role preamble right after
       `BEGIN` (design D4), not by the body's first statement; this changed the expectation of the
       `gatedCatalog.int` self-test (a statement held before it is sent no longer sees a row
       committed while it waits);
     - the test-only `POST /api/admin/__unbound` route exists only in test files
       (`middleware/catalogBinding.int.test.ts`); production has no such route;
     - groups 4 and 5 of the task list landed together (owner, 2026-10-02), because the unbound
       facade breaks the server until the wiring binds it.

     Follow-ups:
     - **post-migration database-side logging and auditing** (owner decision C): the system
       reason and the user visible in `pg_stat_activity` and the database log;
     - **the reach of `postgres`** (owner decision D): `postgres` owns the catalog tables with
       `BYPASSRLS`, reads every table through `pg_read_all_data`, and holds an automatic admin
       membership in `catalog_user` and `catalog_system` because it created them; that reach,
       held by `db`, `migrate` and realtime, is out of slice 6's scope.
   - 6b-2 `catalog-policies`: row-level security enforces the team permission model for
     `catalog_user`, so the database is a backstop behind the 6a app gates. Implemented
     2026-10-03 on `supabase-6b2-catalog-policies` (migration
     `20261007000000_catalog_policies.sql`). Owner decisions (owner, 2026-10-02 and 2026-10-03):
     1. **policy shape** (2026-10-03): reads are team-level; content writes are access-level (a
        show, a session or a team's settings needs owner or admin, or a grant on that show); the
        team-management tables (memberships, invites, grants, the team row) accept writes from
        members of that team only, and the app's in-transaction role checks keep the owner/admin
        precision;
     2. **settings reads have no side effects** (2026-10-03): a missing or corrupt blob reads as
        the default and nothing is written; team creation seeds the row, and saving writes it;
     3. **the 12 system reasons stay system** (2026-10-03; table below);
     4. **earlier decisions stand** (2026-10-02): `catalog_system` keeps its allow-all policies;
        the helpers are `SECURITY DEFINER` with `EXECUTE` revoked from `PUBLIC`; an allow/deny
        matrix test; the `40001` retry measurement; `CatalogForbiddenError` maps to each route's
        existing status.

     After the adversarial panel (owner, 2026-10-03):
     - **A. cross-team contention: accept retries.** Policy reads add `SERIALIZABLE` predicate
       locks, so a transaction in one team may abort with `40001` because of one in another team;
       the adapter retries it, and no such abort reaches HTTP while the retry budget (5 runs)
       holds. Stop rule: the retry rate (retries per transaction call) more than doubles against
       6b-1, or any call exhausts its retries, in the integration runs, the contention test or the
       probe;
     - **B. team-management inserts are system-only:** `catalog_user` has no `INSERT` policy and
       no `INSERT` privilege on `user_studio_memberships` and `team_invites`; only `team-create`,
       `team-invite`, `oauth-callback`, `bootstrap-claim` and `support-plane` add them.

     Approver confirmations (proposal "For the approver", confirmed at approval): seven helpers,
     not three; `POST /api/shows` keeps its in-transaction existence read with a
     `catalog.studio_exists` fallback (so a team deleted mid-create stays `400`); a one-time
     migration backfill of team settings; the team delete removes memberships last; race-only
     writes keep existing statuses (an `api-contract-freeze` delta records them); `kv` is closed
     to `catalog_user`; `set enable_seqscan = off` on every helper.

     What it does:
     - **7 helpers** in schema `catalog`, owned by `postgres`, each `language sql stable security
       definer set search_path = pg_catalog, pg_temp set enable_seqscan = off`, schema-qualified,
       `EXECUTE` revoked from `PUBLIC` and granted to `catalog_user` only: `member_studios(uid)`,
       `manager_studios(uid)`, `accessible_shows(uid)`, `member_shows(uid)`, `co_members(uid)`,
       `studio_exists(id)`, `show_exists(id)`. **Why `enable_seqscan = off` is kept:** the
       catalog's tables are small in prod too, so the planner prefers sequential scans, and under
       `SERIALIZABLE` a sequential scan takes a relation-level predicate lock; inside the helper
       the setting keeps the locks at page or tuple level (written as plain policy subqueries,
       the `sessions`, `show_grants` and `users` reads locked all of `shows` and
       `user_studio_memberships`). It holds for the call only and costs a GUC save and restore.
       It narrows conflicts; it does not make teams independent (decision A).
     - **23 `catalog_user` policies** replace the ten `<table>_user_all` allow-all policies:
       `users` select (own row and co-members) and update (own row); memberships, invites and
       definitions select/update/delete by member team; `user_prefs` one `for all` (own row);
       `shows` select (member) and insert/update (managed); `sessions` select (shows of member
       teams) and insert/update (accessible shows); `app_settings` select (member) and
       insert/update/delete (managed), by full `studio_config:<id>` key; `show_grants` one
       `for all` (shows of member teams). No policy, so nothing: definition inserts, show and
       session deletes, and `kv`.
     - **Narrowed privileges:** no privilege on `kv` (a user-bound statement fails with `42501`);
       on `users`, `SELECT` and `UPDATE (given_name, family_name)` only; no `INSERT` on
       memberships and invites. `catalog_system` keeps its allow-all policies and full DML.
     - **Settings:** `getStudioSettingsBlob` is a pure read; `insertStudioDefinition` (both
       planes) upserts the normalized default blob in place of the old settings delete, so a
       reused id's leftover row is replaced; the migration backfills a default row (fresh
       category ids, the server's default shape, pinned by a `pg` test) for every team without
       one.
     - **Route changes (status-preserving):** the team delete removes invites, the definition,
       the settings, then the memberships (design D5), so each delete passes the member rules;
       `PUT /api/profile` runs its settings and show writes in one transaction that first
       re-reads the caller's role `FOR SHARE` (a demotion committed after the early check gets
       `403 Admin role required.` with nothing written); `updateSessionIndex` returns `null` on a
       zero-row update (`404 Session not found`); a transfer whose target row cannot be read is
       `404 Member not found`; `POST /api/sessions` asks `catalog.show_exists` when the show is
       hidden (`400 Show does not belong to the active team.` vs `Unknown show_id.`); the name
       edit updates only the two name columns; where an in-transaction gate already decided, a
       `42501` stays the generic `500` with the redacted log line.
     - **Within-team escalations left to the app:** the policies hold the team boundary, not the
       role inside a team. As far as the database is concerned, a member can raise their own role
       to `admin`, and delete or update other members' memberships, grants and invites in a member
       team. Raising oneself to `owner` while the team has one fails on
       `idx_user_studio_memberships_one_owner` (`23505`). The app's in-transaction gates
       (`requireTeamRoleIn` with `FOR SHARE`, the target re-checks) are the only check there.

     Why each system reason stays system (owner decision 3): each needs rows outside the
     caller's teams, or has no user at all.

     | reason | why not user scope |
     | --- | --- |
     | `auth-resolve` | runs before a user is known; loads every team's name for the registry snapshot |
     | `kv` | login sessions, OAuth state and the Companion's last command belong to no team; purges span all users |
     | `session-mirror` | the hub's writer has no user; it projects any session |
     | `boot-wait` | no user at boot |
     | `log-import-job` | a detached job that outlives its request; it re-checks access per sheet itself |
     | `oauth-callback` | looks up and creates users by Google subject, and consumes invites across teams, before a catalog user exists |
     | `bootstrap-claim` | claims teams the user is not a member of |
     | `support-plane` | `ADMIN_TOKEN` caller, no user, every team |
     | `companion-token` | `API_TOKEN` caller, no user |
     | `access-loss-check` | reads the access of another user (the target), after the caller may have left the team |
     | `team-invite` | looks users up by email across the catalog, and adds memberships for non-co-members |
     | `team-create` | inserts a team definition (no user insert rule), and purges other users' leftover rows under a reused id |

     **Corrections to the 6b-1 outline of this slice:** it planned to move `team-create`,
     `team-invite`, `access-loss-check` and `log-import-job` toward user scope (owner decision 3
     keeps them system), and to map `CatalogForbiddenError` to masked `404`/`403` responses
     (owner decision 4 keeps each route's existing status: where an in-transaction gate already
     decided, a `42501` stays the generic `500`). Its helper names (`admin_studios`,
     `granted_shows`) became `manager_studios` and `accessible_shows`.

     **Rollback** (as in 6b-1's owner decision A). **Order:** deploy the previous image first,
     then run the SQL right away: the new image calls `catalog.studio_exists`/`show_exists`,
     which the SQL drops, so it must not run while the new image serves. During the short gap the
     previous image meets the deploy-window effects (its self-healing settings read is refused for
     plain members on a team with no row; its team delete removes memberships first and leaves the
     definition and settings behind, which the support plane's delete removes; its four-column
     name edit is refused). Run as `postgres` in one transaction
     (`psql -X -v ON_ERROR_STOP=1 --single-transaction`):
     ```sql
     do $$
       declare p record; t text;
       begin
         for p in select policyname, tablename from pg_policies
                  where schemaname = 'catalog' and 'catalog_user' = any (roles) loop
           execute format('drop policy %I on catalog.%I', p.policyname, p.tablename);
         end loop;
         for t in select tablename from pg_tables where schemaname = 'catalog' loop
           execute format('create policy %I on catalog.%I for all to catalog_user using (true) with check (true)',
                          t || '_user_all', t);
         end loop;
       end
     $$;
     revoke update (given_name, family_name) on catalog.users from catalog_user;
     grant select, insert, update, delete
       on catalog.kv, catalog.users, catalog.user_studio_memberships, catalog.team_invites
       to catalog_user;
     drop function if exists catalog.member_studios(text), catalog.manager_studios(text),
       catalog.accessible_shows(text), catalog.member_shows(text), catalog.co_members(text),
       catalog.studio_exists(text), catalog.show_exists(text);
     delete from supabase_migrations.schema_migrations where version = '20261007000000';
     ```
     This restores 6b-1's state exactly; the backfilled settings rows stay (they are what the
     6b-1 app's self-healing read would have written). Deleting the version row is the
     roll-forward path: the migration uses `create or replace`, `drop policy if exists` before
     each `create policy`, idempotent revokes and `on conflict do nothing`.

     **Measurements** (test-only `RetryCountingRoot`, design D11; 5 runs each, before = this
     branch with the 6b-1 policies, after = with the 6b-2 policies; medians):

     | measurement | before | after | stop rule |
     | --- | --- | --- | --- |
     | integration + `pg` retry rate | 0.00984 (17 of 1728 calls) | 0.00951 (17 of 1787) | not met; 0 exhausted |
     | contention test (analyzed clone) rate | 0.5 (one commit-time `40001` per run) | 0.5 | not met; 0 exhausted |
     | probe, unanalyzed: root `p95` / timeouts / rate | 6.09 ms / 0 / 0.49 | 6.5 ms / 0 / 0.59 | not met (limit 11.7 ms; 6b-1 after-median 5.85 ms) |
     | probe, `ANALYZE`d: root `p95` / timeouts / rate | 6.48 ms / 0 / 0.49 | 6.64 ms / 0 / 0.56 | not met; 0 exhausted |

     The probe's rate is high in both columns because its 20 concurrent session updates hit one
     row. The integration runs' one `42501` per run is a test's injected `CatalogForbiddenError`,
     not a retry.

     Implementation notes (2026-10-03):
     - the single `for all` policies of `user_prefs` and `show_grants` are named
       `<table>_user_all`, following design D2's `<table>_user_<select|insert|update|delete|all>`
       naming over task 4.1's "no `_user_all`" wording; the tests assert no `catalog_user` policy
       is the constant `true` and that `_user_all` exists only on those two tables;
     - in `PUT /api/profile`, a `ValidationError` while building a show entry is returned from
       the transaction as `400`, not thrown, so a serial request keeps today's outcome (earlier
       entries saved, then the `400`);
     - a `CatalogInvalidTextError` (`400`, text containing NUL) in a later show entry now rolls
       back the request's earlier settings and show writes, because the error fails the
       transaction; this conforms to api-contract-freeze "Text containing NUL is refused" ("a
       catalog transaction it belongs to SHALL write nothing");
     - test helpers: `server/src/test/retryCounter.ts` (`RetryCountingRoot`, wired by
       `CATALOG_RETRY_LOG` in the integration harness and used by the probe and the contention
       test), `server/src/test/rewritingCatalog.ts` (rewrites one user-bound statement's
       outcome), and `server/src/test/pg/policyFixture.ts` (the design D10 fixture shared by the
       helper and matrix tests); the probe gained `CATALOG_PROBE_ANALYZE=1`.
7. Session tables, revision, version checks and the audited overwrite. Split (owner, 2026-10-03)
   into three changes, async first, as slice 3 made the catalog async before slice 4 moved it:
   - 7a `async-session-hub`: the session hub goes async, still on SQLite, with no HTTP or
     WebSocket change for serial requests. Merged (PR #42) and live-checked on dev and stage
     2026-10-03.
   - 7b: the session tables in Postgres schema `catalog`, ported faithfully as 4a ported the
     catalog; the postgres.js session adapter and the wiring; the `sessions` projection written
     inside the hub's write transaction, retiring the mirror chain; row-level security on the
     content tables. Split (owner, 2026-10-03) like 6b into:
     - 7b-1 `session-tables`: the nine tables, the adapter's session mode, the wiring and the
       projection in the write transaction. Every session statement runs as the system task
       `session-hub` against allow-all system policies, so serial requests do not change.
       Implemented 2026-10-03 on `supabase-7b1-session-tables`; the after-measurements, merge and
       the live dev and stage checks are pending;
     - 7b-2 `session-content-policies`: the content policies (show access, as in 6a) and every
       hub call bound to its caller (the signed-in user, or a reviewed system task: the hub's open
       and lease alarm, token-only Companion calls, undo steps, the merge script). Implemented
       2026-10-03 on `supabase-7b2-session-content-policies`; the merge and the live dev and stage
       checks are pending.
   - 7c: `sessions.revision`, per-row versions, opt-in version checks, `409` with the current row,
     the overwrite dialog and the audit. A contract delta; Companion routes stay unchecked. Split
     (owner, 2026-10-05) into 7c-1 `session-row-versions` (the server) and 7c-2 (the web's `409`
     handling and the overwrite dialog), each with its own proposal, panel and approval.

   Owner decisions (owner, 2026-10-03):
   1. **split 7a / 7b / 7c, async first:** 7a converts the call graph while the store is still
      SQLite, so 7b's diff is storage alone;
   2. **per-row versions** (7c), not one session-wide version;
   3. **opt-in version checks** (7c): a request without a version keeps today's last-writer-wins;
   4. **a faithful port** (7b): the session tables keep their types and semantics, as 4a did for
      the catalog.

   After the adversarial panel (owner, 2026-10-03):
   - **fix all five interleaving sequences in 7a:** under a per-call lock, two handlers that
     resume in one tick alternate between their hub calls, so the PUT event metadata merge, the
     import's recording ordinal, the Companion transport toggle, the transcript remap and the
     log-import duplicate check each became one hub method, tested by firing the conflicting pair
     at once;
   - **no transaction deadline:** hub bodies await only their own SQL (revisit item below);
   - **a failed lease alarm logs and re-arms** with a backoff of 1 s, doubling, capped at the 40 s
     stale threshold, reset on success;
   - **the spec states observables only** (no dirty read, atomic read-then-write methods,
     broadcasts in commit order, no self-deadlock, a named error on a closed hub); whether 7b
     keeps an in-process lock is 7b's choice.

   **7a's mechanism.** `SessionSql` is async, and `tx(fn)` hands its body a handle scoped to the
   transaction (`t.tx` joins it; any error fails the whole transaction; misuse rejects with
   `SessionTxMisuseError`). Each hub owns one FIFO lock, and every storage call takes it, reads
   included: a write runs `BEGIN IMMEDIATE`, the body, `COMMIT`, then flushes its broadcasts before
   the lock is released; a read runs under the lock without a transaction. The broadcast queue
   belongs to the transaction, so a relayed Companion command is sent at once. A hub call from
   inside the same hub's transaction rejects instead of deadlocking. The five sequences are the
   hub methods `updateEvent` (with a metadata merge), `addImportedAudioSegment`, `toggleTake`,
   `replaceTranscriptWordsRemapped` and `addEventAtTotalFramesIfAbsent`. A failed `ROLLBACK`
   rejects the call and closes the hub (queued calls get `SessionHubClosedError`), and the next
   `get` opens a fresh one. The lease alarm is armed outside the transaction's async context, runs
   through the lock, and re-arms with the backoff above after a failure. A handler may hold a hub
   across its own calls and re-resolves it after a long non-hub `await`.

   **Revisit (owner, 2026-10-03):** ~~a hub transaction that hangs and never resolves holds the
   session's lock and soft-locks that session (every later call on it queues forever); revisit a
   deadline or a lock-wait timeout.~~ Resolved by 7b-1: session transactions have the catalog's
   10-second deadline (below).

   **Slice 7b hazards** (async-session-hub design D11). They go live once session statements do
   I/O:
   1. the observables of the `core-ports-architecture` requirement must hold without the embedded
      lock: every write transaction takes the `sessions` row lock first, and a multi-statement
      read needs one snapshot (one statement, or a `REPEATABLE READ` read transaction);
   2. broadcast flush order versus commit order across two transactions on one session (keep a
      per-session ordering gate, or order frames by revision);
   3. the sequences 7a documents rather than fixes (async-session-hub design D7: S1, S2, S5, S7,
      S8 and S11), which split on any request once statements do I/O;
   4. a hub body re-run after a `40001` retry must have only database effects: drop the held
      broadcasts per attempt; `setAlarm` inside the lease bodies re-arms on every run (harmless,
      one slot); the method callbacks (`mergeMetadata`, `remap`) must stay pure;
   5. a `create_event` insert still in flight when its turn ends is not counted in `created`;
   6. the registry stops owning connections: eviction, `open()`, `.db` creation on read paths and
      the failed-rollback close change meaning, and the adapter sets the unconfirmed-rollback
      policy;
   7. the mirror chain retires (slice 4 hazards 3, 4 and 17, and the `live_revision` follow-up).

   **7b-1 `session-tables`** (owner decisions, 2026-10-03):
   1. **split 7b like 6b:** 7b-1 builds the tables, the adapter, the wiring and the projection
      inside the write transaction, as the system task `session-hub`; 7b-2 adds the content
      policies and user-bound hub calls;
   2. **serialization by row lock under `READ COMMITTED`:** every session write transaction
      first locks the session's `catalog.sessions` row (`FOR UPDATE`); a multi-statement read
      runs in one `REPEATABLE READ READ ONLY` snapshot. The in-process FIFO lock stays, to keep
      broadcast order, until slice 9 (slice 9a: frames are published inside the write
      transaction and delivered from the frame bus listener, so broadcast order is the commit
      order across processes; the FIFO lock stays for in-process serialization);
   3. **start empty,** as 4c did: the `sessions/*.db` files stay untouched for slice 11's
      import, and every existing session's live projection resets to an empty session's;
   4. **backups** (1.3) were never built: a cutover blocker, done as their own change before
      slice 11, not in 7b.

   After the adversarial panel (owner, 2026-10-03):
   - **session calls get their own pool** of 4 connections beside the catalog's 3 root and 5
     transaction connections (12 of the role's 20 per process), so heavy session traffic can slow
     only session calls, never sign-in or catalog writes;
   - **S4/S5 are folded in:** `anchorImportedTake` re-checks `is_rolling` inside its transaction
     and refuses; each import route answers its existing `409` and rolls the segment back as its
     post-blob rolling refusal does;
   - **a projection failure fails the write:** api-contract-freeze "Catalog mirror failures don't
     fail saved session changes" is retired;
   - **the stop rule:** a median `addEvent` above 5 ms, or the 31,621-word transcript replace
     above 10 s, measured in the stack (dev app container to dev database).
   - **the stop rule raised after measurement (owner, 2026-10-03):** in the dev stack the median
     `addEvent` measured 5.4-5.6 ms over two runs (7a on SQLite: 0.17 ms), `listEvents` 4.6-5.0 ms
     (7a: 0.43 ms) and the 31,621-word replace 0.39-0.40 s. Most of an `addEvent` is about 2.2 ms
     fixed per session transaction inside the adapter (an empty locked session transaction
     2182 µs; a root `select 1` 412 µs against 29 µs on a raw connection). The owner accepted
     this as imperceptible for live logging and raised the `addEvent` limit to 10 ms; the replace
     limit stays 10 s. Optimising the overhead is a revisit item.

   **7b-1's mechanism.** Migration `20261008000000_session_tables.sql` adds nine tables in schema
   `catalog` (`events` and `meta` renamed `session_events` and `session_meta`), each with
   `session_id` referencing `catalog.sessions` and leading every key and index, row-level
   security with only the `_system_all` policy, and `catalog_user`'s privileges revoked; it
   resets every session's projection. The catalog adapter gains a session mode (`READ
   COMMITTED`, the row lock pipelined with `BEGIN` and the bindings preamble, retry on `40P01`
   only, `SessionNotFoundError` for a missing row) and a snapshot mode, both on the 4-connection
   session pool, with the catalog's 10-second deadline; every connection sets
   `extra_float_digits` so floats read back exactly. `PostgresSessionDb` hands each hub a
   `SessionStorage` (`tx`, `snapshot`) over `bindSystem('session-hub')`. Every session statement
   names `session_id` (a repo test checks it). Each hub write attempt gets a fresh bound core,
   whose broadcasts and alarm are applied after `COMMIT`, once; a write that changed the events
   or the transport sets the six projection columns in one statement before `COMMIT`. The mirror
   chain, `projectSessionLive` and the `session-mirror` binding are gone. The hub owns no
   connection, and the anchor re-checks the transport as above. Text with NUL in session content
   is refused (`400`, nothing saved).

   **The 7b hazards after 7b-1:**
   1. resolved: the row lock first and one snapshot per read; the FIFO lock also stays;
   2. held in-process by the FIFO lock; carried to slice 9 for several processes (slice 9a:
      resolved for broadcast order, which is the commit order through the frame bus);
   3. S4/S5 resolved (the anchor re-checks inside its transaction); S1, S2, S7, S8 and S11
      carried, and their windows widen from one tick to any concurrent request: each response
      field is still one a serial order produces, with unchanged shapes and statuses;
   4. resolved: broadcasts and the alarm per attempt; `mergeMetadata` and `remap` stay pure;
   5. carried unchanged (7a counts successful inserts only);
   6. resolved: the registry and the hubs own no connection; the adapter retires a connection
      whose rollback is unconfirmed;
   7. resolved, with slice 4 hazards 3, 4 and 17 and the `live_revision` follow-up.

   **Constraints left for 7b-2.** Its per-user binding is not a one-line swap:
   - the seam carries no caller: one storage root per hub serves every user on the session, so
     the binding is passed per call through the seam (each `tx` and `snapshot`, or a bound
     storage per hub method), not per hub;
   - the row lock and the projection update run under the caller's policy
     (`sessions_user_update`): a writer without access gets zero rows, which 7b-1 reports as
     `SessionNotFoundError`, so 7b-2 must tell missing access from a missing session and answer
     the refusal the routes already give;
   - background writers have no caller: the lease alarm, transcript generation, AI turns
     (`create_event`, `create_topic`, dashboards) and the log-import job need reviewed system
     bindings of their own, as 6b-1 gave detached catalog work.

   **7b-2 `session-content-policies`** (owner decisions, 2026-10-03):
   1. **full show access** (`accessible_shows`) for read, insert, update and delete on all nine
      tables: the rule `requireSession` applies, whatever a grant's `can_write`; a member without
      a grant keeps seeing session titles only;
   2. **AI turns and the log-import job run as the user who started them**, so the database
      applies that user's current access to every statement;
   3. **no access is told from no session** by a definer helper, `catalog.session_exists(id)`;
   4. **one change**, landed as reviewable commits.

   After the adversarial panel (owner, 2026-10-03):
   - **P1, undo steps run as the reviewed system task `session-undo`:** the imports' and the
     upload's segment deletes and the regenerate's snapshot delete remove only what the same
     request wrote or replaced, and cannot themselves be refused after a revoke. After the 5.1
     stop the owner added that the YouTube import's undo after its blob put also deletes the
     stored file, best-effort, as the local import's does (fixing an orphan file after any failed
     YouTube import);
   - **P2, disabled accounts are stated, unchanged:** access means a membership or a grant; a
     running AI turn or log-import job of a disabled account finishes.

   **7b-2's mechanism.** Migration `20261009000000_session_content_policies.sql` adds one
   `<table>_user_all` policy per session table (a correlated `exists` on `catalog.sessions` by
   primary key against `accessible_shows`, flat in the number of sessions), restores
   `catalog_user`'s privileges, and adds `catalog.session_exists`. Session-core's branded
   `SessionCaller` (`userCaller`, `systemCaller`) is passed per call through
   `SessionStorage.tx`/`snapshot`; `PostgresSessionDb` holds the catalog root and binds each call.
   The registry resolves a `SessionHubEntry` (socket members and `as(caller)`), so a hub call
   without a caller does not compile. A refused user lock asks `session_exists` and raises
   `SessionAccessDeniedError` (a neutral message, no id) or `SessionNotFoundError`; a user snapshot
   pipelines one probe with `BEGIN`. `app.onError` answers the refusal `404 Session not found`, the
   YouTube import lets it through its `502` wrapper, and the Companion routes answer their
   no-active-session `409` or the masked `200` state. The reviewed-bindings scan covers
   `systemCaller(`, `userCaller(` (two router files), `new PostgresSessionDb(` and caller literals;
   the 7b-1 system task is retired for `session-open`, `session-lease-alarm`, `session-undo` and
   `merge-audio-script`.

   **The 7b-1 constraints, met:**
   - the binding is passed per call through the seam, not per hub; views over one hub share its
     lock, so callers interleave in one FIFO order;
   - the row lock and the projection run under the caller's policy; missing access is told from a
     missing session and answered as each route already answers missing access;
   - writers with no caller of their own run as reviewed system tasks (the open, the lease alarm,
     token-only Companion calls, undo steps, the merge script); AI turns and the log-import job
     carry their starting user.

   **Measurement** (dev stack, design D11, `spike/bench7b2.mts`, every hub call as a user, 3,000
   calls x 3 runs): median `addEvent` 11.9 ms at about 300 accessible sessions and 15.5 ms at about
   3,000 (7b-1 baseline 5.3-5.4 ms), `listEvents` 7.7 ms and 10.6 ms (baseline 5.0-5.2 ms), the
   31,621-word replace 0.50 s and 0.49 s. This trips the 10 ms stop rule. The owner accepted it
   without investigating (2026-10-03): performance work waits for database-side observability, so
   it is measured rather than guessed. The cause is not yet known.

   **7c-1 `session-row-versions`** (owner decisions, 2026-10-05):
   1. **scope:** versions and opt-in checks on the hand-edited rows only (events `PUT`/`DELETE`,
      transcript words and topics `PATCH`/`DELETE`); every other writer advances versions and is
      never checked; Companion routes stay unchecked;
   2. **split 7c** into 7c-1 (server) and 7c-2 (web);
   3. **unify the revision:** `events_stream_revision` becomes `catalog.sessions.revision`,
      advanced by every session write; the wire names stay and their meaning widens;
   4. **an overwrite is a retry with the fresh version** plus `overwrite: true`; the check still
      runs, and a passing overwrite is audited;
   5. (2026-10-06, after approval) **no latency stop rule** until observability exists after the
      migration; the numbers are measured and recorded.

   **7c-1's mechanism.** Migration `20261010000000_session_row_versions.sql` adds `version` (default
   1) to `session_events`, `session_transcript_words` and `session_topics`, `revision` (default 0,
   carried over from each session's meta value, whose rows stay for a later cleanup) to
   `catalog.sessions`, and `catalog.session_overwrites` with an allow-all system policy and an
   insert-only user policy (own user id, accessible show). A transaction-bound `SessionCore`
   writes through a counting handle: the first store statement that changes a row advances the
   revision once (`UPDATE sessions … RETURNING revision`, cached for the transaction's frames); the
   hub-open seed and the relink guard row go through the raw handle and never count, so reads never
   advance it. Every update of the three tables sets `version = version + 1` (a repo scan checks
   it). The six operations take an optional expected version and compare it under the session row
   lock: a stale one returns the stored row and the routes answer `409 {"detail":"Version
   conflict.","current":<row>}` with the route's own success shape; a passing overwrite that
   changes the row writes its audit row in the same transaction, as the signed-in user, and the hub
   refuses a system caller's overwrite before any statement. Two processes racing same-version
   updates of one event for 200 rounds get exactly one winner per round.

   **Measurement** (dev stack, `bench7b2.mts`, every hub call as a user, 3,000 calls x 3 runs; no
   stop rule): at about 300 / 3,000 accessible sessions, median `addEvent` 18.0 / 21.3 ms before and
   16.6 / 21.0 ms after, `listEvents` 5.5 / 7.6 ms before and 5.4 / 8.4 ms after, the 31,621-word
   replace 0.49 / 0.54 s before and 0.52 / 0.56 s after: no change beyond run-to-run noise. The
   same code measured 11.9 / 15.5 ms in 7b-2's run on 2026-10-03, so the host's load differs
   between days; that is what observability should explain.

   **7c-2 `session-edit-conflicts`** (owner decisions, 2026-10-06). The web half; with it, 7c is
   complete:
   1. **The conflict dialog** offers Overwrite and Keep theirs. It shows theirs next to yours for
      every field holding the operator's text.
   2. **A delete conflict** offers Delete anyway and Keep theirs.
   3. **Dismissing the dialog** saves nothing and discards nothing. The draft keeps its old base,
      so its next save meets the conflict again.
   4. **All six requests** carry the version. The dialog is wired for event inline edit, batch
      save and delete, transcript-word edit and topic edit. Word and topic delete have no UI.
   5. **Batch save** prompts per conflicting row and continues.
   6. **Word and topic save failures** are toasted.

   **7c-2's mechanism.**
   - **The seed.** Each feed keeps a per-row **seed**: the server row the row's controls were
     filled from. It survives virtualization unmount, and it follows the server only while the
     row holds no draft, no edit and no save, and is not focused. Saves send the seed's version
     and compare the controls against the seed, never against the cache. The panel traced every
     missed conflict and every silent overwrite in the first draft to a cache fallback.
   - **The save loop.** `useVersionedSave` serializes saves per row and applies each outcome
     before the next save reads its base. It also:
     - queues the prompts, so one never replaces another;
     - settles a row's queued saves without sending them after Keep theirs or a dismissal;
     - dismisses everything on a session switch, including a conflict that arrives afterwards.
   - **The `409` body** is typed from captured responses. A new `errorBody` detector in the
     response-shape guard counts typed error bodies as sites.

   The server is unchanged.
8. Session leases. Split (owner, 2026-10-06) into 8a `session-leases` (the recording lease) and 8b
   (the auto-generate kinds: the shared AI turn slot, transcript generation, YouTube import), each
   with its own proposal, panel and approval.

   **8a `session-leases`** (owner decisions, 2026-10-06):
   1. split into 8a and 8b;
   2. **ready, not on:** leases are correct across processes, but production stays single-process;
   3. **the lease belongs to a user and a client:** heartbeat and release act only for both; anyone
      else's heartbeat answers `{ok:false}`, and anyone else's release does nothing;
   4. **only state changes advance the revision:** claim, release and expiry do, a heartbeat does
      not;
   5. no global sweeper (slice 9);
   6. a reviewed system task may hold a lease (`holder_user_id` null);
   7. (after the panel) **only the holder sees its tab id:** others get `another-client`, which
      closes a squatting path;
   8. (after the panel) **the recorder re-claims a refused heartbeat** and warns once if someone
      else took the lease.

   **8a's mechanism.**
   - **The table.** Migration `20261011000000_session_leases.sql` adds `catalog.session_leases`
     (`session_id`, `kind` checked to `'recording'`, `holder_client_id`, `holder_user_id`,
     `heartbeat_at_ms`, `expires_at_ms`), primary key `(session_id, kind)`.
     - Row-level security is system-all plus user policies on accessible shows that write only the
       user's own id.
     - The update policy's USING is the access rule alone, because a holder-scoped USING turns an
       expired-lease takeover into `42501`.
     - So RLS does not tie a live lease to its holder; the server's statements are the only writers
       and enforce it.
   - **The statements.**
     - A claim is one conditional upsert, so two processes get exactly one winner.
     - A heartbeat is a strict conditional update that does not count towards the revision.
     - Liveness is always the stored expiry against the Clock port. Any process's alarm, open, or
       takeover claim frees an expired lease once.
   - **The old keys.** The `lease_holder` / `lease_seen_ms` meta rows are left for a later cleanup.
   - **Follow-ups for slice 9:**
     - a global expired-lease sweeper;
     - cross-process `lease.changed` fan-out;
     - Realtime exposure of `holder_user_id` and of the per-heartbeat UPDATE.

   **8b `session-run-leases`** (owner decisions, 2026-10-07):
   1. **only the per-session check moves to leases:** three run kinds, `ai-turn` (shared by AI chat,
      AI v2, topic generation and event generation), `transcript-generation` and `youtube-import`;
      after the panel, the in-process check stays in front of the lease; the process ceilings
      (`AI_CHAT_MAX_CONCURRENT`, the YouTube ceiling of 2, one transcript generation and its
      status) stay in memory and count per process; a deployment-wide ceiling is slice 9's;
   2. **the holding process heartbeats:** a run lease lives 40 s and is renewed every 10 s; a
      refused renewal is logged and the run continues;
   3. **silent:** claiming, renewing, releasing or overwriting a run lease never advances the
      revision and never broadcasts `lease.changed`;
   4. **the holder is the requesting user and a run id** `srv:<boot id>:<uuid>`; a log-import job's
      transcript runs hold as the job's creator. The 8a policies apply unchanged.

   **8b's mechanism.**
   - **The table.** Migration `20261012000000_session_run_leases.sql` widens
     `session_leases_kind_check` to the four kinds. No rows or policies change.
   - **The statements.** `LeaseStore.claimRunLease` and `releaseRunLease` run 8a's claim upsert and
     a holder-scoped delete on the raw handle, so they never count, broadcast or arm the alarm.
     Renewal is a re-claim by the same holder, so a holder whose row lapsed takes it back unless
     another process took it. `expireIfStale` and its alarm cover recording rows only; an expired
     run row stays until the next claim overwrites it.
   - **The hold.** `holdRunLease` (session-core) claims once, then renews on an unref'd timer that
     re-resolves the hub each tick, so idle eviction mid-run is harmless. `release()` is memoized
     and never rejects.
   - **The order.** Each route and pipeline takes its in-process slot first, unchanged, then claims
     the lease; a refusal releases the slot and answers the session-busy `409` (transcript: the
     generic in-flight `409`). The lease is released before the slot, before the response ends.
   - **Accepted:** a process that crashes or restarts mid-run leaves its run leases, so that
     session's kind is refused for up to 40 s. Graceful shutdown does not release them.
   - **Rollback.** Revert the code. Run leases are written only by the new code, so rows left
     behind expire harmlessly. To restore the `'recording'`-only check, run `delete from
     catalog.session_leases where kind <> 'recording'`, then re-add the check with
     `'recording'` only. This is a documented step, not a migration file.
   - **Follow-ups for slice 9:** deployment-wide ceilings, a cross-process transcript status, and a
     sweeper for expired run rows.
9. Realtime replaces the WebSocket protocol. **Amended (owner, 2026-10-07):** slice 9 keeps the
   WebSocket and runs as sub-slices; Realtime is deferred.
   - 9a `session-frame-bus`: every session frame, relayed command and access-loss close travels
     through a Postgres `NOTIFY` channel that every server process listens on. Write frames are
     published inside the write transaction, so each socket gets a session's frames in commit
     order; messages are HMAC-signed with `FRAME_BUS_SECRET`; access-loss closes are published in
     the revoking transaction; a process closes its sockets with `1012` after its listener
     re-listens; the app role's connection limit rises to 45 (14 per process, three processes).
     Only `main.ts` uses the Postgres bus; tests keep the in-process bus. The topology stays one
     replica.
   - 9b per-process request state (log-import jobs, AI v2 answers, chat resume); 9c
     deployment-wide ceilings, a cross-process transcript status and sweepers; 9d the Companion
     device credential.
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
- The HTTP/WS contract changes: auth endpoints and new `409` conflicts. The WebSocket stays
  (slice 9a amends the Realtime replacement: cross-process `4403` closes and a `1012` close after
  the frame bus listener comes back). Each change needs a delta amending `api-contract-freeze`.
- From slice 9a every server process holds a Postgres listener and a publisher, and the stacks
  hold one more secret, `FRAME_BUS_SECRET`, whose rotation restarts every process together.
- The dev loop gains roughly 10 containers per stack. Offline native dev goes away.
- Self-hosting makes backups, upgrades and secret rotation the owner's job.
- Backups are a cutover blocker (owner, 2026-10-03): from slice 7b-1 session content is in
  Postgres and nothing backs it up yet; slice 1.3 is done as its own change before slice 11.
- Main is frozen until cutover, and the only prod feedback comes at cutover.
- Revisit if:
  - the Companion spike fails and a relay would keep the old WebSocket protocol alive anyway; or
  - measured write latency hurts live recording.
