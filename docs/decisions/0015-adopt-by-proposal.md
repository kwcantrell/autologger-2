# 0015: Adopt into existing repos by proposal, never by merging

- Date: 2026-09-29
- Status: Accepted
- Rule: `scripts/lib/adopt.py` create-only install; `.lifecycle-adoption/`

## Context

The infisical dry-run showed that init.sh half-installed into a repo with its own lifecycle: hooks
copied but unwired, contradictory guidance appended to a re-dumped config, and the rules missing
from AGENTS.md. Two designs that merged into the target's files drew 4 critical findings between
them:
- a config append that silently corrupted a file ending in a comment;
- partial writes when a later step failed;
- gitignored files overwritten with no copy for git to restore;
- `openspec init` writing between plan and apply.

A third review of the proposal-based design found that the installer's own `sync-skills.sh` step
and `openspec init` could still delete or rewrite a target's files.

## Decision

The installer only creates paths that don't exist. It checks the filesystem, so gitignored files
count as existing. It checks real paths, so it never writes outside the repo. It never runs the
target's scripts, and never runs `openspec init` where OpenSpec files exist. For the target's own
AGENTS.md, CLAUDE.md, settings.json and config, it writes proposals into a self-ignoring
`.lifecycle-adoption/` folder with a checklist for a human. Every created path is recorded, and
`adopt.py undo` validates the manifest before removing anything.

## Evidence

- The infisical dry-run (2026-09-29), and the safe-adoption and adopt-installer panels (two rounds).
- Reproductions: YAML comment swallow; `sync-skills.sh` deleting `.agents/skills/mine`;
  `openspec init` rewriting `.claude/skills/openspec-propose/SKILL.md`.

## Consequences

Adoption needs a human merge step, and until then the hooks aren't active in that repo. That's
stated as the first "Next steps" item and in docs/security.md. Revisit if a safe, tested
three-way merge for these files becomes available.
