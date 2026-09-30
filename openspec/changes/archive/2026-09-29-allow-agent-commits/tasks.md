## 1. Change

The first commit on this branch is `openspec/changes/allow-agent-commits/` only, staged by path. The
owner's uncommitted `.claude/settings.json` edit stays out of it (AGENTS.md rule 6).

- [x] 1.1 Write a failing test first: on a scratch clone, `git checkout main`, then an empty commit
  with `git commit --allow-empty -m t`. It is expected to succeed today, which shows there is no
  guard. Then add `no-commit-to-branch` (`args: [--branch, main]`) under the pinned
  pre-commit-hooks repo in `.pre-commit-config.yaml`. Test: on a scratch clone with hooks installed,
  a commit on `main` fails with `no-commit-to-branch...Failed`, and a commit on a feature branch
  passes.
  Evidence: fresh scratch clone with hooks installed. BEFORE (old config) a commit on `main` gave `lifecycle gates (commit stage)...Passed`, rc=0 (no guard). AFTER (new config, staged) a commit on `main` gave `don't commit to branch...Failed - hook id: no-commit-to-branch`, rc=1; a commit on the feature branch gave `don't commit to branch...Passed`, rc=0. (A first attempt was invalid: `pre-commit install -q` had silently failed, so no hooks ran; redone.)
- [x] 1.2 Commit the owner's `.claude/settings.json` edit, which is human-authored. Test:
  `python3 -c` reads the JSON; `permissions.ask == ["Bash(git push *)"]`; and `permissions.deny`
  still has `Bash(git commit --no-verify *)`, `Bash(git push --no-verify *)`,
  `Bash(git push --force *)` and `Bash(git push -f *)`.
  Evidence: `python3 -c` -> `ask ok: True`, `deny ok: True`; committed in 0e3e689, where the owner's edit is unchanged
- [x] 1.3 Reword AGENTS.md rule 9 (see the proposal). Update the ASI02 row in `docs/security.md`.
  Add `docs/decisions/0020-agent-commits-without-prompt.md`, using the Date, Status, Rule, Context,
  Decision, Evidence and Consequences headers, and cite the panel findings as evidence. These are
  docs, so no test. Checks:
  - `grep -n "ask. for commit" docs/security.md` returns nothing;
  - `scripts/check-change.sh --only guide-size,yaml` passes.
  Evidence: `grep -n "ask. for commit" docs/security.md` -> no output; `--only guide-size,yaml` -> `PASS AGENTS.md 101/150 lines`, `PASS yaml 58 YAML file(s) parse`; ADR 0020 added in 0e3e689
- [x] 1.4 Run `scripts/check-change.sh --stage pr --base main`, and record it as `Evidence:`.
  Expected: every gate passes, except `tasks` until this task is ticked.
  Evidence: `--stage pr --base main` -> PASS openspec, yaml (58), workflows, skills-sync, guide-size (101/150), change (tier 2), risk-floor, approval, panel (13), evidence, artifacts-first, tests-with-code, size (8/400), commands, audit; FAIL only `tasks` (2 unticked: 1.4 and 1.5)
- [x] 1.5 Archive (`skip_specs`). Test: `openspec validate --all --strict` and
  `openspec validate --archived --no-interactive` pass.
  Evidence: `openspec archive allow-agent-commits -y` -> archived as `2026-09-29-allow-agent-commits` (skip_specs); `openspec validate --all --strict` -> `26 passed, 0 failed`; `openspec validate --archived --no-interactive` -> `51 passed, 0 failed`

## At PR (no checkbox)

- Push, open the PR, and confirm CI `gates`, `secrets` and `dependency-review` pass.
