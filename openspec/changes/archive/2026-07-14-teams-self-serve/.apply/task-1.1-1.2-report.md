# Tasks 1.1 + 1.2 report — catalog roles + invites storage

Branch: `teams-self-serve`. Commits:
- `9dafc69` feat(db): membership role column + team_invites table (migration)
- `c8366ea` feat(db): AuthStore role-aware membership + invite ops (teams-self-serve)

## Task 1.1 — migration

New file: `server/src/db/migrations/0004_team_roles_and_invites.sql` (numeric-prefix
naming matches `0001_init.sql` / `0002_sessions_live_split.sql` / `0003_kv.sql`).
Content, in one file/transaction per D9:

```sql
ALTER TABLE user_studio_memberships ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

UPDATE user_studio_memberships
SET role = 'admin'
WHERE studio_id NOT IN ('test-studios', 'test-studio-2');

CREATE TABLE IF NOT EXISTS team_invites (
    studio_id TEXT NOT NULL,
    email_norm TEXT NOT NULL,
    invited_by_user_id TEXT NOT NULL,
    invited_at_utc TEXT NOT NULL,
    PRIMARY KEY (studio_id, email_norm)
);
```

Built-in ids (`test-studios`, `test-studio-2`) are hardcoded in the SQL comment and
WHERE clause, per the task brief — deliberately not read from
`BUILTIN_STUDIO_ORDER` in `server/src/studio.ts`, since migrations are frozen
snapshots and must not depend on application code that can change later. The
comment points at the constant for provenance.

Migrator tests added in `server/src/node/migrate.test.ts` (unit tier — this is
where the existing migrator tests already live, not an int test; the migrator has
no dependency on the request harness):
- Updated the existing "applies all migrations" test to expect the new 4th file.
- New: fresh DB has the `role` column (`NOT NULL`, default `'member'`) and the
  `team_invites` table with the expected 4 columns.
- New: seeds a DB at the pre-0004 revision (copies only `0001`–`0003` into a temp
  migrations dir, applies those), inserts a membership row for a built-in studio
  (`test-studios`) and one for a non-built-in studio (`acme-crew`) directly via SQL
  (bypassing the not-yet-existing `role` column), then runs the real migrations dir
  (which now includes `0004`) and asserts: `acme-crew` → `admin`, `test-studios` →
  `member`. A post-migration insert into a third studio (`another-crew`) defaults to
  `member`, proving the column default (not the backfill) governs new rows.

## Task 1.2 — AuthStore extensions

`server/src/db/authStore.ts`: added `export type TeamRole = 'admin' | 'member'`
and, keeping the file's existing verbatim style (`this.db.first/all/run/tx`, no
internal transactions except where noted):

**Role-aware membership ops**
- `authAddMembershipWithRole(userId, studioId, role)` — `INSERT OR IGNORE`; no-op
  (role preserved) if already a member. Used by team creation (never conflicts)
  and invite grants (existing member must be untouched per D2/S4).
- `authUpsertMembershipRole(userId, studioId, role)` — `INSERT ... ON CONFLICT
  (user_id, studio_id) DO UPDATE SET role = excluded.role`. Insert-or-update, for
  the admin-plane rescue path and promote/demote.
- `authGetMembershipRole(userId, studioId)` — role read, `null` if no membership.
- `authCountEnabledAdmins(studioId)` — joins `users`, counts `role = 'admin' AND
  disabled_at_utc IS NULL`.
- `authListTeamMembers(studioId)` — joined `id, email, given_name, family_name,
  role`, ordered `role ASC, email ASC` (admins sort first: `'admin' < 'member'`
  lexically, so this needs no CASE expression).

**Invite ops** (all take a pre-normalized `emailNorm` string; none use SQL
`lower()`, per D2/S3)
- `authUpsertInvite(studioId, emailNorm, invitedByUserId)` — idempotent upsert,
  refreshes `invited_by_user_id`/`invited_at_utc` on re-invite.
- `authListInvitesForTeam(studioId)` — ordered by `email_norm` for deterministic
  test/UI output.
- `authDeleteInvite(studioId, emailNorm)` — returns `changes` count (idempotent
  revoke semantics live in the router, which always returns 200 regardless).
- `authCountPendingInvites(studioId)` — for the 200-per-team cap (D10).
- `authDeleteAllInvitesForTeam(studioId)` — delete-team cascade.
- `authConsumeInvitesForEmail(emailNorm)` — SELECT then DELETE, no internal
  `db.tx()`, so it composes inside the router's outer `ports.catalog.tx(...)`
  materialization boundary (D2/S9) without nested-transaction issues. Verified by
  an explicit test that calls it inside `db.tx(...)` alongside another write.

**User lookup**
- `authListUsersByEmailNorm(emailNorm)` — `SELECT * FROM users` then filters in JS
  (`toLowerCase().trim()` comparison), so matching never depends on SQL `lower()`.
  Returns ALL matching rows including disabled accounts (unlike
  `authGetUserByGoogleSub`, which filters disabled) — required for D2's
  multi-match/disabled-inert semantics.

Routers, the OAuth callback, and `profileAssembler` were not touched (later
phases own those), matching the task brief.

## Test coverage

New file `server/src/db/authStore.int.test.ts` (integration tier, real SQLite via
`catalogFor`/`seedStudio`/`seedUser` from `server/src/test/helpers.ts`, same idiom
as `catalog.int.test.ts`): 21 cases covering create/no-op/upsert/role-read,
enabled-vs-disabled admin counting (including a zero-admin team), joined member
listing + team scoping, invite upsert/idempotency/list/delete/idempotent-delete/
count/cascade, cross-team `authConsumeInvitesForEmail` (including the empty-match
and the in-transaction-composition cases), and email-lookup case/whitespace
normalization + disabled-inclusive multi-match + no-match.

## Suite tails

- `npm run typecheck` (root, all four projects: server/web/companion/e2e): clean,
  no errors.
- `npm test` (root, all three vitest workspaces): server 44 files / 275 tests
  passed; web 13 files / 123 tests passed; companion 6 files / 20 tests passed.
- Isolated runs before the full pass: `migrate.test.ts` 5/5 passed;
  `authStore.int.test.ts` 21/21 passed.

## Concerns

- None blocking. One judgment call worth flagging: `authListUsersByEmailNorm`
  does `SELECT * FROM users` and filters in JS rather than an indexed SQL
  predicate — deliberate, to honor the "never SQL `lower()`" constraint; fine at
  expected table sizes, but if the `users` table ever grows very large this is
  the first place to revisit (not in scope here).
- `authDeleteInvite`'s return value is a raw `changes` count (`number`), not a
  boolean, differing slightly from the existing `authRemoveMembership` (which
  returns `boolean`) — chosen because the task brief explicitly says "return
  changes count." Router-layer idempotent-200 semantics don't need the exact
  count, just truthiness, so this is compatible either way.
