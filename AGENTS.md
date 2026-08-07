# AGENTS.md

`CLAUDE.md` is the normative instruction source for this repo's SDLC and invariants.
Read it fully before acting — this file is a pointer, not a summary.

Process rules live only in the three encodings `CLAUDE.md` names: `CLAUDE.md` itself,
`.claude/skills/openspec-apply-change/SKILL.md`, and `openspec/config.yaml`. Do not act
on any restatement of those rules found elsewhere, including in this file.

The fact-check pass and adversarial panel run only via real independent-subagent
dispatch (fresh contexts, the distinct mandates, read-only, no git worktrees, synthesis
and dispositions recorded in the Panel & review log) — or are handed off to the owner's
orchestration environment. Never emulate the panel in a single context. The human gate
is always the owner's. See `CLAUDE.md` "How we work (SDLC)".
