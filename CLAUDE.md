@AGENTS.md

## Claude Code specifics

- Use plan mode for Explore and Propose. Skip it for tier 0, where the diff fits in one sentence.
- Run the adversarial panel's reviewers as separate subagents with fresh context. The author
  never reviews its own work.
- Implementation subagents work on the current branch. Don't create worktrees for them.
- No Stop hook is wired up. Before you finish with uncommitted changes, run
  `scripts/check-change.sh --stage hook` yourself. If it fails, fix the failure. If you can't,
  say so plainly to the human.
- The PreToolUse hook blocks writing `Approved-by:`. Ask the human to approve instead.
- `.claude/settings.json` has no sandbox and no permission rules; reading `.env` files and
  secrets is allowed. Don't push unless the human asks.
