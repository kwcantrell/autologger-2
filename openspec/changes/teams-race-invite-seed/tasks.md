# Tasks

The first commit on `supabase-fix-teams-race-invite-seed` holds only
`openspec/changes/teams-race-invite-seed/`. The PR targets `supabase-migration`, and the gates run
with `GITHUB_BASE_REF=supabase-migration`. Logs go under the session scratchpad as
`trs-<task>-<red|green>.log`, named in each `Evidence:` line.

Keep each task's text, and later its `Evidence:`, in one block with no blank line: the evidence gate
reads only up to the first blank line.

## 1. Baseline and fix

- [ ] 1.1 Baseline on the base commit: `cd server && npx vitest run --project integration src/routers/teams.race.int.test.ts -t "invite cap" --reporter=verbose` alone, and the test's result inside one full `npm test` run. Verify: the duration alone is recorded, and the full run's timeout (or pass) is recorded.
- [ ] 1.2 Replace the seed loop at `teams.race.int.test.ts:388-390` with the one `testDb().run(…)` statement proposal.md describes; add `nowIso` to the existing `@autologger/domain` import. The test itself is the check (it exists; no new test). Verify: the test passes alone with its duration recorded beside 1.1's; a one-off assertion run (not committed) that `select email_norm, invited_by_user_id from team_invites where studio_id = <team>` before the requests returns the 199 expected rows, recorded; `cd server && npx vitest run --project integration src/routers/teams.race.int.test.ts` -> 24/24.
- [ ] 1.3 Run the full suite (`npm test`) three times. Verify: "invite cap (#10)" passes in all three; any other failure is recorded and stops the task.
- [ ] 1.4 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`. Verify: every gate PASS.
