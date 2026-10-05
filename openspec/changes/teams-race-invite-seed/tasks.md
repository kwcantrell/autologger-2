# Tasks

The first commit on `supabase-fix-teams-race-invite-seed` holds only
`openspec/changes/teams-race-invite-seed/`. The PR targets `supabase-migration`, and the gates run
with `GITHUB_BASE_REF=supabase-migration`. Logs go under the session scratchpad as
`trs-<task>-<red|green>.log`, named in each `Evidence:` line.

Keep each task's text, and later its `Evidence:`, in one block with no blank line: the evidence gate
reads only up to the first blank line.

## 1. Baseline and fix

- [x] 1.1 Baseline on the base commit: `cd server && npx vitest run --project integration src/routers/teams.race.int.test.ts -t "invite cap" --reporter=verbose` alone, and the test's result inside one full `npm test` run. Verify: the duration alone is recorded, and the full run's timeout (or pass) is recorded.
  Evidence: alone -> `✓ … invite cap (#10) > two invites for new emails at 199 pending: one recorded, one 400 2323ms`, `Tests  1 passed | 23 skipped (24)` (log `trs-1.1-alone.log`). Full `npm test` on f31316e -> exit 1, `Tests  1 failed | 1524 passed | 4 skipped (1529)`: this run the race test passed, and the failure was the same seed pattern in another file, `teams.int.test.ts` "pending-invite cap: rejects a new pending invite at 200 …" `5598ms` (200 sequential `authUpsertInvite` calls at `teams.int.test.ts:482-484`) (log `trs-1.1-full.log`). Stop: that test is outside the approved scope; artifacts updated for re-approval.
- [ ] 1.2a Replace the seed loop at `teams.int.test.ts:482-484` with one `testDb().run(…)` statement over `generate_series(0, 199)` (`pending-<n>@example.com`, `'seed-inviter'`, `nowIso()`); add `testDb` and `nowIso` to its imports. The test itself is the check. Verify: it passes alone with its duration recorded beside its baseline (run alone first, before the edit); `cd server && npx vitest run --project integration src/routers/teams.int.test.ts` all green.
- [ ] 1.2 Replace the seed loop at `teams.race.int.test.ts:388-390` with the one `testDb().run(…)` statement proposal.md describes; add `nowIso` to the existing `@autologger/domain` import. The test itself is the check (it exists; no new test). Verify: the test passes alone with its duration recorded beside 1.1's; a one-off assertion run (not committed) that `select email_norm, invited_by_user_id from team_invites where studio_id = <team>` before the requests returns the 199 expected rows, recorded; `cd server && npx vitest run --project integration src/routers/teams.race.int.test.ts` -> 24/24.
- [ ] 1.3 Run the full suite (`npm test`) three times. Verify: "invite cap (#10)" and `teams.int.test.ts` "pending-invite cap" pass in all three; any other failure is recorded and stops the task.
- [ ] 1.4 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`. Verify: every gate PASS.
