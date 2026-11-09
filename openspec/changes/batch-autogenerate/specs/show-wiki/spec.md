# Spec Delta

## ADDED Requirements

### Requirement: A batch job accepts suggestions as its initiator
A batch autogenerate job in `accept` mode (batch-autogenerate) SHALL accept the suggestions its
own wiki run stored through the same accept transaction and the same rules as a person's accept
("Accepting a suggestion is a compare-and-set edit"), bound to the job's initiator under show
access and the suggestions' row-level security, with these differences only:
- the expected revision is the suggestion's base revision, so a suggestion whose page changed
  after the run is never accepted by a job;
- no title, alias or body is overridden;
- the revision's author is the initiator, and its note is `accepted suggestion <id> (batch <job
  id>)` for an existing page or `created from suggestion <id> (batch <job id>)` for a new page;
- the suggestion's `resolved_by` is the initiator.

A refusal by any rule SHALL leave the suggestion `pending` and the page unchanged, exactly as for a
person. A job SHALL NOT accept a suggestion another run stored, and SHALL NOT dismiss any
suggestion. Revisions written by a job SHALL appear in the page history like any other and can be
reverted the same way.

#### Scenario: A batch accept is attributed and marked
- **WHEN** a job started by Ana Diaz accepts a suggestion for a page at its base revision 2
- **THEN** the page is at revision 3, the revision's `author_name` is `Ana Diaz`, its note is
  `accepted suggestion <id> (batch <job id>)`, and the suggestion is `accepted` with
  `resolved_by_name` `Ana Diaz`

#### Scenario: A clash is left for a person
- **WHEN** a job's suggestion proposes a new page whose title is already used in the show
- **THEN** no page is created and the suggestion stays `pending` in the Suggestions inbox
