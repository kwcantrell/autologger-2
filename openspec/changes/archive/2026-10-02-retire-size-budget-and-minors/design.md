# Design

## Context

See proposal.md for why. The size gate is implemented once, in `scripts/lib/check_change.py`
(`check_size`, lines ~410-456), and configured in `openspec/config.yaml` (`size_budget`,
`size_exclude`, `override_labels.size_budget`). The panel's severities are defined only in
`.claude/skills/adversarial-panel/SKILL.md`. The `panel` gate (`panel_findings`, `PANEL_TAG`)
parses `[critical|major|minor]` and blocks only on open criticals.

## Goals / Non-Goals

**Goals:**
- No size limit anywhere: CI, pre-push and the Stop-hook stage.
- Panels record only critical and major findings.
- An ADR records the measurement behind both retirements (rules 10 and 11).

**Non-Goals:** see proposal.md.

## Decisions

- **Delete the gate, don't zero it.** `check_size` already skips when `size_budget` is 0, but
  leaving dead code and an unused config key invites a template refresh to bring the gate back
  quietly. Removing `size` from `CHECKS` means `--only size` fails with "unknown check", which is
  the honest answer.
- **Delete the helpers too.** `committed_lines` and `untracked_lines` are used only by
  `check_size` (`grep -n 'committed_lines\|untracked_lines' scripts/lib/check_change.py`).
  `stat` is used only by `untracked_lines`.
- **Keep `overridden()` and `override_labels`.** `tests_with_code` still uses them through the
  `no-test-needed` label.
- **Base-branch exemption keys.** `size_budget` and `size_exclude` leave `EXEMPTION_KEYS`.
  `managed_paths` and `test_globs` stay, because `tests-with-code` reads them.
- **AGENTS.md rule 7 becomes a retired stub, not a gap.** ADRs 0008-0011 name their rules as
  "Non-negotiable N", and `.pre-commit-config.yaml` cites "AGENTS.md rule 9". Renumbering would
  make those references wrong, and ADRs are append-only. The stub costs one line of the 150-line
  guide budget.
- **Panel: skill only (owner).** The skill lists two severities and says not to report anything
  below major. The gate's regex keeps `minor`, so the 22 archived panels with minors still
  validate, and a stray minor in a new panel doesn't fail CI. The cost: nothing stops minors
  coming back except the skill text, and a real problem tagged `[minor]` passes CI. The owner
  chose this before the panel. The panel's major on it is open for the owner, and
  `docs/security.md` records the gap either way.
- **`consistency-read` is in scope.** It appends findings to `panel.md`, and its only example is a
  `[minor]`, so leaving it would keep minors flowing into panels. The edit is one word.
- **`docs/security.md` is edited clause by clause.** The size wording shares bullets with gaps
  that stay true (`tests/` folders still evade `tests-with-code`; grandfathered changes still skip
  the review-artifact gates), so whole bullets aren't deleted. A new gap records that nothing
  limits PR size and that `supabase-migration` is unprotected.
- **ADR 0024 supersedes ADR 0007.** ADR 0007 itself said to tune the number from how often it was
  overridden. That review happened early, on 4 days of data, because the override rate was
  already 9 of 24 (about 38%).

## Assumptions (each checked)

- **The size gate lives only in `check_change.py` and `openspec/config.yaml`; the rest are
  references.** The first grep, `grep -rn 'size-override\|size_budget\|size budget'`, missed
  references by the check's name and in capitals (panel finding). After the re-panel,
  `grep -rniw 'size' scripts .github .claude/hooks .pre-commit-config.yaml` and
  `grep -rni 'size budget\|size_budget\|size_exclude\|size-override\|--only size' . --include=*.{md,yaml,yml,py,sh}`
  (outside `node_modules`, the archive and `.agents/`) find only the files listed in proposal.md,
  plus ADR 0007 (being superseded) and ADR 0021's historical notes (kept).
- **Before-state of the size check depends on the base.** With no `--base`, the base is
  `origin/main` and `--only size` exits 1 (`7809 changed lines > budget 400`). With
  `--base origin/supabase-migration` it exits 0 (`0/400`). Task 1.1 uses the explicit base.
- **CI calls no size check by name.** `grep -n size .github/workflows/*.yml` finds nothing.
  The workflow runs `scripts/check-change.sh` by stage.
- **The hooks don't name `size`.** `grep -n size .claude/hooks/*.sh` finds nothing.
- **9 of 24 merged PRs carried `size-override`.** `gh pr list --state all` shows #7, #16, #18, #19,
  #25, #27, #29, #30 and #35 with the label, out of 24 merged PRs from #7 to #35 (`gh pr list --state merged` with number >= 7 -> 24).
- **Panel counts.** Grepping `[critical]`, `[major]` and `[minor]` across the 22 archived panels
  since 2026-09-29 gives 23, 262 and 459.
- **This PR's own CI.** The `pr` stage runs the checked-out script, which no longer has `size`.
  `with_base_exemptions` reads keys from the base branch's config, and the removed keys are
  simply no longer read.

## Risks

- **Large PRs.** With no ceiling, a slice can grow without anyone being prompted to split it.
  Mitigation: the owner already chooses the split for every slice. The panel's scope reviewer
  still asks "what can be cut?".
- **Lost low-severity signal.** A real problem mis-rated as minor now goes unrecorded instead of
  being logged. Mitigation: the reviewers decide severity, and anything that "should be fixed
  before approval" is major by definition.
- **Template drift.** Recorded in ADR 0024 and the memory note about refreshing vendored files.
