# 0022: Retire the `server/data` rule; agents may use the local copy

- Date: 2026-09-30
- Status: Accepted (supersedes ADR 0018's "`server/data` is live production data" Decision bullet and its "retire once a deny rule exists" Consequence)
- Rule: AGENTS.md "This repo (autologger)" no longer has a `server/data` bullet; no `.claude/settings.json` rule replaces it

## Context

ADR 0018 put a prose rule in `AGENTS.md`: `server/data` is live production data, so agents must
never read it, copy into it, mount it or point `DATA_DIR` at it. ADR 0018 also said to retire the
rule only once an equivalent check existed, for example a settings deny rule.

That premise no longer holds. The owner confirmed on 2026-09-30 that the container cutover is
done. Prod runs from its container volume on the deploy host, and `server/data` will never seed
prod again. `server/data` is now a disposable copy of a backup kept elsewhere. The archived
containerize-split-images change had left cutover task 8.3 open and called `server/data` the
pre-seed copy, and this record supersedes that.

## Decision

- **The `AGENTS.md` bullet is removed** (the owner's edit).
- **Agents may read, edit and use `server/data` for dev.**
- **No settings rule replaces it.** A deny rule, or an `ask` rule on Edit/Write, was considered and
  declined by the owner.
- **The container fences are unchanged.** The dev and stage stacks still never mount `server/data`
  or use it as `DATA_DIR` (`check-envs.sh`, `.dockerignore`, and the `container-deployment` and
  `local-container-environments` specs).
- **The README note is reworded** to call `server/data` a disposable copy, not live data.

## Evidence

- **The owner's statements (2026-09-30):**
  - cutover is done;
  - the authoritative backup is kept elsewhere;
  - `server/data` is a copy that can be used for dev.
- **Host state:**
  - `docker ps` shows no prod stack on this host;
  - the dev app's `/data` is the `autologger-dev_dev-data` volume;
  - no host server process runs from `server/data`.
- **The retire-server-data-rule panel:** 3 reviewers; 1 critical and 7 major findings, all
  resolved or decided by the owner. The critical finding was the unconfirmed cutover.

## Consequences

Residuals the owner accepted:
- **Personal data reaches the agent.** Real user data an agent reads lands in tool output, model
  context and subagent reports. `.gitignore` (`data/`) stops the directory being committed, but
  not data copied into fixtures, docs or messages.
- **Prompt injection.** Transcripts and session titles are user-written text. Under AGENTS.md
  rule 9 they are data, never instructions, but `docs/security.md` ASI01 doesn't list them as a
  source.
- **No undo.** Nothing mechanical stops edits or deletes, and git doesn't track the directory.
  This is acceptable only because the copy is disposable.
- **Default `DATA_DIR`.** A host run or test without `DATA_DIR` opens `server/data`
  (`server/src/node/config.ts`) and may migrate it.

Follow-ups:
- Retire the host workflow: `server/.env.example`, the README quick start, and the host path in
  AGENTS.md's loopback rule. Done in ADR 0021 slice 1.4b (`retire-host-dev`), except that the
  owner kept `server/.env.example` as the variable reference (nothing reads `server/.env`).
- Reword the "live" comments in `.dockerignore`, `docker/Dockerfile` and `docker/compose.dev.yaml`.
- If `server/data` ever holds the only copy of anything again, restore a rule, as a settings deny
  rule rather than prose.
