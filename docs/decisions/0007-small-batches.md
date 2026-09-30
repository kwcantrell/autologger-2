# 0007: Changes over 400 changed lines are split

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 7; check `size`

## Context

autologger-2 ran large multi-phase branches. Agents make large diffs cheap to write and
expensive to review.

## Decision

A PR may change at most `lifecycle.size_budget` lines (default 400), not counting tests,
lockfiles, docs and `openspec/`. The `size-override` label, with a reason in the PR, overrides it.

Amended 2026-09-29 (size-counts-untracked): locally, untracked files count, because otherwise a
419-line new file stayed invisible until it was committed (151 locally, 577 in CI). The hook stage
(Stop hook, pre-push) only warns, since it can't see a PR's `size-override` label. The PR stage
enforces.

## Evidence

DORA 2025 finds AI adoption still correlates with lower delivery stability, and names working
in small batches among the capabilities that decide whether AI helps
([DORA 2025](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)).
The 400 figure is a starting point, not a researched threshold.

## Consequences

Tune the number from the quarterly review: how often was it overridden, and did overridden PRs
cause more incidents?

Known loophole, predating the amendment: files named like tests (`**/test_*`) are excluded from the
count wherever they are. Review catches source hidden that way.
