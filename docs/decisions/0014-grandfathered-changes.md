# 0014: Grandfather changes that predate the lifecycle, within bounds

- Date: 2026-09-29
- Status: Accepted
- Rule: `lifecycle.grandfathered_changes`; check `change`

## Context

infisical adopted the lifecycle with `self-host-infisical` already in flight: no `Tier:` line, a
prose panel, and a 2,000-line branch. Under the gates it could never finish. A first design
grandfathered in-flight changes automatically with no bounds. Its panel found that the waiver
never expired, could be inherited by a reused id, could be granted by the install PR itself,
and didn't even apply, because the Tier check failed first.

## Decision

A human lists ids in `grandfathered_changes`. A change is grandfathered only when:
- its id is listed in the merge-base's config (never the PR's own), and
- `openspec/changes/<id>/` exists on the merge-base.

A grandfathered change WARNs on `change` and skips the tier, approval, panel, tasks, evidence,
artifacts-first and size gates. risk-floor warns instead of skipping. In CI, the PR must say
`Grandfathered: <id>`. A tier 0 change directory fails. That closes the route of merging a bare
directory without approval, then listing it.

## Evidence

- The infisical dry-run (2026-09-29): the in-flight branch failed `change` (no Tier) and
  `size` (1,999 lines).
- The grandfather-changes panel (17 findings) and the withdrawn safe-adoption panel.

## Consequences

The entry dies when the change is archived. Retire this mechanism once no adopting repo has
pre-lifecycle changes left, or if the quarterly review finds it used for new work.
