# 0001: Three risk tiers decide how much process a change gets

- Date: 2026-09-29
- Status: Accepted
- Rule: AGENTS.md "Risk tiers"; check `risk-floor`

## Context

autologger-2 ran the full four-reviewer panel on every design change, whatever its risk.
infisical had no tiering at all. Full process on a typo trains people to skip process.

## Decision

Tier 0 (no behavior change) skips proposal, panel and approval. Tier 1 (inside existing
contracts) runs a one-reviewer panel. Tier 2 (contracts, auth, secrets, migrations,
concurrency, destructive ops, the process itself) runs the full panel and a consistency read.
Paths in `lifecycle.high_risk_paths` force tier 2 in CI. Auth, secrets and PII work stays
human-led.

## Evidence

- GitHub advises giving agents well-scoped tasks and keeping security-sensitive,
  production-critical, ambiguous and broad cross-repo work with humans
  ([GitHub Docs](https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/best-practices-for-using-copilot-to-work-on-tasks)).
- Anthropic: skip planning "if you could describe the diff in one sentence"
  ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)).
- autologger-2's risk-tiered code review (contract, auth, concurrency, destructive data)
  worked across 47 archived changes.

## Consequences

Tier is self-declared, so the path floor and PR review are the backstop. Drop the path floor
if it forces tier 2 on changes reviewers consistently call trivial.
