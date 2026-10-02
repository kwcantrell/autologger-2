# Design

## Context

See proposal.md for the why and the owner decisions (owner, 2026-10-02). The current state:

- **Roles.** `catalog.user_studio_memberships.role` is free text with default `'member'` and no
  check (`supabase/migrations/20261001000000_catalog_schema.sql:30`). The code knows `admin` and
  `member` (`packages/catalog/src/authStore.ts:8`, `TeamRole`).
- **Team routes** (`server/src/routers/teams.ts`):
  - `requireNotBuiltin` runs before every membership check;
  - `requireTeamMember` / `requireTeamAdmin` check early, and `requireTeamAdminIn` re-checks
    inside the transaction with the caller's row locked `FOR SHARE`;
  - demote, remove and leave go through `guardedAgainstLastAdmin`, which counts enabled admins
    (`authCountEnabledAdmins`) in the write's transaction;
  - `GET /api/teams/:id` also returns `authCountEnabledAdmins` as `enabled_admin_count`
    (`teams.ts:182`);
  - the creation cap is `authCountAdminTeams(userId, BUILTIN_STUDIO_ORDER)`.
- **Built-ins.** `packages/domain/src/studio.ts:66-77` defines `BUILTIN_STUDIO_ORDER`,
  `BUILTIN_STUDIO_NAMES`, `DEFAULT_STUDIO_ID` and the dead `LEGACY_STUDIO_MAP`. `StudioRegistry`
  merges the built-ins ahead of `studio_definitions` rows and refuses to create, rename or delete
  them. `studioExists` short-circuits them. `defaultCategoriesForNewStudio` has a
  `test-studio-2` branch (`studio.ts:164`). The admin plane reports `builtin: true` for them.
- **Global defaults.** The callback's new-user branch seeds prefs from the global
  `active_studio_id` / `active_show_id` settings, falling back to `DEFAULT_STUDIO_ID`
  (`server/src/routers/auth.ts:232-236`). `studioProfileForSession` falls back to
  `resolveActiveStudio()` (`packages/catalog/src/sessionIndexStore.ts:372`).
  `DEFAULT_STUDIO_ID` is also read by `profileAssembler.ts:68`, `studioRegistry.ts:139` and `:195`,
  and `server/src/routers/shows.ts:70`.
- **Sign-in.** The callback refuses unverified emails before the GoTrue exchange (`auth.ts:183`),
  then splits into a new-user branch (one catalog transaction) and an existing-user branch that
  refuses disabled accounts. Both end at `createLoginSession` (`auth.ts:275`).
- **Boot.** `checkBootEnv` (`server/src/bootGuard.ts`) refuses blank `SIGN_IN_VARS`;
  `compose-run.mjs` `checkSignInClient` refuses blank Google values in every stack.
- **Tests.** The integration harness clones a migrated template database per test and signs in a
  default `member` of the built-in ids (`server/src/test/harness.ts:108`).

## Owner decisions after the panel (owner, 2026-10-02)

The proposal's decisions 1-6 stand. After the adversarial panel the owner added A-D, which this
design implements:
- **A. Takeover accepted.** On dev and stage the bootstrap owner's first sign-in claims every
  ownerless team, including teams other users created after 5a (stage today: `my-crew2` and
  `my-studio` with one admin each, and the empty `my-crew`). The claim logs each claimed team id
  (D7; Risks).
- **B. `enabled_admin_count` keeps its meaning**: enabled members with role `admin` only; the
  owner is not counted, and a new team reports `0`. The web no longer reads it (D4, D12).
- **C. A role-less support upsert never demotes the owner.** `POST
  /api/admin/users/:userId/memberships` without `role` that would change the current owner's
  role gets `409 Explicit role required to change the team owner.`. An explicit `admin`/`member`,
  or a membership delete, still applies and leaves the team ownerless until the bootstrap claim
  (D6).
- **D. Transfer details as drafted**: `200 {ok: true}`; a disabled target `400`; a non-member
  target `404 Member not found`; a self-transfer `200` with no change (D3).

## Goals / Non-Goals

**Goals:**
- A team has at most one owner, enforced by the database, and every team-plane write keeps a team
  that has an owner at exactly one.
- The owner rules are decided inside the write's transaction, like the admin re-check today.
- No code path knows a team id by name: `test-studios` and `test-studio-2` are data.
- No reader of the global active team or show is left.

**Non-Goals:** see proposal.md (RLS, per-show grants, support-plane guards, a "exactly one owner"
trigger).

## Decisions

### D1. "At most one" in the database, "at least one" in the application
Migration `supabase/migrations/20261004000000_team_owner.sql`:
```sql
alter table catalog.user_studio_memberships
  add constraint user_studio_memberships_role_check check (role in ('owner', 'admin', 'member'));
create unique index idx_user_studio_memberships_one_owner
  on catalog.user_studio_memberships (studio_id) where role = 'owner';
insert into catalog.studio_definitions (id, display_name, sort_order, created_at_utc) values
  ('test-studios', 'Test Studio', 0, '2024-01-01T00:00:00Z'),
  ('test-studio-2', 'Test Studio 2', 1, '2024-01-01T00:00:00Z')
on conflict (id) do nothing;
delete from catalog.app_settings where key in ('active_studio_id', 'active_show_id');
```
- The index name starts with `idx_`, so `catalogSchema.pg.test.ts` (which records
  `pg_indexes` rows named `idx_%`) captures it. The schema record gains check constraints
  (`contype = 'c'`), so the role check is recorded too.
- Sort orders 0 and 1 keep the two teams first: self-serve teams are inserted with 1000
  (`studioRegistry.ts:272`), and the registry orders by `sort_order, id`.
- The created-at value matches the seed shows'.
- No statement assigns an owner (owner decision 6). The migration has no transaction-control
  lines (`migrate.sh` refuses them).

"Exactly one" is kept by the application: creation inserts the creator as owner in the creating
transaction (D5), transfer and the support owner upsert demote and promote in one transaction
(D3, D6), and the team plane never removes or demotes the owner (D2). Ownerless teams are legal:
the former built-ins before the bootstrap claim, teams the admin plane creates, and teams whose
owner support removed.

*Alternative:* a deferred constraint trigger for "exactly one". Rejected: ownerless teams are
legitimate by the owner's decisions 2 and 6, and the admin plane creates teams with no members.

### D2. Role checks: one helper, re-run inside the transaction
`teams.ts` replaces `requireTeamAdmin` / `requireTeamAdminIn` with `requireTeamRole(c, teamId,
roles)` and `requireTeamRoleIn(cat, userId, teamId, roles)`. Both keep today's statuses and
details: masked `404 Team not found`, then `403`. The detail is `Admin role required.` when
`admin` is allowed and `Owner role required.` for owner-only routes. The `In` form keeps the
`FOR SHARE` read (`authGetMembershipRoleForShare`).

| Route | Early and in-transaction check | Target rules (in the transaction) |
| --- | --- | --- |
| `GET /api/teams/:id` | member; `invites` included for owner or admin (today's gate at `teams.ts:190` is `role === 'admin'`) | — |
| `PATCH`, invites, revoke | owner or admin | — |
| `DELETE /api/teams/:id` | owner | — |
| role change | owner | not a member → `404 Member not found`; owner → `409 Transfer ownership first.`; same role → `200` |
| remove member | owner or admin | not a member → `404`; owner → `409`; `admin` target and caller not owner → `403 Owner role required.` |
| leave | member | caller is owner → `409`; already gone → `404` |
| transfer | owner | D3 |

The status order is `401`, masked `404`, the caller's `403`, body `400`, then the target's
`404` / `409` / `403`.

### D3. Transfer is two updates in one transaction, demote first
New route `POST /api/teams/:id/owner`, body `teamOwnerTransferBodySchema = z.object({ user_id:
z.string().trim().min(1) })` in `packages/contract`, parsed through `parseTeamBody` (so a bad body
is `400`). In one `catalog.tx`:
1. `requireTeamRoleIn(cat, caller, team, ['owner'])`;
2. `user_id === caller` → return `200 {ok: true}` with no write;
3. the target's role (`authGetMembershipRole`): none → `404 Member not found`; its user row
   disabled → `400 That member's account is disabled.`;
4. `authTransferOwnership(studioId, fromUserId, toUserId)`:
   `UPDATE … SET role = 'admin' WHERE studio_id = ? AND user_id = ? AND role = 'owner'`, then
   `UPDATE … SET role = 'owner' WHERE studio_id = ? AND user_id = ?`. If either touches no row,
   it throws, so the transaction rolls back (`404` for the target).

Demoting first matters: Postgres checks a non-deferrable unique index row by row as each row is
written, so promoting first would fail with `23505` while the old owner row still says `owner`;
after the demote no other owner row exists. Concurrency: a second concurrent transfer re-checks the caller under
`FOR SHARE` after the first committed, so it gets `403` (the caller is now an admin); a racing
leave by the target either commits first (transfer `404`) or sees the target as owner (leave
`409`). Under SERIALIZABLE the adapter retries `40001` as today. The response is `{ok: true}`,
like the other membership writes (owner decision D).

### D4. Last-admin protection is deleted
`wouldStripLastEnabledAdmin`, `guardedAgainstLastAdmin` and `LAST_ADMIN_MESSAGE` go. Demote,
remove and leave use D2's target rules inside their transactions. `authCountEnabledAdmins` stays,
because `GET /api/teams/:id` returns it as `enabled_admin_count`, a frozen field. Its query is
unchanged (owner decision B): enabled `admin` rows only, so the owner is not counted and a fresh
team reports `0`. The web stops reading it; the no-owner notice keys on the members' roles (D12).
This corrects the plan, which said to drop the function.

### D5. Creation inserts the owner; the cap counts owned teams
`POST /api/teams` adds the creator with `'owner'` and returns `role: 'owner'`.
`authCountAdminTeams(userId, exclude)` becomes `authCountOwnedTeams(userId)` (`role = 'owner'`,
no exclusion list). The cap message becomes `You already own 20 teams; the limit has been
reached.`. Cap, definition and owner membership stay in one transaction.

### D6. Support plane: an owner upsert demotes the old owner; a role-less demotion is refused
`adminMembershipBodySchema.role` becomes `z.enum(['owner', 'admin', 'member']).optional()`. In
the existing upsert transaction, `role: 'owner'` calls `authSetOwner(studioId, userId)`:
`UPDATE … SET role = 'admin' WHERE studio_id = ? AND role = 'owner' AND user_id <> ?`, then the
existing upsert with `'owner'`. When the body has no `role` and the target is the team's
current owner, the upsert would demote the owner to the default `member`, so it is refused inside
the transaction with `409 Explicit role required to change the team owner.` and nothing changes
(owner decision C). An explicit `admin`/`member` upsert, or a membership delete, on the current
owner is applied and leaves the team ownerless until the bootstrap claim or an owner upsert
(owner decision 4 keeps the support plane unguarded). `builtin` is the literal `false` in both admin shapes.
`server/scripts/bootstrapMemberships.example.ts` accepts `owner`.

### D7. The bootstrap claim runs after both callback branches, fails open
`authClaimOwnerlessStudios(userId): Promise<string[]>` returns the claimed team ids
(`RETURNING studio_id`):
```sql
INSERT INTO user_studio_memberships (user_id, studio_id, role)
SELECT ?, d.id, 'owner' FROM studio_definitions d
WHERE NOT EXISTS (SELECT 1 FROM user_studio_memberships m
                  WHERE m.studio_id = d.id AND m.role = 'owner')
ON CONFLICT (user_id, studio_id) DO UPDATE SET role = 'owner'
RETURNING studio_id
```
It inserts or upgrades only the claimant's rows, so other members' roles are untouched (admins
stay admins). In `auth.ts`, after the new-user and existing-user branches have set `uid` (enabled,
verified, identity matched) and before `createLoginSession`:
```ts
const match = bootstrapEmailMatch(email, bootstrapOwnerEmail(c.env.config)); // D16
if (match === 'non-ascii') console.warn('OAuth callback: bootstrap owner claim refused (non-ASCII email)');
else if (match) {
  try {
    const ids = await catalog.tx((cat) => cat.auth.authClaimOwnerlessStudios(uid));
    for (const id of ids) console.info(`OAuth callback: bootstrap owner claimed team ${id}`);
  } catch (e) { console.warn(`OAuth callback: bootstrap owner claim failed (${code})`); }
}
```
Each claimed team id is logged (owner decision A); the logs name team ids and error codes, never
the email. A concurrent owner insert can make the claim fail
with `23505` or exhaust `40001` retries; that is the fail-open path, and the next sign-in
retries. The partial index guarantees no second owner either way. Refused sign-ins
(`email_unverified`, `account_disabled`, `identity_unavailable`) return before this point.

*Alternative:* claim in a migration or at boot. Rejected by owner decision 6 (no migration
promotes anyone), and a boot claim would need the user to exist already.

### D8. `BOOTSTRAP_OWNER_EMAIL`: config, boot refusal, compose refusal
- `packages/ports/src/config.ts` gains `BOOTSTRAP_OWNER_EMAIL: string`; `server/src/node/config.ts`
  reads it (`|| ''`); `server/src/env.ts` adds `bootstrapOwnerEmail(env)`, the ASCII
  normalization of D16 (not `normalizeEmail`).
- `checkBootEnv` also refuses a value with any non-ASCII character (D16), naming the variable
  and no value.
- At boot, `main.ts` logs the masked value: `bootstrap owner: <domain> #<first 8 hex of
  sha256(normalized)>`, never the local part, so the operator can check for a typo
  (`maskBootstrapOwnerEmail` in `env.ts`, unit-tested).
- `checkBootEnv` adds a separate refusal after the sign-in one: `BOOTSTRAP_OWNER_EMAIL is missing
  or blank (the bootstrap owner claims teams that have no owner; set it in Infisical, see
  docs/infisical-secrets.md).`. It stays out of `SIGN_IN_VARS`, whose comment ties it to
  `oauthConfigured()`. No email-shape check: the owner asked only for "blank refuses".
- `compose-run.mjs` `checkSignInClient` loops over the three keys (trimmed), every stack.
- `docker/secrets-env.yaml` gains one `BOOTSTRAP_OWNER_EMAIL:` passthrough under "Sign-in and
  tokens". `check-envs.sh` invariant 15 and `allowedNames()` read that file, so no other compose
  edit is needed (verified by running both).

### D9. Built-ins become data
- `domain`: delete `BUILTIN_STUDIO_ORDER`, `BUILTIN_STUDIO_NAMES`, `DEFAULT_STUDIO_ID`,
  `LEGACY_STUDIO_MAP`, `SETTING_ACTIVE_STUDIO`, `SETTING_ACTIVE_SHOW`, and the `test-studio-2`
  branch of `defaultCategoriesForNewStudio`.
- `StudioRegistry`: `refreshStudioRegistry` reads `studio_definitions` only (its query already
  orders by `sort_order, id`); `validateNewStudio` loses the reserved-id check (the existing-id
  check in `insertStudioDefinition` now answers `test-studios`); `studioExists` is the definition
  query; `adminDeleteStudio` and `renameStudio` lose their refusals; `resolveActiveStudio` is
  deleted; `getStudioSettingsBlob` stops remapping an unknown id to `DEFAULT_STUDIO_ID` (an
  unknown id already returns the unpersisted default, because `studioExists` is false).
- `teams.ts`: `requireNotBuiltin` is deleted. `admin.ts`: `builtin: false`.
- `shows.ts:70`: the fallback `defaultSettingsBlob(DEFAULT_STUDIO_ID)` becomes
  `defaultSettingsBlob('')` (OQ2). With the `test-studio-2` branch gone, the default categories no
  longer depend on the id.
- Web: `TeamsRoute.tsx` loses `BUILTIN_TEAM_IDS` and `BuiltinTeamRow`.

### D10. Global defaults are gone
- `auth.ts`: the `authSeedPrefsFromGlobals` call goes; `authSeedPrefsFromGlobals` is deleted. A
  new user's prefs row is created empty by `authEnsurePrefsRow` on the first profile read, and
  `profileStudioForUser` picks the first team in registry order the user belongs to.
- `profileAssembler.ts:68`: when none of the user's memberships names a known team, the profile
  is `null` (as with zero memberships), not `DEFAULT_STUDIO_ID`'s.
- `sessionIndexStore.studioProfileForSession`: when the session's team is empty or unknown, it
  returns a team-less profile, `blobToProfile('', '', …)`, with the show's categories when the
  session has a show, else `defaultSettingsBlob('')`. Exports, Companion and events read only the
  categories and settings from it.
- The migration deletes the two global rows (D1).

### D11. Members list order
`authListTeamMembers` orders by `CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
u.email`. Plain `ORDER BY role` would sort `owner` after `member`.

### D12. Web
- `web/src/api/types.ts`: `TeamRole = 'owner' | 'admin' | 'member'`; `TeamOwnerTransferBody`
  `{user_id}` and response `{ok: true}`. `useTeams.ts`: `useTransferOwnership(teamId)`,
  invalidating the team detail and the profile.
- `TeamCard.tsx`:
  - owner: `OwnerPanel` = the admin controls plus role toggles, "Transfer ownership" on other
    members (with a confirm), and delete; no leave;
  - admin: rename, invites, and remove on `member` rows only; no role toggles; leave;
  - member: unchanged.
  - `OrphanedNotice` shows when no member has `role: 'owner'`, with the copy "This team has no
    owner. Contact support." A member sees only the notice (as today); an admin sees the notice
    above the admin panel. `enabled_admin_count` is no longer read.
  - `RoleBadge` renders `owner`.
- `OnboardingPanel.tsx`: "you'll be its owner". `AdminUsersPage.tsx` has no role picker
  (`grep -c role` is 0), so it is unchanged; its builtin column shows "No".

### D13. Test harness and fixtures
- `harness.ts`: the default member's teams are the literal `['test-studios', 'test-studio-2']`
  (defined rows now, from the template migration); the base config adds
  `BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com'`, an address no other suite uses, so no
  sign-in claims by accident.
- `bootOrder.int.test.ts`'s spawned env gains the variable; `bootGuard.test.ts` and
  `compose-run.test.mjs` fixtures gain it.
- Suites that encoded built-in `400`s or last-admin `409`s (`teams`, `teams.race`, `admin`,
  `authStore`, `catalog`) are rewritten to the owner rules, each named in tasks.md.
- `apiResponseFixtures.int.test.ts` recaptures `teamCreate`, `teamDetailAdmin`,
  `teamDetailMember`, `teamRoleChange`, `profileAuthenticated` and `adminUsers.json`
  (`builtin: false`), and adds `teamOwnerTransfer` and `teamDetailOwner` captures (the existing
  `seedTeam()` at `apiResponseFixtures.int.test.ts:714` adds the caller as admin, so the owner
  capture seeds the caller as owner); `web/src/api/types.conformance.test.ts`
  checks them.

### D14. Spec deltas use REMOVED + ADDED where a scenario would be dropped or renamed
`team-management`'s "Membership roles", "Self-serve team creation", "Team lifecycle and
last-admin protection" and "Concurrent team writes" each carry a scenario that no longer holds
(built-in rejection, reserved ids, last enabled admin, built-in purge), so each is removed and
restated under a new name. The rest are MODIFIED in full. `team-management`'s Purpose names the
built-ins and last-admin protection; a delta can't change a Purpose, so archive edits it
directly (task 9.4).

### D15. Capabilities with no delta
`container-deployment` names no sign-in variable (its only posture pin is `REQUIRE_LOGIN`), and
the compose refusal lives in `local-container-environments`; `web-login-experience` has no
first-sign-in prefs wording (`grep -n -i "prefs\|global" openspec/specs/web-login-experience/spec.md`
→ no output). Neither changes.

### D16. The bootstrap match is exact ASCII
JS `toLowerCase` is Unicode-aware: `"Kalen@gmail.com".toLowerCase() === "kalen@gmail.com"`
is `true` (U+212A KELVIN SIGN folds to `k`), so `normalizeEmail` would let a different Google
address match. `env.ts` adds `asciiEmailNorm(v)` (trim, then fold only `A`-`Z`) and
`bootstrapEmailMatch(tokenEmail, configured)`, which returns `'non-ascii'` when the token email
has any character above U+007F, otherwise whether the two ASCII-normalized values are equal.
`'non-ascii'` refuses the claim (logged, sign-in continues). `checkBootEnv` refuses a non-ASCII
`BOOTSTRAP_OWNER_EMAIL`, so the configured side is always ASCII. Invite normalization is
unchanged (out of scope).

## Assumptions (each with the command that tests it)

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | The role column has no check today | `grep -c "check (" supabase/migrations/*.sql` | `0` in each of the three files; `30:  role text collate "C" not null default 'member',` |
| A2 | The schema test records only `idx_%` indexes, and no check constraints | `grep -n "contype\|idx" server/src/test/pg/catalogSchema.pg.test.ts` | `contype = 'f'`, `contype = 'u'`, `indexname like 'idx\\_%'` |
| A3 | Self-serve teams sort after 0 and 1 | `grep -n "VALUES (?, ?, 1000" packages/catalog/src/studioRegistry.ts` | `272: 'INSERT INTO studio_definitions (id, display_name, sort_order, created_at_utc) VALUES (?, ?, 1000, ?)'` |
| A4 | `enabled_admin_count` reads `authCountEnabledAdmins` | `grep -n authCountEnabledAdmins server/src/routers/teams.ts` | `116:` (last-admin check) and `182: const enabledAdminCount = …` |
| A5 | Members are ordered by plain `role` | `grep -n "ORDER BY m.role" packages/catalog/src/authStore.ts` | `412: ORDER BY m.role ASC, u.email ASC` |
| A6 | `DEFAULT_STUDIO_ID` has readers beyond the plan's list | `grep -n DEFAULT_STUDIO_ID server/src/routers/shows.ts packages/catalog/src/*.ts` | `shows.ts:70`, `studioRegistry.ts:139,195`, `profileAssembler.ts:68` |
| A7 | The seed shows carry their own categories | `grep -n "show-the-something-podcast" -A1 supabase/migrations/20261001000000_catalog_schema.sql` | `'[{"id":"b2000000-…","name":"Note",…},{…"name":"Mark",…}]'` |
| A8 | The global setting keys are read only by the prefs seed and `resolveActiveStudio` | `grep -rn "SETTING_ACTIVE_STUDIO\|SETTING_ACTIVE_SHOW" --include=*.ts packages server/src web/src` | `auth.ts:6-7,234-235`, `studioRegistry.ts:13,193`, `studio.ts:61-62` |
| A9 | The harness names the built-ins through the domain constant | `grep -n BUILTIN_STUDIO_ORDER server/src/test/harness.ts` | `9: import …`, `108: for (const sid of BUILTIN_STUDIO_ORDER)` |
| A10 | The admin users page has no role picker | `grep -c role web/src/pages/admin-users/AdminUsersPage.tsx` | `0` |
| A11 | `BOOTSTRAP_OWNER_EMAIL` exists nowhere yet | `grep -rn BOOTSTRAP server/src packages docker \| wc -l` | `0` |
| A12 | Unverified and disabled sign-ins return before the session is issued | `grep -n "email_unverified\|account_disabled\|createLoginSession" server/src/routers/auth.ts` | redirects at `:183` and `:263` precede `createLoginSession(` at `:275` |
| A14 | JS lowercasing folds the Kelvin sign | `node -e 'console.log("\u212Aalen@gmail.com".toLowerCase()==="kalen@gmail.com")'` | `true` (panel finding) |
| A13 | Compose reads the allowlist file's key lines | `grep -n "allowedNames" -A4 docker/scripts/compose-run.mjs` | `/^ {6}([A-Z][A-Z0-9_]*):\s*$/` over `docker/secrets-env.yaml` |

## Risks / Trade-offs

- **[The bootstrap email is a master key for ownerless teams]** → It is accepted only with a
  verified Google email that also passes the GoTrue exchange; it claims only teams with no owner;
  the value lives in Infisical, never in compose files. Teams with an owner are untouched.
- **[The claim takes over teams other users created]** → Accepted (owner decision A). On dev and
  stage the bootstrap owner's first sign-in claims every ownerless team, including `my-crew2`,
  `my-studio` and `my-crew` on stage. The bootstrap owner gains content access and delete rights
  there; the original creators stay admins but lose role changes and delete; and every claimed
  team counts toward the bootstrap owner's 20 owned-team cap. Each claimed id is logged, so the
  takeover is visible. Prod's catalog is empty at cutover, so there it claims only the two
  former built-ins.
- **[Support can make a team ownerless, which hands it to the bootstrap owner]** → By owner
  decisions 4 and C the support plane stays unguarded for explicit roles and deletes, but a
  role-less POST can't demote the owner by accident (`409`). Support can re-assign with an owner
  upsert.
- **[A typo in prod's `BOOTSTRAP_OWNER_EMAIL` hands the teams to nobody, or to the wrong
  account]** → Boot logs the masked value (domain plus a short hash; D8), and proposal "After
  merge" requires checking the owner of `test-studios` right after the first prod sign-in.
- **[A disabled owner blocks role changes and delete]** → The support owner upsert (owner
  decision 4) is the rescue. The no-owner notice won't show for a disabled owner, because
  per-member disabled status is not exposed (unchanged frozen rule).
- **[Dev is down from task 3.1 until the owner sets the key]** → The bind-mounted dev server
  reloads with the new boot refusal and exits. That is intended; don't change compose early.
- **[test-studio-2's unstored settings blob changes its default categories]** → Only when no
  blob is stored. The seed show keeps its own categories (A7), and slice 11 imports stored blobs.
  OQ6.
- **[Rollback]** → dev and stage only (prod runs `main` until slice 11's cutover). The 5b image
  over the migrated catalog still works: the check accepts its `admin`/`member` writes, and the
  definition rows for the built-ins are skipped by its merge. Under the old image an `owner`
  row is neither admin nor member, so owners lose management until roll-forward. The migration is
  forward-only, like the others.
- **[Cutover]** → prod's catalog is created at cutover, so the migration runs on an empty
  catalog and the teams start ownerless; the image refuses to boot without
  `BOOTSTRAP_OWNER_EMAIL`, so prod's Infisical needs it before the first deploy of this image.
  ADR 0021's cutover notes record this.

## Open Questions

Facts found while grounding the plan, recorded for the panel and the owner. OQ1, OQ3 and OQ5
were decided by the owner after the panel (decisions B, C and D above).

- **OQ2 (gap in the plan).** `DEFAULT_STUDIO_ID` is also read by `shows.ts:70` and
  `studioRegistry.ts:139` (A6). Deleting the constant forces both edits (D9); no behavior beyond
  the plan changes.
- **OQ4.** ADR 0021's permissions text says "exactly one owner, enforced in the database" and
  "the built-in studios are dropped". Owner decision 2 and D1 refine both (at most one in the
  database; built-ins become ordinary teams). The 5c ADR entry records it.
- **OQ6.** `test-studio-2`'s default (unstored) settings categories become the generic default
  (Scene, Audio issue, Note) instead of Note and Mark.
