# 0034: Adopt the software factory; keep the specs; ship by PR

- Date: 2026-11-12
- Status: Accepted (supersedes ADRs 0001-0006, 0008, 0014-0016 and 0024)
- Rule: AGENTS.md "The line" and rules 1-8; `factory.json` (`spec_gate: true`); the `openspec`
  gate (specs only); CI's required checks on the PR

## Context

Since 2026-09-29 (ADR 0018) every change ran the OpenSpec change lifecycle: a risk tier, a
proposal with design, spec deltas and `tasks.md`, an adversarial panel sized by tier, an
`Approved-by:` line, an artifacts-first commit, ticked tasks with `Evidence:` lines, and an
archive step that merged the deltas into `openspec/specs/`. Seven of `scripts/check-change.sh`'s
gates existed only to check those artifacts.

The process had a known cost. ADR 0024 had already retired the size budget and the panel's
minor findings after 22 tier 2 panels logged 744 findings in four days. Every step ran in one
agent session, so the author planned, implemented and graded its own work, with the panel as the
only independent read and only before code.

On 2026-11-12 a separate checkout (branch `factory-trial`) ran the **software factory** Claude
Code plugin instead: intake writes a `task.md` with checkable acceptance criteria; a human
approves it; a builder agent works in its own git worktree; a verifier agent proves each
criterion first-hand; three reviewer agents (security, standards, behavior) record their own
verdicts; and a human merges. A CLI state machine (`factory`) is the only way a job changes stage.

## Decision

- **Adopt the factory as the lifecycle on `main`.** Work arrives as factory jobs through
  `/factory:run`. `task.md` is the plan of record. `factory.json` keeps `spec_gate: true`, so a
  human approves every `task.md` (`/factory:approve`) before a builder starts.
- **Keep `openspec/specs/` as the living behavior docs, and retire the OpenSpec change
  lifecycle.** A job that changes behavior updates the matching spec in the same job. The
  `openspec` gate validates the specs only. `openspec/changes/archive/` is history; the
  `openspec-*` change skills, `/opsx:*` commands, `risk-tier`, `adversarial-panel` and
  `consistency-read` are removed.
- **Ship through a GitHub PR with green CI.** `/factory:ship` pushes `factory/<id>` and opens a
  PR with `ship.md` as the body. The human merges on GitHub once the required checks pass. The
  plugin's local `factory merge` is not used on `main`.
- **Rules that must hold stay machine checks** (carrying over ADR 0008): CI and pre-commit run
  `scripts/check-change.sh`, the `factory` CLI enforces the line, and the plugin's hook turns
  `factory approve` and `factory merge` into permission prompts.

## Evidence

The trial's first nine jobs, from their `ship.md` files and job histories (all on 2026-11-12;
the `factory/` directory is untracked, so the facts are quoted here):

| Job | What | Outcome |
| --- | --- | --- |
| 001 | Docs-site generator agent | Proof attempt 1 **failed**: criterion 7 (`npm run lint`, `npm test` green) was unmeetable on the base (64 biome errors; pg tests exhausting connections). The builder said so instead of redefining it, and the job stopped for the human, who split the base fixes into 002 and 003. Proof passed on attempt 2; all 3 reviewers approved in round 1. |
| 002 | Make `npm run lint` pass | 56 files: safe biome fixes plus 18 findings fixed by hand. Approved in round 1. |
| 003 | pg test connection exhaustion | Root cause found in the suite (a migration replay left the app role at 20 connections, and 19 concurrent files). `npm run test -w server` passed three times in a row. Approved in round 1. |
| 004 | Bound integration-tier concurrency | 6 files at once instead of 19, below the connection limit; about 20% slower than unbounded but within the 1.5x budget. Approved in round 1. |
| 005 | Prune redundant integration tests | 47 duplicates deleted, 26 moved to the unit tier, coverage identical. `ship.md` called the payoff small (198.4 s to 191.2 s). Approved in round 1. |
| 006 | Speed up the integration harness | Integration tier 166.78 s to 64.77 s (-61%); median per-test setup 231 ms to 18.7 ms. Approved in round 1. |
| 007 | `AiMcpListener.close()` returns promptly | Traced to undici's 4 s keep-alive; 3 failing timing tests on the base pass at 10-58 ms. Approved in round 1. |
| 008 | Test-code cleanups from 003-006 reviews | Non-blocking review findings turned into their own job. Approved in round 1. |
| 009 | Flaky `ConfirmDialog` test | Root cause: a Radix 0 ms focus-restore timer firing after jsdom teardown. Approved in round 1. |

- 9 of 9 jobs merged. 10 proof runs, 1 failure (001's first), which caught a real problem with the
  task, not the code. Every job was approved by all three reviewers in its first round.
- Every job's `task.md` stopped for human approval before build, as `spec_gate` requires.
- Non-blocking findings were not lost: they became new jobs (004 from 003, 008 from 003-006) or
  follow-ups listed in `ship.md`.
- Jobs built in parallel worktrees (002 and 003 from 14:24, 007 and 008 overlapping) and each
  `ship.md` reports `git merge-tree` finding no conflicts. No commit landed on the wrong branch,
  the failure ADR 0005 was written against.
- Jobs 010 and 011 then reworked the gates, CI and guidance for this decision through the same
  line.

## Consequences

Lost, and what replaces it:

- **Risk tiers and the path floor (ADR 0001).** Every job gets the same line: one human spec
  review, a verifier and three reviewers. There is no lighter path for a typo and no forced
  heavier one for high-risk paths; the security reviewer, the human merge and code owner review
  on the ruleset cover `.github/**`, `scripts/**`, `.claude/**`, auth, migrations and the contract.
- **The adversarial panel before approval (ADRs 0002, 0024).** Nobody but the human reviews the
  spec before code. Independent review now happens after code, against the diff, by three
  fresh-context reviewers, with a cap of 3 rounds before a human is called.
- **`Approved-by:` and the approval gate (ADR 0002).** Spec approval is recorded in the untracked
  `factory/` state and guarded by a permission prompt, not by CI. The PR merge is the durable
  human approval.
- **`tasks.md`, evidence lines and artifacts-first (ADRs 0003, 0004, 0006).** `task.md`,
  `build.md` and the verifier's `proof.md` replace them. These live in `factory/`, which is not
  tracked, so `ship.md` (the PR body) is the lasting record of how a job was proven.
- **Plain branches for subagents (ADR 0005).** Builders work in worktrees, one job per
  worktree, cut by the CLI.
- **Grandfathering, archive edits and adoption by proposal (ADRs 0014-0016).** No gate checks
  changes or archives any more, so these mechanisms have nothing to do.
- **ADR 0008's specifics.** The principle carries over (rule 8). The Stop hook stays unregistered,
  so agents run `scripts/check-change.sh --stage hook` themselves.
- **Size budget.** Stays retired, as ADR 0024 decided.

Costs and risks:

- The factory depends on a plugin outside this repo; setup is in `docs/lifecycle.md`.
- The PR path was not exercised in the trial (it merged locally into `factory-trial`); the PR
  that lands this decision is its first run.
- Drop or rework this if the quarterly review finds that reviewer verdicts approve work CI or
  production later shows to be broken, or that the spec gate is approved without being read.
