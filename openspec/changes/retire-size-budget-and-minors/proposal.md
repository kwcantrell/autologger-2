# Retire the size budget; the panel reports only critical and major findings

Tier: 2
Tier reason: changes the lifecycle itself: `AGENTS.md`, `.claude/skills/`, `openspec/config.yaml` and `scripts/lib/check_change.py` are all high-risk paths.

Approved-by: Kalen 2026-10-02

## Why

Two parts of the lifecycle cost more than they return (AGENTS.md rule 11):

- **The size budget is routinely overridden.** Since the lifecycle was adopted (2026-09-29), 9 of the
  24 merged PRs carried `size-override`: 1,410, 904, 584, 777, 689 and 1,022 counted lines, among
  others. Each override was the owner's call to keep an atomic change in one PR. PR #35's only CI
  failure was the size gate, and the PR merged on the override. A gate overridden on more than
  a third of PRs is a prompt to add a label, not a control.
- **Minor panel findings are noise.** The 22 tier 2 panels since adoption logged 459
  `[minor]` findings against 23 critical and 262 major. The criticals and majors changed
  designs (Studio CSRF, the shared `db` network, the encoded-path login bypass). The minors
  are optional by definition, yet they still have to be read and triaged before approval.

## What Changes

- **Size budget removed.**
  - `scripts/lib/check_change.py`: the `size` check is deleted from `CHECKS` and from the `hook`
    and `pr` stages. Its helpers (`committed_lines`, `untracked_lines`) and the now-unused `stat`
    import go too. `size_budget` and `size_exclude` leave `EXEMPTION_KEYS`. `size` leaves
    `GRANDFATHER_SKIPS` and the quiet-mode WARN list. The `LIFECYCLE_OVERRIDE` comment's example
    changes to `tests_with_code`. The usage header in `scripts/check-change.sh` (`--only size,tasks`)
    changes the same way as AGENTS.md.
  - `.pre-commit-config.yaml`: the pre-push hook's `verbose: true` comment ("show the size
    warning") is reworded to the remaining reason, the `yaml` warning.
  - `openspec/config.yaml`: `size_budget`, `size_exclude`, the `size_budget: size-override` label
    mapping and the "keep the change inside the size budget" proposal rule are removed.
  - `AGENTS.md`: rule 7 becomes a one-line retired stub pointing at ADR 0024, so rules 8-11 keep
    their numbers (ADRs and `.pre-commit-config.yaml` cite them by number). The commands-table
    example `--only size,tasks` becomes `--only tests-with-code,tasks`.
  - Docs: the `size` row and the size paragraphs in `docs/lifecycle.md`; `size-override` in
    `.github/pull_request_template.md`; ADR 0021's "each under 400 lines" rollout line.
  - `docs/security.md`, edited clause by clause so the gaps that are still true stay:
    - ASI08 row: "Size budget" is dropped from the controls; tier 2 for contracts and CI before
      merge stay.
    - The `tests/`-folder bullet keeps its gap for `tests-with-code` and drops "size budget" and
      "both gates".
    - The exemptions bullet lists only `managed_paths` and `test_globs`.
    - The grandfathered bullet keeps the review-artifact skip and drops "size" and "no size cap".
    - New known gap: no gate limits PR size. `supabase-migration` has no branch protection, and
      human PR review there leaves no trace on GitHub, so an arbitrarily large PR can merge into
      it and reach `main` in the cutover PR. The control is the owner's slice planning and the
      cutover whole-branch audit.
    - The "real critical tagged `[minor]`" gap is updated: `[minor]` is no longer a valid panel
      severity, but the gate still accepts it.
- **Panel reports only critical and major findings.** `.claude/skills/adversarial-panel/SKILL.md`
  drops the `minor` severity and tells reviewers not to report anything below `major`. The scope
  reviewer's "inside the size budget" question is removed. The `consistency-read` skill, which
  appends to `panel.md`, changes its example finding from `[minor]` to `[major]`. `.agents/` is
  regenerated with `scripts/sync-skills.sh`.
- **ADR 0024** records both retirements with the counts above. It supersedes ADR 0007.

## Decisions (owner, 2026-10-02)

- Remove the size budget entirely, rather than raising it or making it warn-only.
- Panel minors: change the skill only. The `panel` gate keeps accepting `[minor]` tags, so
  archived panels still parse and nothing new is enforced in code.
- Land on `supabase-migration`, so the remaining migration slices get the change now. It reaches
  `main` at cutover, with no freeze exception.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. No spec covers the lifecycle (the `sdlc-process` spec was retired by ADR 0018), so this is
`skip_specs`.

## Non-goals

- Branch protection or required checks on `supabase-migration`, and the human PR-review gap.
  Both are separate decisions.
- Changing the `panel` gate's parsing, or rejecting `[minor]` in code.
- Changing tiering or `high_risk_paths`.
- Rewriting history: archived panels, archived tasks and ADR 0021's past `size-override` notes
  stay as they are.
- `.claude/settings.json` and `.claude/hooks/` (human-only).
- Deleting the GitHub `size-override` label. That's the owner's action after merge.
- Pushing the change upstream to `agent-lifecycle-template`.

## Impact

- About 14 files, around 150 lines (mostly deleted code and docs). No product code, spec or
  contract change.
- PRs no longer have a size limit. Reviewability depends on the owner's judgment when splitting
  slices, and on PR review.
- Future `panel.md` files are shorter. Any concern below `major` goes unrecorded.
- The vendored checker drifts further from `agent-lifecycle-template`, so a future refresh from
  the template must keep the `size` check out.
