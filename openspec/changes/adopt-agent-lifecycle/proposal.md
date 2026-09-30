# Adopt the agent-lifecycle-template

Tier: 2
Tier reason: replaces the lifecycle itself (AGENTS.md, CLAUDE.md, .claude/, .github/, scripts/, openspec/config.yaml), all high-risk paths.

Approved-by: Kalen 2026-09-29

## Why

This repo's SDLC lived in a long `CLAUDE.md`, hand-customized `openspec-*` skills and Cursor pointer
adapters. It was enforced by prose, with no hooks and no CI. The owner chose to replace it with
[agent-lifecycle-template](https://github.com/kwcantrell/agent-lifecycle-template), which supplies:
- risk tiers;
- a human approval gate;
- a Stop hook;
- pre-commit hooks;
- CI gates.

The owner's approach:
- copy the template in verbatim;
- keep the old files locally under a git-ignored `old-lifecycle/` (they are also in history at
  `main` @ 794c107);
- add pieces back as needed.

That work is on the unmerged branch `adopt-agent-lifecycle`, and this change lands it.

## What Changes

**Replayed from `adopt-agent-lifecycle`, in order:**
1. **Old lifecycle moved aside.** `AGENTS.md`, `CLAUDE.md`, `openspec/config.yaml`,
   `.claude/settings.json`, the customized `openspec-*` skills and the `/opsx` commands move out.
   So do the Cursor OpenSpec adapters (`.cursor/commands/opsx/`, `.cursor/rules/openspec-sdlc.mdc`)
   and their guard test `web/src/cursorAdapters.repo.test.ts`.
   - They go to the git-ignored `old-lifecycle/`.
   - The OpenSpec skills are regenerated with `openspec init --tools claude,codex`.
   - `.claude/skills/agent-browser` becomes a real directory.
2. **Template installed** with `init.sh`, with owner `@kwcantrell`. `lifecycle.commands` sets:
   - test: `npm test`;
   - typecheck: `npm run typecheck`;
   - build: `npm run build`;
   - lint and audit are left blank, because both fail on main today.
3. **Placeholder Purposes replaced** with real text in five baseline specs, because strict
   validation (the `openspec` gate) rejects the archive placeholder.
4. **Two proposal-only draft changes removed:** `server-capabilities` and `web-log-search`. Both
   have no spec deltas, so they fail the same `openspec` gate. They remain in history.
5. **CodeGraph restored:** the prompt hook and the `mcp__codegraph__*` permission. This was the
   owner's edit to the human-only settings.
6. **26 archived tasks ticked** across six archived changes, each with an inline note that it is
   not a record of completion. `openspec validate --archived` fails on unticked tasks, and template
   ADR 0016 exempts these edits from the `change` gate.
7. **Vendored lifecycle files refreshed** to template `main` @ 44b75ac: the checker, the `adopt.py`
   installer, ADRs 0015-0017, and the docs.

**New in this change (owner decisions, 2026-09-29, after the panel):**
- **Repo rules restored in `AGENTS.md`:** a short "This repo" section covering:
  - `server/data` is live production data;
  - the HTTP/WS contract is frozen;
  - dev stays on loopback;
  - `e2e:container` clashes with a running prod stack.

  Codex and Claude both load it.
- **Contract code is high-risk:** `high_risk_paths` gains `packages/contract/**` and
  `server/src/routers/**`, so a contract shape change can't land below tier 2.
- **`release.yml` removed**, together with `lifecycle.release_artifacts` and
  `lifecycle.commands.build`. The template's release attests `dist/*`, but this repo builds into
  `web/.next`, and its real releases are GHCR images (`make prod-push`).
- **CI stack setup:** `lifecycle.yml` installs the stack on Node 22 with `npm ci`, so the
  `commands` gate runs.
- **`.gitleaksignore`** lists the four historical false positives:
  - three are the RFC 6455 sample `Sec-WebSocket-Key`;
  - one is a placeholder image tag in `check-envs.sh`.

  Without it, the `secrets` job fails on every run.
- **ADR 0018** records why and how this repo adopted the template.
- **Obsolete specs:**
  - `sdlc-process` is retired;
  - `cursor-agent-adapters` loses its two adapter requirements;
  - its two remaining requirements drop their drift-guard clauses;
  - its Purpose is rewritten.

## Non-goals

- **`.claude/settings.json` changes.** The owner keeps the template settings plus CodeGraph:
  - no `server/data` deny rule, since the `AGENTS.md` rule covers it;
  - the `impeccable` plugin setting is not restored.
- **Forge settings:** the ruleset, required checks, secret scanning and code-owner review. These,
  and `pre-commit install`, are owner-owed; see the owner-owed list in tasks.md.
- **Sandbox tuning,** the single-process rule in `AGENTS.md`, and making `npm run lint` and
  `npm audit` gates.
- **The rest of the old `CLAUDE.md`,** such as the source layout and the SDLC history. It is
  recoverable from `main` @ 794c107.

## Capabilities

- **Retired:** `sdlc-process`, via `retire_capabilities: true`.
- **Modified:** `cursor-agent-adapters`, with 2 requirements removed and 2 modified; its Purpose is
  edited in the main spec.

## Impact

- **Size:** `git diff --shortstat main adopt-agent-lifecycle` gives 5,240 insertions and 1,828
  deletions. The `size` gate counts 4,332 of them after its exclusions. The PR needs the
  `size-override` label, because this is an install of vendored and generated files; see design 5.
- **No runtime code changes.** The one test removed is the old adapter guard.
- **The HTTP/WS contract is unchanged.**
