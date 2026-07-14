# Task 6.1–6.3 report — Teams UI + onboarding

Branch: `teams-self-serve`. Commits (3, each green on `npm run typecheck` +
`npm test` + `npm run lint`):

1. `7dba365` feat(web): team API hooks + types (task 6.1)
2. `8191192` feat(web): /teams management page + rail affordance (task 6.2)
3. `e050354` feat(web): zero-membership onboarding at / (task 6.3)

Final gate at branch tip: server 335 / web 157 / companion 20 tests, all
green; `npm run typecheck` clean across server+web+companion+e2e; `npm run
lint` clean (5 pre-existing warnings in `TopicsRow.tsx` /
`shared/utils/loadingVideo.ts`, files this work never touched — confirmed via
`git status` before each commit). `tasks.md` 6.1/6.2/6.3 ticked in the task
6.3 commit.

## Hook API (task 6.1) — `web/src/api/hooks/useTeams.ts`

- `teamKeys.detail(teamId)` → `['team', teamId]`.
- `useTeam(teamId)` — `GET /api/teams/:id`, ordinary react-query staleness
  (no latch, unlike `useSession`'s deep-link latch), `enabled: teamId !==
  ''`. Callers pass `''` to disable (collapsed cards, built-in rows).
- Mutations: `useCreateTeam`, `useRenameTeam(id)`, `useDeleteTeam(id)`,
  `useInviteToTeam(id)`, `useRevokeInvite(id)`, `useChangeMemberRole(id)`,
  `useRemoveMember(id)`, `useLeaveTeam(id)`. Every one invalidates
  `teamKeys.detail(id)` (except create, which has no prior detail cache
  entry) **and** `['profile']` — both surfaces (the `/teams` list, sourced
  from the profile, and the expanded detail) go stale together. Delete/leave
  additionally `removeQueries` the detail key.
- Types added to `web/src/api/types.ts`: `TeamRole`, `TeamMembershipBrief`
  (extends `StudioBrief` with `role`; `AuthUser.teams` is now
  `TeamMembershipBrief[]`), `TeamMember`, `TeamInvite`, `TeamDetail`
  (`invites?` optional, matching the server omitting it for non-admins),
  request/response body types for the whole family. Purely additive.
- Tests (`useTeams.test.tsx`, 10 tests): asserts invalidation as an
  *observable effect* (`getQueryState(key)?.isInvalidated`/cache-drop) rather
  than spying on `invalidateQueries` calls directly, plus id/email
  URL-encoding and the empty-id no-fetch gate.

## `/teams` page structure (task 6.2)

- `TeamsRoute.tsx` — stable outer `data-testid="teams-route"` wrapper
  (required by the pre-existing `AppShell.test.tsx` "/teams route mount"
  test, which renders the real component). Branches on `useProfile()`:
  `profile.auth.user === null` → signed-in-required notice, nothing else
  mounts (no team hooks called, so dev-anonymous issues zero `/api/teams*`
  requests). Otherwise renders `CreateTeamForm` (exported for reuse by
  `OnboardingPanel`, task 6.3) + a list built from
  `profile.auth.user.teams[]`: built-in ids (`test-studios`,
  `test-studio-2`, hardcoded locally — no server export exists) render a
  static `BuiltinTeamRow` (no expand, no fetch); everything else renders
  `TeamCard`.
- `TeamCard.tsx` — collapsed by default; `useTeam(expanded ? team.id : '')`
  so expansion is what triggers the detail fetch (design D7). On data:
  `enabled_admin_count === 0` → orphaned-team notice (checked before role,
  since it can only ever be true for a `member` viewer — an admin viewer is
  by definition an enabled admin); else `role === 'admin'` → `AdminPanel`
  (rename form, members list with promote/demote/remove, invite form,
  pending invites with revoke, all mutation errors surfaced inline via
  `role="alert"` using the `{detail}` text through `ApiError.message`);
  else → `MemberPanel` (read-only members + leave, per the task brief — the
  admin view intentionally has no leave affordance, matching "MEMBER view =
  read-only members + leave" verbatim; last-admin 409 is instead exercised
  via an admin self-demoting as sole admin, which the admin panel does
  expose).
- `V6Rail.tsx` — added a minimal "Teams" nav button in the rail footer
  calling `navigate('/teams')` through the navigation wrapper only (no
  `V6Rail.test.tsx` exists; `AppShell.test.tsx` mocks `V6Rail` entirely, so
  this is unexercised by the existing suite but doesn't touch routing
  logic).
- `vite.config.ts` — fixed the stale dev-shell comment (~line 38) to mention
  `/teams` alongside `/` and `/sessions/<segment>`.
- Tests (`TeamsRoute.test.tsx`, 7 tests): dev-anonymous no-fetch, built-in
  read-only + no fetch, admin-vs-member affordances (scenario verbatim),
  invite round-trip without reload (real invalidation-driven refetch, not
  simulated), last-admin 409 actionable message, orphaned-team notice,
  create-form cap-error surfaced inline.

## Onboarding condition (task 6.3)

`AppShell.tsx` computes, after all hooks and before the main return:

```ts
const needsOnboarding =
  profile !== undefined &&
  profile.auth.logged_in &&
  profile.auth.user !== null &&
  profile.auth.user.teams.length === 0;
```

keyed on `logged_in && teams.length === 0` per the brief — never on
`studios` emptiness (dev-anonymous always reports the built-in studio in
`studios` but has `logged_in: false`, so it's structurally excluded). When
true, `AppShell` returns `<Toast/><OnboardingPanel/>` instead of the
rail+main tree — a render switch inside the authed shell, not a new gate
(RootGate is untouched). `OnboardingPanel.tsx` reuses `CreateTeamForm`
verbatim; no explicit post-create navigation is needed because
`useCreateTeam` already invalidates `['profile']` (task 6.1), so a
successful create refetches the profile, `needsOnboarding` flips false, and
the normal shell mounts on the next render.

Tests live in a new `AppShell.onboarding.test.tsx` (4 tests) rather than the
existing `AppShell.test.tsx`, because that file mocks `useProfile` entirely
(fine for its routing assertions, but incompatible with the "success lands
in the normal shell" scenario, which needs a real invalidate→refetch round
trip). This file uses the REAL `useProfile`/`useCreateTeam` hooks against a
real `QueryClient` with only `apiFetch` mocked at the module boundary, plus
lightweight stand-ins for `V6Rail`/`SessionRoute`/etc. (the same idiom
`AppShell.test.tsx` uses for those). Covers: onboarding renders for
zero-team logged-in profile, dev-anonymous unaffected, ≥1-team profile skips
onboarding, and the full create round-trip landing in the normal shell.

## What was mocked, by file

- `useTeams.test.tsx` — `apiFetch` only (real react-query).
- `TeamsRoute.test.tsx` — `useProfile` (module boundary) + `apiFetch`; real
  `useTeam`/mutation hooks and real `QueryClient` underneath.
- `AppShell.onboarding.test.tsx` — `apiFetch` (real `useProfile` +
  `useCreateTeam`), plus the same child-component/utility mocks
  `AppShell.test.tsx` already uses (`V6Rail`, `SessionRoute`,
  `NewSessionModal`, `YouTubeImportErrorModal`, `Toast`, breakpoints,
  loadingVideo, perfDebug, `useYoutubeImport`) so only the onboarding switch
  is under test.
- Pre-existing `AppShell.test.tsx` (routing/departure tests) was **not**
  modified and still passes unchanged — it mocks `useProfile` with
  `{ data: undefined }` by default, under which `needsOnboarding` is false
  by construction (`profile !== undefined` guards it), so the new branch
  never fires for those tests.

## Suite tails (branch tip)

```
server: Test Files  46 passed (46) | Tests  335 passed (335)
web:    Test Files  16 passed (16) | Tests  157 passed (157)
companion: Test Files  6 passed (6) | Tests  20 passed (20)
```

Web went from the pre-existing 136 → 157 (21 new: 10 hooks, 7 page, 4
onboarding). No existing test was modified or broken.

## Concerns / follow-ups (not blocking)

- `V6Rail`'s new "Teams" button has no dedicated component test (no
  `V6Rail.test.tsx` exists in the repo at all; `AppShell.test.tsx` mocks the
  whole component). Low risk — it's a one-line `navigate('/teams')` call
  through the same wrapper every other nav action already uses, and the
  `/teams` route mount itself is covered by `AppShell.test.tsx`'s existing
  test.
- `BUILTIN_TEAM_IDS` (`test-studios`, `test-studio-2`) is hardcoded in
  `TeamsRoute.tsx` since no shared web-side constant exists; if the
  server-side `BUILTIN_STUDIO_ORDER` list ever grows, this needs a matching
  edit (same lockstep-by-review situation as design D6's route mirrors).
