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
full review pipeline.

## Requirements

### Requirement: The operational encodings are the normative SDLC record
The repo's SDLC rules SHALL live in exactly three operational encodings — `CLAUDE.md`
("How we work (SDLC)" and its subsections), `.claude/skills/openspec-apply-change/SKILL.md`,
and `openspec/config.yaml` `context`/`rules` — and those encodings are the normative record.
No parallel process rulebook SHALL duplicate their content (gate ruling 2026-07-14: a
duplicate normative home was cut from this change as a drift generator). A change that
alters a process rule in any encoding is design-bearing: it SHALL go through the adversarial
panel + human gate pipeline, not land as a "small, obvious fix".

#### Scenario: Process-rule changes are design-bearing
- **WHEN** a change alters the review/gate pipeline, apply-time execution rules, or
  verification discipline encoded in CLAUDE.md, the apply skill, or config.yaml
- **THEN** the change carries OpenSpec artifacts reviewed by an adversarial panel and gated
  by the owner before implementation

#### Scenario: No duplicate rulebook re-grows
- **WHEN** a future change proposes a standalone normative process document restating rules
  the encodings already carry
- **THEN** the proposal is rejected or reworked to amend the encodings directly, keeping a
  single normative home per rule
