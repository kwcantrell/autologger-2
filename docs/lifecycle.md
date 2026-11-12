# The factory lifecycle, explained

AGENTS.md is the rulebook agents load. This file is for humans: how work moves through the
software factory, where you come in, and how to set it up. ADR 0034 records why the repo moved
to it from the OpenSpec change lifecycle.

## The loop

```
request -> intake -> APPROVE SPEC -> build -> proof -> review -> ship -> PR -> MERGE (CI green)
           task.md   ^ human         builder  verifier  3 reviewers  ship.md      ^ human, hard gate
                       /factory:approve  ^        |        |                       on GitHub
                                         +--------+--------+  fail / changes requested
```

You start work with `/factory:run <request>` in Claude Code. The supervisor (that session)
splits the request into one or more jobs and writes a `task.md` for each: the goal, checkable
acceptance criteria, what is out of scope, and context. Then each job runs the line:

| Stage | Who | Writes |
| --- | --- | --- |
| Intake | Supervisor | `task.md` |
| Build | `builder` agent, in its own git worktree on branch `factory/<id>` | commits + `build.md` |
| Proof | `verifier` agent, independent of the builder; re-runs every claim first-hand | `proof.md` + `evidence/` |
| Review | `reviewer-security`, `reviewer-standards` and `reviewer-behavior`, in parallel | `review-<round>-<lens>.md`, each with its own verdict |
| Ship | Supervisor | `ship.md`: what changed, how each criterion was proven, risks |

Loop-backs:

- Proof fails: back to build. After 3 failed proofs the job stops and needs you.
- Any reviewer asks for changes: back to build, then proof again. After 3 rounds the job stops and
  needs you.
- The builder finds the task contradictory or impossible: it stops and says so, and the job
  needs you. You fix `task.md` (which needs approving again) or close the job.
- Work found along the way is a new job, not scope creep in this one.

The `factory` CLI enforces the line, not the prompts. It is the only writer of `job.json` and the
only way a job changes stage: `start` refuses an unapproved or since-edited `task.md`, `built`
refuses a dirty worktree or a missing `build.md`, and `verdict` refuses a verdict without its
written review.

## The two human gates

1. **Spec approval.** `factory.json` sets `spec_gate: true`, so every job stops after intake.
   Read its `task.md` and run `/factory:approve <id>` to approve it, or
   `/factory:approve <id> changes <what to change>` to send it back. Approving pins the file:
   if `task.md` changes afterwards, the job can't start until you approve it again. A plugin
   hook turns `factory approve` into a permission prompt, so an agent can't approve for you.
2. **PR merge with green CI.** When all three reviewers approve, the job reaches ship. Run
   `/factory:ship <id>`. It shows you `ship.md` and the diff stat, then takes the PR path:
   ```sh
   git push -u origin factory/<id>
   gh pr create --base main --head factory/<id> --title "<job title>" \
     --body-file factory/jobs/<id>/ship.md
   ```
   CI runs on the PR. You merge it on GitHub once the required checks (`gates`, `secrets`,
   `dependency-review`, `db-tests`) are green, then run `factory close <id> merged via PR` and
   `git pull` on `main`. Never use the plugin's local `factory merge` here: it would commit on
   `main`, which the pre-commit hook and the branch ruleset both refuse.

To reject a job at ship, run `/factory:ship <id> reject <reason>`; the branch is kept.

## Specs: what the system does now

`openspec/specs/<capability>/spec.md` stays the living description of behavior, in OpenSpec's
format (requirements with scenarios). There are no change proposals or delta specs any more:

- **A job that changes behavior updates the matching spec in the same job.** Intake writes that
  into the acceptance criteria, the builder edits the spec beside the code, and reviewers read
  the two together. A new capability gets a new `openspec/specs/<capability>/spec.md`.
- **The `openspec` gate validates the specs** with `openspec validate --specs --strict` on every
  commit, push and PR. Run it yourself after editing a spec.
- **`openspec/changes/archive/`** is history. Nothing new goes under `openspec/changes/`.
- **A frozen-contract change** (the README endpoint table and the `api-contract-freeze` spec)
  needs your decision before it is built. Agents escalate it with `factory human` instead.

## What the checks do

`scripts/check-change.sh` is the single implementation. It never reads the PR body, so a PR
whose body is `ship.md` needs nothing extra.

| Check | commit | hook | pr | Fails when |
| --- | --- | --- | --- | --- |
| openspec | x | x | x | `openspec validate --specs --strict` fails |
| yaml | x | x | x | A YAML file doesn't parse, or `.pre-commit-config.yaml` lacks a loadable shape. At the commit and hook stages, broken files the change didn't touch only warn |
| workflows | x | x | x | An action isn't SHA-pinned, or a workflow lacks top-level `permissions:` |
| skills-sync | x | x | x | `.agents/skills` differs from `.claude/skills` |
| guide-size | x | x | x | AGENTS.md is over its line budget (`agent_guide_max_lines`, 150) |
| commands | | x | x | typecheck or test fails. Whether the test run includes the pg and integration projects depends on the changed paths; see below |
| tests-with-code | | | x | Source changed without a test change. Test folders count at any depth; `managed_paths` files are ignored (label `no-test-needed` overrides) |
| audit | | | x | `lifecycle.commands.audit` fails |

`lifecycle.commands.lint` is empty, so no gate runs `npm run lint` yet; builders run it by hand.
`managed_paths`, `test_globs` and `db_test_paths` are read from the base branch's config, so a
PR can't exempt itself. Changes to them apply from the next PR.

pre-commit runs `commit` on commit and `hook` on push. CI runs `pr` on pull requests. The Stop
hook script (`.claude/hooks/stop-check.sh`) would run `hook`, but it isn't registered in
`.claude/settings.json`, so agents run it themselves before they finish.

### Which tests run (ADR 0026)

The pg and integration vitest projects (`server`, `packages/storage`) start a Postgres container
and take most of the test time. They run in CI on the PR, and only when the change can affect
them:

- **Locally, never by default.** Pre-push and manual runs skip them, with
  `(pg/integration skipped: local run; ...)`. Test-first work runs the test being written
  directly, for example `npx vitest run --project integration src/foo.int.test.ts`. Catching
  regressions elsewhere is the PR's `db-tests` check.
- **The CI decision.** If any changed file matches `lifecycle.db_test_paths` (code, migrations, the
  pg harness, `docker/`, `fixtures/`, root manifests, and the selection machinery itself), they
  run. If none does, the test command runs with `SKIP_DB_TESTS=1`, and the vitest configs leave
  those projects out. Anything unclear runs them: no base, no list on the base, a non-PR CI run,
  or `FULL_TESTS=1`. An inherited `SKIP_DB_TESTS` is always stripped.
- **What it says.** The `commands` line ends with `(full: <why>)`, `(pg/integration skipped:
  <why>)` or `(pg/integration: db-tests job)`. `scripts/check-change.sh --db-selection` prints
  CI's path decision locally.
- **Forcing a full run locally.** `FULL_TESTS=1 scripts/check-change.sh --stage hook`.
- **In CI**, `gates` sets `DB_TESTS_IN_SHARDS=1` and runs typecheck, unit tests and audit. The DB
  tests run in `db-shard`, a 3-way matrix that splits the server files with `vitest --shard`.
  `db-tests` is green only when every shard succeeded, and it's the check to require.

## Setup on a fresh clone

You need git, Node 22.12+ with npm, Python 3.8+ with PyYAML, the OpenSpec CLI (`openspec@1.13.2`,
as CI pins it), the `gh` CLI signed in to GitHub, and Claude Code.

1. Clone the repo and run `npm ci` at its root.
2. `pre-commit install --hook-type pre-commit --hook-type pre-push`.
3. Get a checkout of the software-factory plugin, for example at `~/software-factory`.
4. Start Claude Code in the repo with the plugin loaded:
   ```sh
   claude --plugin-dir ~/software-factory
   ```
   The plugin adds `/factory:run`, `/factory:approve`, `/factory:ship` and `/factory:dashboard`,
   the builder, verifier and reviewer agents, and the hook that guards `factory approve` and
   `factory merge`. Inside Claude Code, `factory` is on the PATH; outside it, call
   `~/software-factory/bin/factory`.
5. Check the configuration with `factory config`: it should print `"spec_gate": true` from
   `factory.json`. Runtime state goes in `factory/` (jobs, worktrees, the dashboard), which
   ignores itself in git.
6. Do the forge settings in `docs/security.md` "Setup a human must do" once per repository.

Then start work with `/factory:run <request>` from the main checkout on an up-to-date `main`.
Jobs are cut from the branch the main checkout is on.

## The dashboard

`/factory:dashboard` starts it in the background and prints the URL. From a shell:

```sh
factory dashboard --port 8787      # then open http://127.0.0.1:8787/
# or, the same thing:
cd factory && python3 -m http.server 8787 --bind 127.0.0.1
```

Jobs are cards that move across the stage columns, with a row of reviewer chips per review
round. Jobs that need you are highlighted and counted in the header and the tab title; click a
card to read its markdown files and history. The page re-reads `factory/jobs/*/job.json` every
two seconds. For a text view, run `factory status` (or `factory status <id>`); `factory stats`
prints the line metrics: first-pass proof rate, review rounds to approval, time to approval and
escalations.

## Operating

- Release: `docs/templates/release-checklist.md`. This repo has no `release` workflow yet, so the
  checklist's workflow and attestation steps don't apply until one is added.
- Rollback: rehearse with `docs/templates/rollback-drill.md` each quarter.
- Incidents: `docs/templates/postmortem.md`. A postmortem that finds a process gap proposes a
  rule with an ADR. One that finds a gate never fires proposes retiring it (ADR 0011).
- Each quarter, read `factory stats` alongside the gates: a station or gate that never catches
  anything is a candidate to retire.
