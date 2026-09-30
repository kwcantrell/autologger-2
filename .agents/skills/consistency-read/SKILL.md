---
name: consistency-read
description: Light check that post-approval edits to a tier 2 change's artifacts didn't introduce contradictions, and log the result. Use whenever proposal.md, design.md, tasks.md or spec deltas change after the human approved them, and before archiving a tier 2 change.
---

# Consistency read

A full re-panel after every small edit costs more than it catches. This is the cheap check
that runs instead, unless the edit changes scope (then re-run the adversarial panel on the delta
and get re-approval).

## Steps

1. Diff the change's artifacts against the approval commit:
   `git log --format=%H -S'Approved-by:' -- openspec/changes/<id>/proposal.md | tail -1`, then
   `git diff <that commit> -- openspec/changes/<id>/`.
2. Decide: does the edit change scope, a contract, or an accepted risk? If yes, stop. Tell the
   human that it needs a re-panel and re-approval.
3. Otherwise, read proposal, design, tasks and spec deltas together and check that:
   - every requirement in the spec deltas has a task and a test,
   - no task does something the proposal's non-goals exclude,
   - design decisions and specs don't contradict each other.
4. Append the result to `panel.md`:

```markdown
## Consistency read YYYY-MM-DD
Edits since approval: design.md (retry cap 3 -> 5), tasks.md (+1 task)
Scope change: no
- [x] [minor] tasks 4.2 had no test named. Resolved: added `test_retry_cap`.
```

Any contradiction you can't resolve without changing scope is a `[critical]` finding.
