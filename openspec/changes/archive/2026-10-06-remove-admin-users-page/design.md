# Design: remove the `/admin/users` page and the last legacy chrome CSS

## Context

The motivation is in proposal.md. This is the state on 2026-10-06, from a read-only footprint survey.

**Web**
- The page is three files under `web/src/app/(admin)/`: the second root layout, `AdminIsland.tsx`, and `admin/users/page.page.tsx`.
- Three more under `web/src/pages/admin-users/`: `AdminRoot.tsx` (StrictMode, ThemeProvider, TooltipProvider), `AdminUsersPage.tsx`, and its test.
- The page reads `ADMIN_TOKEN` from a password field into `sessionStorage['autologger_admin_token']` and sends it as `Authorization: Bearer` through a local `fetchAdmin<T>` wrapper over `apiFetch`.
- No other app code links to it. Every shared module it imports is also used by the index app.

**Routing**
- `(index)/[[...path]]/page.page.tsx` calls `notFound()` whenever `isShellSegments(path)` is false.
- `isShellSegments(['admin','users'])` is false: two segments, and the first isn't `sessions`.
- So with the `(admin)` group gone, `/admin/users` gets the same not-found page as `/nope` or `/admin/logs`.

**Server and infrastructure**
- There is no page route in the server: Hono bridges every unmatched GET to Next.
- `docker/scripts/test_router.sh` lists `/admin/users` in its "Shell served by web" loop (expects 200 HTML). Its recorded disposition table has `GET`/`HEAD /admin/users` as `200 … s-maxage=31536000`, and `/admin/logs` as `404 … private, no-cache, no-store, max-age=0, must-revalidate`.
- `/api/admin/*` (server `routers/admin.ts`, `ADMIN_TOKEN`-gated) has no other web caller. Its other caller is `server/scripts/bootstrapMemberships.example.ts`.

**Repo guards that reference the page**
- `apiResponseShapes.repo.test.ts`:
  - two exemptions (`:1213`, `:1218`);
  - five untyped `fetchAdmin` entries (`:1419-1437`);
  - the canary `fetchAdmin<AdminDataResponse>('admin/users')` (`:1723`);
  - population and detector floors measured on a tree that includes the page: the comment at `:1682` gives "wrapper 7", and the floor is `wrapper: 6`.
- `webBoundaries.repo.test.ts`:
  - the live-tree `admin-index-cross` rule (`:598`, `:633-634`, `:723-730`);
  - the "two entry bundles" spec reference (`:34`);
  - the route-group carve-out comments (`:244-252`, `:611-619`).
- `types.conformance.test.ts:54, 98-100, 400-450` cover the admin types against `fixtures/api-responses/adminUsers.json`.

**CSS**
- Every remaining chrome rule in `tailwind.css` has `AdminUsersPage` as its only consumer: `.header`, `.brand*`, `.tagline`, `.admin-settings-block`, `.settings-*`, `.profile-select`, `.main`, `.panel`, `.field`, `.btn*`, `.footer`, `.developer-*`, `.crumb`, and the max-md `.header` / `.btn`.
- The exceptions are `.shell` (AppShell), `.muted` (RecentSessionsList), and `.mono` / `.faint` (workspace).
- The perf-debug list at `:667-668` names `.panel` and `.footer`.

## Goals / Non-Goals

**Goals:**
- The page and every trace of it in web code, tests and types are gone, and `GET /admin/users` is the app's 404.
- The chrome CSS is deleted, and a guard keeps it from returning.
- Every repo guard keeps proving something real: floors are re-measured on purpose, never just lowered.

**Non-Goals:** see proposal.md. The API and the server are untouched.

## Decisions

**D1. Delete the route group and the page; the catch-all owns `/admin/users`.**
- Removing `(admin)` leaves `(index)` as the only route-group root layout. There is still **no `app/layout`**: `app/not-found.page.tsx` renders the not-found page **as its own document**, with its own `<html>`/`<body>`, outside the `(index)` layout. That's how `/nope` works today, and it stays so (panel correction: the scratch build served `/admin/users` and `/nope` both as `404 … 404 — Not Found`, without the `(index)` body attribute).
- Only the not-found file's "two root layouts" **comment** is updated. Its `<html>`/`<body>` stay, and no root layout is added.
- The scratch `next build` with the admin tree removed shows routes `○ /_not-found` and `ƒ /[[...path]]` only.
- `loginReturnPath.test.ts:319` already asserts `isShellSegments(['admin','users'])` is false, so no new unit test is needed (it can't start red). The not-found behaviour follows from the existing `notFound()` branch.
- The QA walk's `admin-users` capture checks the rendered page.

**D2. Delete the admin types and their conformance cases (owner decision).**
- `AdminStudioCreateBody`, `AdminStudio`, `AdminUser` and `AdminDataResponse` (`api/types.ts:667-690`) go.
- `AdminInfo` (`:290`, `:305`) stays: it's the profile's `admin` block, not the admin API.
- The `types.conformance.test.ts` `adminUsers` import and the "GET /api/admin/users" describe (`:400-450`) are removed, along with the "AdminUser tolerates `picture_url` / `created_at_utc`" case (`:778-790`).
- **The `ExpectUndeclared` helper's non-vacuity test (`:796-803`) is retargeted, not dropped (panel finding).** It proves a *declared* key fails to typecheck, using `AdminUser`/`email`. It becomes `ExpectUndeclared<SessionStatus, 'is_rolling'>` under the same `@ts-expect-error`, because `is_rolling` is declared on `SessionStatus` (`api/types.ts:444`). That keeps the proof behind web-api-response-conformance's "Verification tolerates additive server changes".
- `fixtures/api-responses/adminUsers.json` stays: `server/src/routers/apiResponseFixtures.int.test.ts:153` captures and owns it.

**D3. `apiResponseShapes.repo.test.ts`: re-measure, don't just lower.**
- Remove the AdminUsersPage exemptions and the five `fetchAdmin<>` entries; the no-stale-exemption check requires it.
- **Live covered-wrapper assertion (panel finding).** `:2414-2421` ("knows which client types are conformance-checked") requires `covered.some(s => s.typeNames.includes('AdminDataResponse') && s.detector === 'wrapper')`. That site was the only live typed wrapper call, so the assertion is removed. It gets the same "fixture-covered only" note as the canary. The covered-wrapper path stays pinned by the mutation suite's "a call through a NEW local generic wrapper is discovered" case (`:1821-1833`), which is extended to assert that its typed wrapper call is `covered: true`, alongside the existing uncovered one. The rest of that test's live-tree assertions (other covered types) stay.
- **Canary.** Remove the admin canary. Every other entry in `CANARY_SITES` names a live site that exercises a detector path. With the admin page gone, **no live site uses a local generic wrapper**: a grep for `function \w*<T>…apiFetch` outside admin-users finds nothing.
  - The wrapper detector stays covered by its synthetic mutation tests (`:1827-2034`: cross-file, wrapper-over-wrapper, alias, class-method and late-declaration cases).
  - A comment at `CANARY_SITES` records that the wrapper path is fixture-covered only, until a live wrapper exists again.
- **Floors.**
  - Re-run the scan on the post-removal tree.
  - Set `POPULATION_FLOOR`, each `DETECTOR_FLOORS` entry and `COVERED_FLOOR` with the same stated slack policy as the existing comment (`:1696-1703`: "a few sites under today's count").
  - Update the "Measured …" comment to the new numbers and date.
  - `wrapper` becomes `0`: there are no live sites. The comment says why, so a later reader doesn't mistake it for vacuity.
- The non-vacuity assertions that iterate `DETECTOR_FLOORS` (`:2397-2402`) must still pass.

**D4. `webBoundaries.repo.test.ts`: one entry.**
- Retire the three admin-only checks and their violation kinds (panel finding: the transitive check is admin-only too):
  - the live-tree `admin-index-cross` rule (`pages/admin-users` ↔ `pages/index`);
  - the `(index)` ↔ `(admin)` route-group check;
  - the **transitive reachability check**. Every call is `isReachable(graph, 'pages/admin-users', 'pages/index')` or its reverse (`:2148-2156`), and its B5 mutation suite (`:1936-2070`) exists only for that pair.
- Reword the "two entries" comments.
- The mutation and temporary-root tests of those three rules go with them. Without that they'd pass vacuously: a scratch run with the admin dirs deleted showed `109 passed` with no edits.
- **F2 is retargeted, not dropped** (`:1546`, alias-plus-`..` zone resolution). It is the only regression test for alias + `..` mis-zoning. It becomes an `api/…` file importing `@/api/../pages/index/AppShell` and asserting a `layering` violation (scratch: `scanFileForViolations` → `kind: 'layering'`).
- Tests for the surviving rules (layering, packages, app-layer, test-file) are untouched.
- The spec reference at `:34` changes to the new requirement name.
- Non-vacuity (self-locating root, non-zero file count, mutation pairs) still holds for every surviving rule.

**D5. `docker/scripts/test_router.sh`: record the new disposition deliberately.**
- Drop `/admin/users` from the "Shell served by web" loop.
- Add an explicit check that `GET /admin/users` returns `404` with `text/html`.
- In `EXPECTED`, change `GET` / `HEAD /admin/users` to the same disposition `/admin/logs` already records (`404 | - | - | - | text/html; charset=utf-8 | - | rsc, … | private, no-cache, no-store, max-age=0, must-revalidate`).
- Edit the "Recorded … edit only deliberately" header with this change's id. This script runs against the stage router (CI / owner), not jsdom.

**D6. Delete the remaining chrome CSS, and extend the guard.**
- **Deleted:**
  - `.header` (+ max-md), `.brand-with-logo .brand-lockup`, `.brand-logo`, `.brand-with-logo .brand-text`, `.brand h1`, `.tagline`;
  - `.admin-settings-block`, `.settings-panel .admin-settings-block`, `.settings-subheading`, `.settings-actions`;
  - `.profile-select` (+ focus-visible), `.main`, `.panel`, `.panel h2`, `.field`, `.field span`;
  - the `.btn` family (base, hover, disabled, `.primary`, `.danger`, max-md touch floor);
  - `.footer`, `.footer .mono`, `.developer-footer`, `.developer-label`, `.developer-logo`, `.crumb`, `.crumb a`, `.crumb a:hover`;
  - `.admin-table`, if a rule exists.
- **Edited:** the `.panel` / `.footer` entries leave the perf-debug selector list. The "shell width fix" comment at `.shell` (which cites the admin page) is reworded.
- **Kept:** `.shell` / `.shell-v3`, `.muted`, `.mono`, `.faint`, the bare `input[type=text], textarea` baseline and its placeholder rule (the contrast test reads it), and `--legacy-*` / `--color-legacy-*`.
- **Guard:** `shadcnHygiene.repo.test.ts` `DELETED` gains `btn`, `btn-icon`, `profile-select`, `admin-settings-block`, `settings-subheading`, `settings-actions`, `settings-panel`, `brand-with-logo`, `brand-lockup`, `brand-logo`, `brand-text`, `tagline`, `developer-footer`, `developer-label`, `developer-logo`, `crumb`, `admin-table`. Generic words (`field`, `primary`, `danger`, `header`, `main`, `panel`, `footer`, `brand`) stay off the list, as in 3c-2a.

**D7. Specs.** See `specs/`. The web-coordination-seam Purpose sentence ("…the `admin-users` and `index` page bundles never import from each other…") can't be expressed in a delta. It is rewritten directly during the archive sync, and the archive PR says so.

## Assumptions (tested)

- **A1. `/admin/users` is not a shell path.** `sed -n 84,92p web/src/shared/utils/loginReturnPath.ts` → `if (segments.length === 2) return segments[0] === 'sessions' && …; return false;`. `(index)/[[...path]]/page.page.tsx` → `if (!isShellSegments(path)) { notFound(); }`.
- **A2. Nothing outside the page uses the chrome classes.** A grep of class-argument tokens (`className=` / `clsx(` / `cn(`, non-test, excluding `pages/admin-users`) finds no `btn`, `primary`, `danger`, `btn-icon`, `field`, `profile-select`, `admin-settings-block`, `settings-*`, `header*`, `brand*`, `tagline`, `main`, `panel`, `footer`, `developer-*`, `crumb` or `admin-table`. Kept: `shell` (AppShell), `muted` (RecentSessionsList), `mono` (TranscribeRow, Timeline, TopicsRow, RecentSessionsList), `faint` (Timeline). A second literal-token grep matched only a local variable named `btn` (`CategoryButtonStrip.tsx:299`).
- **A6. Post-removal scan counts (panel, scratch tree).**

  | Count | HEAD | Post-removal |
  | --- | --- | --- |
  | Population | 150 | 138 |
  | Covered | 90 | 85 |
  | apiFetch | 68 | 67 |
  | wrapper | 7 | 0 |
  | conformanceAssertion | 56 | 52 |
  | rawFetch | 7 | 7 |
  | jsonBody | 5 | 5 |
  | jsonParse | 5 | 5 |
  | beacon | 2 | 2 |

  The "Measured" comment is already stale on HEAD. A 0 floor passes the floor loop (`counts[d] < floor`).
- **A7. The not-found page is its own document.** `next start` on the scratch build → `/admin/users` and `/nope` both `404 … 404 — Not Found`, without `data-v4-transport`. Their headers are byte-identical to `/admin/logs`.
- **A3. No live generic wrapper remains.** A grep for `fetchAdmin` or `function \w*<T>…apiFetch` outside `pages/admin-users` (non-test) finds nothing. The wrapper detector's coverage is the mutation suite (`apiResponseShapes.repo.test.ts:1827-2034`).
- **A4. The router's recorded disposition for an unknown `/admin/*` path.** `sed -n 85,96p docker/scripts/test_router.sh` → `"GET /admin/logs": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, … | private, no-cache, no-store, max-age=0, must-revalidate"`.
- **A5. The `/api/admin/*` API has no other web consumer.** A grep for `'admin/` in `web/src` outside `pages/admin-users` (non-test) finds only example paths in tests. The server bootstrap script is the remaining caller (README:1381-1391).

## Risks / Trade-offs

- **[An operator relied on the page]** → It's a deliberate owner decision. The proposal and README point to curl or the bootstrap script. The API is unchanged.
- **[Floors lowered too far hide a scan regression]** → D3 re-measures and applies the existing slack policy, with the numbers in the comment. `wrapper: 0` is justified in place, and its coverage is the mutation suite.
- **[The boundary-test edit drops a rule that still matters]** → Only the admin-specific rule goes. The surviving rules keep their non-vacuity tests, and the consistency read checks this.
- **[`test_router.sh` can't run locally]** → It runs in CI and the stage flow. D5 mirrors `/admin/logs`'s recorded 404 disposition exactly. Running it is part of the owner's pass where possible.
- **[A deleted chrome rule still styles something]** → A2 greps, the extended guard, and the QA walk's untouched screens at 0%.

## Migration Plan

Deploy normally. Rolling back means reverting the merge commit: the API never changed, so no data or contract migration is involved. Operators use curl or the bootstrap script for admin tasks from deploy onward.
