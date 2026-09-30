# 0003: tasks.md is the only plan

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 1; check `tasks`

## Context

infisical kept a plan.md beside OpenSpec's tasks.md. Two plans drift, and the agent follows
whichever it read last.

## Decision

tasks.md is the plan of record. No other plan file. CI fails a PR with unticked tasks.

## Evidence

autologger-2 used tasks.md alone across 47 archived changes. infisical's separate plan.md has no
track record yet (one change in flight). No drift incident is recorded; add one here if it
happens, or retire this rule if a second plan file proves harmless.

## Consequences

Plans that need narrative go in design.md, which describes decisions, not steps.
