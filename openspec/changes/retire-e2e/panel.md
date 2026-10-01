# Panel: retire-e2e
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-09-30

Three fresh subagents reviewed the combined draft `retire-host-dev`. After the panel, the owner
decided on 2026-09-30:
- split it into 1.4a `retire-e2e` (this change) and 1.4b `retire-host-dev`;
- keep the router security cases as `test_router.sh`;
- send LAN testing through the upstream proxy to stage.

Findings that belong to 1.4b say so. The parked 1.4b draft carries them forward to its own
proposal and re-panel.

## Assumption tester

- [x] [critical] `tsx watch` keeps running after its child exits, so "npm run dev exits non-zero" can't hold with the guard in `main.ts` only. Evidence: `timeout 8 npx tsx watch exit1.ts` -> `exit=124`. Resolved: moved to 1.4b, where the guard must also run before `tsx watch` (not part of 1.4a).
- [x] [critical] Root `typecheck` runs `tsc --noEmit -p e2e`, so deleting `e2e/` breaks a CI gate. Evidence: `tsc --noEmit -p e2e_does_not_exist` -> `TS5058`, exit 1. Resolved: D2 removes it, and task 2.1 checks `npm run typecheck` after the deletion. The proposal no longer says "CI: unaffected" without qualification.
- [x] [major] `scripts/teardown.mjs` kills listeners on :8787, :8791 and :8792, and :8791 is now the stage Supabase gateway's docker-proxy. Evidence: `ps -C docker-proxy` -> `-host-port 8791 … -container-port 8000`. Resolved: deleted along with the root `teardown` script (proposal, D1/D2).
- [x] [major] `capture:deepgram-fixture` can't run in the dev stack (fixture paths aren't in the image). Resolved: moved to 1.4b (helper scripts).
- [x] [major] A full `npm uninstall` changes 44 unrelated packages on this host. Evidence: dry-run -> `added 17, removed 9, changed 44`. Resolved: `--package-lock-only` (D2, A4), which gives a 59-line lockfile removal with the audit unchanged.
- [x] [major] Untracked e2e state (9.7 MB of SQLite, `test-results`) becomes committable once its ignore lines go. Also raised by failure and abuse. Resolved: the D1 order deletes the state first, and task 2.1 checks `git status --porcelain`.
- [x] [major] "`npm run lint` passes" can't hold: two existing warnings in `compression.int.test.ts`. Resolved: task 2.2's check is "only those two warnings" (A7). Lint is not a gate.
- [x] [minor] Parity: the proposal and design contradicted each other, and the delta matched neither. Also raised by scope, and by failure and abuse. Resolved: the delta MODIFIES the parity scenario to compare against a recorded expectation table, checked by `test_router.sh`. Proposal, design and delta agree.
- [x] [minor] The size estimate was low (1,147 counted lines for the e2e harnesses and config alone). Also raised by scope. Resolved: the split. 1.4a is about 1,250 counted lines under the owner's recorded exception. 1.4b is about 300.
- [x] [minor] Stale e2e-only seams (`AI_V2_SDK_EXECUTABLE_PATH`, the fake-agent fixture, the `fixturesDir.ts` comment, `.pre-commit-config.yaml`, `compose-env.sh`, `noAgentAuthoredMarkup` scan list). Also raised by scope. Resolved: all removed or fixed (D1-D4, task 2.2). The `main.ts:45` "run npm run build" hint moves to 1.4b.
- [x] [minor] `api-contract-freeze` and `package-architecture` name `e2e/` in requirement text. Resolved: left unchanged, because both stay true without it (proposal Non-goals). The `api-contract-freeze` Purpose is edited with the exact text in D6.

## Failure and abuse

- [x] [major] A second server can start on a live `DATA_DIR` from `make dev-shell` and run migrations and sweeps. Resolved: moved to 1.4b (a lock on `DATA_DIR` before `createBindings`).
- [x] [major] Router security rules lose their only behavioural test. Resolved: (owner decision, 2026-09-30) `test_router.sh` keeps traversal, stray upgrades, token scope, dispositions and topology (D5, a new spec requirement). The unported cases are named in Risks.
- [x] [major] Untracked e2e state becomes committable. Resolved: see the assumption tester's matching major.
- [x] [major] Removing the dev script's loopback default makes a deliberate host bypass bind `0.0.0.0`. Resolved: moved to 1.4b (a loopback default for non-production in `main.ts`).
- [x] [major] "Test LAN devices against stage" is false, because stage is loopback-only. Resolved: (owner decision, 2026-09-30) LAN testing goes through the upstream proxy to stage. Written in 1.4b's docs and AGENTS.md text.
- [x] [major] Spec scenarios require a single-process production server that won't exist. Resolved: 1.4a rewords the parity scenario to the recorded table. "Same shell from both topologies" and the remaining single-process-production text move to 1.4b, which removes `start`.
- [x] [major] The prod boot refusal isn't verified for prod. Resolved: moved to 1.4b (an A1 row for prod, and a migration-plan check).
- [x] [minor] `server/.env` is dead but still on disk. Resolved: moved to 1.4b (an owner step: confirm the values are in Infisical, then delete it).
- [x] [minor] Scenarios left with no automated test. Resolved: router scenarios move to `test_router.sh`. The rest are named in Risks as accepted until the e2e rebuild (browser, login, Companion, WebSocket frames, encoding, XFF, recreation, scale).
- [x] [minor] No test proves `main.ts` runs the guard first. Resolved: moved to 1.4b.
- [x] [minor] The sentinel check is weak (any non-empty value). Resolved: moved to 1.4b (values limited to dev, stage or prod, and an absolute `DATA_DIR`).
- [x] [minor] Stale tooling: `teardown`, `typecheck -p e2e`, the `ai-runtime` comments about `./data`. Resolved: `teardown` and `typecheck` are handled here. The `./data` comments move to 1.4b.
- [x] [minor] The Cursor rule rewrite should state `dev-restart`'s scope and forbid hand-starting the server. Resolved: moved to 1.4b (Cursor rule).

## Scope and simplicity

- [x] [major] Parity: proposal, design and delta disagreed. Resolved: see the assumption tester's matching minor.
- [x] [major] The single-process production topology is specified with nothing able to run it. Resolved: moved to 1.4b, as above.
- [x] [major] A size override contradicts ADR 0021's under-400 rule. Resolved: (owner decision, 2026-09-30) split, with an explicit exception for 1.4a recorded in the proposal and the ADR 0021 slice list. 1.4b fits the budget.
- [x] [major] Task 3.1's grep could never pass (`\b` matches `.example`). Resolved: 1.4a's README grep targets `e2e|playwright` only. The `server/.env` grep moves to 1.4b and will exclude `.example`.
- [x] [major] Purpose edits at archive were unreviewed. Resolved: D6 gives the exact before and after text, for approval.
- [x] [minor] D3 missed references (the typecheck chain, `.pre-commit-config.yaml`, `main.ts:45`, the noAgentAuthoredMarkup scan, `fixturesDir.ts`, README:921). Resolved: listed in the design Context table. `main.ts:45` moves to 1.4b.
- [x] [minor] "SHALL NOT read `server/.env`" has no test. Resolved: moved to 1.4b (a repo test asserting no `--env-file` in package scripts).
- [x] [minor] No test that `main.ts` calls the guard first. Resolved: moved to 1.4b.
- [x] [minor] A2's grep missed `config.test.ts`. Resolved: moved to 1.4b (its A2).
- [x] [minor] Keeping `server/.env.example` departs from ADR 0022's follow-up. Resolved: moved to 1.4b (ADR 0022 note).
- [x] [minor] The `docs/security.md` correction is unrelated scope. Resolved: dropped from 1.4a. 1.4b decides.
- [x] [minor] Slice order (1.4 before 1.3) should be recorded. Resolved: proposal Decisions and the ADR 0021 slice list.
- [x] [minor] The `0.0.0.0` HOST fallback. Resolved: moved to 1.4b (see failure and abuse).

## Approval 2026-09-30
The owner approved v2 (split 1.4a, size exception, test_router.sh, Purpose edits in D6).
