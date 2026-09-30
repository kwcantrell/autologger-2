# Stop prompting before agent commits; guard local main

Tier: 2
Tier reason: edits `.claude/settings.json`, `AGENTS.md` and `.pre-commit-config.yaml`, which are the agent's own guardrails (high-risk paths).

Approved-by: Kalen 2026-09-29

## Why

The owner removed `Bash(git commit *)` from `permissions.ask` in `.claude/settings.json`, so agents
commit without an approval prompt. The prompt added a manual step to every commit on a feature
branch.

The panel found that the prompt was also the human backstop for gaps the settings don't close
(details in panel.md):
- **Hook skips:** the `deny` rule matches only the literal `git commit --no-verify …`. So
  `git commit -n`, `git -c core.hooksPath=… commit` and `SKIP=… git commit` skip the hooks
  unprompted.
- **Commits on local `main`:** nothing mechanical prevents them. AGENTS.md rule 9 is prose.
- **History rewrites:** `git commit --amend`, `git reset` and `git rebase` are unprompted.
- **Pushes:** the push `ask` is prefix-matched. `git -C dir push`, `gh api` and the like don't match.
- **The ruleset:** `main-protect` exempts repo admins, and agents run with the owner's credentials,
  so it isn't an independent control against an agent.

## What Changes

- **`.claude/settings.json`:** `permissions.ask` loses `Bash(git commit *)`. This is the owner's edit,
  kept exactly as made.
- **`.pre-commit-config.yaml`** gains `no-commit-to-branch` with `--branch main`, from the
  pre-commit-hooks repo already pinned there (v6.0.0). Any commit on local `main` fails at the
  pre-commit stage (owner decision). Work happens on branches.
- **`AGENTS.md` rule 9** is reworded (owner decision), from "Never push to `main`, and don't commit
  or push unless the human asks." to "Never commit or push on `main`. Commit freely on a feature
  branch for in-scope work, but don't push unless the human asks."
- **`docs/security.md`:** the ASI02 row changes to "`ask` for push (prefix-matched)", and it notes
  that commits are checked by hooks and CI, citing ADR 0020.
- **ADR 0020** records:
  - the change;
  - what still guards commits (the pre-commit hooks including the `main` guard, the pre-push hook,
    CI, and push `ask`);
  - the residuals the owner accepted;
  - that it amends ADR 0018's settings line, so a template refresh must not restore the commit
    `ask`.

## Decisions (owner, 2026-09-29, after the panel)

- **Add the `main` guard hook.**
- **Reword rule 9.**
- **Don't harden `.claude/settings.json` further. Record the gaps as residuals in ADR 0020:**
  - hook-skip spellings;
  - history rewrites;
  - push variants;
  - the admin-exempt ruleset.

## Non-goals

- Further changes to `permissions`, `deny`, the hooks in `.claude/hooks/`, or the sandbox.

## Impact

- Five files: `.claude/settings.json`, `.pre-commit-config.yaml`, `AGENTS.md`, `docs/security.md`,
  and a new ADR 0020. About 40 lines. No code, specs (`skip_specs`) or contract change.
