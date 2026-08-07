# sdlc-process — delta for cursor-sdlc-adapters

## MODIFIED Requirements

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
