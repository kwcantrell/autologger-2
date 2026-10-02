# Design: catalog-concurrency-hazards

## Context

See proposal.md for the motivation. Relevant behaviour of the 4b/4c adapter:
- every `tx` is SERIALIZABLE, and its body is re-run up to 3 times on `40001`/`40P01`;
- a body must touch only the catalog;
- root statements are autocommit, on a 3-connection pool, and take no part in conflict
  detection;
- `23505` and `23503` are not retried and reach the generic `500`.

The hazard numbers (#2-#20) are those in ADR 0021's "Slice 4 hazards" list.

## Goals / Non-Goals

**Goals:**
- Each hazard is fixed at the smallest point that makes it race-free.
- Each fix is proven by a test that forces its interleaving and fails before the fix.

**Non-Goals:** see proposal. At the design level: no new status codes, and one additive index
migration only (owner, after the panel). `PostgresCatalogDb`'s transaction machinery is
unchanged.

## Assumptions

| # | Assumption | Command | Observed |
| - | --- | --- | --- |
| A1 | Six team admin routes gate with a root `requireTeamAdmin`, then write separately | `grep -n "requireTeamAdmin(c" server/src/routers/teams.ts` | `189, 206, 223, 257, 268, 291` |
| A2 | The live projection is mirrored from 9 call sites, each a root `projectSessionLive` | `grep -n "projectSessionLive" -r server/src --include=*.ts \| grep -v test` | `events.ts:175,183,241,637,693,703`; `companion.ts:189,205`; `logImport.ts:205` |
| A3 | Local and YouTube import call `anchorImportedTake` and never mirror | `grep -n "anchorImportedTake" server/src/routers/sessions.ts` and A2 | `428`, `551`; neither appears in A2 |
| A4 | Memberships, invites and shows have no foreign key to `studio_definitions` | `grep -n "references" supabase/migrations/20261001000000_catalog_schema.sql` | only `users (id)` ×2 and `shows (id)` |
| A5 | Expired KV rows are purged only at boot | `grep -n "purgeExpired" -r server/src --include=*.ts \| grep -v test` | `main.ts:48`, via `startupPurge.ts:11` |
| A6 | The root pool has 3 connections, and `rootQuery` has no bound | `grep -n "rootMax\|rootQuery" packages/storage/src/postgresCatalogStore.ts` | `rootMax = 3`; `return map(await this.root.unsafe(…))` |
| A7 | The Companion ack does `kv.get` then `kv.put` on one key | `grep -n "LAST_COMMAND_KEY" server/src/routers/companion.ts` | `155` get, `227` put (command), `258` get, `265` put (ack) |
| A8 | `authCreateUserGoogle` is a plain `INSERT INTO users` (no `ON CONFLICT`) | `grep -n "INSERT INTO users" packages/catalog/src/authStore.ts` | `106` |
| A9 | Every route builds its catalog once, in `authContext`, from `c.env.ports.catalog`, so a test can swap the port with `envWith({}, {catalog})` | `server/src/middleware/auth.ts:16-18`; `server/src/test/harness.ts:134-143` | `createCatalog(c.env.ports.catalog)`; the port overrides spread over `ports` |
| A10 | `projection()` recomputes all six mirrored columns from hub state, and every `projectSessionLive` writes all six | `packages/session-core/src/sessionCore.ts:215-224`; `sessionIndexStore.ts:318-341` | so a later write heals an earlier miss (#17) |
| A11 | A late `cancel()` can hit the next statement on a pooled connection | 4b design A4 | `{"57014":3,"25P02":1}`; so the root deadline doesn't cancel (#19) |
| A12 | No route holds a hub across an await (#7) | 4d exploration, every `getSessionHub`/`registry.get` binding | `sessions.ts:403/513` and `transcribe.ts:312` re-fetch after long awaits |
| A13 | Under SERIALIZABLE, a plain re-check read does not abort rename, revoke or invite by a concurrently demoted admin, because there is no rw cycle. `SELECT … FOR SHARE` on the caller's membership row does: a demotion waits, and one already committed gives `40001` | panel probe `ssi.mjs`, `forshare.mjs` (throwaway pinned Postgres, real schema) | `rename-by-B vs demote-B: commit/commit`; with FOR SHARE: `T2 finished while T1 open? false`, `after committed demotion -> 40001` |
| A14 | Invite vs team delete, show create vs team delete, the create cap, and delete or promote by a demoted admin all abort one side under SERIALIZABLE | panel probe `ssi.mjs` | `#18 … T1(held)=40001`; `#13 … 40001`; `#9 … T2=40001`; `delete-by-B vs demote-B: 40001` |
| A15 | With no `studio_id` index on `user_studio_memberships`, a per-team query is a sequential scan and takes a relation-level SIREAD lock, so writes in unrelated teams conflict | panel probe; `EXPLAIN delete … where studio_id='x'` | `two creates by different users, different ids: ok 40001`; `Seq Scan on user_studio_memberships` |
| A16 | A root statement that hits its client bound still runs later on its connection, so a timed-out older mirror write can land after a newer one. postgres.js pipelines queries onto busy connections; `cancel()` on a query not yet sent only removes it from the queue | panel probe `pause.mjs` (pool 3, pause, bound 300 ms, 15 runs); `node_modules/postgres/src/index.js:336-360`, `connection.js:166-176` | `link1=BoundExpired link2=ok final=1: 7`, `final=2: 8` |
| A17 | A second concurrent `INSERT … ON CONFLICT (google_sub) DO NOTHING` in SERIALIZABLE gets `40001`, and its re-run returns no row | panel probe `ssi.mjs` | `D5 … T2 -> 40001`; `retry run: rows=0` |
| A18 | Every log-import domain failure is a plain `Error` with an operator message; database errors carry a string `code` | `grep -rn "throw new" packages/log-import/src/*.ts` | `runSessionLogImport.ts:32,38,61`, `syncScore.ts:140,141,170,189`, `categoryMatch.ts:41`, `sheetsFetch.ts:70,91` |
| A19 | `KvStore` and the mirror hold the process adapter, so a gated `ports.catalog` doesn't reach them; tests override `ports.kv` / `ports.mirror` too | `server/src/node/config.ts` | `const kv = new KvStore(catalogDb, clock)` |
| A20 | Admin-plane membership removal and account disable are root writes that SSI can't see | `server/src/routers/admin.ts:100,111`; panel probe `rootw.mjs` | `SER demote (counted 2) vs root disable: T1=commit; enabled admins left=0` |
| A21 | `team_invites` is keyed `(studio_id, email_norm)`, so its primary key already indexes `studio_id`; `shows.studio_id` has no index | `grep -n "create index\|primary key" supabase/migrations/20261001000000_catalog_schema.sql` | `primary key (studio_id, email_norm)`; indexes only `idx_users_email`, `idx_sessions_show` |

## Decisions

### D1. Test seam: a gated catalog port

`server/src/test/gatedCatalog.ts` wraps a `CatalogDb`. Before a statement whose SQL matches a
pattern, it waits on a one-shot, test-controlled gate. A body re-run after `40001` passes through
an already-opened gate, so a retry can't deadlock the test. `tx` handles are wrapped the same way.

A test passes it with `envWith({}, { catalog: gated })` (A9). Where the race involves KV or the
mirror, the test also passes `kv: new KvStore(gated, clock)` and a mirror built on the gated
catalog (A19). Same-tick `Promise.all` is used where it already reproduces a race. Each
team-hazard test holds the in-flight request *before* its in-transaction role read.

### D2. Team writes: re-check inside one transaction (#8-#12, #18)

- **The re-check.** `requireTeamAdminIn(cat, userId, teamId)` reads the caller's membership with
  `SELECT role … FOR SHARE` through the transaction-bound catalog (A13).
  - A non-member gets `404`, a member `403`; these are the `ApiError`s the early check throws.
    `ApiError` has no `code`, so it isn't retried.
  - FOR SHARE makes a concurrent demotion or removal wait for the write, and makes a demotion
    already committed abort the write (`40001`), so the re-run returns `403`. Plain SSI only
    covered delete and promote (A14).
- **Admin routes.** Each of the six admin routes (A1) runs its body as
  `catalog.tx(async (cat) => { await requireTeamAdminIn(cat, …); … })`.
  - The early `requireTeamAdmin` stays, so the order of statuses is unchanged.
  - `guardedAgainstLastAdmin` takes the bound `cat`, not `c.get('catalog')`, because the adapter
    refuses the root handle inside an open transaction.
- **Create (#9, #18).**
  - The existing validation (slug, built-in reservation, display name) runs first, outside the
    transaction.
  - Then, in one `catalog.tx`:
    1. `400` if the id exists;
    2. `400` if `shows` rows exist for the id;
    3. count the caller's admin teams, and at 20 return the existing `400`;
    4. `insertStudioDefinition`;
    5. `DELETE` any leftover `team_invites`, `user_studio_memberships` and `app_settings`
       `studio_config:<id>` rows for the id;
    6. add the admin membership.
  - After commit, `refreshStudioRegistry()` runs. If it fails, it warns and the request still
    returns `200`; the snapshot is used for display only.
  - `adminCreateStudio` (admin plane) uses the same transaction steps 1, 2, 4 and 5, then
    refreshes after commit.
- **Invite (#10).** The lookup, list, cap check and grant/upsert run in the admin transaction.
  The user lookup reads all of `users` (the email is normalized in JS), so an invite can
  conflict with a concurrent first sign-in. That conflict is what closes the stranded-invite
  race, and the retry resolves it (R2).
- **Role change (#11).** `authSetExistingMembershipRole` does an `UPDATE … RETURNING`; 0 rows
  gives `404 Member not found`. The last-admin check shares the transaction. The upsert stays
  for the admin-plane rescue.
- **Removal (#12).** The guard returns `'missing' | 'blocked' | 'ok'`, after reading the target
  inside its transaction.
- **Admin plane (A20), corrected at implementation (re-panel 2026-10-01).** Membership removal
  (`admin.ts:100`) and account disable (`:111`) stay as they are. The admin plane has no
  last-admin check, by spec. A team-plane demotion that races an admin-plane disable can end
  with no enabled admin, but that is the same result as the two requests run in order (demotion,
  then disable), which the support plane may do. Adding the check would add `409`s to support
  routes, which no delta authorizes.

### D3. Show create and the admin-plane membership add (#13, #14)

- **Show create.** One `catalog.tx`:
  1. the studio exists: a definition row or a built-in id, otherwise `400 Unknown studio id.`;
  2. `authUserHasStudio`, otherwise `404 Unknown studio id.`, as today;
  3. `createShow`.
- **Admin-plane membership add** (`admin.ts:82-92`). A new transaction: studio exists, then
  upsert.
- **The registry snapshot** stays for display names, which can go stale across awaits. This
  part of #14 is accepted and recorded in D11.

### D4. Settings defaults without a transaction (#20)

`getStudioSettingsBlob(sid)` keeps today's mapping of the id (the snapshot remap of an unknown
id is unchanged). Then:
1. a root read;
2. if no row:
   - if the studio is neither defined nor built-in, return the defaults without storing them;
   - otherwise `INSERT … ON CONFLICT (key) DO NOTHING`, then read again;
3. if the blob is corrupt, a compare-and-set `UPDATE … WHERE key = ? AND value = <raw>`, then
   read again.

A delete that commits between the existence check and the insert can still leave a row. D2's
create purge makes that row harmless, and the spec says so.

### D5. First sign-in (#15)

- `authCreateUserGoogle`: `INSERT … ON CONFLICT (google_sub) DO NOTHING RETURNING id`, which
  returns `null` when no row comes back (A17).
- The callback's transaction body returns `null` before seeding prefs or materializing invites.
- After the transaction, a `null` makes the handler re-read the user by subject and take the
  existing-user path.

### D6. Session mirror (#3, #4, #17)

`server/src/sessionMirror.ts`, `SessionMirror.mirror(sid)`:
- **Ordering.** A per-session promise chain. A call always awaits a link that starts *after*
  the call, and the link reads `registry.get(sid).ensure()` when it starts. So every committed
  change is covered by a later read, and there is no coalescing.
- **Each link.** It calls `projectSessionLive` on the process catalog.
  - On failure it warns with the session id and the error's code or name.
  - On `CatalogRootTimeoutError`, the link waits on the error's `settled` promise before the
    chain moves on (A16, D10), so a timed-out write can't land after a newer one.
- **Cleanup.** Idle chains are deleted from the map.
- **Close.** `close()` makes later calls no-ops and awaits the running links. `createBindings`'s
  `close` calls it before `registry.closeAll()`, so a link never reopens a hub after shutdown.
- **Wiring.** It is a server port (`ports.mirror`, `server/src/appEnv.ts`), built in
  `createBindings`. All nine call sites (A2) await `mirror(sid)`, and both import paths (A3)
  gain a call.
- **Generate.** The `finally` keeps release-then-mirror. The `events.generate.int.test.ts:1033`
  pin changes from 500 to "the run's outcome is returned, and a warning is logged".
- **Episode date.** `setSessionEpisodeDate` after a YouTube import is caught and warned, with
  the session id and the intended date.

### D7. Companion ack (#2)

`KvStore.replaceIf(key, expected, next)`: `UPDATE kv SET value = ? WHERE key = ? AND value = ?
AND (expires_at IS NULL OR expires_at > ?)`, returning `changes > 0`. Command ids are UUIDs, so
there's no ABA problem. The ack uses it; `false` gives `{ok:false}`.

### D8. Active show (#5)

- **Logged-in repair.** `authReplaceActiveShowIf(uid, expected, next)` is a conditional
  `UPDATE` on `active_show_id` only. A missing prefs row is inserted with the studio that was
  read, using `ON CONFLICT DO NOTHING`.
- **Anonymous repair.** `setSettingIf(key, expected, next)` is a conditional
  `UPDATE app_settings`, with an insert when the row is missing.
- **Anonymous profile PUT.** Its two `setSetting` calls go in one `catalog.tx`.

### D9. Log-import job (#6)

- **Catalog.** The job builds its own `createCatalog(env.ports.catalog)` and calls `init()`. It
  mirrors through `ports.mirror` (process-scoped, never request-scoped).
- **Error lines.** These invert to a deny-list (A18). An error with a string `code`, or a name
  starting with `Catalog`, is a catalog or driver failure: it gives `Failed "<title>"` (or
  `Failed` for the job) and a server warning. Every other error keeps today's message.

### D10. Periodic KV purge (#16) and root deadline (#19)

- **Purge.** `main.ts` starts an unref'd 10-minute interval that calls `kv.purgeExpired()`, with
  its own warning text. Shutdown clears it before `close()`.
- **Root deadline.** `PostgresCatalogDb` gets `rootTimeoutMs` (default 5 000), and the root pool
  gets `max_pipeline: 1` (A16). `rootQuery` races the query against the deadline.
  - If the query hasn't been sent, it is withdrawn with `cancel()` (a dequeue that sends
    nothing). It rejects with `CatalogRootTimeoutError`, and `settled` is already resolved.
  - If it has been sent, there is no cancel. It rejects with `CatalogRootTimeoutError`, whose
    `settled` resolves when the statement finishes. The role's `statement_timeout` (30 s)
    bounds that.
  - It is never retried, and goes to the generic `500` (owner).

### D11. Revisit after the migration (owner)

Recorded in ADR 0021's follow-ups:
- `503` + `Retry-After` for timeouts and exhausted retries;
- foreign keys from memberships, invites and shows to `studio_definitions` (built-ins seeded as
  rows, `23503` mapped), instead of re-checks and the create purge;
- a `live_revision` column with a hub counter, instead of the in-process chain (needed for
  slice 8's several processes);
- reconcile-on-read, or a retried dirty set, instead of log-and-succeed;
- a rate limit on `/auth/google/start`, instead of the periodic purge;
- the 5 s root deadline's value, and a distinct timeout for root writes;
- registry display names going stale across awaits (#14, accepted);
- an email-indexed user lookup, so invites don't read all of `users`.

### D12. Team-scoped indexes (owner, after the panel)

`supabase/migrations/<ts>_catalog_team_indexes.sql` adds:
- `create index … on catalog.user_studio_memberships (studio_id)`;
- `create index … on catalog.shows (studio_id)`.

`team_invites` is already keyed by `studio_id` first (A21). With these, per-team reads lock an
index range rather than the whole table (A15). Measured in task 2.7: on tables this small,
SERIALIZABLE still tracks reads by whole index page (and the planner may pick a sequential scan),
so two creates in different teams can conflict once. The retry absorbs it and both succeed, as
the spec requires. The index keeps that from growing with the number of teams. The index is
additive. A matching SQLite migration (`0006_team_indexes.sql`) keeps the catalog-database
requirement that the Postgres schema's indexes match the SQLite catalog true until 4e (found in
task 1.2).

## Risks / Trade-offs

- **R1. Re-checks rely on every team-plane membership write being in a transaction.** → The
  D1 tests pin each route. The admin-plane writes stay root writes by design (D2, A20). Foreign
  keys are on the revisit list.
- **R2. More transactions mean more retries under contention.** → D12 keeps cross-team
  conflicts from scaling with the table. On small tables, page-level tracking can still make
  writes in different teams retry once (task 2.7). A sustained flood of team writes could still
  exhaust the 3 runs; the revisit list (D11) has the rate-limit item. An invite still reads all of `users` and can conflict with a concurrent first
  sign-in; the retry absorbs it, and D11 lists an indexed lookup.
- **R3. The mirror is in-process.** → One server per `DATA_DIR`. Slice 8 revisits it.
- **R4. A failed mirror stays stale until the session's next change.** → Owner-accepted. A
  failed stop on an idle session shows it "rolling" in the list until then. It's display only:
  the Companion toggle reads hub state.
- **R5. Size about 550-650** (owner: one PR with `size-override`, about 650 ceiling; stop and
  split if it goes beyond).
- **R6. A root write that timed out may still apply** (A16). → It is documented in the spec, and
  the mirror waits for it to settle.

## Migration Plan

One additive index migration (D12), applied by `make <env>-up` (migrate runs first). Rollback:
redeploy the previous commit. The indexes are harmless to the old code.
