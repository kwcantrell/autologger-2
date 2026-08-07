---
description: OpenSpec apply — implement gated tasks (not runnable from this adapter).
---

Apply executes via the subagent-dispatch protocol in
`.claude/skills/openspec-apply-change/SKILL.md` — this environment cannot dispatch those
subagents.

Stop-condition: stop here and hand the change off to the owner's orchestration
environment; do not implement any tasks inline.
