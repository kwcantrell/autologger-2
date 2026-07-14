# Tasks — teams-self-serve

Plan of record (post-panel, post-gate — see design.md "Panel & review log"). Every
code-bearing task lands with its tests; `npm run typecheck` + `npm test` gate each
commit. `file:line` anchors are orientation only — locate quoted code by content.

## 1. Catalog: roles + invites storage

- [x] 1.1 Migration (one file): `role TEXT NOT NULL DEFAULT 'member'` on
      `user_studio_memberships` + backfill existing rows to `admin` EXCLUDING
      built-in studio memberships (gate ruling, design D1) + `team_invites` table
      (design D2 shape, `invited_at_utc`); migrator int test proving the
      built-in-aware backfill and fresh-DB shape
- [x] 1.2 `AuthStore` extensions with int tests: role-aware membership ops (create
      with role, upsert role, enabled-admin count per team), invite CRUD
      (JS-normalized upsert — never SQL `lower()`, list per team, delete,
      per-team count for the cap), lookup ALL user rows by normalized email
      including disabled (design D2 multi-match)

## 2. Teams router (the endpoint family)

- [x] 2.1 Integration tests first — the full family per the api-contract-freeze
      delta table + default-behaviors clause: 401 anonymous; masked 404 non-member
      vs nonexistent (indistinguishable); 403 member-on-admin-route; **built-in id
      rejected 400 on every management route**; create (shared `STUDIO_ID_SLUG_RE`
      validation, built-in/duplicate rejection, creator becomes admin, creation cap
      400 at 20 owned non-built-in teams); rename (shares create's display-name
      validation); delete (blocks-on-shows, full cascade incl. invites via the
      shared store method); invite (existing user → immediate member for ALL
      matching rows, uniform 200; existing member → strict no-op incl. sole-admin
      case; unknown email → pending, idempotent; email shape/length validation;
      pending cap 400 at 200); revoke (idempotent 200; `:email` decoded+normalized);
      role change + remove + leave with last-enabled-admin 409s (all three paths;
      disabled admin rows don't count; count+mutate in one transaction); role
      change to held role idempotent 200; unknown `:userId` member target 404;
      GET detail (members for members, invites only for admins)
- [x] 2.2 Implement `server/src/routers/teams.ts` (helpers per design D3 incl. the
      wholesale built-in guard, shared delete method with the admin path per D4,
      transactional last-admin checks, caps per D10) + Zod schemas; wire into
      `app.ts`

## 3. Sign-in materialization + callback fixes

- [x] 3.1 Integration tests first — new-user branch: pending invites for the
      normalized Google email materialize into `member` memberships atomically
      (single catalog tx wrapping create + prefs + materialization, design D2) and
      consume the rows — ONLY when `email_verified: true` (absent/false → user
      created, invites remain); revoked invite does not materialize; existing-user
      sign-in does not re-scan; `NEW_USER_ALL_TEAMS=1` grants nothing; **disabled
      user signs in → 302 `/?login_error=account_disabled`, no cookie, no writes
      (replacing the latent 500 — design D11)**
- [x] 3.2 Implement: transactional materialization in the callback's new-user
      branch (replacing the `NEW_USER_ALL_TEAMS` grant; KV login-session write
      stays outside the tx), disabled-account redirect, one-time startup
      deprecation warning (design D5); README env docs + `.env.example` updated

## 4. Profile + admin-plane additive fields

- [x] 4.1 Int tests + implementation: `auth.user.teams[]` gains `role` (profile
      assembler, one site); admin add-membership body accepts optional `role`
      with **upsert semantics** (existing membership's role updated — rescue
      scenario: promote a remaining member of an orphaned team; legacy body
      unchanged, defaults member)
- [x] 4.2 README endpoint table rows for the `/api/teams` family + `GET /teams`
      HTML route

## 5. Routing + serve-path extension

- [x] 5.1 Server: `GET /teams` HTML route beside `/sessions/:id` (int test: 200
      shell, no Set-Cookie, `/teams/x` unchanged); shared route-module extension
      (`/teams` in the router-known predicate) + the three lockstep mirrors in the
      same commit: AppShell wouter pattern, vite dev-middleware matcher, serve
      block (design D6); web unit tests: stash validator accepts `/teams`, still
      rejects `/admin/users`; stash write fires on `/teams`; full consume
      round-trip for a stashed `/teams` (replace-navigate + stash cleared — the
      spec's "Teams deep link survives the sign-in round-trip" scenario)
- [x] 5.2 Wire `/teams` into `AppShell`; unit tests: navigate to `/teams` + Back;
      leaving a rolling session for `/teams` fires the originator departure stop
      exactly once (the MODIFIED transport-stop scenario)

## 6. Teams UI + onboarding

- [x] 6.1 API hooks + types for the family (`useTeam(id)`, mutations with
      profile/detail invalidation — design D7); unit tests for invalidation wiring
- [x] 6.2 `/teams` page: teams list with roles from profile; create-team form
      (slug + display name, validation + cap errors surfaced); admin panel per team
      (rename, members with promote/demote/remove, invite form, pending invites
      with revoke, delete); member view (read-only + leave); built-in memberships
      read-only legacy entries (no controls, no leave); zero-enabled-admin teams
      show the contact-support notice; dev-anonymous renders a signed-in-required
      notice and issues no `/api/teams` requests; shell affordance to reach
      `/teams` (navigation wrapper only). Unit tests: admin vs member affordances,
      invite round-trip without reload, last-admin 409 surfaced as an actionable
      message, built-in read-only, orphaned-team notice, dev-anonymous no-fetch
- [ ] 6.3 Zero-membership onboarding state at `/` (design D8): renders for
      logged-in zero-team profiles, create-first-team lands the user in the team;
      unit tests incl. dev-anonymous unaffected

## 7. e2e

- [ ] 7.1 Seeded-session harness fixture (gate ruling, design/panel S2): e2e setup
      seeds a user row + hashed login-session token directly into the hermetic
      server's catalog DB (KV-on-sqlite) and injects the cookie into the browser
      context — test-side only, no server surface; prove it with a trivial
      authenticated profile assertion
- [ ] 7.2 Teams smoke (authenticated via 7.1's fixture): create team → rename →
      invite an email → pending invite visible → revoke; zero-membership
      onboarding covered if the fixture can seed a zero-team user cheaply (else
      unit-tier coverage stands — note in report)
- [ ] 7.3 Login-gate project: anonymous `/teams` renders the login view with URL
      preserved and sign-in hrefs intact (mirrors the sessions deep-link test)

## 8. Final gates

- [ ] 8.1 `npm run typecheck` + `npm test` + `npm run e2e` +
      `npx playwright test --project=login-gate` + `npm run lint` green at branch
      tip
- [ ] 8.2 Whole-branch review (per SDLC), then merge readiness
