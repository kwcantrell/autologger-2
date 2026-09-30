# Panel: adopt-agent-lifecycle

Tier: 2 · Reviewers: assumption tester (A), failure and abuse (F), scope and simplicity (S), each a separate Sonnet subagent · Date: 2026-09-29

No critical findings. Four decisions went to the owner (2026-09-29):
- restore repo rules in `AGENTS.md`, without the single-process rule;
- leave `.claude/settings.json` as is;
- remove `release.yml`;
- make the contract paths high-risk.

- [x] [major] S-4 / F-invariants-deferred (S, F): deferring the repo rules leaves agents free to run the server against live `server/data`, break the frozen contract, or clash with prod containers, before any PR exists. Resolved: by owner decision, `AGENTS.md` gains a "This repo" section (design 2), minus the single-process rule at the owner's request.
- [x] [major] F-settings-no-datadir-protection (F): the new settings don't deny `server/data`, and the sandbox allows writes inside the repo. Declined by human: the owner keeps `.claude/settings.json` unchanged; the `AGENTS.md` rule is the control (design "Accepted residuals").
- [x] [major] F-release-broken / A-3 (F, A): `release.yml` attests `dist/*`, but this repo builds `web/.next`, so the first `v*` tag fails. Resolved: by owner decision, `release.yml`, `release_artifacts` and `commands.build` are removed (design 4).
- [x] [major] F-gitleaks-history (F): the `secrets` job would fail on every run. Evidence: gitleaks on a scratch clone found 4 `generic-api-key` hits. Resolved: `.gitleaksignore` with the four fingerprints, each verified as a false positive (design 7); task 2.4 tests it.
- [x] [major] A-1 / S-3 (A, S): `openspec archive` refuses to empty `sdlc-process` without `retire_capabilities: true`. Evidence: scratch archive aborts, then succeeds with the flag (validate 26/26). Resolved: flag set; design 8; task 3.1 checks that the spec directory is gone.
- [x] [major] A-2 / S-1 / S-2 (A, S): the kept `cursor-agent-adapters` requirements and Purpose still cite the deleted drift guard and `sdlc-process`. Resolved: MODIFIED deltas drop the guard clauses, keeping all scenarios; the main spec's Purpose is rewritten (design 8, task 2.5).
- [x] [major] S-5 (S): tasks.md lacked named tests and expected results. Resolved: rewritten; every task names its test or expected output.
- [x] [minor] F-risk-floor-blind-to-contract (F): the contract code wasn't high-risk. Resolved: by owner decision, `packages/contract/**` and `server/src/routers/**` join `high_risk_paths` (design 3, task 2.2).
- [x] [minor] F-release-npmci-idtoken (F): the release job ran `npm ci` with `id-token: write`. Resolved: `release.yml` is removed.
- [x] [minor] F-settings-plugin-dropped (F): the `impeccable` plugin setting was silently dropped. Declined by human: the owner leaves the settings as is; recorded as a residual.
- [x] [minor] S-6 (S): removing the two draft changes looked unrelated to adoption. Resolved: both lack spec deltas and fail the `openspec` gate; the proposal (item 4) now says so.
- [x] [minor] S-7 (S): the size figures came from different commands, and the no-split claim was asserted. Resolved: the proposal cites `git diff --shortstat` and the gate's own count; design 5 gives the reasoning.
- [x] [minor] S-8 (S): forge settings and `pre-commit install` weren't tracked. Resolved: an owner-owed list in tasks.md, without checkboxes so the `tasks` gate isn't blocked.
- [x] [minor] S-9 (S): there was no ADR for the adoption. Resolved: ADR 0018 (design 9, task 2.5).
- [x] [minor] S-10 (S): no task created the artifacts commit. Resolved: design 1 and task 1.1 start after the approved-artifacts commit.
- [x] [minor] S-11 / A-5 (S, A): the CI claims were untested, and the hook fails on a fresh clone without `npm ci`. Resolved: the Node 22 CI path was verified in Docker (design 6); the fresh-clone behaviour is recorded in ADR 0018 and the residuals.
- [x] [minor] A-4 (A): the design cited pre-replay SHAs. Accepted: only trees matter; task 1.1 compares trees.
- [x] [minor] A-6 (A): a stale comment mentions `cursorAdapters.repo.test.ts` in `server/src/packageBoundaries.repo.test.ts:41`. Accepted: harmless prose.
- [x] [minor] F-ci-fork-safe / F-cherrypick-ok (F): informational, checked. Fork PRs get no secrets; the replay assumption holds.
- [x] [minor] F-size-override-routine / F-codeowners-single-owner / F-stop-hook-cost / F-old-lifecycle-loss (F): accepted as residuals (design "Accepted residuals").
