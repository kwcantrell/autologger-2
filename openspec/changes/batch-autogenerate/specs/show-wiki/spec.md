# Spec Delta

## ADDED Requirements

### Requirement: A batch job accepts suggestions as its initiator
A batch autogenerate job in `accept` mode (batch-autogenerate) SHALL accept only the **safe**
suggestions its own wiki run stored, through the same accept transaction and the same rules as a
person's accept ("Accepting a suggestion is a compare-and-set edit"), bound to the job's initiator
under show access and the suggestions' row-level security.

A suggestion is **safe** when either:
- it proposes a **new page**; or
- it is an **additions-only rewrite** of an existing page, judged against the page's revision equal
  to the suggestion's base revision:
  - the title is unchanged (equal after trimming leading and trailing spaces);
  - every existing alias is still present, compared exactly; new aliases MAY be added;
  - the body, split into lines after turning each `CRLF` into `LF`, contains every line of the
    existing body, byte for byte and in the same order (the existing lines are a subsequence of
    the new lines); new lines MAY be inserted anywhere. A changed line, even one that only grows,
    counts as a removal.

Every other suggestion SHALL stay `pending` for a person. For a safe suggestion the differences
from a person's accept are only:
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

#### Scenario: Additions-only is judged line by line
- **WHEN** a page's body is `A\nB\nC` and one suggestion's body is `A\nB\nnew\nC`, another's is
  `A\nB more\nC`, and a third keeps the body but drops an alias
- **THEN** the job accepts the first and leaves the second and third `pending`

#### Scenario: A clash is left for a person
- **WHEN** a job's suggestion proposes a new page whose title is already used in the show
- **THEN** no page is created and the suggestion stays `pending` in the Suggestions inbox
