# 0011: Retire rules that don't pay

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 11

## Context

Process only grows unless something removes it. autologger-2 measured its process and dropped
rules that caught nothing.

## Decision

Each quarter a human reviews, per gate: how often it failed, how often it was overridden, and
whether a failure caught a real defect. A gate that caught nothing in two quarters is downgraded
(CI to warning, or tier 2 only) or retired, with the ADR marked Retired. The same review
rechecks the vendor docs cited in these ADRs, since they change fast.

## Evidence

autologger-2 practice.

## Consequences

Needs CI history. GitHub keeps workflow run logs for 90 days by default, so export failure
counts before they expire.
