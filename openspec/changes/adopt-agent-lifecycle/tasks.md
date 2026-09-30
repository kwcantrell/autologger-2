## 1. Replay the install

- [ ] 1.1 After the approved-artifacts commit, run `git cherry-pick main..adopt-agent-lifecycle`.
  Test: `git diff adopt-agent-lifecycle HEAD --stat -- . ':!openspec/changes/adopt-agent-lifecycle'`
  is empty, and `scripts/check-change.sh --only change,risk-floor` shows `change` PASS at tier 2
  (6 archives not counted) and `risk-floor` PASS.

## 2. This change's edits

- [ ] 2.1 Append the "This repo" section to `AGENTS.md`, verbatim from design 2. Test first:
  `scripts/check-change.sh --only guide-size` passes, at 150 lines or fewer.
- [ ] 2.2 In `openspec/config.yaml`:
  - add `packages/contract/**` and `server/src/routers/**` to `high_risk_paths`;
  - remove `release_artifacts` and `commands.build`.

  Delete `.github/workflows/release.yml`. Test: after a scratch edit to
  `packages/contract/src/schemas.ts`, `scripts/check-change.sh --only risk-floor` names it and
  requires tier 2 (then revert). `--only yaml,workflows` passes.
- [ ] 2.3 Add Node 22 `setup-node` (pinned SHA, `cache: npm`) and `npm ci` to `lifecycle.yml`'s
  Stack setup (design 6). Test: `scripts/check-change.sh --only workflows,yaml` passes.
- [ ] 2.4 Add `.gitleaksignore` with the four fingerprints (design 7). Test:
  `docker run zricethezav/gitleaks:v8.30.1 git --redact` on a scratch clone of this branch reports
  `no leaks found`.
- [ ] 2.5 Rewrite `openspec/specs/cursor-agent-adapters/spec.md`'s Purpose (design 8). Add ADR
  `docs/decisions/0018-adopt-agent-lifecycle.md` (design 9). These are docs, so no test; the check is
  `openspec validate --all --strict`.
- [ ] 2.6 Run `scripts/check-change.sh --stage hook`, and record it as `Evidence:`. Expected:
  everything passes, except `size` WARN.

## 3. Archive and PR

- [ ] 3.1 Archive. `sdlc-process` is retired and `cursor-agent-adapters` updated. Test:
  `openspec validate --all --strict` passes, and `openspec/specs/sdlc-process/` no longer exists.
- [ ] 3.2 Push and open the PR with the `size-override` reason. Record the first CI run as
  `Evidence:`; expected: `gates` and `secrets` pass, with `size` failing until the owner applies
  `size-override`.

## Owner-owed, after merge (tracked here, done by the human; no checkboxes, so the tasks gate ignores them)

- Apply the `size-override` label to the PR, and merge.
- Main ruleset: require a PR, code-owner review, and the `gates`, `secrets` and
  `dependency-review` checks; turn on secret-scanning push protection (`docs/security.md`).
- Run `pre-commit install --hook-type pre-commit --hook-type pre-push` on each dev machine.
- Delete the `adopt-agent-lifecycle` branch.
