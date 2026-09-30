---
name: risk-tier
description: Classify a proposed change as tier 0, 1 or 2 so the right amount of process runs. Use at the start of every change, before writing proposal.md, and again if scope changes.
---

# Risk tier

The tier decides which lifecycle phases run (see AGENTS.md). Pick the **highest** tier any
rule below triggers. When unsure between two tiers, pick the higher one and say why.

## Tier 2: high risk

Any of these makes the change tier 2:

- Touches a path in `lifecycle.high_risk_paths` in `openspec/config.yaml` (CI enforces this).
- Changes a public API, wire format, schema, CLI flag or any other contract a caller relies on.
  This counts even when you believe there is no caller, and even when you are changing the client too.
- Authentication, authorization, sessions, secrets, crypto or PII handling.
- Data migrations, deletes, or any operation that can't be undone.
- Concurrency, locking, retries or ordering guarantees.
- The lifecycle itself: AGENTS.md, CLAUDE.md, .claude/, .github/, scripts/, openspec/config.yaml.
- Anything security-sensitive, production-critical or ambiguous. Those stay human-led: the agent
  drafts and tests; a human owns the design decisions.

## Tier 1: standard

A feature or fix that stays inside existing contracts and triggers nothing above.

## Tier 0: trivial

No behavior change: typos, comments, docs, formatting, a config value with no behavior effect.
Rule of thumb: you can describe the whole diff in one sentence and no test outcome changes.
Tier 0 needs no OpenSpec change. It still runs the checks.

## Output

Write the result as the first line after the title of `proposal.md`, then one line of reasons:

```
Tier: 2
Tier reason: changes the /v1/export response shape (contract) and adds a migration.
```

Tell the human the tier and the reason in one sentence. A human may raise a tier, never lower it
below what the path rules force.
