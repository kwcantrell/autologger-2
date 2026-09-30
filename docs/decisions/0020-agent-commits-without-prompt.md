# 0020: Agents commit on feature branches without a prompt; no commits on main

- Date: 2026-09-29
- Status: Accepted (amends ADR 0018's `.claude/settings.json` line)
- Rule: `.claude/settings.json` `permissions.ask` without `Bash(git commit *)`; the `no-commit-to-branch --branch main` pre-commit hook; AGENTS.md rule 9

## Context

The template ships `Bash(git commit *)` in `ask`, so every agent commit waits for approval. This
repo's lifecycle already checks every commit on its way to `main`:
- the pre-commit hooks: gitleaks, YAML, JSON and whitespace checks, and the commit-stage gates;
- the pre-push hook, which runs tests and typecheck;
- CI on every PR;
- the `main-protect` ruleset.

The owner found the per-commit prompt to be friction without a matching benefit on feature
branches.

## Decision

- **No commit prompt.** `Bash(git commit *)` is removed from `ask`. Pushes stay in `ask`, and
  `--no-verify` commits and pushes stay in `deny`.
- **No commits on `main`.** A `no-commit-to-branch --branch main` pre-commit hook fails any commit
  on local `main`, for agents and humans alike. A human may override it with `--no-verify`.
- **Rule 9 reworded to match:** "Never commit or push on `main`. Commit freely on a feature branch
  for in-scope work, but don't push unless the human asks."
- **`.claude/settings.json` is otherwise unchanged,** by the owner's choice. The residuals below
  are accepted, not fixed.

## Evidence

- **The guard:** with the old config, a scratch-clone commit on `main` passed (hooks ran; no guard).
  With the new config, it failed with `don't commit to branch...Failed` (`no-commit-to-branch`),
  while a feature-branch commit passed.
- **The allow-agent-commits panel:** 3 reviewers, 7 major entries. They showed that the commit
  prompt was also the human backstop for the gaps below.

## Consequences

Residuals the owner accepted, which no longer prompt:
- **Hook skips:** the `deny` rule matches only the literal `git commit --no-verify …`. So
  `git commit -n`, `git -c core.hooksPath=… commit`, `SKIP=… git commit`, `git commit-tree` and
  edits to `.git/hooks` or `core.hooksPath` skip or disable the hooks unprompted.
- **History rewrites:** `git commit --amend`, `git reset` and `git rebase` run unprompted. CI
  `artifacts-first` still checks what is pushed.
- **Push variants:** the push `ask` is prefix-matched, so `git -C dir push`, `git -c k=v push`,
  `gh api` and `gh pr merge` don't match it.
- **The ruleset:** `main-protect` exempts repo admins, and agents run with the owner's
  credentials, so it isn't an independent control against an agent.
- **The Stop hook:** it verifies only uncommitted work, so a committed failure is caught at
  pre-push or CI instead.

Two follow-ups:
- A template refresh must not restore `Bash(git commit *)` to `ask` (this amends ADR 0018).
- Revisit if an agent commit ever lands something the hooks should have stopped. The fix would then
  be `deny` or `ask` rules for the spellings above.
