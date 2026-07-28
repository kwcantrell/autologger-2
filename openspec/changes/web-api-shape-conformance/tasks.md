# Tasks — web-api-shape-conformance

Plan of record, reflecting the 2026-07-27 gate ruling (runtime validation rejected; captured-
fixture contract checks adopted — `design.md` D1). Phases are ordered by dependency and are
individually shippable in the order given. Every phase ends green on `npm run typecheck` +
`npm test`; final gates run once at the end (phase 6).

`file:line` references anywhere in these artifacts are **orientation only** — locate the quoted
code by content before editing, since earlier phases shift line numbers.

## 1. Crash fix + admin-page regression coverage

Standalone and shippable on its own. Spec: `web-admin-users`. TDD pair — 1.1 and 1.2 are one
dispatch unit.

- [ ] 1.1 Write failing tests for `AdminUsersPage` against a fixture in the **real** response
      shape (`studios: [{id, name}]`): a user with memberships renders; a user with
      `studios: []` renders and still offers the add control; a membership whose `name` equals
      its `id` renders; the offered-teams set excludes existing memberships by `id`; the remove
      control issues `DELETE …/memberships/<id>`. Tests must fail against current `main`.
      Note: this fixture is superseded in phase 4 by the **captured** one — write it wire-
      accurate now, and 4.4 swaps it for the captured artifact.
- [ ] 1.2 Retype `AdminUser` in `web/src/api/types.ts` — replace `memberships: string[]` with a
      `studios` array of `{id, name}`, **reusing the existing `StudioBrief`** rather than
      declaring a new shape — and update its consumers in `AdminUsersPage.tsx`: the two direct
      reads of the field (chip list, add-membership filter: `Array.includes` → `.some(m => m.id
      === s.id)`) plus the remove-handler argument threaded out of the chip list.
- [ ] 1.3 Render the team **display name** on membership chips (D8). The remove control's
      accessible name becomes `Remove from <name>` while the request stays keyed by `id`.
      Extend the phase-1 tests to assert both.
- [ ] 1.4 Re-bless the two committed visual baselines this changes —
      `admin-users-visual-{desktop,mobile}-linux.png` — in this phase, not at the end, so the
      branch is never left red across phases (`npm run e2e:visual:update`, then confirm the
      diff touches only the admin-users snapshots).
- [ ] 1.5 Verify in a real browser against the running dev server. **Precondition: `ADMIN_TOKEN`
      set AND at least one seeded user with at least one membership** — dev auth is anonymous
      and creates no OAuth user rows, so an empty users table would make this observation
      vacuous. Confirm name-labelled chips render and the React root stays mounted with no
      console error. Record the observation in the ledger.
- [ ] 1.6 `npm run typecheck` + `npm test` green; `npm run lint` clean.

## 2. Characterize the `apiFetch` success path

Supports D5 — phase 5's repo-invariant guard reasons about how responses acquire types at this
seam, so the seam's actual behavior should be pinned first. The content-type branch is currently
untested (its 5 existing tests cover header merging and `ApiError` only). These tests also stand
on their own merit: `apiFetch` keeps its current behavior throughout this change, and nothing
else in the plan would notice if that broke.

- [ ] 2.1 Add tests to `web/src/api/client.test.ts` pinning current success-path behavior: a
      JSON content-type returns the parsed body; a non-JSON content-type returns the raw text;
      a JSON content-type with parameters (e.g. `application/json; charset=utf-8`) still takes
      the JSON branch. These describe today's behavior and must pass **before** any change.
- [ ] 2.2 `npm test` green — confirm the new tests pass against unmodified `client.ts`.

## 3. Conformance audit — semantic enumeration

Spec: `web-api-response-conformance`. Method is D6/D7. **A grep count is not acceptance
evidence** — the crashing call site is invisible to `grep 'apiFetch<'`.

- [ ] 3.1 Enumerate every site in `web/src` where a JSON API response acquires a client type.
      Four populations, each counted separately: (a) direct `apiFetch<T>` calls; (b) assertions
      through local generic wrappers — `fetchAdmin<T>` in `AdminUsersPage.tsx` and its call
      sites, which is where the bug being fixed actually lives; (c) untyped `apiFetch(…)` calls;
      (d) raw `fetch(…).json() as X` ingresses (AI-v2 dashboard persistence, SSE frame parsing,
      transcribe modal, audio clips). Record endpoint, client shape, and source file per site.
- [ ] 3.2 For each payload-bearing site, state the **property to verify** — "the emitted key set
      and value types for `<endpoint>`, under every branch" — then answer it by following the
      response to its **producing** function, not stopping at the router (D7). Handlers known to
      need this: `transcribe.ts` (`{...w, session_id}` — shape owned by the store),
      `showsStore.showApiDict` (`JSON.parse` passthrough of a DB column, unvalidated on read),
      `profileAssembler.profilePayload` (three structurally distinct branches),
      `teams.ts` (`invites` attached only for admin callers). Record: endpoint, client shape,
      emitted shape, branch conditions, verdict, and the evidence read.
- [ ] 3.3 Enumerate the `OkResponse` and `void` sites with an explicit verdict each. **They are
      not all trivial** — `transport/start` and `transport/stop` both `return c.json(state)`
      while the client asserts `OkResponse`. Verify rather than assume.
- [ ] 3.4 Write the ledger to a **tracked** file, `openspec/changes/web-api-shape-conformance/
      audit.md` (D9 — not `.apply/`, which is git-ignored and would not survive archival).
      State in it that `CONFORMS` means "client matches emitted", not "emitted is intended"
      (D10).
- [ ] 3.5 Fix every CLIENT-WRONG finding, each with a test. Two are already known and must be
      verified rather than rediscovered: (i) the `transport` mismatch from 3.3; (ii) the
      `Category.dropdown_options` split — `/api/profile`'s `active_studio.categories` emits
      `string[]` (`studioToApiDict`) while `ShowCategoriesResponse` emits `{label,
      needs_context}` (`showCategoriesApiShape`), under one shared client type. This needs a
      **type split**; consumers to update: `CategoryButtonStrip` (reads `opt.label`),
      `EventButtonsTable` (constructs `{label, needs_context}`), plus their tests.
- [ ] 3.6 Escalate every SERVER-WRONG finding in the ledger and the Panel & review log — **do
      not change the server**. Per D10 this verdict is reachable only where a documented
      statement about the shape exists to contradict.
- [ ] 3.7 `npm run typecheck` + `npm test` green.

## 4. Captured response fixtures

Spec: `web-api-response-conformance`. Depends on phase 3 — the audit tells us which endpoints
carry payloads and which shapes are branch-dependent.

- [ ] 4.1 Build the capture helper in the `server/` integration tier: issue a real request
      through `app.request` with the existing seed helpers, and assert the emitted body against
      a committed fixture. **Assert-only, with an explicit update path** (design Open Question)
      — auto-write-on-miss would silently bless drift, which is the failure mode being designed
      against.
- [ ] 4.2 Capture fixtures for the payload-bearing endpoints identified in 3.2, starting with
      `GET /api/admin/users` (`admin.int.test.ts` already issues this request — extend it).
      For branch-dependent shapes, capture **each** branch: `/api/profile` anonymous and
      authenticated; `/api/teams/:id` as admin and as member.
- [ ] 4.3 For any endpoint whose client type includes a string-literal union, emit that fixture
      as a `.ts` module with `as const` instead of `.json` (D4's verified wrinkle — JSON imports
      widen `"active"` to `string`, producing a false positive). Known affected types:
      `Category.type`, `ShowCategory.type`, `Session.session_status`, the seven `role: TeamRole`
      fields, and `CompanionCommandType`. Record the choice per endpoint in the ledger.
- [ ] 4.4 Swap the phase-1 admin-page test fixture for the captured artifact, so the admin tests
      and the conformance check validate against the same file (`web-admin-users` requirement).
- [ ] 4.5 `npm run typecheck` + `npm test` green.

## 5. Conformance checks + repo-invariant guard

- [ ] 5.1 Add the web-tier conformance module: for each captured fixture, a type-level
      assignment against the client type (`const _check: AdminUser = fixture.users[0]`). Verify
      it actually catches the bug — temporarily reintroduce `memberships: string[]` and confirm
      `npm run typecheck` fails, then revert. **A check that cannot be shown to fail is not a
      check.**
- [ ] 5.2 Confirm additive tolerance: a fixture field absent from the client type must **not**
      fail (excess-property checking does not apply to non-fresh expressions). Assert this
      deliberately — it is the forward-compatibility property the spec requires.
- [ ] 5.3 Add `web/src/apiResponseShapes.repo.test.ts` (D5), following the existing idiom in
      `queryKeyFactories.repo.test.ts` / `noAgentAuthoredMarkup.repo.test.ts`: fail when a site
      from any of 3.1's four populations has neither a conformance check nor a recorded
      exemption, naming the offending site. Cover the raw-`fetch` population too (design Open
      Question) — that is where the next instance is most likely.
- [ ] 5.4 Verify the guard fails as designed: add a throwaway unverified response site, confirm
      the test fails and names it, then remove it.
- [ ] 5.5 Record in the ledger every recorded exemption and every site deliberately left
      unverified, so the residual is measured rather than forgotten.
- [ ] 5.6 `npm run typecheck` + `npm test` + `npm run lint` green.

## 6. Final gates

- [ ] 6.1 `npm run typecheck` and `npm test` green across all three workspaces.
- [ ] 6.2 `npm run lint` clean.
- [ ] 6.3 `npm run e2e` (chromium + login-gate projects) green.
- [ ] 6.4 `npm run e2e:visual` (visual-desktop + visual-mobile) green against the baselines
      re-blessed in 1.4. Baselines are otherwise current as of 2026-07-14, so **any diff on a
      non-admin-users baseline at this point is an unintended regression** — investigate, do not
      re-bless.
- [ ] 6.5 Browser re-verification of `/admin/users` under 1.5's precondition: page loads, chips
      render names, no console error.
- [ ] 6.6 Confirm no runtime surface changed: `web/package.json` gained no dependency, and the
      built bundle carries no validation library (`web-api-response-conformance` requirement).
- [ ] 6.7 Confirm the working tree holds no stray files — `git diff --stat` and `git log --stat`
      reviewed against the intended file list; `audit.md` is **tracked**, `.apply/` artifacts
      stay git-ignored.
