# Task 4.1 / 4.2 report — profile teams role field; admin membership upsert; README rows

## 4.1 — implementation

### Store method choice

Added `AuthStore.authListMembershipsForUser(userId)` in `server/src/db/authStore.ts`
(right after `authListStudioIdsForUser`), returning `Array<{ studioId, role }>` in a
single indexed query:

```sql
SELECT studio_id, role FROM user_studio_memberships WHERE user_id = ? ORDER BY studio_id
```

Preferred this over reusing `authGetMembershipRole` per team (would be an N+1 over
`studioOrderTuple()`), matching the phase-2 review precedent already set by
`authCountAdminTeams` (single indexed query, comment cites the same rationale).

`ProfileAssembler.authSection` (`server/src/db/profileAssembler.ts`) now builds a
`Map<studioId, role>` from that call instead of a `Set<studioId>`, and the `teams`
mapper adds `role: roleByStudioId.get(sid)` per entry. Everything else in the method
(order via `studioOrderTuple()`, filter to allowed ids, `names` lookup) is unchanged —
additive-only, per the spec's "field is additive" language.

### The deliberate legacy-downgrade pin

`server/src/schemas.ts`: `adminMembershipBodySchema` gained `role: z.enum(['admin',
'member']).optional()`.

`server/src/routers/admin.ts` `POST /api/admin/users/:userId/memberships` now calls
`catalog.auth.authUpsertMembershipRole(userId, sid, body.role ?? 'member')` instead of
`authAddMemberships` (which was `INSERT OR IGNORE` — a silent no-op on an existing row,
which would have broken the orphaned-team rescue path). `authUpsertMembershipRole`
already existed from phase 1 (`ON CONFLICT ... DO UPDATE SET role = excluded.role`) —
no new store method needed here, just switching which one the router calls.

Per the spec text ("when absent, behavior is the existing one with role defaulting to
member" + "if the membership already exists, its role is updated to the requested (or
defaulted) value"), a legacy role-less re-POST on an **existing admin membership**
downgrades it to `member`. This is pinned explicitly in
`admin.int.test.ts`: *"re-POSTing a legacy (role-less) body on an existing admin
membership downgrades it to member"* — seeds an admin membership via
`authAddMembershipWithRole`, re-POSTs with no `role` field, asserts the role reads back
as `member`. Comment in the test and in the router explains this is deliberate
(support plane is a precision tool, not last-admin protected — matches the spec's
explicit carve-out).

Also added: the rescue scenario itself (member of an orphaned team promoted to admin
via `role: "admin"`, confirming the upsert actually mutates rather than no-oping), and
a legacy-body-creates-member test for the base case.

### Tests added

- `server/src/routers/admin.int.test.ts` — new `describe('admin add-membership role
  field (teams-self-serve, task 4.1)')` block, 3 tests (legacy create, rescue-by-
  promotion, legacy-downgrade pin).
- `server/src/routers/shows-profile.int.test.ts` — one new test in the existing `GET
  /api/studio + /api/profile` describe block: seeds a user with an admin membership on
  one team and a member membership on another (`authAddMembershipWithRole` +
  `loginCookie`), asserts `auth.user.teams` carries the matching `role` per entry.

## 4.2 — README endpoint table

Added, in `README.md`'s frozen endpoint table (after the existing admin row, before the
session deep-link row):

```
| `POST /api/teams` · `GET\|PATCH\|DELETE /api/teams/{id}` | `routers/teams.ts` (new, teams-self-serve) |
| `POST …/invites` · `DELETE …/invites/{email}` · `POST …/members/{userId}/role` · `DELETE …/members/{userId}` · `POST …/leave` | `routers/teams.ts` (new, teams-self-serve) |
| `GET /sessions/:id` (SPA shell) | (app.ts page route) |
| `GET /teams` (SPA shell) | (app.ts page route) |
```

Two rows cover the nine `/api/teams/*` routes (create + detail/rename/delete = 4;
invites/role/remove/leave = 5); origin column uses `routers/teams.ts (new,
teams-self-serve)` since this family has no Python-era counterpart (the header's
"origin records which Python module each route was ported from" framing doesn't apply,
so this makes the novelty explicit rather than leaving the cell implying a port that
never existed). `GET /teams` mirrors the existing `GET /sessions/:id` row's framing
exactly (`(SPA shell)` / `(app.ts page route)`), documenting it ahead of task 5.1's
implementation — consistent with how the frozen-contract table is meant to be read
(spec-first).

Checked for a stale "admin-token only" claim about team management: found none. The
only ADMIN_TOKEN-related prose (`admin.ts ADMIN_TOKEN-gated users + studio-definitions
admin` in the source-layout tree, and the endpoint table's admin row) describes the
support plane specifically, not a claim that team management is admin-token-exclusive
— no edit needed there. Left the "Frontend (web/ workspace)" paragraph listing `GET /`,
`GET /sessions/:id`, `GET /admin/users` as serving built HTML **unchanged** — `GET
/teams` isn't wired into the serve block yet (that's task 5.1, out of this task's
scope per the scope guard), so adding it there now would misdescribe current behavior.

Did not touch `teams.ts`, `auth.ts`, `web/`, or the serve block, per the scope guard.

## Commits

1. `feat(api): profile teams role field; admin membership upsert with role` — store
   method, profile assembler wiring, schema + router upsert change, all three new
   int tests.
2. (this task's tasks.md tick + README rows land together with the docs commit below)

## Suite tails (both green before each commit)

```
npm run typecheck   → server + web + companion + e2e all pass, no errors
npm test             → server: 46 files / 333 tests passed
                       web:    13 files / 123 tests passed
                       companion: 6 files / 20 tests passed
```

## Concerns / residual notes

- None blocking. The two new README rows for `/api/teams/*` document already-shipped
  (phase 2) surface; only the `GET /teams` row is ahead of implementation, as directed.
- `authAddMemberships` (the old `INSERT OR IGNORE` bulk helper) is now unused by the
  admin router but still used by `server/src/test/helpers.ts`'s `seedUser({ studios })`
  and possibly the sign-in materialization path — left untouched, out of scope for this
  task.
