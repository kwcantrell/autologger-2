---
name: adversarial-panel
description: Run a tier-aware adversarial review of an OpenSpec change's proposal, design and specs before the human approval gate, and record findings in panel.md. Use after the change artifacts are drafted and before asking for approval; re-run on the delta when scope changes.
---

# Adversarial panel

The panel advises; the human decides. Run it before asking for approval.

## Who reviews

| Tier | Reviewers |
| --- | --- |
| 0 | None |
| 1 | One: the **assumption tester** |
| 2 | Three: **assumption tester**, **failure and abuse**, **scope and simplicity** |

Run each reviewer as a separate subagent with fresh context, given only the change directory
and the relevant code. Reviewers do not see each other's findings. The author does not review.

- **Assumption tester.** Lists every assumption in the design, runs a command that tests each one
  (read the code, run a query, call the API, run a test), and pastes the command and its output.
  An assumption with no evidence is a finding.
- **Failure and abuse.** How does this break under bad input, partial failure, concurrency,
  retries, a hostile user, or a prompt injection in data the agent reads? What can't be undone?
- **Scope and simplicity.** What can be cut? Does anything conflict with existing specs or
  frozen contracts? Is the change inside the size budget, or should it split?

## Record: panel.md

Write `openspec/changes/<id>/panel.md`. Each finding is a checklist item with a severity tag:

```markdown
# Panel: <change id>
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: YYYY-MM-DD

- [ ] [critical] Export drops rows with null region. Evidence: `psql -c "select count(*) ..."` -> 412
- [x] [major] No retry bound on the upload call. Resolved: capped at 3 in design.md
- [x] [minor] Rename `exp2` to `export_v2`. Declined by human: churn outweighs gain
```

Severities: `critical` (wrong or unsafe if shipped), `major` (should fix before approval),
`minor` (optional).

CI parses this file, so keep to the format:

- Each finding is a top-level `- [ ]` or `- [x]` line, and its first word is the tag, in lowercase
  and brackets. Put details on the same line; indented sub-bullets are not findings.
- A ticked `[critical]` or `[major]` says `Resolved: ...` or `Declined by human: ...`.
- If reviewers found nothing, write `No findings.` on its own line. Prose findings with no
  checklist items fail CI.

## Rules

- A critical finding is fixed, or the human explicitly declines it. The agent never ticks a
  critical finding as declined on its own. CI fails while any `- [ ] [critical]` remains.
- Tick a finding only with how it was resolved, on the same item.
- If the approved scope later changes, re-run the panel on the delta only and append a dated
  `## Re-panel` section.
