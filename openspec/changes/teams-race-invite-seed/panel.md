# Panel: teams-race-invite-seed
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-10-05

Reviewers report only critical and major findings (ADR 0024). Each ran as a separate fresh-context
subagent.

- [x] [major] The proposal ruled out the repo's usual fix for this symptom (a per-test `}, 30_000);`, `sessionHub.interleave.int.test.ts:292-294`) without saying why, and did not state that the batched insert departs from the `server/src/test/helpers.ts:24-25` convention of seeding through real store methods, so the approver could not see the trade-off. Found by scope and simplicity. Resolved: the owner chose the batched seed (2026-10-05); proposal.md gains "Alternatives considered", naming both the timeout precedent and the convention, and why the seed is accepted (the cap reads only the row set; the file already seeds with raw `testDb().run` inserts).

Verified by the assumption tester and the failure and abuse reviewer (no findings):
- the adapter's `toPg` binds only the three bare `?` (prepared types `{text,text,text}`, `INSERT 0 199` in the dev DB inside `begin … rollback`);
- the 199 emails are the loop's, normalized, all invited by the owner;
- `catalog_system` may insert under `team_invites_system_all`;
- `team_invites` has no trigger or default, and the cap check reads only `pending.length` and `email_norm`;
- the seed bypasses the `GatedCatalog` hold, which still catches A's list query, and A still re-runs after B's commit and answers `400` while B answers `200`;
- each test gets a fresh catalog clone;
- timing alone: baseline 2.31-3.58 s, prototype 0.49-0.65 s (seed 12 ms), 24/24 in the file.

The full-suite effect is task 1.3.

## Re-panel 2026-10-05

Delta: the scope widened after approval to the same seed loop in `teams.int.test.ts:479-497`
(task 1.1's baseline full run timed out there, `5598ms`). Three fresh-context reviewers on the delta
only.

- [x] [major] The approval line on proposal.md covered the one-file scope at f31316e, and no gate would reject it for the widened scope. Found by scope and simplicity. Resolved: no test is edited until the owner re-approves the widened scope with a new dated `Approved-by:` line naming the widening; asked for at hand-off.
- [x] [major] "Alternatives considered" justified going around `authUpsertInvite` partly because "this file already seeds with raw `testDb().run` inserts", which is true only of `teams.race.int.test.ts`; `teams.int.test.ts` has no `testDb`, and the four-column row copy would now live in two files. Found by scope and simplicity. Resolved: the bullet now says the raw seed is new in `teams.int.test.ts` and that a change to `authUpsertInvite`'s row shape must update both seeds.

Verified (assumption tester; failure and abuse; no findings): the batch writes the same 200 rows as the loop (`SEEDCMP 200 200 true`, probe comparing both seeds); no foreign key on `invited_by_user_id`; the re-invite of `pending-0@example.com` takes the real `ON CONFLICT` path (inviter and timestamp change) and answers `200`; the 201st answers `400`; the count stays 200; no assertion or route reads per-row `invited_at_utc` or order; alone 3,656 ms -> 399-473 ms, the file 65/65; typecheck clean. No other awaited write loop over 100 iterations exists in `server/src` or `packages` tests. Noted for task 1.3: several unrelated tests run 3-4 s under load (`teams.int` admin 403, `isolation.int`, `events.metadataStrip.int`, `authStore.int`); a timeout there is recorded and stops the task, per 1.3.
