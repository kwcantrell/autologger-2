# 0002: A human approves every tier 1-2 change before code

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 2; checks `approval`, `panel`; PreToolUse hook `guard-approval.sh`

## Context

An adversarial panel catches design errors, but an agent that can dismiss its own critical
findings makes the panel advisory in name only.

## Decision

The human writes `Approved-by:` in proposal.md. Agents are blocked from writing that line by a
hook. Critical panel findings are fixed or declined by the human, never by the agent. CODEOWNERS
makes a human review every change under `openspec/changes/`.

## Evidence

- Thoughtworks Technology Radar Vol. 34 warns that "as coding agents become more powerful,
  humans are dangerously tempted to step out of the loop"
  ([Thoughtworks](https://www.thoughtworks.com/about-us/news/2026/combat-ai-cognitive-debt-radar-v34)).
- infisical's rule that critical findings can't be rejected without the human.

## Consequences

The approval line is text: an agent working outside Claude Code, or a human committing as the
agent, could write it. The real guarantee is code owner review on the PR. Replace the text line
with a signed commit or PR review check if that proves too weak.
