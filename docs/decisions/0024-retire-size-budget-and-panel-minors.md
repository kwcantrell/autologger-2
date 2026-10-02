# 0024: Retire the size budget; the panel reports only critical and major findings

- Date: 2026-10-02
- Status: Accepted (supersedes ADR 0007)
- Rule: Non-negotiable 7 is retired (no `size` check); the `adversarial-panel` skill has two severities, `critical` and `major`

## Context

ADR 0007 capped a PR at 400 counted lines, with a `size-override` label as the escape hatch. It
asked for the number to be tuned from how often it was overridden. The adversarial panel had
three severities: `critical`, `major` and `minor` (optional).

Both were measured four days after the lifecycle was adopted (2026-09-29), during the Supabase
migration (ADR 0021). Rule 11 says to drop rules that don't pay.

## Decision

- **The size gate is removed**, not raised or downgraded to a warning (owner):
  - the `size` check and its helpers are deleted from `scripts/lib/check_change.py`;
  - `size_budget`, `size_exclude` and the `size-override` label mapping are removed from
    `openspec/config.yaml`.
- **AGENTS.md rule 7 stays as a retired stub**, so rules 8-11 keep the numbers that ADRs and
  `.pre-commit-config.yaml` cite.
- **Panels report only critical and major findings.** The `adversarial-panel` and
  `consistency-read` skills drop `minor`. The `panel` gate still parses `[minor]`, so archived
  panels validate unchanged. The owner chose a skill-only change, with no code check.

## Evidence

- **Size overrides:** 9 of the 24 PRs merged since adoption (#7 to #35) carried `size-override`
  (1,410, 1,022, 904, 777, 689 and 584 counted lines among them). PR #35's only CI failure was the
  size gate, and the label cleared it. Each time, the owner had chosen to keep an atomic change in
  one PR.
- **Panel volume:** the 22 tier 2 panels in that window logged 23 critical, 262 major and 459
  minor findings. The criticals and majors changed designs (Studio CSRF to superuser SQL, the app
  on the shared `db` network, the percent-encoded login bypass). The minors were optional by
  definition but still had to be triaged before every approval.
- **The retire-size-budget-and-minors panel:** 3 reviewers; 0 critical, 6 major. Five majors were
  resolved in the artifacts. The sixth (`[minor]` still passes the gate) is recorded in
  `docs/security.md`.

## Consequences

- **No PR size signal.** Reviewability depends on the owner's slice planning and on PR review.
  `docs/security.md` records that `supabase-migration` has no branch protection and that human
  review there leaves no trace on GitHub.
- **Low-severity concerns go unrecorded.** A real problem a reviewer under-rates is now dropped
  rather than logged as minor. Anything that should be fixed before approval is major.
- **`[minor]` is not enforced away.** A stray `[minor]` in a new panel passes CI. If minors creep
  back, reject them in `check_panel` for panels not yet on the base branch.
- **Template drift.** The vendored checker no longer matches `agent-lifecycle-template`. When
  refreshing from the template, keep the `size` check out.
