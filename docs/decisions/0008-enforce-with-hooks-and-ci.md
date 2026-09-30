# 0008: Rules that must hold are hooks or CI checks, not prose

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 8; `lifecycle.yml`, `.claude/settings.json`, main ruleset

## Context

Neither autologger-2 nor infisical had CI or hooks. Every gate relied on the agent choosing
to run it.

## Decision

Every gate an agent could skip has a machine check, in `scripts/check-change.sh`, run by
pre-commit, the Stop hook and CI. A main-branch ruleset makes the CI jobs required.

## Evidence

- DORA 2025: AI acts as an "amplifier". Without strong automated testing, mature version
  control and fast feedback, more change volume means more instability
  ([DORA 2025](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)).
- Anthropic: hooks "guarantee the action happens", unlike instructions
  ([best practices](https://code.claude.com/docs/en/best-practices)).
- GitHub rulesets: required status checks ensure CI passes before changes land
  ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)).

## Consequences

The checker is code to maintain. It stays one file with no dependencies beyond PyYAML.
