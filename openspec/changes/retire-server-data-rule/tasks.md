# Tasks

## 1. Change

The first commit on this branch is `openspec/changes/retire-server-data-rule/` only, staged by
path. The owner's uncommitted `AGENTS.md` edit stays out of it (AGENTS.md rule 6). These are docs
only, so no failing test comes first. Each task gives the check that shows it is done.

- [x] 1.1 Commit the owner's `AGENTS.md` edit exactly as made. Check: `git diff main -- AGENTS.md`
  shows only the three removed `server/data` lines, and `grep -n 'server/data' AGENTS.md` returns
  nothing.
  Evidence: `git diff main -- AGENTS.md | grep '^[-+]'` -> only the three `-` lines of the `server/data` bullet; `grep -n 'server/data' AGENTS.md` -> rc=1 (no output)
- [x] 1.2 Reword the README "Protect `server/data`" note: it becomes a disposable copy of a backup
  kept elsewhere, and the never-mounted / never-`DATA_DIR` facts stay. The dev-mount list line
  (about 1609) stays unchanged. Check: `grep -n 'live-data copy' README.md` returns nothing, and
  `grep -n 'server/data' README.md` shows the new note plus the unchanged mount line.
  Evidence: `grep -n 'live-data copy' README.md` -> rc=1; `grep -n 'server/data' README.md` -> `1510: ... it is a disposable copy of a backup kept elsewhere,` and `1610: ... none of `server/data`, ...` (unchanged)
- [x] 1.3 Add `docs/decisions/0022-retire-server-data-rule.md` with the Date, Status, Rule, Context,
  Decision, Evidence and Consequences headers. Status: Accepted (supersedes ADR 0018's
  "`server/data` is live production data" Decision bullet and its "retire once a deny rule exists"
  Consequence). Record the owner decisions and the residual risks listed in the proposal, and cite
  the panel as evidence. Check: `grep -c -E '^(- Date|- Status|- Rule|## Context|## Decision|## Evidence|## Consequences)' docs/decisions/0022-retire-server-data-rule.md`
  prints 7, and `grep -n '0018' docs/decisions/0022-retire-server-data-rule.md` shows the supersede
  note.
  Evidence: `grep -c -E '^(- Date|...)' docs/decisions/0022-retire-server-data-rule.md` -> `7`; `grep -n 0018 ...` -> `4:- Status: Accepted (supersedes ADR 0018's ...`
- [ ] 1.4 Run `scripts/check-change.sh --stage pr --base main` and record it as `Evidence:`.
  Expected: every gate passes except `tasks`, until this task is ticked. `approval` and `panel`
  pass because `Approved-by:` is in proposal.md and panel.md has no open `[critical]`.
- [ ] 1.5 Archive (`skip_specs`). Check: `openspec validate --all --strict` and
  `openspec validate --archived --no-interactive` pass.

## At PR (no checkbox)

- Push, open the PR, and confirm CI `gates`, `secrets` and `dependency-review` pass.
- Update the agent's own memory, which still calls `server/data` live data. It is outside the repo,
  so it is not a task.
