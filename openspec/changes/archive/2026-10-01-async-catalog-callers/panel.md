# Panel: async-catalog-callers
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-10-01

- [x] [critical] The temporary D4 test's lexical "inside `.tx(`" exemption contradicts D2. The three `mutate` arrows (`teams.ts:277-278, 296-297, 307-308`) and `wouldStripLastEnabledAdmin` (`:102, 103, 107`) run inside the transaction but aren't lexically inside it. The natural "fix" (`async (cat) => { await … }`) typechecks against `(catalog) => void`, passes every test today, and in slice 4 runs the write after `COMMIT`, outside the last-admin guard (two admins removing each other leave zero admins). Resolved: the temporary test is dropped (D4). The transaction-reachable code is named explicitly (D2). `mutate` is typed `(catalog) => undefined` with block-bodied arrows. The promise-hygiene test now flags async functions passed where a void callback is expected (spec MODIFIED, scenario added).
- [x] [major] Drop the temporary catalog-await test: it duplicates what 3d's types plus the hygiene test give for free and must be deleted in 3d. Resolved: dropped. Completeness is proven by a local retype probe recorded in the task log (design D4, task 2.4).
- [x] [major] The ADDED requirement was a transitional implementation rule, stricter than and in tension with "Server code never drops or misuses a promise" (it demanded `await` where returning is allowed), and 3d would have had to remove it. Resolved: no ADDED requirement. The existing requirement is MODIFIED with durable rules only.
- [x] [major] The hygiene test misses `c.json(promise)` (`profile.ts:36,58,133`), shorthand fields (`teams.ts:165-173` `{ members }`), and promise `=== null` comparisons (`teams.ts:287`), all of which 3d would rely on. Resolved: three permanent checks with fixtures (design D4, task 1.1).
- [x] [major] D5 missed the authorisation time-of-check to time-of-use gap: each `requireTeamAdmin` gate reads the role outside the mutating write. Resolved: slice 4 hazard D6.1 (re-check in the transaction, or RLS in slice 6).
- [x] [major] D5 missed the cross-router race between team delete (`adminDeleteStudio` counts shows outside its transaction) and show create. Resolved: slice 4 hazard D6.6.
- [x] [minor] The 74-call figure was wrong; the probe counts 56 to convert. Resolved: D1 table and tasks use the probe counts.
- [x] [minor] D4 didn't define production files (`test/helpers.ts` holds sync seed calls). Resolved: moot, the test is dropped. The hygiene test already excludes `*.test.ts` and `src/test/`.
- [x] [minor] `listStudiosBriefAllowed` is not on the facade and has no server caller. Resolved: noted in D3, not part of any rule.
- [x] [minor] The spec lacked the returned-callback exception (`logImport.ts` `projectLive`). Resolved: moot. The MODIFIED requirement already allows "returned".
- [x] [minor] The D4 lexical matcher could be evaded by aliases. Resolved: moot, the test is dropped. The type-based checks don't depend on names.
- [x] [minor] No runtime test pins the transaction boundary for an async transaction body. Resolved: sign-up is caught by `uid: string` and `auth.int.test.ts`. The guard is protected by the `undefined` callback type and the new hygiene check.
- [x] [minor] The registry snapshot can go stale across awaits within a request, and getters need `init()` first. Resolved: D3 dependency note and slice 4 hazard D6.7.
- [x] [minor] The "unchanged" scenarios restate existing suites. Resolved: the delta keeps only the MODIFIED requirement's existing scenarios plus one new one. The per-file checks are task evidence (2.4).
- [x] [minor] Size estimate high; the probe estimate is 140-170 lines. Resolved: D7 updated.
- [x] [minor] The pre-existing OAuth get-then-delete. Resolved: already on the slice 4 list from 3a (D6.1 there).

## Consistency read 2026-10-01
Edits since approval: tasks.md (evidence lines only; 3.3 checks the anonymous `401` on `GET /api/teams/:id` because no `GET /api/teams` route exists)
Scope change: no
- [x] [minor] Task 3.3 named a `GET /api/teams` route that does not exist (it answers `404` before and after). Resolved: the anonymous `401` was checked on `GET /api/teams/:id`, recorded in the 3.3 evidence.
- [x] [minor] Every clause of the MODIFIED requirement has a test: comparisons, whole-body, shorthand and spread response values, and async callbacks where no value is expected are fixtures in `promiseHygiene.repo.test.ts` (task 1.1); the unchanged scenarios are covered by the existing suites (task 2.4). Resolved: no gap.
- [x] [minor] Non-goals hold: `git diff --stat` touches no `packages/catalog`, `packages/ports` or transaction body, and no OAuth state code. Resolved: no action needed.
