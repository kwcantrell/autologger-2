## 1. Replay the install

- [x] 1.1 After the approved-artifacts commit, run `git cherry-pick main..adopt-agent-lifecycle`.
  Test: `git diff adopt-agent-lifecycle HEAD --stat -- . ':!openspec/changes/adopt-agent-lifecycle'`
  is empty, and `scripts/check-change.sh --only change,risk-floor` shows `change` PASS at tier 2
  (6 archives not counted) and `risk-floor` PASS.
  Evidence: artifacts commit `2751139`, then 7 cherry-picks (rc 0); the diff stat outside the change dir is empty; `--only change,risk-floor` -> `PASS change tier 2 (openspec/changes/adopt-agent-lifecycle); not counted: ... 6 archives`, `PASS risk-floor 32 high-risk path(s) touched`

## 2. This change's edits

- [x] 2.1 Append the "This repo" section to `AGENTS.md`, verbatim from design 2. Test first:
  `scripts/check-change.sh --only guide-size` passes, at 150 lines or fewer.
  Evidence: the block matched design 2 verbatim (a script check printed `verbatim: True`); `--only guide-size` -> `PASS AGENTS.md 100/150 lines`
- [x] 2.2 In `openspec/config.yaml`:
  - add `packages/contract/**` and `server/src/routers/**` to `high_risk_paths`;
  - remove `release_artifacts` and `commands.build`.
  Delete `.github/workflows/release.yml`. Test: after a scratch edit to
  `packages/contract/src/schemas.ts`, `scripts/check-change.sh --only risk-floor` names it and
  requires tier 2 (then revert). `--only yaml,workflows` passes.
  Evidence: `matches()` -> `packages/contract/src/schemas.ts True`, `server/src/routers/sessions.ts True`, `server/src/app.ts False`; a scratch edit to `schemas.ts` raised risk-floor from `32` to `33 high-risk`, then was reverted. The branch is tier 2, so the gate passes either way. `--only yaml,workflows` -> PASS both
- [x] 2.3 Add Node 22 `setup-node` (pinned SHA, `cache: npm`) and `npm ci` to `lifecycle.yml`'s
  Stack setup (design 6). Test: `scripts/check-change.sh --only workflows,yaml` passes.
  Evidence: `--only workflows,yaml` -> `PASS workflows actions pinned, token scoped`, `PASS yaml 56 YAML file(s) parse`
- [x] 2.4 Add `.gitleaksignore` with the four fingerprints (design 7). Test:
  `docker run zricethezav/gitleaks:v8.30.1 git --redact` on a scratch clone of this branch reports
  `no leaks found`.
  Evidence: scratch clone plus `.gitleaksignore` -> `846 commits scanned ... no leaks found`; the same clone without it -> `leaks found: 4`
- [x] 2.5 Rewrite `openspec/specs/cursor-agent-adapters/spec.md`'s Purpose (design 8). Add ADR
  `docs/decisions/0018-adopt-agent-lifecycle.md` (design 9). These are docs, so no test; the check is
  `openspec validate --all --strict`.
  Evidence: `openspec validate --all --strict` -> `Totals: 28 passed, 0 failed`
- [x] 2.6 Run `scripts/check-change.sh --stage hook`, and record it as `Evidence:`. Expected:
  everything passes, except `size` WARN.
  Evidence: `--stage hook` -> PASS openspec, yaml, workflows, skills-sync, guide-size, change (tier 2), risk-floor, evidence, commands (`typecheck`, `test`); WARN size `4312 changed lines > budget 400`

## 3. Archive and PR

- [x] 3.1 Archive. `sdlc-process` is retired and `cursor-agent-adapters` updated. Test:
  `openspec validate --all --strict` passes, and `openspec/specs/sdlc-process/` no longer exists.
  Evidence: `openspec archive adopt-agent-lifecycle -y` -> `Retiring openspec/specs/sdlc-process/spec.md ... Totals: + 0, ~ 2, - 4`; `ls openspec/specs/sdlc-process` -> `No such file or directory`; `openspec validate --all --strict` -> `26 passed, 0 failed`
- [ ] 3.2 Push and open the PR with the `size-override` reason. Record the first CI run as
  `Evidence:`; expected: `gates` and `secrets` pass, with `size` failing until the owner applies
  `size-override`.

## Owner-owed, after merge (tracked here, done by the human; no checkboxes, so the tasks gate ignores them)

- Apply the `size-override` label to the PR, and merge.
- Main ruleset: require a PR, code-owner review, and the `gates`, `secrets` and
  `dependency-review` checks; turn on secret-scanning push protection (`docs/security.md`).
- Run `pre-commit install --hook-type pre-commit --hook-type pre-push` on each dev machine.
- Delete the `adopt-agent-lifecycle` branch.
