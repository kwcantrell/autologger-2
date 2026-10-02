# Tasks

The first commit on this branch is `openspec/changes/retire-size-budget-and-minors/` only (AGENTS.md
rule 6). The checker has no test suite in this repo (`ls scripts/lib` shows no tests), so each task
names the command that fails before the change and passes after it.

## 1. Retire the size gate

- [x] 1.1 Remove the `size` check from `scripts/lib/check_change.py`: the `CHECKS` entry, the `hook` and
  `pr` stage lists, `check_size`, `committed_lines`, `untracked_lines`, the `stat` import, the
  `size_*` entries in `EXEMPTION_KEYS`, `size` in `GRANDFATHER_SKIPS` and the quiet-mode WARN tuple,
  and the `LIFECYCLE_OVERRIDE` example. In `scripts/check-change.sh`, the usage line becomes
  `--only tests-with-code,tasks`. In `.pre-commit-config.yaml`, the `verbose: true` comment names the
  `yaml` warning instead of the size warning. Check first (before):
  `scripts/check-change.sh --only size --base origin/supabase-migration` exits 0 with
  `PASS  size  0/400`. After: it exits 2 with "unknown check ['size']";
  `grep -n 'size_budget\|size_exclude\|check_size\|untracked_lines\|committed_lines\|^import stat' scripts/lib/check_change.py`
  returns nothing; and `grep -rniw size scripts .pre-commit-config.yaml` shows only `guide-size` lines.
  Evidence: before `scripts/check-change.sh --only size --base origin/supabase-migration` -> `PASS  size  0/400 changed lines`, exit=0; after -> `check-change: unknown check ['size']; valid checks: change, risk-floor, ...`, exit=2; the `grep -n 'size_budget\|...\|^import stat' scripts/lib/check_change.py` -> rc=1; `grep -rniw size scripts .pre-commit-config.yaml` -> only `check_change.py:34,35,37` (stage lists' `guide-size`) and `:544 "guide-size": check_guide_size`
- [x] 1.2 Remove `size_budget`, `size_exclude`, `override_labels.size_budget` and the size-budget
  proposal rule from `openspec/config.yaml`. Check: `grep -ni size openspec/config.yaml` returns
  nothing, and `scripts/check-change.sh --only yaml,openspec` passes.
  Evidence: `grep -ni size openspec/config.yaml` -> rc=1; `scripts/check-change.sh --only yaml,openspec` -> `PASS yaml 80 YAML file(s) parse`, `PASS openspec openspec validate --strict`

## 2. Docs and the agent guide

- [x] 2.1 `AGENTS.md`: rule 7 becomes `7. *Retired (ADR 0024): no size budget.*`; the commands example
  becomes `--only tests-with-code,tasks`. Check: `grep -n '400\|size_\|size budget\|--only size' AGENTS.md`
  shows only the stub line, and `scripts/check-change.sh --only guide-size` passes.
  Evidence: `grep -n '400\|size_\|size budget\|--only size' AGENTS.md` -> `45:7. *Retired (ADR 0024): no size budget.*` only; `--only guide-size` -> `PASS guide-size AGENTS.md 96/150 lines`
- [x] 2.2 Edit `docs/lifecycle.md` (the `size` row, the `size_exclude`/`size_budget` and untracked-files
  paragraphs, "and size gates" at line ~115), `.github/pull_request_template.md` (`size-override`) and
  ADR 0021's "each under 400 lines". Edit `docs/security.md` clause by clause, as listed in
  proposal.md: ASI08 row, the `tests/`-folder, exemptions and grandfathered bullets (keeping their
  remaining gaps), the updated `[minor]` gap, and the new "no size limit; `supabase-migration`
  unprotected" gap. Check:
  `grep -rni 'size_budget\|size_exclude\|size-override\|size budget\|size cap\|under 400' docs/lifecycle.md docs/security.md .github/pull_request_template.md`
  and `grep -n 'under 400' docs/decisions/0021-*.md` return nothing (ADR 0021's historical
  `size-override` notes stay, per the non-goals), and `grep -n 'tests-with-code\|review-artifact\|supabase-migration' docs/security.md`
  shows the kept gaps and the new one.
  Evidence: the docs grep -> rc=1; `grep -n 'under 400' docs/decisions/0021-*.md` -> rc=1; `grep -n 'tests-with-code\|review-artifact\|supabase-migration' docs/security.md` -> `48: \`tests-with-code\`. Code review is the control.`, `52:- A grandfathered change (ADR 0014) skips the review-artifact gates.`, `57:- No gate limits PR size (ADR 0024). \`supabase-migration\` has no branch protection`
- [x] 2.3 Add `docs/decisions/0024-retire-size-budget-and-panel-minors.md` (Date, Status, Rule,
  Context, Decision, Evidence, Consequences), superseding ADR 0007, and set ADR 0007's Status to
  "Superseded by ADR 0024". Check: `grep -c -E '^(- Date|- Status|- Rule|## Context|## Decision|## Evidence|## Consequences)'`
  on 0024 prints 7, and `grep -n 'Superseded' docs/decisions/0007-small-batches.md` matches.
  Evidence: `grep -c -E '^(- Date|...)' docs/decisions/0024-retire-size-budget-and-panel-minors.md` -> `7`; `grep -n Superseded docs/decisions/0007-small-batches.md` -> `4:- Status: Superseded by ADR 0024 (2026-10-02)`

## 3. Panel severities

- [x] 3.1 `.claude/skills/adversarial-panel/SKILL.md`: severities are `critical` and `major` only;
  reviewers don't report anything below major; the example's `[minor]` line and the scope reviewer's
  size-budget question go. `.claude/skills/consistency-read/SKILL.md`: the example finding becomes
  `[major]`. Run `scripts/sync-skills.sh`. Check:
  `grep -rni 'minor\|size budget' .claude/skills/adversarial-panel .claude/skills/consistency-read .agents/skills/adversarial-panel .agents/skills/consistency-read`
  returns nothing, and `scripts/check-change.sh --only skills-sync` passes.
  Evidence: `scripts/sync-skills.sh` -> `synced 4 skill(s) into .agents/skills`; `grep -rni 'minor\|size budget' .claude/skills/{adversarial-panel,consistency-read} .agents/skills/{adversarial-panel,consistency-read}` -> rc=1; `--only skills-sync` -> `PASS skills-sync 4 skill(s) in sync`

## 4. Verify and archive

- [ ] 4.1 Run `scripts/check-change.sh --stage pr --base origin/supabase-migration` and record the
  result. Expected: every gate passes, with no `size` line, except `tasks` until this task is ticked.
- [ ] 4.2 Consistency read (tier 2), then archive (`skip_specs`). Check:
  `openspec validate --all --strict` and `openspec validate --archived --no-interactive` pass.

## At PR (no checkbox)

- Push, open the PR against `supabase-migration`, and confirm `gates`, `secrets` and
  `dependency-review` pass before merging.
- Owner: delete the GitHub `size-override` label after merge, if wanted.
