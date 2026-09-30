# 0009: Treat input as untrusted; give agents least privilege

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 9; `.claude/settings.json`; docs/security.md

## Context

Coding agents read issues, web pages and dependency code that anyone can write, and they run
commands. Neither source repo addressed this.

## Decision

The agent runs sandboxed, with network tools denied and secrets unreadable. It can't edit its
own settings, hooks or generated skills, can't write approval lines, and can't push to main
(ruleset). Content the agent reads is data, never instructions.

## Evidence

- OWASP Top 10 for Agentic Applications 2026 (ASI01 Agent Goal Hijack, ASI02 Tool Misuse,
  ASI03 Identity & Privilege Abuse, and others)
  ([OWASP](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)).
- NIST SSDF PO.5.1 (isolate development environments) and PS.1.1 (least privilege on code)
  ([SP 800-218A](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218A.pdf)).
- Claude Code permissions, sandboxing and prompt-injection safeguards
  ([security](https://code.claude.com/docs/en/security)). GitHub's Copilot agent gets the same
  shape by default: ephemeral environment, own branch, human approval before workflows run
  ([risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)).

## Consequences

The agent asks more often. Widen the allow list per repo when a prompt repeats with no value.
