## ADDED Requirements

### Requirement: A rule lands on the encoding the acting agent loads at the moment it applies

A process rule SHALL be placed on the encoding that is in the context of the agent performing the
work the rule governs, at the moment it performs it. Placement is judged by **reach**, not by
topical fit.

The three encodings have materially different reach, and a rule placed for topical tidiness on a
surface the acting agent never loads is unreachable at the moment it applies — which is
indistinguishable, in effect, from not having the rule:

- `CLAUDE.md` is loaded by **every** agent, including subagents, in every session.
- `.claude/skills/openspec-apply-change/SKILL.md` reaches only the orchestrator, and only during an
  apply.
- `openspec/config.yaml` reaches only the agent drafting artifacts.
- Capability specs under `openspec/specs/` are read **only when a change consults them**, and reach
  no agent by default.

A change that adds a process rule SHALL state which agent must encounter it, at which moment, and
that the chosen encoding reaches that agent then.

This requirement governs **placement only**. It does not restate, and SHALL NOT be used to restate,
the content of any rule the encodings carry — the encodings remain the normative record of what the
rules are.

#### Scenario: A rule is placed by reach rather than by topic

- **WHEN** a change proposes a process rule
- **THEN** its artifacts name the agent that must encounter the rule and the moment it applies, and
  the rule is placed on an encoding that agent loads at that moment

#### Scenario: A rule is not parked on a surface its actor never loads

- **WHEN** a proposed rule governs work performed by an agent that does not read the surface the
  rule would be placed on
- **THEN** that placement is rejected, and the rule is placed on a surface that agent does load —
  or the change records why the rule cannot be reached and what compensates

#### Scenario: The placement principle carries no rule content

- **WHEN** this requirement is cited
- **THEN** it is cited about where a rule belongs, never as the source of what a rule says
