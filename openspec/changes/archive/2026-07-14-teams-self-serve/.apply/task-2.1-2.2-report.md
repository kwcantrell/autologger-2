# Tasks 2.1 / 2.2 — Teams router (the endpoint family)

Branch: `teams-self-serve`. Commits:

- `243b6bd` refactor(db): StudioRegistry delete cascades team_invites; add renameStudio (teams-self-serve)
- `a2433b8` feat(api): teams router — self-serve team management endpoint family (teams-self-serve)

Both green independently (`npm run typecheck` + `npm test` after each commit).

## RED evidence (task 2.1)

Tests and router were built together, then verified RED by temporarily
commenting out `app.route('/', teamsRouter);` in `server/src/app.ts` and
re-running `npx vitest run src/routers/teams.int.test.ts` (not committed —
router wiring was restored immediately after capturing this):

```
 Test Files  1 failed (1)
      Tests  35 failed | 3 passed (38)
```

Representative failures (routes fall through to the static catch-all and
404, since nothing before them handles `/api/teams/*`):

```
FAIL DELETE /api/teams/:id/members/:userId — remove > removes a member
  expected 404 to be 200

FAIL DELETE /api/teams/:id/members/:userId — remove > 409s removing the last ENABLED admin
  expected 404 to be 409

FAIL POST /api/teams/:id/leave > lets a member leave
  expected 404 to be 200

FAIL POST /api/teams/:id/leave > 409s the last ENABLED admin leaving
  expected 404 to be 409
```

(3 of 38 passed only because they asserted `401`/masked-`404`-shaped
outcomes that a bare static-catch-all 404 happens to satisfy by accident —
not meaningful passes.) Restoring the `app.route` line brought all 38 back
to green, confirming the tests exercise the router and not some pre-existing
surface.

## Route-by-route implementation notes

All in `server/src/routers/teams.ts`, mounted in `server/src/app.ts` beside
`showsRouter`/`sessionsRouter`.

**Auth helpers (design D3).** `requireUser` (401 `'Login required.'` if
`c.get('user')` is null — checked directly in the router, independent of the
global `REQUIRE_LOGIN` gate, so dev-anonymous mode is always locked out of
this family per the team-management delta). `requireNotBuiltin` (400 if the
team id is in `BUILTIN_STUDIO_ORDER`). `requireTeamMember` calls
`requireUser` then `requireNotBuiltin` **before** consulting membership, then
404 `'Team not found'` if `authGetMembershipRole` returns null.
`requireTeamAdmin` wraps `requireTeamMember` and adds 403
`'Admin role required.'` for a non-admin member. Every `/api/teams/:id/*`
handler funnels through one of these two, so the built-in guard and the
401→400→404→403 ordering is uniform across the family.

**Contract-mandated 400 (not the codebase's 422 default).** The
api-contract-freeze delta states create's "validation errors `400`" and
"Role values outside admin|member are schema-rejected `400`" — but
`app.onError` maps `ZodError` to `422` globally (confirmed against
`sessions.int.test.ts`'s "422 on an invalid create body" case). To honor the
frozen wording without a codebase-wide behavior change, `teams.ts` defines a
local `parseTeamBody(schema, raw)` that `safeParse`s and throws
`ApiError(400, ...)` on failure, used for all four of this family's bodies
(create, rename, invite, role-change) instead of the usual `.parse()`.

**`POST /api/teams`** (any user). Cap check first
(`countOwnedNonBuiltinTeams` — N+1 role lookups over
`authListStudioIdsForUser`, bounded by the 20-team cap itself, so cheap);
then delegates id/display-name/slug/duplicate/built-in validation to
`StudioRegistry.adminCreateStudio` unchanged (`ValidationError` → 400); then
`authAddMembershipWithRole(user.id, teamId, 'admin')`. Not wrapped in a
transaction — mirrors `adminCreateStudio`'s own non-transactional shape, and
a partial failure between the two calls is not realistically reachable
(studio creation succeeding but the membership insert failing would require
a mid-flight process crash, same risk profile as every other two-statement
sequence in this codebase's non-transactional admin paths).

**`GET /api/teams/:id`** (member). Returns
`{id, name, role, members}`, `+invites` only when `role === 'admin'`. Members
come straight from `authListTeamMembers` (already
`{id,email,given_name,family_name,role}[]`, admins-first — no reshaping
needed). Invites are mapped from `authListInvitesForTeam` rows to
`{email, invited_at_utc}` (dropping the unexposed `invited_by_user_id`
audit column per design D2).

**`PATCH /api/teams/:id`** (admin). New `StudioRegistry.renameStudio`
(display-name only; validates non-empty/≤200, rejects built-ins, then
`UPDATE studio_definitions ... ; refreshStudioRegistry()`). No slug
re-validation — ids are immutable after creation.

**`DELETE /api/teams/:id`** (admin). Calls
`StudioRegistry.adminDeleteStudio` unchanged from the caller's perspective —
see the shared-delete refactor below. Blocks-on-shows behavior (400,
"Team still has N show(s)...") is untouched.

**`POST /api/teams/:id/invites`** (admin). Normalizes
(`toLowerCase().trim()`) in JS, then validates shape/length via a local
`isPlausibleEmail` (regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`, ≤254 chars) — kept
out of the Zod schema deliberately, since D2 frames this as
"validation performed in application code," and the schema only guards the
JSON shape (`email: string, ≤320` — generous pre-normalization headroom).
`authListUsersByEmailNorm` returns every matching row (including disabled);
each gets `authAddMembershipWithRole(..., 'member')`, whose `INSERT OR
IGNORE` makes an existing membership (including the sole admin's) a strict
no-op. No match → cap check (400 if the team is at 200 pending AND this
email isn't already one of them — re-inviting an existing pending stays
idempotent even exactly at the cap) → `authUpsertInvite`. Uniform `{ok:true}`
either way (design D2: shape minimalism).

**`DELETE /api/teams/:id/invites/:email`** (admin). Hono already
percent-decodes named path params (verified empirically — a param round-trip
through `encodeURIComponent`/`app.request` comes back decoded), so the
handler just normalizes and calls `authDeleteInvite`, which is already
idempotent (`DELETE ... ; changes` — the handler doesn't inspect the count,
always returns 200).

**`POST /api/teams/:id/members/:userId/role`** (admin). 404
`'Member not found'` if the target has no membership row. Same-role request
short-circuits to `{ok:true, role}` before touching the last-admin guard
(idempotent, and demoting-to-same-role can never be the problematic case
since it's a no-op). Promotion (`→admin`) is unconditional. Demotion
(`→member`) routes through `guardedAgainstLastAdmin`.

**`DELETE /api/teams/:id/members/:userId`** (admin) and
**`POST /api/teams/:id/leave`** (member, target = caller) both route through
the same `guardedAgainstLastAdmin` helper.

**Last-admin guard (normative: one transaction).**
`guardedAgainstLastAdmin(c, teamId, targetUserId, mutate)` wraps
`wouldStripLastEnabledAdmin` + `mutate` in one
`c.env.ports.catalog.tx(...)` call (the `CatalogDb` port, reached off
`c.env.ports.catalog` — same pattern the phase-1 int test used to prove
`authConsumeInvitesForEmail` composes inside an outer `tx`).
`wouldStripLastEnabledAdmin` returns true only when the target currently
holds an **enabled** admin membership (checks `authGetMembershipRole ===
'admin'` AND `authGetUserRowAny(...).disabled_at_utc` is null) and
`authCountEnabledAdmins(teamId) <= 1` — so a disabled admin's row never
blocks anyone else's demotion/removal/leave, and demoting/removing a
*disabled* admin themselves is never blocked either (they were never
counted). On block: 409, nothing mutated (the whole closure ran inside the
transaction, so the count check and the write are atomic against
concurrent requests).

## Shared-delete refactor (design D4)

`StudioRegistry.adminDeleteStudio` (`server/src/db/studioRegistry.ts`) is
the ONE method both `admin.ts` (`DELETE /api/admin/studios/:studioId`,
unchanged call site) and `teams.ts` (`DELETE /api/teams/:id`) call. Its
transaction gained one line:

```ts
this.db.tx(() => {
  this.db.run('DELETE FROM team_invites WHERE studio_id = ?', sid);       // new
  this.db.run('DELETE FROM user_studio_memberships WHERE studio_id = ?', sid);
  this.db.run('DELETE FROM studio_definitions WHERE id = ?', sid);
  this.db.run('DELETE FROM app_settings WHERE key = ?', studioConfigKey(sid));
});
```

Built-in rejection and blocks-on-shows validation are untouched — `admin.ts`
gets the invite cascade for free with no behavior change to its own request/
response shape (verified: `admin.int.test.ts`'s existing
"creates then deletes a studio" case still passes unmodified).

## Suite tails

Final state, both commits landed:

```
npm run typecheck
> autologger-server: tsc --noEmit                 (clean)
> autologger-web: tsc --noEmit                     (clean)
> companion-module-autologger: tsc --noEmit        (clean)
> tsc --noEmit -p e2e                              (clean)

npm test
 server:     Test Files  45 passed (45)   Tests  313 passed (313)
 web:        Test Files  13 passed (13)   Tests  123 passed (123)
 companion:  Test Files   6 passed (6)    Tests   20 passed (20)
```

`teams.int.test.ts` alone: 38 passed (0 failed).

## Coverage vs. task 2.1's enumeration

- 401 anonymous on all 9 routes — one parametrized case.
- Masked 404: non-member vs. nonexistent team, identical response body, on a
  read (`GET`) and a mutating route (`PATCH`).
- 403 member-on-admin-route, contrasted with a member successfully calling
  `GET` and `leave`.
- Built-in 400 on **every** operation, for **both** built-in ids
  (`test-studios`, `test-studio-2`) — 16 request cases in one test.
- Create: success + creator-is-admin, built-in rejection, duplicate
  rejection, slug-regex rejection, empty/too-long display name, creation cap
  (20 successful creates then a 400 on the 21st).
- Rename: success + empty/too-long rejection (403/built-in covered by the
  shared cases above).
- Delete: blocks-on-shows (team survives), and cascade (memberships,
  invites, and registry entry — via `authListTeamMembers`/
  `authListInvitesForTeam`/`initedCatalog().studios.studioNamesDict()`,
  post-mutation reads through a **freshly `.init()`'d** `Catalog` instance,
  since `catalogFor()` alone doesn't repopulate the in-memory registry —
  caught and fixed during this task's own dev loop, see the `initedCatalog`
  helper's doc comment in the test file).
- Invite: immediate grant (single + duplicate-email multi-match), no-op on
  an existing member (including the sole admin), pending + idempotent
  re-invite, implausible-shape rejection, over-254-chars rejection
  (post-normalization, under the schema's pre-normalization 320 ceiling),
  pending cap (200 seeded directly via `authUpsertInvite` for speed, 201st
  via the API → 400, then a re-invite of one of the 200 stays 200).
- Revoke: idempotent on a nonexistent invite, removes an existing one,
  percent-encoded + mixed-case + padded email in the path normalizes and
  matches.
- Role change: promote, demote-with-a-second-admin, idempotent same-role,
  unknown userId → 404, out-of-enum role → 400, and the 409 last-enabled-
  admin case with a **disabled second admin present** (proves disabled rows
  don't count).
- Remove: success, unknown userId → 404, 409 last-enabled-admin (same
  disabled-admin-present setup).
- Leave: success, 409 last-enabled-admin (same setup).
- `GET` detail: admin sees `invites`, member's response has no `invites` key
  at all (not just empty); member shape assertion
  (`{id,email,given_name,family_name,role}`), admins-first ordering.

## Concerns / judgment calls for review

1. **400 vs. the codebase's 422 default for Zod validation.** The frozen
   contract text explicitly calls out `400` for this family (create's
   "validation errors 400", role's "schema-rejected 400"). I extended that
   to ALL four of this family's request bodies (rename, invite too) for
   internal consistency, since the contract's default-behaviors clause also
   describes rename/invite validation in the same breath. This is a
   deliberate, scoped divergence from the rest of the codebase's
   `ZodError → 422` convention — confined to `teams.ts` via a local
   `parseTeamBody` helper, not a change to `app.onError`.
2. **Creation-cap counting has no dedicated `AuthStore` method.**
   `countOwnedNonBuiltinTeams` composes `authListStudioIdsForUser` +
   per-team `authGetMembershipRole` (N+1, N ≤ ~20 in the non-abuse case,
   bounded by the very cap it enforces). Phase 1's `AuthStore` didn't ship a
   direct "count admin teams for user" query, and the task brief scoped me
   to that fixed surface, so I composed from what exists rather than adding
   a new store method. Cheap in practice; call out if a dedicated indexed
   count is wanted later.
3. **Create is not wrapped in a transaction** (cap check → `adminCreateStudio`
   → `authAddMembershipWithRole` are three sequential calls, matching
   `adminCreateStudio`'s own existing non-transactional shape). A crash
   between studio creation and the membership grant would leave an unowned
   team — recoverable via the admin-plane rescue path (task 4.1, not yet
   landed), same risk class as pre-existing admin-plane flows.
4. **Response body shapes beyond the frozen table's stated fields** (e.g.
   create returns `{id, name, role}`, rename returns `{id, name}`, role
   change returns `{ok, role}`) are my choices where the contract table left
   the shape open ("additive-open" clause) — flag if a different shape is
   preferred before `web/` (phase 6) starts consuming them.
5. **Did not touch:** `auth.ts` callback, `profileAssembler.ts`,
   `admin.ts`'s own membership-add semantics (task 4.1's upsert/role-field
   work), `web/`, or the `GET /teams` HTML route (task 4.2/5.1) — all
   explicitly out of scope per the brief.

## Fix round 1 (phase-2 review follow-up)

Commit `56c839b` — `fix(api): indexed admin-team cap count; enabled_admin_count
on team detail; admin delete cascade test`.

Addressed the three items from the phase-2 review:

1. **N+1 creation-cap counting (Important).** Added
   `AuthStore.authCountAdminTeams(userId, excludeStudioIds)` in
   `server/src/db/authStore.ts` — one indexed
   `SELECT COUNT(*) FROM user_studio_memberships WHERE user_id = ? AND role =
   'admin' AND studio_id NOT IN (...)` query (dynamic placeholder list built
   from `excludeStudioIds.length`, matching `CatalogDb`'s variadic-binds
   `run`/`first`/`all` signature — no separate array-param path needed since
   `BUILTIN_STUDIO_ORDER` is a fixed short list). `teams.ts`'s
   `countOwnedNonBuiltinTeams` now delegates to it directly instead of
   `authListStudioIdsForUser` + a per-row `authGetMembershipRole` call.
   Behavior is unchanged (same cap, same 20-team threshold) — the existing
   `teams.int.test.ts` "creation cap" test (20 successful creates then a 400
   on the 21st) passed unmodified. Added three `authStore.int.test.ts` unit
   cases for the new method: counts only admin'd teams while excluding a
   given id, counts everything with an empty exclusion list, and returns 0
   for a user with no admin memberships.

2. **`enabled_admin_count` on `GET /api/teams/:id` (contract addition).** The
   handler now calls the phase-1 `authCountEnabledAdmins(teamId)` store
   method and includes `enabled_admin_count` in the response body for every
   caller (member or admin — not gated behind the `role === 'admin'` invites
   branch, since the delta spec's row lists it as a top-level field). Two new
   `teams.int.test.ts` cases: a two-admin team's count is 2, and a
   single-admin team where that admin is disabled reads `enabled_admin_count:
   0` while `members` still lists them with `role: 'admin'` and no
   `disabled`/`disabled_at_utc` key (asserted the response is read via a
   second seeded member's session, not the disabled admin's own cookie —
   disabling doesn't revoke an existing session, but using an
   already-independent reader keeps the test from depending on that).

3. **Admin-plane delete cascade test gap (minor).** Added one case to
   `admin.int.test.ts`'s "admin studios" describe block: creates a studio via
   the admin API, seeds a pending `team_invites` row directly via
   `catalogFor().auth.authUpsertInvite`, deletes the studio via
   `DELETE /api/admin/studios/:studioId`, and asserts
   `authCountPendingInvites` drops to 0 — exercising the shared cascade
   (design D4 / commit `243b6bd`) from the admin plane, which previously only
   had self-serve-path coverage.

### Suite tail (fix round 1)

```
npm run typecheck
> autologger-server: tsc --noEmit                 (clean)
> autologger-web: tsc --noEmit                     (clean)
> companion-module-autologger: tsc --noEmit        (clean)
> tsc --noEmit -p e2e                              (clean)

npm test
 server:     Test Files  45 passed (45)   Tests  319 passed (319)
 web:        Test Files  13 passed (13)   Tests  123 passed (123)
 companion:  Test Files   6 passed (6)    Tests   20 passed (20)
```

Server test count rose from 313 to 319 (+3 `authStore.int.test.ts`, +2
`teams.int.test.ts`, +1 `admin.int.test.ts`). Diff scoped to
`server/src/routers/teams.ts`, `server/src/db/authStore.ts`, and the three
test files — no other files touched, per the fix brief.
