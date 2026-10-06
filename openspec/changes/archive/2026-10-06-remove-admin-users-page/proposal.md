# Remove the `/admin/users` page and the last of the legacy chrome CSS

Tier: 2
Tier reason: it removes a feature and the browser's only `ADMIN_TOKEN` entry point (auth-adjacent), changes an observable response (`GET /admin/users` goes from the shell to the app's 404), and retires a spec capability. It touches no `high_risk_paths`, and the `/api/admin/*` contract is unchanged.

Approved-by: Kalen 2026-10-06

## Why

The owner is retiring the `/admin/users` browser page. On it, an operator pastes `ADMIN_TOKEN` (kept in `sessionStorage`) to list users and edit team memberships through `/api/admin/*`.

It's also the last consumer of the legacy chrome CSS: `.btn*`, `.field`, `.profile-select`, `.settings-*`, `.admin-settings-block`, and the page chrome. Changes 3a–3c-2a ported every other surface onto the shadcn layer, so removing the page lets that CSS go and finishes the legacy-chrome retirement. It also removes the only place the browser ever holds `ADMIN_TOKEN`.

## What Changes

- **BREAKING (UI): `/admin/users` is removed.**
  - The `(admin)` route group and `web/src/pages/admin-users/` are deleted.
  - `GET /admin/users` now renders the app's existing not-found page (404); there's no redirect.
  - **The `/api/admin/*` API, `ADMIN_TOKEN`, the server admin router and its tests are unchanged.** Admin tasks move to curl. The README gains a tested curl recipe for **each of the seven** admin operations the page offered (panel finding):
    - list users (with the user-id lookup);
    - create and delete a team (studio);
    - add and remove a membership;
    - disable and enable a user. Disable is the incident kill switch.

    `server/scripts/bootstrapMemberships.example.ts` still covers bulk bootstrap.
  - **No `api-contract-freeze` delta (stated for the owner to rule on; panel finding).** AGENTS.md asks for an `api-contract-freeze` amendment for observable HTTP changes. The `/admin/users` *document* route is in neither the README endpoint table (the normative route inventory, which lists only `/api/admin/*` for admin) nor `api-contract-freeze`, which freezes only `/api/admin/*` and the `/teams` and `/sessions/:id` HTML routes. Its router disposition is frozen in `container-deployment`, and this change amends that spec. The frozen `/api/admin/*` contract is untouched.
- **Admin response types deleted:** `AdminUser`, `AdminStudio`, `AdminDataResponse` and `AdminStudioCreateBody` in `web/src/api/types.ts`, with their `types.conformance.test.ts` cases. The captured fixture `fixtures/api-responses/adminUsers.json` stays, because the server's fixture-capture test owns it.
- **Remaining legacy chrome CSS deleted** from `tailwind.css`:
  - `.btn` family, `.field`, `.profile-select`;
  - `.admin-settings-block`, `.settings-subheading`, `.settings-actions`;
  - `.header`, `.brand*`, `.tagline`, `.main`, `.panel`, `.footer`, `.developer-*`, `.crumb`;
  - the `.panel` / `.footer` entries in a perf-debug selector list.

  The hygiene guard's deleted-class list grows to match. Kept, because they're still used: `.shell` / `.shell-v3`, `.muted`, `.mono`, `.faint`, the bare input/textarea baseline, and the `--legacy-*` tokens.
- **Repo guards updated, not silently weakened:**
  - `apiResponseShapes.repo.test.ts`: admin exemptions, the admin canary and the live `AdminDataResponse` covered-wrapper assertion removed; population and detector floors re-measured (wrapper 7 → 0).
  - `webBoundaries.repo.test.ts`: the admin-only rules retired (admin-index-cross, route-group cross, the transitive admin↔index reachability check) along with their tests. The alias-plus-`..` zone regression test is retargeted to the layering rule.
  - `types.conformance.test.ts`: the admin cases removed. The `ExpectUndeclared` helper's non-vacuity test is retargeted to a declared `SessionStatus` key.
  - `docker/scripts/test_router.sh`: `GET /admin/users` is now expected to return 404.
- **Docs:** README shell and deep-link lists drop `/admin/users`. The admin API section notes it's curl or script only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- **`web-admin-users`:** retired. All four requirements are REMOVED, and `retire_capabilities: true` deletes the main spec at archive.
- **`web-frontend-platform`:** "Shell routing from the shared route definition", "Client-island rendering" and "Server-rendered shell" drop the admin route and island. `/admin/users` falls through to not-found.
- **`web-coordination-seam`:** "The web app's internal import direction is mechanically enforced" is replaced (REMOVED + ADDED, because a MODIFIED block can't drop a scenario) by the same requirement "…across its single entry", without the admin-island clauses and the two-bundle scenario. The capability's Purpose sentence about "the `admin-users` and `index` page bundles" is edited directly when the spec is synced at archive (the delta format can't express a Purpose edit).
- **`web-ui-system`:** "Themed confirmations replace browser chrome" drops "including the admin-users page".
- **`container-deployment`:** "Internal router preserves the single-origin disposition matrix". `/admin/users` leaves the "Shell served by web" scenario, and a new scenario says it is a 404 from `web` with `/api/admin/*` unaffected.

## Non-goals

- Any change to `/api/admin/*`, `ADMIN_TOKEN`, the server admin router or its tests, or the `adminUsers.json` fixture.
- A replacement admin UI.
- `server/src/routers/staticServing.int.test.ts`, which uses `/admin/users` only as an example path for the bridge and still passes. Editing it would add a high-risk path for nothing.
- `.shell`, `.muted`, `.mono`, `.faint`, the input baseline, and the tokens.
- Dashboards (3d) and the Assistant (4).

## Impact

- **Deleted:**
  - `web/src/app/(admin)/**`;
  - `web/src/pages/admin-users/**`;
  - the admin types and their conformance cases;
  - about 300 lines of `tailwind.css`.
- **Edited:**
  - the repo tests `apiResponseShapes`, `webBoundaries` and `shadcnHygiene`;
  - `docker/scripts/test_router.sh`;
  - comment-only mentions across `web/src`;
  - `README.md`.
- **Behaviour:** `GET /admin/users` returns 404 with the app's not-found page.
- **Operators:** admin tasks move to curl or the bootstrap script.
- **Dependencies:** none.
