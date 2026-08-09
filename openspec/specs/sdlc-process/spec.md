# sdlc-process

## Purpose

A minimal marker capability recording the gate ruling (2026-07-14, change
`sdlc-retro-improvements`) on where the repo's SDLC rules live: the three operational
encodings — `CLAUDE.md` "How we work (SDLC)", `.claude/skills/openspec-apply-change/SKILL.md`,
and `openspec/config.yaml` — are the normative process record. A proposed nine-requirement
process rulebook was cut at that gate as a drift generator (a fourth sync home guarded by
the same unenforced-rule class that had just demonstrably lapsed); this capability
deliberately does not restate the rules the encodings carry. Its purpose is to make the
ruling durable: no parallel rulebook re-grows, and process-rule changes route through the
full review pipeline. A 2026-07-27 evaluation (change `sdlc-review-mandate-gaps`) clarified
the ruling's scope — it forbids duplication *alongside* the encodings and never evaluated
replacing them — and separately evaluated and declined a replacement architecture, recording
disjunctive reversal conditions (that change's design.md D6, in the changes archive).

## Requirements

### Requirement: The operational encodings are the normative SDLC record
The repo's SDLC rules SHALL live in exactly three operational encodings — `CLAUDE.md`
("How we work (SDLC)" and its subsections), `.claude/skills/openspec-apply-change/SKILL.md`,
and `openspec/config.yaml` `context`/`rules` — and those encodings are the normative record.
No parallel process rulebook — normative or a "convenience" restatement — SHALL duplicate
their content alongside them (gate ruling 2026-07-14: a duplicate normative home was cut as
a drift generator; that ruling's scope is duplication *alongside* the encodings — replacing
them was not evaluated by that gate). **Pointer adapters are permitted and are not a
rulebook, but only under governance**: an artifact whose content is limited to routing
(naming a normative encoding and directing the agent to read and follow it, with bounded
stop-conditions — each naming a state plus where to read, never characterizing how a
process step runs) MAY exist for an agent surface that cannot load the encodings
directly, and only under a governing capability spec that imposes content-free
constraints and CI drift-guard coverage on that surface (capability
`cursor-agent-adapters` governs the Cursor set). Introducing a new adapter surface is
design-bearing (panel + gate), never a "small, obvious fix". An adapter that restates
rule or procedure content, or an adapter file with no governing capability, falls under
the duplicate-rulebook prohibition. A proposal to
*replace* the encodings with a single normative source that derives the operational
surfaces is design-bearing, not pre-foreclosed; it is judged against the recorded
2026-07-27 evaluation that declined it and that evaluation's recorded reversal conditions
(change `sdlc-review-mandate-gaps`, design.md D6, in the changes archive). A change that
alters a process rule in any encoding is design-bearing: it SHALL go through the
adversarial panel + human gate pipeline, not land as a "small, obvious fix".

#### Scenario: Process-rule changes are design-bearing
- **WHEN** a change alters the review/gate pipeline, apply-time execution rules, or
  verification discipline encoded in CLAUDE.md, the apply skill, or config.yaml
- **THEN** the change carries OpenSpec artifacts reviewed by an adversarial panel and gated
  by the owner before implementation

#### Scenario: No duplicate rulebook re-grows
- **WHEN** a future change proposes a standalone process document — normative or a
  "convenience" digest — restating rules the encodings already carry, alongside them
- **THEN** the proposal is rejected or reworked to amend the encodings directly, keeping a
  single normative home per rule

#### Scenario: Pointer adapters are distinguished from rulebooks
- **WHEN** a future change proposes an agent-surface artifact (e.g. under `.cursor/` or an
  `AGENTS.md`) whose content is limited to routing to the normative encodings
- **THEN** it is evaluated through the full design-bearing pipeline against a governing
  capability that imposes content-free constraints and guard coverage — created by that
  change if none exists — and an artifact that restates rule or procedure content, or
  that has no governing capability, is rejected or reworked as a duplicate rulebook

#### Scenario: Replacement proposals are evaluated, not auto-rejected
- **WHEN** a future change proposes replacing the three encodings with a single normative
  source from which the operational surfaces are derived
- **THEN** the proposal runs the full design-bearing pipeline on its merits, judged against
  the recorded 2026-07-27 decline and its recorded reversal conditions rather than being
  rejected under the duplicate-rulebook scenario

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
