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
