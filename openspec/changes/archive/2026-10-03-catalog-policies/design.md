# Design

## Context

See proposal.md for the why, the owner decisions and the items for the approver. The current
state on `supabase-6b2-catalog-policies` (cut from `supabase-migration` at e4e36e1):

- **Bindings (6b-1).**
  - The auth middleware loads the team registry and resolves the user on
    `system('auth-resolve')`, then hands routes `forUser(id)` (`server/src/middleware/auth.ts:19-24`,
    A1).
  - The registry snapshot (`isKnownStudio`, names, order) is therefore global: every team, loaded
    as system.
  - Twelve reviewed system reasons cover everything else (`server/src/catalogSystem.repo.test.ts`).
- **Policies (6b-1).** Every catalog table has RLS on, with `<table>_user_all` and
  `<table>_system_all` allow-all policies
  (`supabase/migrations/20261006000000_catalog_roles.sql`). `catalog.app_user_id()` returns the
  transaction's user id or null.
- **The user-bound write paths** (a statement-level read of every route; A2-A4, A19, A25):
  - Four route sites take `FOR SHARE` on the caller's own membership row
    (`authGetMembershipRoleForShare`, `authStore.ts:447`): `requireTeamRoleIn` (`teams.ts:96`),
    the leave (`teams.ts:387`), `POST /api/shows` (`shows.ts:79`), and `POST /api/sessions`
    through `authCanAccessShowForShare` (`authStore.ts:585`, `sessions.ts:201`). That call also
    locks the caller's own grant `FOR SHARE`.
  - One site locks a target member's row `FOR SHARE`: the grant `PUT` (`teams.ts:304`).
  - The transfer demotes the caller, then promotes the target, in one transaction
    (`authStore.ts:384`).
  - The team delete removes invites, then memberships, then the definition, then the settings
    (`studioRegistry.ts:281-284`).
  - A leave or removal deletes the member's grants in the team, then the membership
    (`authStore.ts:315`).
  - `getStudioSettingsBlob` (`studioRegistry.ts:127`) inserts a missing default row or replaces a
    corrupt one on read. Plain members reach it on `GET /api/profile`, `GET /api/studio`,
    `GET`/`POST /api/sessions` and `GET /api/shows` (A19). Team creation and
    `insertStudioDefinition` delete the key and never seed it.
- **Errors.** `42501` becomes `CatalogForbiddenError` (`postgresCatalogStore.ts:179`), which the
  server answers with the generic `500` (`app.ts:139`, `:227`). A policy-refused `UPDATE` or
  `DELETE` changes 0 rows without an error (A9).
- **Key/value.** No user-bound statement touches `kv`: the only `KvStore` runs on
  `bindSystem('kv')` (`server/src/node/config.ts:50`), and the boot wait reads `kv` as
  `boot-wait` (A23).

## Goals / Non-Goals

**Goals:**
- `catalog_user` sees and writes only what the 6a model allows (the catalog-database table); a
  bug in an app gate can no longer reach another team's rows.
- Every route keeps every status, body and message for every request a serial order can produce
  (design D9).
- Cross-team serialization failures stay inside the adapter's retry loop (owner decision A):
  policy reads lock as little as practical (D1), and the retry stop rule (D11) watches the rest.
- Every commit on the branch keeps the full suites green.

**Non-Goals:** see proposal.md. At the design level, out of scope are:
- any change to the transaction contract, the retry policy, pool sizes, or the 12 system call
  sites;
- any new production API, option or hook for measurement.

## Decisions

### D1. The helpers

All seven live in schema `catalog`, created by the migration's role (`postgres`, which has
`BYPASSRLS`, so the body reads every row and its `WHERE` is the whole check). All are `language
sql stable security definer set search_path = pg_catalog, pg_temp set enable_seqscan = off`, use
schema-qualified names only, and get `revoke all … from public; grant execute … to catalog_user`.
They are written with `create or replace`, so a roll-forward after the rollback re-applies them.

```sql
-- Teams the user is a member of (any role). The membership PK (user_id, studio_id) serves it.
create or replace function catalog.member_studios(uid text) returns setof text …
  as $$ select m.studio_id from catalog.user_studio_memberships m where m.user_id = uid $$;

-- Teams the user manages.
create or replace function catalog.manager_studios(uid text) returns setof text …
  as $$ select m.studio_id from catalog.user_studio_memberships m
        where m.user_id = uid and m.role in ('owner', 'admin') $$;

-- Shows the user can access: owner/admin of the show's team, or a grant while still a member.
-- The same predicate as authStore's SHOW_ACCESS_PREDICATE (show-grants D2).
create or replace function catalog.accessible_shows(uid text) returns setof text …
  as $$ select s.id from catalog.shows s
        join catalog.user_studio_memberships m on m.studio_id = s.studio_id and m.user_id = uid
        where m.role in ('owner', 'admin')
           or exists (select 1 from catalog.show_grants g
                      where g.user_id = uid and g.show_id = s.id) $$;

-- Shows of the user's member teams (session and grant reads).
create or replace function catalog.member_shows(uid text) returns setof text …
  as $$ select s.id from catalog.shows s
        join catalog.user_studio_memberships m on m.studio_id = s.studio_id and m.user_id = uid $$;

-- Users who share a team with the user, the user included.
create or replace function catalog.co_members(uid text) returns setof text …
  as $$ select o.user_id from catalog.user_studio_memberships m
        join catalog.user_studio_memberships o on o.studio_id = m.studio_id
        where m.user_id = uid $$;

-- Existence checks for the two status-preserving probes (D6).
create or replace function catalog.studio_exists(id text) returns boolean …
  as $$ select exists (select 1 from catalog.studio_definitions d where d.id = studio_exists.id) $$;
create or replace function catalog.show_exists(id text) returns boolean …
  as $$ select exists (select 1 from catalog.shows s where s.id = show_exists.id) $$;
```

Why each `WHERE` is the real check:
- Every membership helper filters on `m.user_id = uid`. A null `uid` matches nothing (`=` with
  null is never true), so a transaction with no user id gets empty sets (A11).
- `accessible_shows` requires the membership join for both arms. So a grant without a membership
  (impossible by the app's delete order, but possible by a bug) gives no access, as
  `authCanAccessShow` does.
- `co_members` includes the user through the self-join. It returns ids only, not rows.
- The existence checks return one boolean and reveal only what the two routes already reveal
  (`404` vs `400`, `400` vs `400` with another message, A21).

**Why seven, not three** (proposal "For the approver", OQ1).
- **Without `member_shows` and `co_members`.** The `sessions` and `show_grants` read rules
  ("shows of member teams") and the `users` read rule ("co-members") were first written as
  plain subqueries over `catalog.shows` and `catalog.user_studio_memberships`. On the probe, a
  `SERIALIZABLE` transaction then held `relation`-level `SIReadLock`s on `shows` and on
  `user_studio_memberships` (A10): the planner scans these small tables sequentially, and a
  sequential scan locks the whole relation. Every transaction that touches a session or reads a
  co-member would then be in read-write conflict with every show or membership write in any team,
  so more transactions would abort with `40001` and retry.
- **With them.** Inside a helper, `set enable_seqscan = off` makes the planner use the indexes,
  and the locks drop to page and tuple level (A10). The setting holds for the function call only,
  so the outer statement's plan is unchanged.
- **This narrows conflicts; it does not remove them** (owner decision A). On a table that fits
  in one page, a page lock still covers every row. And the outer statements (a session update by
  id, a membership read by key) take their own locks. Cross-team `40001`s therefore remain
  possible, and the adapter retries them.
- **Why `enable_seqscan = off` is kept.** The catalog's tables stay small in prod too (tens of
  teams and shows), so without the setting the planner keeps choosing sequential scans and
  relation locks there, not only in tests. On larger tables the planner would pick the indexes
  anyway, and the setting changes nothing. Its cost is one GUC save and restore per helper call.
  The retry measurement (D11) shows its effect.
- **`studio_exists` and `show_exists`** are D6's.
- *Alternative:* a per-statement `set local enable_seqscan = off` in the adapter's preamble.
  Rejected: it changes every statement's plans, not just the policy reads.

*Alternative to the `uid` parameter:* no-argument helpers that read `catalog.app_user_id()`
themselves. The plan names `(uid)`, and the parameter makes the helpers testable for any user. A
`catalog_user` caller could pass another id, but `catalog_user` only ever runs the app's fixed
SQL, so this is accepted and recorded in Risks.

### D2. The policies

The migration drops every `<table>_user_all` (`drop policy if exists`, so a re-apply works). It
then creates the policies below, all `to catalog_user`, permissive, and named
`<table>_user_<select|insert|update|delete|all>`. The table has 23 policies in all. Below,
`me` is `catalog.app_user_id()`, and `MEMBER`, `MANAGER`, `ACCESSIBLE`, `MEMBER_SHOWS` and
`CO_MEMBERS` are `(select catalog.<helper>(catalog.app_user_id()))`. Each one is a set
subquery, so Postgres evaluates it once per statement as a hashed subplan, not once per row.

| table | SELECT `USING` | INSERT `WITH CHECK` | UPDATE `USING` / `WITH CHECK` | DELETE `USING` |
| --- | --- | --- | --- | --- |
| `users` | `id = (select me) or id in CO_MEMBERS` | — (no policy, no privilege) | `id = (select me)` / same (columns `given_name`, `family_name` only) | — (no policy, no privilege) |
| `user_studio_memberships` | `studio_id in MEMBER` | — (no policy, no privilege) | `studio_id in MEMBER` / same | `studio_id in MEMBER` |
| `user_prefs` (one `for all` policy) | `user_id = (select me)` | same | same / same | same |
| `studio_definitions` | `id in MEMBER` | — (no policy) | `id in MEMBER` / same | `id in MEMBER` |
| `shows` | `studio_id in MEMBER` | `studio_id in MANAGER` | `studio_id in MANAGER` / same | — |
| `sessions` | `show_id in MEMBER_SHOWS` | `show_id in ACCESSIBLE` | `show_id in ACCESSIBLE` / same | — |
| `app_settings` | `key in (select 'studio_config:' \|\| s from catalog.member_studios(me) s)` | same with `manager_studios` | manager / manager | manager |
| `team_invites` | `studio_id in MEMBER` | — (no policy, no privilege) | `studio_id in MEMBER` / same | `studio_id in MEMBER` |
| `show_grants` (one `for all` policy) | `show_id in MEMBER_SHOWS` | same | same / same | same |
| `kv` | — | — | — | — |

Notes:
- **`kv`:** no `catalog_user` policy, and `revoke all on catalog.kv from catalog_user`. A
  user-bound statement on it then fails with `42501 permission denied for table kv` (A12), not
  silently empty. `kv_system_all` stays. The default privileges (6b-1) still grant future tables
  to both roles; catalog-database "Row-level security is enabled…" requires each new table's
  migration to choose.
- **No policy, so nothing.** `studio_definitions` INSERT (team creation is `team-create`),
  `shows` DELETE and `sessions` DELETE (no path deletes either; hiding a session is an UPDATE)
  have no policy, so `catalog_user` cannot do them. The plan's table says "member teams (create
  is system)" for definitions and "insert/update" for shows. Sessions follow shows.
- **Privileges narrow with the policies** (panel fix 1, owner decision B):

  ```sql
  revoke all on catalog.kv from catalog_user;
  revoke insert, update, delete on catalog.users from catalog_user;
  grant update (given_name, family_name) on catalog.users to catalog_user;
  revoke insert on catalog.user_studio_memberships, catalog.team_invites from catalog_user;
  ```

  - A user-bound `INSERT` into `users`, memberships or invites, a `DELETE` from `users`, or an
    `UPDATE` naming any other `users` column (`email`, `google_sub`, `picture_url`,
    `disabled_at_utc`, `id`) fails with `42501` before any policy is consulted.
  - `SELECT` on `users` stays table-wide, because the routes read `SELECT *`.
  - No user-bound path inserts into memberships or invites (A28). Team creation, invites, sign-up
    invite consumption, the bootstrap claim and the support plane do, and they run as
    `team-create`, `team-invite`, `oauth-callback`, `bootstrap-claim` and `support-plane`. The
    transfer and role changes are UPDATEs.
  - User creation is `oauth-callback`.
- **The name edit.** `authUpdateUserNames` today delegates to `authUpdateUserProfile`, whose one
  `UPDATE` sets `email`, `given_name`, `family_name` and `picture_url` (A29). Under the column
  grant that statement would fail. `authUpdateUserNames` gets its own statement,
  `UPDATE users SET given_name = ?, family_name = ? WHERE id = ? AND disabled_at_utc IS NULL`,
  returning `changes > 0`. It is the same outcome as today: false for a missing or disabled
  user, and the names written. `authUpdateUserProfile` keeps its four-column form for
  `oauth-callback` (system).
- **Settings keys.** The `app_settings` rules match the full key, so no global key (none is
  left, `20261004000000_team_owner.sql`) is readable by a user.
- **Updates.** For UPDATE, Postgres also applies the SELECT `USING` to the old row and, when the
  statement reads columns, to the new row (PostgreSQL 17 docs, "Policies Applied by Command
  Type"). A refused old row is skipped (A9); a refused new row is an error (A8). Every UPDATE rule above is at least as strict as
  its table's read rule, so the old row always passes. The new rows the app writes stay in the
  same team.

**`catalog_system`** keeps `<table>_system_all` on every table (owner decision 4).

### D3. Why the traps stay closed

- **`FOR SHARE` reads** need the row to pass both the SELECT and the UPDATE `USING` (A5). On
  `user_studio_memberships` both are `studio_id in MEMBER`. So the caller's own row and any
  target row in a member team lock as before, and a non-member gets no row (the masked `404` the
  routes already give). On `show_grants` both are `show_id in MEMBER_SHOWS`, so the granted
  member's own grant locks. `authCanAccessShowForShare` first reads the show's team from `shows`
  (member read rule), so it works for every show the member can see.
- **Transfer.** Both UPDATEs touch rows of the caller's team. After the demotion the caller is
  still a member (an admin), so the promotion passes `MEMBER` (A16). The one-owner index is
  unaffected.
- **Leave and removal.** `authRevokeGrantsInStudio` (`DELETE … USING shows`) runs before the
  membership delete, while the member still belongs to the team. The joined `shows` rows pass
  the member read rule, and the grants pass `MEMBER_SHOWS` (A15).
- **Team delete.** D5.
- **A multi-row delete** of every membership of a team in one statement deletes them all. The
  helper is `STABLE`, so it reads the statement's snapshot, which still holds the caller's
  membership (A7).

### D4. The migration, in two steps

`supabase/migrations/20261007000000_catalog_policies.sql` has a header naming ADR 0021 slice 6b-2,
and no transaction-control lines (every `begin`/`end` inside a DO block is indented, as in 6b-1).
Like 6b-1 (catalog-roles D1), it reaches its final form in two steps on this branch, so every
commit stays green:
- **Step 1** (task 2.2): the seven helpers (D1) with their grants, and the settings backfill
  (D7). The allow-all policies stay, so behaviour is unchanged. The helpers are only called by
  their tests and by the app's two existence checks (D6).
- **Step 2** (task 4.3): drop the `_user_all` policies, create D2's 23 policies, and apply D2's
  privilege changes (`kv`, `users` columns, no `INSERT` on memberships and invites).

The file is unmerged between the steps, so editing it is safe for test databases (each run
migrates fresh). `make dev-up` is not run on this branch before task 4.3, because a dev database
migrated in between would record step 1's text.

### D5. The team delete removes memberships last

`adminDeleteStudio`'s transaction becomes: count shows (refuse if any) → delete invites → delete
the definition → delete the settings key → delete the memberships. With today's order, the
memberships go second, so the definition and settings deletes, judged by `MEMBER` and `MANAGER`,
change 0 rows without an error. The owner would get `200 {ok: true}` with the team still defined
(A6). Nothing depends on the old order: memberships have no foreign key to definitions, and a
team with shows is refused first (so it has no grants). The admin plane (`support-plane`, system)
runs the same method, so both planes still cascade identically (team-management "Owner-anchored
team lifecycle").

*Alternative:* run the team delete as system. Rejected by owner decision 3 (no new system
sites), and unnecessary.

### D6. Existence probes keep their statuses

**`POST /api/shows`** (`shows.ts:208-221`). Inside the transaction:
```ts
if (!(await cat.studios.studioExists(body.studio_id))) {           // policy-scoped, unchanged SQL
  return (await cat.studios.studioExistsAnywhere(body.studio_id)) ? 404 : 400;
}
const role = await cat.auth.authGetMembershipRoleForShare(user.id, body.studio_id);
… unchanged
```
`studioExistsAnywhere(id)` is a new `StudioRegistry` method, `SELECT catalog.studio_exists(?) AS
e`. It is executable only on a user binding; no system path calls it. The outcomes are:
- a member team: as today;
- a foreign team: the policy hides the definition, the helper says it exists, so `404`, as today;
- a missing team: `400`, as today;
- the race in `teams.race.int.test.ts:443`: the create holds after `studioExists`, the delete
  commits, the `FOR SHARE` read fails with `40001`, and the re-run's `studioExists` is false. The
  helper is false too (the definition is gone), so `400 Unknown studio id.`, as team-management
  "No show for a deleted team" requires (A21).

The plan said to use the snapshot's `isKnownStudio` instead. That answers `404` in the race,
because the snapshot predates the delete (proposal "For the approver", OQ2).

**`POST /api/sessions`** (`sessions.ts:173-177`):
```ts
const showRow = await catalog.shows.getShowRow(showId);
if (showRow === null) {
  if (await catalog.shows.showExistsAnywhere(showId)) {
    throw new ApiError(400, 'Show does not belong to the active team.');
  }
  throw new ApiError(400, 'Unknown show_id.');
}
… unchanged
```
A show the policy hides is in a team the caller is not a member of, so it can never be in the
caller's active team. The today-message is therefore exact. `showExistsAnywhere` is a new
`ShowsStore` method, `SELECT catalog.show_exists(?) AS e`.

**Other probes, checked and unchanged** (A14). Each answers the same for "missing" and "in a
foreign team" today, or reads only the caller's own rows:
- `GET /api/shows/:id`, `requireTeamShow` and `requireSession`/`requireShowAccess`: masked
  `404`s;
- `PUT /api/profile` `show_updates`: one `400` text for a missing or foreign show;
- `GET /api/shows?studio_id`: snapshot `400`, own-membership `404`;
- the team routes: own membership, then target rows in a member team.

### D7. Settings: no write on read, seeded at creation, backfilled once

- **`getStudioSettingsBlob(id)`** becomes a pure read:
  `parse(await this.getSetting(studioConfigKey(id))) ?? base`. It does no
  `INSERT … ON CONFLICT DO NOTHING`, no conditional `UPDATE` of a corrupt row, and no
  `studioExists` read. The returned value is unchanged for a valid row. For a missing or corrupt
  row it is `base` (`defaultSettingsBlob(id)`), which is also what today's self-heal returns
  after writing.
- **`insertStudioDefinition(sid, disp)`** (team creation on both planes, inside its
  transaction) replaces `DELETE FROM app_settings WHERE key = ?` with
  `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value =
  excluded.value`. The value is
  `JSON.stringify(validateSettingsBlob(defaultSettingsBlob(sid), sid, () => true))`, the same
  normalized shape a save stores. A leftover row under a reused id is overwritten, so
  team-management's "settings left under the id SHALL be removed … default settings" still holds.
  `seedStudio` in the integration helpers creates teams through `adminCreateStudio`, so test teams
  get rows too (A20).
- **Backfill (migration step 1).** The default blob draws fresh category ids on every call (A18).
  A team with no row would therefore show new ids on every load once reads stop writing. Teams
  that exist before this migration (dev and stage teams never loaded, and the two seed teams)
  could have no row. The migration runs:
  ```sql
  insert into catalog.app_settings (key, value)
  select 'studio_config:' || d.id,
         jsonb_build_object(
           'categories', jsonb_build_array(
             jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Scene', 'color', '#4a9fd4',
               'type', 'BUTTON', 'dropdown_options', '[]'::jsonb, 'on_label', '', 'off_label', ''),
             jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Audio issue', 'color', '#a86bdc',
               'type', 'DROPDOWN', 'dropdown_options', jsonb_build_array(
                 jsonb_build_object('label', 'Lav', 'needs_context', false),
                 jsonb_build_object('label', 'Boom', 'needs_context', false)),
               'on_label', '', 'off_label', ''),
             jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Note', 'color', '#6bcf7a',
               'type', 'TEXT', 'dropdown_options', '[]'::jsonb, 'on_label', '', 'off_label', '')),
           'show_title_format', '', 'default_frame_rate', 24.0)::text
  from catalog.studio_definitions d
  on conflict (key) do nothing;
  ```
  A `pg` test keeps the two definitions in step: it parses a backfilled row, strips the category
  ids, and compares the result with `defaultSettingsBlob('x')` (ids stripped) after the server's
  `validateSettingsBlob`. The test also checks that the ids are distinct UUIDs. A future change
  to the defaults that forgets the migration's copy fails that test only while the test database
  is built from this migration. That is the intent: it pins the backfill as written.
- **The catalog-database requirement is MODIFIED**, not removed. Reading writes nothing, so it is
  trivially race-free and never recreates a deleted team. Its scenarios and
  `settingsDefaults.int.test.ts` change with it (task 3.1).
- With no write on read, the `app_settings` write rules can be `MANAGER` without breaking a plain
  member's profile load. That is why owner decision 2 precedes the policies.

### D8. Writes a policy could refuse: route by route

The "Gate" column says how the route checks access before the write. "Locked" means the check
runs inside the write's transaction with the rows `FOR SHARE`, so no concurrent change can make
the policy disagree; a `42501` or a 0-row result there is a bug.

| route | write (store method) | gate | policy outcome if it disagrees | answer |
| --- | --- | --- | --- | --- |
| `PUT /api/profile` | `authUpdateUserNames` (own `users` row, the two name columns, D2) | none needed | cannot disagree | unchanged |
| | `saveStudioSettingsBlob`, `updateShowFields` | **locked**: one transaction re-reads the caller's role `FOR SHARE` before the first write (below) | a demotion that committed first: the re-check answers `403` before any write; a `42501` or 0-row result after it is a bug | `403 Admin role required.`, nothing written; bug → generic `500` + log |
| | `authSetPrefs` (own `user_prefs`) | — | cannot disagree | unchanged |
| `GET /api/profile`, `GET /api/sessions` | `authEnsurePrefsRow`, `authSetPrefs`, `authReplaceActiveShowIf` (own row) | — | cannot disagree | unchanged |
| `POST /api/shows` | `createShow` | locked (`FOR SHARE` role) | bug | generic `500` + log |
| `POST /api/sessions` | `createSessionForShow` | locked (`authCanAccessShowForShare`) | bug | generic `500` + log |
| `PUT /api/sessions/:id` | `updateSessionIndex` (tx: read row, UPDATE) | `requireSession`, root | revoked or demoted meanwhile: the read still sees the row (team-level), the UPDATE changes 0 | **`404 Session not found`**: `updateSessionIndex` returns `null` when the UPDATE changed 0 rows (today it would return the unchanged row with `200`) |
| `POST …/archive`, `…/restore`, `DELETE /api/sessions/:id` | `setSessionArchived`, `setSessionUiHidden` | `requireSession`, root | 0 rows | `404 Session not found` (existing code) |
| YouTube import | `setSessionEpisodeDate` | `requireSession` | 0 rows | unchanged: a missed date is already a no-op by design; the import still answers `200` |
| team rename, delete, invite revoke, grant `PUT`/`DELETE`, role change, remove, leave, transfer | per D3, D5 | locked (`requireTeamRoleIn`, target `FOR SHARE` or in-tx target read) | bug | generic `500` + log; the existing `false` → `404 Member not found` checks stay |
| transfer target read | `authGetUserRowAny` | in-tx membership read | `null` (only by a bug: a co-member is always readable) | **`404 Member not found`** (today `null` passes as "not disabled") |
| `POST /api/teams`, invite | system (`team-create`, `team-invite`) | — | system policies allow all | unchanged |

- **`PUT /api/profile` in one transaction** (panel fix 3). api-contract-freeze "Show creation
  and team settings need owner or admin" says a member gets `403` and "nothing SHALL be
  written". A demotion committing between the early check and the writes would otherwise
  produce a partial write, or a policy refusal half-way. When `settings` or `show_updates` is
  present, the route keeps its early checks unchanged (statuses and their order), then runs:
  ```ts
  const r = await catalog.tx(async (cat) => {
    const role = await cat.auth.authGetMembershipRoleForShare(user.id, rawSid);
    if (role !== 'owner' && role !== 'admin') return { status: 403, detail: 'Admin role required.' } as const;
    if (body.settings != null) await cat.studios.saveStudioSettingsBlob(rawSid, body.settings);
    for (const ent of body.show_updates ?? []) {
      const row = await cat.shows.getShowRow(sid);           // as today, per entry
      if (row === null || String(row.studio_id) !== rawSid) {
        return { status: 400, detail: `Show '${ent.show_id}' is not part of the selected team.` } as const;
      }
      … build fields as today; if (Object.keys(fields).length) await cat.shows.updateShowFields(sid, fields);
    }
    return null;
  });
  if (r) return c.json({ detail: r.detail }, r.status);
  ```
  - A body returned (not thrown) from the transaction commits. So a serial request with an
    invalid show entry keeps today's outcome exactly: the settings and earlier show entries are
    saved, then `400` (no change for serial requests).
  - The `403` path writes nothing, because it returns before the first write.
  - A `ValidationError` from the save still propagates (rolling back) to the existing `400`
    mapping. Before this slice, a later failure could not undo an earlier save. Now a thrown
    validation error rolls back the transaction's writes, but the save is the first write, so
    nothing earlier exists.
  - Prefs and the name edit stay after the transaction, as today.
  - The transaction is `SERIALIZABLE` and may retry. The body is re-runnable: its only side
    effects are catalog writes.
- **Logging.** Every `500` from `CatalogForbiddenError` keeps `app.ts`'s redacted log line (name,
  code, table, binding).

### D9. The contract: serial requests unchanged, one race narrowed

For every request a serial order of requests can produce, every route returns what it returned
before, and writes what it wrote:
- the gates run first;
- D6 keeps both probes;
- D5 and D3 keep the multi-step writes working;
- D7 returns the same settings values;
- D8's `PUT /api/profile` transaction keeps the serial outcomes, including the partial save
  before a `400`.

What does change is the outcome of a write whose access is revoked while the request is in
flight. Before this slice, such a session write, or the profile's settings and show writes, went
through with `200`. Now it gets the route's existing no-access answer and changes nothing:
- `404 Session not found` for `PUT /api/sessions/:id`, `…/archive`, `…/restore` and
  `DELETE /api/sessions/:id`;
- `403 Admin role required.` for `PUT /api/profile`;
- the YouTube import's publish date is not written (the import still answers `200`, as for any
  missed date).

That is observable, so it gets an ADDED `api-contract-freeze` requirement ("Writes whose access
is revoked in flight change nothing"). It is modeled on "Concurrent first sign-in succeeds", which
narrows another requirement "only for this race". The panel's fix 2 replaced this section's
earlier claim of no delta.

`team-management` needs none:
- "No show for a deleted team" keeps `400` (D6);
- "Concurrent team writes" still removes leftover settings, now by overwriting them with
  defaults;
- its "Cross-team independence" is stated per request. Under owner decision A, a cross-team
  `40001` is retried inside the adapter and reaches no request while the retry budget holds; D11's
  stop rule watches that budget.

The full integration suite, with no existing HTTP status, body or WebSocket assertion changed,
is the proof for serial requests (task 4.4). The new race tests pin the narrowed outcomes.

### D10. Tests

**Fixture (`pg`, shared by the matrix and helper tests).** One cloned database seeded as
`catalog_system` with:
- users `owner`, `admin`, `granted`, `ungranted` (the members of team T) and `outsider` (the
  owner of team U);
- an empty team V owned by `owner`;
- shows `S1` and `S2` in T, and `SU` in U;
- a grant `granted → S1`;
- sessions `ss1` (S1), `ss2` (S2) and `ssU` (SU);
- settings rows for T and U;
- invites in T and U;
- prefs for `granted` and `outsider`;
- one `kv` row.

Each case runs in its own transaction on a `catalog_user` connection with
`set_config('app.user_id', …, true)`, and rolls back, so cases don't interact.

**Allow/deny matrix** (`server/src/test/pg/catalogPolicies.pg.test.ts`). The expectations are a
data table in the test: for each of the 10 tables × 4 commands × 6 actors (the five users and
"no user id"), the expected outcome. The outcome is a set of visible ids (SELECT), a count of
affected rows (UPDATE/DELETE, run with `RETURNING` to count), or `42501` (INSERT, or an UPDATE
whose new row leaves the rule). The writes target one row of T, one of U and one of the actor's
own. The table is generated from the catalog-database rule table, not from the policies, so a
policy typo fails it. Also in this file:
- the `FOR SHARE` cases (own membership, target membership, own grant; a non-member gets none);
- the transfer, team-delete (in the D5 order) and leave sequences of the spec scenario;
- `kv` refused for `catalog_user` and allowed for `catalog_system`;
- the privilege cases (D2): own `users` row: `UPDATE` of `given_name`/`family_name` affects 1
  row; `UPDATE` of `email`, `google_sub`, `picture_url` or `disabled_at_utc`, `INSERT` and
  `DELETE` each fail with `42501`; `INSERT` into `user_studio_memberships` and `team_invites`
  fails with `42501` for every actor, the owner of the target team included;
- the one-owner index: a member updating their own membership to `owner` in a team that has an
  owner fails with `23505` (`idx_user_studio_memberships_one_owner`, A30). Updating it to `admin`
  succeeds, which is the recorded escalation (Risks);
- no `catalog_user` policy with a constant-`true` expression (`pg_policies.qual`/`with_check`);
- every table except `kv` has a `catalog_user` policy;
- the old D5 order leaves the definition behind (documents why the order changed).

**Helpers** (`server/src/test/pg/catalogPolicyHelpers.pg.test.ts`):
- each helper's exact set or boolean for each actor, null, and an unknown id;
- `prosecdef` true, and `proconfig` containing `search_path=pg_catalog, pg_temp` and
  `enable_seqscan=off`;
- the owner is `postgres`;
- `has_function_privilege` false for `public`, `catalog_system`, `autologger_app`, `anon`,
  `authenticated` and `service_role`, and true for `catalog_user`;
- the backfill shape test (D7).

These run first against step 1 (allow-all policies still in place), where they don't depend on
policies.

**Statistics** (panel fix 4). A test database is a clone of `autologger_template`, and nothing in
the test setup runs `ANALYZE` (A31). The rows each test seeds are far below autovacuum's analyze
threshold (50 rows plus 10%), so the planner plans with no statistics for them. Plans, and so
predicate-lock granularity, can differ from a database with statistics. So:
- the former lock-granularity assertion (no relation-level `SIReadLock`) is dropped. On an
  unanalyzed clone it could pass or fail for reasons unrelated to the policies;
- the contention test and the probe run on a clone after `ANALYZE` (as `postgres`, after
  seeding). The probe also keeps its unanalyzed mode, for comparison with 6b-1's numbers.

**Cross-team contention** (`server/src/test/pg/catalogContention.pg.test.ts`, written in task 1.4
so it also measures the 6b-1 baseline; owner decision A). After
seeding and `ANALYZE`, two user-bound transactions run through one `PostgresCatalogDb`
(`bindUser(...).tx`, so the adapter's retry loop applies), wrapped in a `RetryCountingRoot`
(D11). They are run by the owners of T and U. Each:
- reads its membership `FOR SHARE`;
- updates a session of its team;
- creates a show;
- updates its team's definition.

A barrier makes each wait until both have written before either commits. The test asserts that
both calls resolve, and that both teams' rows hold the written values. No call is exhausted
(`runs` < `maxTries`). It reports the retries counted; it does not assert that none occurred.

**Integration** (new cases; every existing assertion unchanged):
- `server/src/test/settingsDefaults.int.test.ts`, rewritten to the MODIFIED requirement:
  - five concurrent first loads return the same ids, and one row exists (the seeded row);
  - a read with the row deleted writes nothing and returns defaults;
  - a corrupt row is returned as defaults and stays corrupt;
  - a stale-snapshot read of a deleted team writes nothing;
  - `POST /api/teams` and `POST /api/admin/studios` store exactly one default row.
- `server/src/routers/catalogPolicies.int.test.ts`:
  - a plain member's `GET /api/profile` on a team with no settings row (row deleted by
    `testDb()`) is `200` and writes nothing;
  - `POST /api/shows` for a foreign team is `404 Unknown studio id.`, for a missing team
    `400`;
  - `POST /api/sessions` for a foreign-team show is `400 Show does not belong to the active
    team.`;
  - a transfer to a non-member target, and to a user id that does not exist, is
    `404 Member not found`;
  - a leave removes the member's grants in that team (and not in another team);
  - `DELETE /api/teams/:id` leaves no invite, definition, settings or membership row;
  - the D8 race cases, each with a `GatedCatalog` hold:
    - a grant revoked between `requireSession` and the session update gives `404` with the
      row unchanged;
    - an admin demoted between the route's early role check and its transaction gives
      `403 Admin role required.` with the settings and the show unchanged and the prefs and
      names not written either (the `PUT /api/profile` transaction, D8);
    - a granted member's grant revoked between `requireSession` and an archive gives `404` with
      the row unchanged.
  - a plain member's name edit (`PUT /api/profile` with `given_name`) still works under the
    column grant.
- Before the policies land (task group 3), each D8 mapping is tested with a test-only
  `CatalogRoot` wrapper (`server/src/test/rewritingCatalog.ts`). The wrapper rewrites one
  matching statement's outcome: 0 changes, no row, or a thrown `CatalogForbiddenError`. The
  profile race is tested in group 3 with a `GatedCatalog` hold, since it needs no policy: the
  in-transaction re-check alone produces the `403`. So the
  route's answer is pinned before any policy can produce the outcome, and the race cases above
  then show the policies producing it.
- The existing race (`teams.race.int.test.ts:443`) and probe (`sessions.int.test.ts:668-672`)
  tests stay unchanged. They are the D6 proof under policies.

### D11. Counting retries without a production hook, and the retry stop rule

The 6b-1 panel cut a production `onRetry` hook, because it was an untraced API with nothing to
measure. This slice measures with a test-only wrapper and adds no production surface.
- **The wrapper.** `server/src/test/retryCounter.ts` exports `RetryCountingRoot implements
  CatalogRoot`. It wraps `bindUser`/`bindSystem` handles; their `tx(fn)` calls the inner
  `tx(async (t) => { runs++; try { return await fn(t) } catch (e) { codes.push(e.code); throw e } })`.
  - The adapter re-runs the body on a `40001` or `40P01` (core-ports-architecture "The Postgres
    catalog adapter"), so `runs - 1` is the number of retries of one call.
  - A retry with no code recorded is a commit-time failure.
  - A call that rejects with `40001`/`40P01` after `maxTries` runs (5, the adapter's default)
    is recorded as `"exhausted": true`.
  - Nested `tx` calls join the open transaction through the adapter's handle, not the wrapper,
    so they are not double-counted.
- **The output.** Each settled call appends one JSON line `{ "runs": n, "codes": [...],
  "exhausted": bool }` to the file it is given (`$CATALOG_RETRY_LOG` in the harness). One small
  `appendFileSync` per call is atomic under `O_APPEND`, which is safe across vitest workers.
- **The wiring.**
  - `server/src/test/harness.ts` `resetTestEnv()` wraps `bindings.ports.catalog` when
    `CATALOG_RETRY_LOG` is set. `GatedCatalog(env.ports.catalog)` then wraps the counting root,
    so gated races count too.
  - The probe (D12) and the contention test (D10) wrap their own adapter the same way.
- **Scope.** KV and the session mirror hold their own handles from `createBindings` and use only
  root statements, which never retry, so nothing is missed. The other `pg` suites build their own
  adapters and run for pass/fail only.
- **Summary.** `jq -s '{calls: length, retries: (map(.runs - 1) | add), rate: ((map(.runs - 1) |
  add) / length), exhausted: (map(select(.exhausted)) | length), by_code: (map(.codes[]) |
  group_by(.) | map({(.[0]): length}) | add)}' <log>`, recorded per run in the evidence.
- **Before and after.** Measured on this branch with the 6b-1 policies (group 1) and after
  step 2 (group 5), each in three places:
  - 5 integration-plus-`pg` runs;
  - the contention test, after `ANALYZE` (D10; 5 runs). Before step 2 it runs against the
    6b-1 allow-all policies;
  - the probe, after `ANALYZE` and without (D12).
- **Stop rule** (owner decision A): stop and ask the owner before archiving if either holds:
  - in any of the three, the median retry rate (retries per transaction call) after is more
    than double the median before. With a zero baseline, any retry counts as more than double,
    and is reported with its codes;
  - any call is `exhausted` in the integration runs, the contention test or the probe.

### D12. The probe rerun

The 6b-1 probe (`server/src/test/pg/catalogRootProbe.pg.test.ts`, skipped unless
`CATALOG_ROOT_PROBE=1`) already builds the request as the middleware does: system resolution,
KV on `kv`, and the route mix on `forUser`. After step 2 its route statements run under the real
policies with no code change. Its seed user is the owner of the seeded team, so the
session-update transaction is allowed.

Task 1.3 adds two test-only options to it:
- `CATALOG_PROBE_ANALYZE=1` runs `ANALYZE` on the clone (as `postgres`) after seeding;
- its adapter is wrapped in `RetryCountingRoot`, and its JSON line gains `retries`, `rate` and
  `exhausted`.

It runs 5 times in each mode, before (task 1.3) and after (task 5.4).

**Stop rules:** stop and ask the owner before archiving if any of these holds:
- the median root `p95` in the unanalyzed mode is above 11.7 ms (2 × 6b-1's after-median of
  5.85 ms; owner, 6b-1 decision B);
- any run in either mode shows `timeouts > 0`;
- D11's retry rule fires.

The fresh before-runs let machine drift be told apart from the policies' cost.

### D13. Docs

- **ADR 0021, item 6, the 6b-2 entry** (replacing the outline). It records:
  - the owner decisions and the approver confirmations;
  - the 23 policies, the narrowed privileges (`kv`, `users` columns, memberships and invites
    insert) and the 7 helpers, with why `enable_seqscan = off` is kept;
  - owner decisions A (cross-team retries accepted, the retry stop rule) and B (system-only
    inserts), and the within-team escalations left to the app (Risks);
  - the settings change and the backfill;
  - the D5 and D8 route changes;
  - the retry and probe numbers;
  - the rollback SQL (Migration Plan);
  - why each of the 12 system reasons stays system. Each needs rows outside the caller's teams,
    or has no user at all:

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

  The entry also corrects the 6b-1 outline in two places:
  - it had planned to move `team-create`, `team-invite`, `access-loss-check` and
    `log-import-job` to user scope (owner decision 3 keeps them system);
  - it had planned to map `CatalogForbiddenError` to masked `404`/`403` (owner decision 4
    keeps each route's existing status).
- **`docs/supabase.md`'s role table.**
  - `catalog_user`: "DML under the 6b-2 policies on every catalog table except `kv` (none);
    `users`: `SELECT` and `UPDATE (given_name, family_name)`; no `INSERT` on memberships and
    invites; executes the policy helpers".
  - `catalog_system`: unchanged.

### D14. Every commit stays green

1. The retry counter, the probe options, the contention test and every baseline, on unchanged
   code (the contention test passes under allow-all).
2. Migration step 1: helpers and backfill; helper tests. Allow-all is still in place.
3. App changes (D5-D8), each test-first; all green under allow-all.
4. Migration step 2: policies and privileges, with the matrix and the new integration cases; the
   full suites green.
5. Docs, then verification.

The matrix's deny cases are red against step 1 and are committed with step 2, as 6b-1 committed
its schema tests with its migration. The red run is recorded in the evidence.

## Assumptions

Probe setup (2026-10-03): a throwaway container of the pinned image
(`docker run -d --rm --name cp-probe … supabase/postgres:17.6.1.136 postgres -c
config_file=/etc/postgresql/postgresql.conf`, removed afterwards; dev, stage and the test
container untouched). Databases `p1` and `p3` were migrated with `docker/supabase/migrate.sh`
(`6 applied`). They were seeded as `postgres`:
- users `o1` (owner of t1 and t3), `a1` (admin of t1), `g1` (member of t1 with a grant on s1),
  `u1` (member of t1) and `x1` (owner of t2);
- shows `s1` and `s3` in t1, and `s2` in t2;
- sessions `ss1`, `ss3` and `ss2`;
- settings for t1 and t2;
- invites in t1 and t2.

A draft of D1 and D2 was applied to both. On `p1` the first draft had plain subqueries for the
`sessions`, `show_grants` and `users` reads and three helpers; on `p3` it was the final draft.
Each statement ran as `autologger_app` inside `begin; select set_config('role','catalog_user',true),
set_config('app.user_id','<uid>',true); …; rollback;`.

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | Routes get `forUser(id)` after system resolution; the snapshot is loaded as system | `grep -n "system('auth-resolve')\|forUser" server/src/middleware/auth.ts` | `19:  const sys = createCatalog(c.env.ports.catalog).system('auth-resolve');` `24:  c.set('catalog', user ? sys.forUser(user.id) : sys.unbound());` |
| A2 | The `FOR SHARE` sites | `grep -n "authGetMembershipRoleForShare\|authCanAccessShowForShare" server/src/routers/*.ts \| grep -v test` | `teams.ts:96`, `teams.ts:304` (target), `teams.ts:387`, `shows.ts:79`, `sessions.ts:201` |
| A3 | Transfer demotes then promotes in one transaction | `sed -n 384,400p packages/catalog/src/authStore.ts` | `UPDATE … SET role = 'admin' … AND role = 'owner'`, then `UPDATE … SET role = 'owner' WHERE studio_id = ? AND user_id = ?`, inside `this.db.tx` |
| A4 | Team delete order today | `sed -n 275,285p packages/catalog/src/studioRegistry.ts` | invites, `user_studio_memberships`, `studio_definitions`, `app_settings` |
| A5 | `FOR SHARE` passes on own and target rows of a member team, and returns nothing to a non-member | `q.sh u1 "select role … where user_id='u1' and studio_id='t1' for share; select role … where user_id='g1' … for share;"`; `q.sh x1 "select coalesce((select role … user_id='o1' and studio_id='t1' for share),'<none>');"`; `q.sh g1 "select 1 from show_grants where user_id='g1' and show_id='s1' for share;"` | `member`, `member`; `<none>`; `1` |
| A6 | The old delete order silently keeps the definition; the D5 order removes it | as `o1` on t3: `with d as (delete … returning 1) select count(*) from d` for invites, memberships, definitions; then definitions, memberships | old: `0`, `1`, `0`; D5: `1`, `1` |
| A7 | A one-statement delete of all a team's memberships removes them all (the `STABLE` helper reads the statement snapshot) | `q.sh o1 "with d as (delete from user_studio_memberships where studio_id='t1' returning 1) select count(*) from d;"` | `4` |
| A8 | An upsert refused by a policy is `42501`, on both `ON CONFLICT DO UPDATE` and `DO NOTHING` | `q.sh u1 "\set VERBOSITY verbose` `insert into app_settings … on conflict(key) do update …"`; `q.sh g1 "insert into app_settings values ('studio_config:t1','y') on conflict (key) do nothing;"`; as `a1` the same upsert | `ERROR:  42501: new row violates row-level security policy for table "app_settings"`; the same error; `a1`: succeeds |
| A9 | A refused UPDATE changes 0 rows without an error | `q.sh u1 "with d as (update sessions set title='z' where id='ss1' returning 1) select count(*) from d; … update shows …"`; `q.sh g1` same on sessions | `0`, `0`; `1` |
| A10 | Plain policy subqueries take relation-level predicate locks; the helpers with `enable_seqscan = off` take page/tuple locks | `begin isolation level serializable; …; update sessions set title='q' where id='ss1'; select locktype, relation::regclass, count(*) from pg_locks where mode='SIReadLock' and pid=pg_backend_pid() group by 1,2` (on `p1`, then on `p3`; also `select id from users where id='a1'` as `o1`) | `p1`: `relation\|shows\|1`; the co-member read: `relation\|user_studio_memberships\|1`. `p3`: `page\|shows`, `page\|user_studio_memberships`, `page\|idx_shows_studio`, `tuple\|users`, … no `relation` row |
| A11 | No user id sees nothing | `q.sh "" "select (select count(*) from users),(select count(*) from shows),(select count(*) from sessions),(select count(*) from user_studio_memberships);"` | `0\|0\|0\|0` |
| A12 | `kv` revoked from `catalog_user` fails loudly | `q.sh u1 "select count(*) from kv;"` | `ERROR:  permission denied for table kv` |
| A13 | Helper privileges and configuration | `select p.proname, has_function_privilege('public', p.oid, 'execute'), …('catalog_system'…), …('catalog_user'…), p.prosecdef, p.proconfig from pg_proc p where p.pronamespace='catalog'::regnamespace` | each helper `f\|f\|t\|t\|{"search_path=pg_catalog, pg_temp",enable_seqscan=off}`; `app_user_id\|f\|t\|t\|f\|` |
| A14 | Visibility per actor (users, shows, sessions, grants, settings, definitions) | `for u in o1 a1 g1 u1 x1; do q.sh $u "select (select string_agg(id, ',' order by id) from users), …"; done` | `o1`: `a1,g1,o1,u1\|s1,s3\|ss1,ss3\|g1>s1\|studio_config:t1\|t1,t3`; `a1`, `g1`, `u1`: the same with `t1` only; `x1`: `x1\|s2\|ss2\|\|studio_config:t2\|t2` |
| A15 | A leave deletes own grants, then the membership | `q.sh g1 "with d as (delete from show_grants g using shows s where … g.user_id='g1' returning 1) …; with d as (delete from user_studio_memberships where user_id='g1' and studio_id='t1' returning 1) …"` | `1`, `1` |
| A16 | Transfer succeeds under member rules | `q.sh o1 "update … set role='admin' where studio_id='t1' and user_id='o1' and role='owner'; update … set role='owner' where studio_id='t1' and user_id='a1'; select user_id\|\|':'\|\|role …"` | `a1:owner`, `g1:member`, `o1:admin`, `u1:member` |
| A17 | Pinned server version | `select version()` | `PostgreSQL 17.6 on aarch64-unknown-linux-gnu` |
| A18 | The default settings draw fresh category ids per call | `sed -n 79,81p;147,189p packages/domain/src/studio.ts` | `return crypto.randomUUID();`; `id: newId(), name: 'Scene', color: '#4a9fd4', type: 'BUTTON'` …; `defaultSettingsBlob` returns `{ categories: defaultCategoriesForNewStudio(), show_title_format: '', default_frame_rate: 24.0 }` |
| A19 | Plain members reach the settings read | `grep -rn "getStudioSettingsBlob\|loadStudioProfile\|allStudioSettingsForAllowedStudios" packages server/src --include=*.ts \| grep -v test` | `profileAssembler.ts:72`, `:130`, `:140`; `sessionIndexStore.ts:408`; `studioRegistry.ts:175`, `:186` |
| A20 | Test teams are made through `adminCreateStudio`, so creation seeding covers them | `sed -n 26,30p server/src/test/helpers.ts` | `await catalogFor().studios.adminCreateStudio(id, opts.name ?? …)` |
| A21 | The frozen probe and race outcomes are asserted | `sed -n 443,461p server/src/routers/teams.race.int.test.ts; sed -n 664,673p server/src/routers/sessions.int.test.ts` | `expect(res.status).toBe(400); … { detail: 'Unknown studio id.' }`; `'Unknown show_id.'`, `'Show does not belong to the active team.'` |
| A22 | The helper reads have indexes, so no new index is needed | `grep -n "primary key\|create index\|create unique index" supabase/migrations/*.sql` | `user_studio_memberships` PK `(user_id, studio_id)`; `idx_user_studio_memberships_studio`; `show_grants` PK `(user_id, show_id)`; `idx_show_grants_show`; `idx_shows_studio`; `idx_sessions_show`; `studio_definitions`, `shows` PK `id` |
| A23 | No user-bound statement touches `kv` | `grep -rn "new KvStore" server/src packages --include=*.ts \| grep -v test`; `grep -rn "FROM kv\|INTO kv\|UPDATE kv" packages/catalog server/src --include=*.ts \| grep -v test` | `server/src/node/config.ts:50:  const kv = new KvStore(catalogDb.bindSystem('kv'), clock);`; only `server/src/waitForCatalog.ts:34` (`boot-wait`) |
| A24 | `42501` is a distinct error answered with the generic 500 | `grep -n "42501" packages/storage/src/postgresCatalogStore.ts; grep -n "Internal Server Error\|CatalogForbidden" server/src/app.ts` | `179:  if (error instanceof postgres.PostgresError && error.code === '42501')`; `139:  if (e?.name === 'CatalogForbiddenError')`, `227:    return c.json({ detail: 'Internal Server Error' }, 500);` |
| A25 | Zero-row results the routes ignore today | `sed -n 101,103p server/src/routers/profile.ts; sed -n 298,305p packages/catalog/src/sessionIndexStore.ts` | `await catalog.shows.updateShowFields(sid, fields);` (result unused); `UPDATE sessions SET title = ?, start_offset_frames = ? WHERE id = ?` then `return s.getSessionIndexRow(…)` (no change count) |
| A26 | After a team write, the registry refresh runs on the user catalog, and nothing in that request reads the snapshot afterwards | `grep -n "refreshAfterWrite" -A2 server/src/routers/teams.ts` | `:142` create, `:198` rename, `:219` delete, each followed only by `return c.json(…)` built from local values |
| A27 | The integration harness owns the bindings, so a test-only wrapper can sit in front of the adapter | `sed -n 25,28p;87p server/src/test/harness.ts` | `const db = (await createTestDatabase()).app;` … `current = { ...made, dir, defaultUser: null };` |
| A28 | No user-bound path inserts into memberships or invites | `grep -rn "authAddMemberships\|authUpsertInvite\|authAddMembershipWithRole\|authUpsertMembershipRole\|authClaimOwnerlessStudios" server/src --include=*.ts \| grep -v test` | `teams.ts:136` (inside `system('team-create')`), `teams.ts:248` and `:259` (inside `system('team-invite')`), `auth.ts:245` (`oauth-callback`), `auth.ts:283` (`bootstrap-claim`), `admin.ts:116` (`support-plane`); `authAddMemberships` has no production caller |
| A29 | The user-path name edit writes four `users` columns today | `sed -n 164,191p packages/catalog/src/authStore.ts`; `grep -rn "authUpdateUserNames\|authUpdateUserProfile" server/src --include=*.ts \| grep -v test` | `UPDATE users SET email = ?, given_name = ?, family_name = ?, picture_url = ? WHERE id = ?`; `authUpdateUserNames` → `this.authUpdateUserProfile(userId, { givenName, familyName })`; callers `profile.ts:50`, `:127` (user), `auth.ts:264` (`oauth-callback`) |
| A30 | At most one owner per team is enforced by a partial unique index | `grep -n "one_owner" -A1 supabase/migrations/20261004000000_team_owner.sql` | `create unique index idx_user_studio_memberships_one_owner` `on catalog.user_studio_memberships (studio_id) where role = 'owner';` |
| A31 | Test clones carry no statistics for seeded rows | `grep -rni "analyze" test/pg server/src/test packages/storage/src/test` | no output; clones come from `create database … template autologger_template` (`test/pg/testDb.ts`) |

## Risks / Trade-offs

- **[More `40001` retries, across teams]** Policy reads add predicate locks to every user-bound
  `SERIALIZABLE` transaction (memberships, shows of member teams, grants). A transaction can
  therefore abort because of a transaction in another team. Owner decision A accepts this: the
  adapter retries, and no abort reaches HTTP while the budget holds. Mitigations:
  - the helpers read through indexes where the planner allows (D1, A10, A22);
  - the contention test commits through the retry loop on an `ANALYZE`d clone (D10);
  - the retry stop rule against a same-branch baseline (D11).

  On tiny test tables a page lock covers the whole table, so the integration counts are a
  pessimistic bound.
- **[Within-team escalation is the app's job]** The policies hold the team boundary, not the
  role inside a team. A user-bound statement could, as far as the database is concerned:
  - update the caller's own membership role to `admin`;
  - delete other members' memberships, grants or invites in a member team;
  - update invites or memberships in a member team.

  Raising oneself to `owner` while the team has one fails with `23505` on
  `idx_user_studio_memberships_one_owner` (A30). Inserts into memberships and invites are
  refused outright (owner decision B). Everything else above is covered only by the app's
  in-transaction gates (`requireTeamRoleIn` with `FOR SHARE`, the target re-checks), as decided
  in owner decision 1.
- **[Statement cost]** Each user-bound statement on a policy table runs its helpers once
  (hashed subplan). The probe (D12) carries the stop rule. Root statements are `READ COMMITTED`,
  so they take no predicate locks.
- **[Definer helpers bypass RLS]** Their `WHERE` clauses are the whole check, so the risk is a
  wrong body. Mitigations:
  - each helper is one short query, reviewed in D1;
  - exact-set tests (D10);
  - `search_path` pinned, schema-qualified names, `EXECUTE` for `catalog_user` only;
  - the `uid` parameter lets a `catalog_user` caller ask about another user. That caller only
    runs the app's fixed SQL; a no-argument variant is OQ1's alternative.
- **[The existence helpers are oracles]** `studio_exists` and `show_exists` answer for any id. The
  two routes already reveal the same fact through their statuses (A21), and the registry snapshot
  already holds every team id. No other caller is added.
- **[A policy refusal hidden as a 404]** Zero-row session writes are mapped to the existing
  `404` (D8). The race tests pin each mapping.
- **[The registry refresh after a team write sees member teams only]** `refreshAfterWrite`
  re-reads `studio_definitions` on the user catalog. The request's snapshot then holds the
  caller's teams only, but nothing reads it after the refresh (A26); the next request reloads it
  as `auth-resolve`.
- **[Backfill drift]** The migration's copy of the default settings can drift from the code's.
  The shape test (D7) pins it; the copy runs once per database.
- **[Deploy window]** Between the migration and the app recreate, the old (6b-1) image runs
  against the policies:
  - its self-healing settings read (INSERT for a missing row) is refused for plain members. The
    backfill leaves no team without a row, and the old image creates teams with no row only
    during that window;
  - its team delete removes memberships first. The definition and settings deletes then change
    nothing, and the owner gets `200` with the team left defined and memberless. The support
    plane's delete (system) removes such an orphan;
  - its name edit writes four `users` columns, which the column grant refuses (`500`).

  On dev the app hot-reloads; on stage `make stage-up` runs both; prod is not on this branch.
- **[An edited unmerged migration]** The file changes between its two steps (D4); `make dev-up`
  is not run on this branch before task 4.3.

## Migration Plan

1. Merge to `supabase-migration`. Dev applies the migration on its next `make dev-up`
   (`migrate`), then the hot-reloaded app runs under the policies.
2. Stage, with the owner's permission for `make stage-up`: `migrate`, then the app recreate.
3. Live checks: proposal "After merge".
4. **Rollback** (documented SQL, as in 6b-1's owner decision A; no script file, no rollback test).
   **Order:** deploy the previous image first, then run the SQL right away. The new image calls
   `catalog.studio_exists`/`show_exists`, which the SQL drops. The SQL must therefore not run
   while the new image serves: its foreign-team and foreign-show probes would fail with `500`.
   During the short gap the previous image meets the window effects in Risks "Deploy window".
   Run the SQL as `postgres` in one transaction
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
   This restores 6b-1's state exactly. The backfilled settings rows stay: they are what the 6b-1
   app's self-healing read would have written. Deleting the version row is the roll-forward
   path: the next `migrate` run re-applies the migration, which uses `create or replace`,
   `drop policy if exists` before each `create policy`, an idempotent revoke and
   `on conflict do nothing`. The same SQL goes into ADR 0021's 6b-2 entry.

## Owner decisions after the panel (owner, 2026-10-03)

- **A. Cross-team contention: accept retries.** The adapter retries a cross-team `40001`, and
  none reaches HTTP within the retry budget. The contention test asserts commits through the
  retry loop (D10). The retry stop rule is D11's: rate more than doubled against 6b-1, or any
  exhausted call, in the integration runs, the contention test or the probe, measured with and
  without `ANALYZE`. `enable_seqscan = off` is kept (D1).
- **B. Team-management inserts are system-only.** `catalog_user` has no `INSERT` policy and no
  `INSERT` privilege on `user_studio_memberships` and `team_invites` (D2, A28). The one-owner
  index (A30) and the remaining within-team escalations are recorded in Risks.

Panel fixes folded in: the `users` column privileges and the dedicated name edit (D2, A29); the
`api-contract-freeze` delta (D9); the `PUT /api/profile` transaction (D8); statistics and
`ANALYZE` (D10, D11, D12, A31); the deploy and rollback windows (Risks, Migration Plan).

## Open Questions

These are for the owner at approval. Each has a recommended answer that the specs and tasks
already use, and an alternative that changes only the named helper or task.
- **OQ1. Seven helpers.** Confirm `member_shows`, `co_members`, `studio_exists` and
  `show_exists` beyond the plan's three (D1, D6), and the `(uid)` parameter. *Alternative:*
  no-argument helpers reading `catalog.app_user_id()` (same tests, minus the per-user calls).
- **OQ2. `POST /api/shows` existence.** Confirm the in-transaction `studioExists` plus
  `studio_exists` in place of the plan's snapshot check (D6). *Alternative:* the snapshot check,
  which changes the race outcome to `404` and needs a `team-management` delta and an edit to
  `teams.race.int.test.ts:443`.
- **OQ3. Settings backfill.** Confirm the one-time migration backfill (D7). *Alternative:* no
  backfill; teams with no row show new category ids on each load until a save. Task 2.1's shape
  test and the backfill statement would then be dropped.
- **OQ4** (retry stop rule) is resolved by owner decision A (D11).
