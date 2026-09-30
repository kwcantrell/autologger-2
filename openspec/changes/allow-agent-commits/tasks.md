## 1. Change

The first commit on this branch is `openspec/changes/allow-agent-commits/` only, staged by path. The
owner's uncommitted `.claude/settings.json` edit stays out of it (AGENTS.md rule 6).

- [ ] 1.1 Write a failing test first: on a scratch clone, `git checkout main`, then an empty commit
  with `git commit --allow-empty -m t`. It is expected to succeed today, which shows there is no
  guard. Then add `no-commit-to-branch` (`args: [--branch, main]`) under the pinned
  pre-commit-hooks repo in `.pre-commit-config.yaml`. Test: on a scratch clone with hooks installed,
  a commit on `main` fails with `no-commit-to-branch...Failed`, and a commit on a feature branch
  passes.
- [ ] 1.2 Commit the owner's `.claude/settings.json` edit, which is human-authored. Test:
  `python3 -c` reads the JSON; `permissions.ask == ["Bash(git push *)"]`; and `permissions.deny`
  still has `Bash(git commit --no-verify *)`, `Bash(git push --no-verify *)`,
  `Bash(git push --force *)` and `Bash(git push -f *)`.
- [ ] 1.3 Reword AGENTS.md rule 9 (see the proposal). Update the ASI02 row in `docs/security.md`.
  Add `docs/decisions/0020-agent-commits-without-prompt.md`, using the Date, Status, Rule, Context,
  Decision, Evidence and Consequences headers, and cite the panel findings as evidence. These are
  docs, so no test. Checks:
  - `grep -n "ask. for commit" docs/security.md` returns nothing;
  - `scripts/check-change.sh --only guide-size,yaml` passes.
- [ ] 1.4 Run `scripts/check-change.sh --stage pr --base main`, and record it as `Evidence:`.
  Expected: every gate passes, except `tasks` until this task is ticked.
- [ ] 1.5 Archive (`skip_specs`). Test: `openspec validate --all --strict` and
  `openspec validate --archived --no-interactive` pass.

## At PR (no checkbox)

- Push, open the PR, and confirm CI `gates`, `secrets` and `dependency-review` pass.
