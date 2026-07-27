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
them was not evaluated by that gate). A proposal to *replace* the encodings with a single
normative source that derives the operational surfaces is design-bearing, not
pre-foreclosed; it is judged against the recorded 2026-07-27 evaluation that declined it
and that evaluation's recorded reversal conditions (change `sdlc-review-mandate-gaps`,
design.md D6, in the changes archive). A change that alters a process rule in any encoding
is design-bearing: it SHALL go through the adversarial panel + human gate pipeline, not
land as a "small, obvious fix".

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

#### Scenario: Replacement proposals are evaluated, not auto-rejected
- **WHEN** a future change proposes replacing the three encodings with a single normative
  source from which the operational surfaces are derived
- **THEN** the proposal runs the full design-bearing pipeline on its merits, judged against
  the recorded 2026-07-27 decline and its recorded reversal conditions rather than being
  rejected under the duplicate-rulebook scenario
