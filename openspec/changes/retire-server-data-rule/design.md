# Design

## Context

See proposal.md for why. The removed rule was the only guard keeping agents out of `server/data`.
`.claude/settings.json` has no deny rule for it, and ADR 0018 said to retire the rule only once a
deny rule existed. The owner has decided to retire it without a replacement.

## Goals / Non-Goals

**Goals:**
- Make the agent guide and the README match how the repo now runs.
- Record in an ADR why the rule was dropped without the replacement ADR 0018 expected.

**Non-Goals:**
- Any change to the mechanical fences that keep `server/data` out of images and container mounts.
  Those still stop the dev and stage stacks from seeing it. This change only allows host-side
  agent access.

## Decisions

- **Remove the rule; don't add a deny rule (owner).** Alternatives considered:
  - a `.claude/settings.json` Read/Edit deny rule for `server/data/**`, which is what ADR 0018
    planned;
  - a one-line prose rule calling it a backup and saying not to read it.

  The owner wants agents to be able to read and edit the backup, so both were rejected.
- **ADR 0021 amends ADR 0018 rather than editing it.** ADRs are append-only records. 0021 names the
  0018 line it supersedes, as ADR 0020 did.
- **README keeps the fence facts.** The note still says the dev stack never mounts `server/data` or
  uses it as `DATA_DIR`, because `check-envs.sh` and the `local-container-environments` spec still
  enforce that.

## Assumptions (each checked)

- **Prod doesn't use `server/data`.** `grep -n 'data' compose.yaml` gives `DATA_DIR: /data` and
  `autologger-data:/data`, a named volume.
- **Nothing on this host serves from `server/data`.** `docker ps` shows only the `autologger-dev-*`
  containers, no prod stack. `docker inspect autologger-dev-app` shows `/data` backed by the
  `autologger-dev_dev-data` volume. `pgrep -af main.ts` shows only the dev container's `/app/...`
  processes, no host `npm run dev` or `npm run start`.
- **No deny rule exists today.** `grep -n data .claude/settings.json` gives no output.
- **No lifecycle script depends on the rule's text.** `git grep -n 'server/data' -- scripts .claude`
  gives no output.
- **The cutover is done, and `server/data` is a disposable copy of a backup kept elsewhere.** This
  is the owner's statement (2026-09-30). It supersedes the archived containerize-split-images
  record, which left cutover task 8.3 open and called `server/data` the pre-seed copy. The agent
  didn't open the directory to check it.

## Risks / Trade-offs

- **Personal data reaches the agent.** Real user data an agent reads lands in tool output, model
  context and subagent reports. Accepted by the owner and recorded in ADR 0021, so a later owner
  can restore the rule or add a deny rule.
- **Prompt injection.** Transcripts and session titles are user-written text, now readable by
  agents. Under AGENTS.md rule 9, agents treat them as data, never instructions. ADR 0021 records
  this as residual risk.
- **Edits or deletes.** Nothing mechanical stops an agent changing `server/data`, and it is
  gitignored, so git can't restore it. The owner accepts this because it is a disposable copy.
  The authoritative backup is kept elsewhere.
- **Default `DATA_DIR`.** A host run or test without `DATA_DIR` opens `server/data`
  (`server/src/node/config.ts:21`) and may migrate it. Accepted for the same reason: the owner
  allows dev use of the copy.
- **Stale "live" comments remain** in `.dockerignore`, `docker/Dockerfile` and
  `docker/compose.dev.yaml`. They are left as they are (a non-goal) and do no harm, because they
  describe fences that still apply.
