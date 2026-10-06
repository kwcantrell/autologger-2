# Tasks

## 1. Remove the page

- [x] 1.1 Delete `web/src/app/(admin)/**` and `web/src/pages/admin-users/**` (D1).
  - The existing `loginReturnPath.test.ts:319` already pins `isShellSegments(['admin','users'])` as false (it can't start red); `app/not-found.page.tsx` keeps its own `<html>`/`<body>` (D1).
  - Verify: `npx vitest run src/shared/utils/loginReturnPath.test.ts` passes; `ls web/src/app` shows only `(index)` plus the root files; `next build` (dev stack rebuild) lists only `/_not-found` and `/[[...path]]`.
  - Evidence: `git rm -r web/src/app/(admin) web/src/pages/admin-users` -> `ls web/src/app` = `(index) not-found.page.tsx`; existing `loginReturnPath.test.ts:319` pins isShellSegments([admin,users]) false -> `Tests 64 passed (64)`; `npx next build` -> routes `○ /_not-found` + `ƒ /[[...path]]` only (one pre-existing appVersion.ts warning); stale gitignored `web/.next/types` (Oct 1 host build referencing the deleted (admin) files) removed -> `npx tsc --noEmit` exit 0; full run then `4 failed` exactly the apiResponseShapes guards task 2.1 owns (stale exemption, detector floor, canary, AdminDataResponse covered set); webBoundaries passed vacuously as the panel predicted (task 2.2)
- [ ] 1.2 Comment cleanup across web/src:
  - `next.config.ts`, `(index)/layout.page.tsx`, `app/not-found.page.tsx`;
  - `RootGate.tsx`, `AppLoadingSkeleton(.test).tsx`, `Toast.tsx`, `Tooltip(.test).tsx`, `primitives.smoke.test.tsx`;
  - `HomeSettingsModal.tsx` (the "until 3c-2" note).
  - Verify: `grep -rn "admin-users\|AdminUsersPage\|(admin)" web/src` prints only intentional historical or example mentions, each listed in the evidence.
- [ ] 1.3 Delete the admin response types and their conformance cases, and retarget the `ExpectUndeclared` non-vacuity test to `SessionStatus`/`is_rolling` (D2).
  - Test first: retarget the non-vacuity test before deleting `AdminUser`, and confirm it still fails to typecheck when the `@ts-expect-error` is removed (shown by temporarily removing it).
  - Verify: `npx vitest run src/api/types.conformance.test.ts` passes, `npx tsc --noEmit` is clean, and `grep -rn "AdminDataResponse\|AdminUser\b\|AdminStudio\b\|AdminStudioCreateBody" web/src` prints nothing.

## 2. Repo guards

- [ ] 2.1 `apiResponseShapes.repo.test.ts`: remove the admin exemptions, the canary and the live `AdminDataResponse` covered-wrapper assertion; extend the wrapper mutation case to assert a covered typed wrapper call; add the "wrapper path is fixture-covered" note; re-measure every floor (D3, A6).
  - Test first: run the suite on the post-removal tree. It fails on the stale exemptions, the missing canary and the floors. Record the measured counts.
  - Verify: the suite passes with the re-measured floors, and the measured-numbers comment matches the scan output.
- [ ] 2.2 `webBoundaries.repo.test.ts`: retire the admin-index-cross, route-group-cross and transitive admin↔index rules and their dedicated tests; retarget F2 to the layering rule; reword the comments (D4).
  - Verify: the suite passes; the retargeted F2 asserts a `layering` violation; every surviving rule (layering, packages, app-layer, test-file) still has its mutation-pair test.
- [ ] 2.3 `docker/scripts/test_router.sh`: record the 404 disposition for `/admin/users` (D5).
  - Verify: `bash -n docker/scripts/test_router.sh`, and a diff shows only the `/admin/users` loop entry, the new explicit 404 check, the two `EXPECTED` rows, and the header note. Run against the stage router where available.

## 3. Legacy chrome CSS

- [ ] 3.1 Delete the remaining chrome rules and the perf-debug selector entries, reword the `.shell` comment, and extend the hygiene guard's `DELETED` list (D6).
  - Test first: the extended guard passes on the post-removal tree. Prove it with a probe file, `className="btn primary"` plus `clsx("profile-select")` → fails listing `btn` and `profile-select`.
  - Verify: `npx vitest run src/shadcnHygiene.repo.test.ts src/shared/theme/contrastTokens.test.ts` passes, and the full `npx vitest run` passes.

## 4. Docs

- [ ] 4.1 README: add a curl recipe for each of the seven admin operations (list users with the user-id lookup, create and delete a team, add and remove a membership, disable and enable a user), and:
  - drop `/admin/users` from the shell list (~:1730) and the deep links (~:1849);
  - drop the `(admin)` layout CSS entry (~:1786);
  - note that the admin API is curl / bootstrap-script only.
  - Verify: `grep -n "admin/users" README.md` shows only the `/api/admin/users` API rows.

## 5. Integration: QA gate and checks

- [ ] 5.1 Copy the walk from the archived `shadcn-port-modals/qa`. Capture `before-admin` on HEAD before the change, then `after-admin`, at 1440 and 390.
  - Verify:
    - `admin-users` now shows the app's not-found page, and its HTTP status is 404 (agent-browser eval of `fetch('/admin/users').status`);
    - every other screen is 0%;
    - contrast shows 0 failures apart from "Audio issue";
    - results are recorded in `qa/README.md`.
- [ ] 5.2 The owner's pass and review:
  - `/admin/users` is not-found in the browser;
  - on the dev stack, the README curl recipes work: list users; disable then enable a test user (confirm the disabled user's session stops resolving while disabled); add then remove a membership;
  - the PR review and whole-branch audit.
  - Verify: the result is recorded in `qa/README.md`.
- [ ] 5.3 Run `scripts/check-change.sh` (the tier-2 full gate set), plus the full suite, typecheck, lint and `openspec validate --all --strict`.
