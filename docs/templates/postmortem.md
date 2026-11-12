# Postmortem: <incident title>

- Date: YYYY-MM-DD · Severity: · Duration: · Author:
- Blameless: this is about the system, including the lifecycle, not about people or agents.

## Impact

Who noticed what, for how long.

## Timeline

| Time (UTC) | Event |
| --- | --- |

## Cause

What broke, and which change introduced it (link its PR; the body is the job's `ship.md`).

## Why the lifecycle didn't catch it

Which gate should have caught it: spec approval, proof, the three reviewers, tests, CI, the PR
merge? Did it run? Was it overridden?

## Actions

- [ ] Fix (a factory job)
- [ ] Process: a new or changed rule, with an ADR citing this postmortem. Or a gate to retire.
