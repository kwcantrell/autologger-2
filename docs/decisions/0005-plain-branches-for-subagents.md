# 0005: Subagents implement on plain branches, not worktrees

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 5

## Context

In autologger-2, subagents implementing in git worktrees committed to the wrong branch, and
commits leaked to main. infisical combined worktrees with subagents and has not yet run a change.

## Decision

Implementation subagents work on the current branch of the main checkout. One change in flight
per checkout. Humans may still use worktrees for separate, parallel sessions they drive.

## Evidence

autologger-2 incident, recorded in its CLAUDE.md. This rule is local experience, not industry
guidance: vendor docs describe worktrees for running parallel sessions.

## Consequences

Parallel implementation of one change is serial. Revisit if the agent tooling starts
reliably scoping subagents to a worktree's branch.
