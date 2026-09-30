# 0018: Adopt agent-lifecycle-template, with repo rules on top

- Date: 2026-09-29
- Status: Accepted
- Rule: AGENTS.md "This repo (autologger)"; `lifecycle.high_risk_paths` contract entries; the `lifecycle.yml` stack setup; `.gitleaksignore`

## Context

autologger-2's SDLC lived in prose that only the agent enforced:
- a 400-line `CLAUDE.md`;
- a customized 510-line `openspec-apply-change` skill;
- `openspec/config.yaml` rules;
- Cursor pointer adapters.

Nothing ran as a hook or in CI. There was no `.github/`, and work merged to a local `main`.
[agent-lifecycle-template](https://github.com/kwcantrell/agent-lifecycle-template) supplies risk
tiers, a human approval gate, a Stop hook, pre-commit, and CI gates. It was partly derived from
this repo's own practice. Its `init.sh` skipped every file this repo already had.

## Decision

The owner adopted the template verbatim, with the old files kept locally in the git-ignored
`old-lifecycle/` (authoritative copy: `main` @ 794c107). Only these repo-specific pieces sit on
top:
- **Repo rules** in `AGENTS.md`:
  - `server/data` is live production data;
  - the frozen HTTP/WS contract;
  - loopback dev;
  - the `e2e:container` clash.

  Both Claude and Codex load it. The single-process rule was left out by owner choice.
- **Contract code is high-risk:** `packages/contract/**` and `server/src/routers/**` force tier 2.
- **Stack commands:** test `npm test` and typecheck `npm run typecheck`. Lint and audit stay blank
  because both fail on main at adoption.
- **CI runs the stack on Node 22** (npm 10), which runs `better-sqlite3`'s install script, as the
  Docker images already do.
- **The template's `release.yml` is removed,** with `release_artifacts` and `commands.build`. This
  repo releases GHCR images through `make prod-push`, not a `dist/` artifact.
  `docs/lifecycle.md` (vendored) still describes the template's release flow.
- **`.gitleaksignore`** allows four historical false positives: three copies of the RFC 6455 sample
  WebSocket key, and one placeholder image tag.
- **`.claude/settings.json`** is the template's, plus the CodeGraph hook and permission. No
  `server/data` deny rule; the `impeccable` plugin setting is dropped.
- **The old lifecycle's specs:**
  - `sdlc-process` is retired;
  - `cursor-agent-adapters` keeps only its MCP-config and restart-rule requirements.

## Evidence

- The adopt-agent-lifecycle panel: 3 reviewers; 7 major entries (12 raw findings, deduplicated), all resolved or decided by the owner.
- A Docker node:22 run of `npm ci`, typecheck, test and build: all pass, in about 2 min.
- gitleaks v8.30.1 over 846 commits: 4 hits without the ignore file, none with it.

## Consequences

- **The Stop hook runs `npm test` and `npm run typecheck`** whenever the tree is dirty. On a fresh
  clone it fails `commands` until `npm ci` has run. The hook stops blocking after 3 tries.
- **A template refresh must merge the "This repo" section back** into `AGENTS.md`, and must not
  restore `release.yml`.
- **Retire the repo rules** once equivalent checks exist, for example a settings deny rule for
  `server/data`.
