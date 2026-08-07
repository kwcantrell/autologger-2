---
description: OpenSpec propose — create a change and generate all artifacts in one step.
---

Read the full file `.claude/skills/openspec-propose/SKILL.md` and follow it exactly; do
not restate or summarize its steps here.

Stop-conditions:
1. After artifacts are created, `tasks.md` is provisional — stop before apply until the
   fact-check pass, adversarial panel, and human gate recorded in `CLAUDE.md` "How we
   work (SDLC)" have run.
2. Run the fact-check pass and panel only via real independent-subagent dispatch (fresh
   contexts, the four distinct mandates, read-only, no git worktrees, log recorded); if
   that dispatch is unavailable here, hand the change name to the owner's orchestration
   environment instead — never emulate the panel in a single context.
