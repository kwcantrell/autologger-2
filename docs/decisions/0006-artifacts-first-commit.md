# 0006: The first commit on a branch is the approved artifacts

- Date: 2026-09-29
- Status: Proposed
- Rule: Non-negotiable 6; check `artifacts-first`

## Context

If code and plan land together, nobody can tell whether the plan was written after the fact.

## Decision

For tier 1-2, the branch's first commit holds only `openspec/changes/<id>/`. CI checks it.

## Evidence

None yet beyond the design argument above. It stays Proposed until a change shows the check
catching a plan written after the code, or the quarterly review retires it.

## Consequences

Rebasing that squashes the first commit into code fails the check; keep it separate.
