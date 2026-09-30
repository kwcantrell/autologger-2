# 0004: Evidence, not claims, and a Stop hook that checks

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 4; checks `evidence`, `commands`; Stop hook `stop-check.sh`

## Context

Agents report success they didn't verify. A ticked box is a claim.

## Decision

Every ticked task carries `Evidence:` with the command and an excerpt of its output. A Stop
hook runs `check-change.sh --stage hook` before Claude Code may finish with uncommitted work.
After three blocked stops it lets the agent stop and tell the human, so a broken environment
can't trap it. CI still enforces the gates.

## Evidence

- Anthropic: "Give Claude a check it can run" and "If you can't verify it, don't ship it". It
  recommends a Stop hook or a separate verifier so the worker doesn't grade itself
  ([best practices](https://code.claude.com/docs/en/best-practices)). Hooks give
  "deterministic control" ([hooks guide](https://code.claude.com/docs/en/hooks-guide)).
- infisical's assumption tester had to run commands and show output.

## Consequences

Slow test suites make the Stop hook slow. Move slow suites to CI only (leave them out of
`lifecycle.commands.test`) if the hook takes more than about a minute.
