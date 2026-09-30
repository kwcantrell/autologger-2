@AGENTS.md

## Claude Code specifics

- Use plan mode for Explore and Propose. Skip it for tier 0, where the diff fits in one sentence.
- Run the adversarial panel's reviewers as separate subagents with fresh context. The author
  never reviews its own work.
- Implementation subagents work on the current branch. Don't create worktrees for them.
- The Stop hook (`.claude/hooks/stop-check.sh`) runs `scripts/check-change.sh --stage hook`
  when you have uncommitted changes. If it blocks you, fix the failure. If you can't, say so
  plainly to the human. Never work around the hook.
- The PreToolUse hook blocks writing `Approved-by:`. Ask the human to approve instead.
- The sandbox and deny rules in `.claude/settings.json` are intentional. If a command is
  blocked, tell the human what you needed and why. Don't look for another route to it.
