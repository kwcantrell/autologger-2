@AGENTS.md

## Claude Code specifics

- Drive work with the factory plugin: `/factory:run <request>` to start, `/factory:run` to
  continue jobs in progress. Don't use plan mode for factory work; `task.md` is the plan.
- `/factory:approve` and `/factory:ship` are the human's commands. Don't invoke them for the
  human. When a job reaches ship, `/factory:ship` here takes the PR path: push `factory/<id>`,
  open the PR with `ship.md` as the body, and close the job once the PR merges.
- Run builders, the verifier and the three reviewers as separate subagents with fresh context.
  The agent that builds never reviews or proves its own work.
- No Stop hook is wired up. Before you finish with uncommitted changes, run
  `scripts/check-change.sh --stage hook` yourself. If it fails, fix the failure. If you can't,
  say so plainly to the human.
- `.claude/settings.json` has no sandbox and no permission rules; reading `.env` files and
  secrets is allowed. Push only through `/factory:ship`'s PR path when the human runs it.
