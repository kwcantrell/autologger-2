# 0010: The agent guide is short; reasons live in ADRs

- Date: 2026-09-29
- Status: Accepted
- Rule: Non-negotiable 10; check `guide-size`

## Context

autologger-2's CLAUDE.md grew to about 3,800 words with dated rationale inline, plus a
510-line skill, synced by hand across three files.

## Decision

AGENTS.md stays under 150 lines and holds only what the agent can't infer from the code.
CLAUDE.md imports it and adds Claude Code specifics. Each rule's reason is an ADR here.

## Evidence

- Anthropic: "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!";
  target under 200 lines ([best practices](https://code.claude.com/docs/en/best-practices)).
- OpenAI: "A short, accurate AGENTS.md is more useful than a long file full of vague rules"
  ([Codex best practices](https://developers.openai.com/codex/learn/best-practices)).

## Consequences

Some context an agent wants is one hop away in docs/. That's the point.
