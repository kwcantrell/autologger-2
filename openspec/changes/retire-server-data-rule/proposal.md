# Retire the `server/data` rule

Tier: 2
Tier reason: edits `AGENTS.md`, a high-risk path and part of the lifecycle itself, and changes whether agents may read a copy of live user data.

Approved-by: Kalen 2026-09-30

## Why

`AGENTS.md` says `server/data` is live production data and agents must never read it. That is no
longer true. The owner confirmed (2026-09-30) that the container cutover is done: prod runs from
its container volume on the deploy host, and `server/data` will never seed prod again. `server/data`
is a copy of a backup kept elsewhere, and the owner has decided agents may read, edit and use it
for dev.

## What Changes

- **`AGENTS.md`:** the `server/data` bullet in "This repo (autologger)" is removed. This is the
  owner's edit, kept exactly as made.
- **`README.md`:** the "Protect `server/data`" note in the dev-environment section (about line
  1510) is reworded. It says `server/data` is a disposable copy of a backup kept elsewhere, not
  the live copy. It keeps the facts that are still true: the dev stack never mounts it and never
  uses it as `DATA_DIR`, and dev data lives in the `dev-data` volume. The dev-mount list at about
  line 1609 stays as it is.
- **ADR 0021** records:
  - the retirement, superseding ADR 0018's "`server/data` is live production data" Decision bullet
    and its "retire once a deny rule exists" Consequence;
  - that the owner chose not to replace the rule with a settings rule (see Decisions);
  - the residual risks: user-written text in the data (transcripts, titles) is a prompt-injection
    source, and real user data an agent reads reaches tool output, model context and subagent
    reports.

## Decisions (owner, 2026-09-30)

- **The cutover is done, and `server/data` is a disposable copy.** The authoritative backup is kept
  elsewhere, so losing or changing `server/data` costs nothing.
- **Agents may read, edit and use `server/data` for dev.** No `.claude/settings.json` deny or ask
  rule replaces the removed prose rule.
- **Update the README note and add an ADR** in the same change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. No spec-level behavior changes (`skip_specs`). The container fences that keep `server/data`
out of images and mounts (`container-deployment`, `local-container-environments`) are unchanged.

## Non-goals

- Changing the container fences for `server/data`: the Dockerfile, `.dockerignore`, the compose
  mounts, `check-envs.sh`, or their specs.
- Changing `.claude/settings.json`, the hooks, or the sandbox.
- Retiring `server/.env.example` or the README quick start and environment variable reference.
  That is a separate change.
- Rewording the "live" comments in `.dockerignore`, `docker/Dockerfile` and
  `docker/compose.dev.yaml`.
- Moving, deleting or reading anything inside `server/data`.
- Retiring the host `npm run build && npm run start` path in AGENTS.md's loopback rule. That rule
  stays as written. Retiring the host workflow is follow-up work, alongside `server/.env.example`.

## Impact

- Three files: `AGENTS.md` (3 lines removed), `README.md` (one note reworded) and a new
  `docs/decisions/0021-retire-server-data-rule.md`. About 40 lines. No code, specs or contract change.
- Agents are no longer told to stay out of a directory that holds a copy of real user data
  (sessions, transcripts, audio). The owner accepts this. ADR 0021 records the residual risks.
