# auto-event-generation — delta (topic-generate-paged-transcript)

## MODIFIED Requirements

### Requirement: Generation-density transcript rendering
For a generation-density turn — an event-generation run or a topic-generation one-shot
(the latter's use governed by `topic-generation`'s "One-shot transcript delivery is
paged, complete, and snapshot-stable") — `get_transcript_words` SHALL render the
transcript with
timecode anchors at a bounded interval — a new anchored line at least at every speaker
change AND whenever the current line reaches a bounded word count (small enough that
an utterance can be placed to within a few seconds) — rather than the chat rendering's
one-anchor-per-speaker-turn density (which collapses a single-speaker session to one
timestamp and makes per-utterance placement impossible). Words without session-time
anchors render without invented timestamps. The rendering SHALL remain bounded: pages
SHALL be packed on line boundaries to a hard rendered-size cap that sits under the
CLI's stable always-accept threshold for tool output (a word-count cap alone is not a
size bound — rendered bytes per word are unbounded under diarization churn, since each
anchored line carries a fixed-size prefix), with the existing word-count cap retained
as a secondary bound and a single over-cap line split hard at the cap rather than
emitted oversized. The bound SHALL be validated with an ADVERSARIAL fixture (maximal
line count per word, e.g. a speaker change on every word), not merely a realistic one,
and a transcript exceeding one page SHALL be delivered in deterministic sequential
segments the model can page through (never silently truncated). Transcript content
SHALL NOT be able to render a line matching the continuation-marker shape (body lines
are neutralized) — the marker is trustworthy framing, not reproducible data. Chat
turns keep the existing (unpaged) rendering unchanged.

#### Scenario: Single-speaker transcript is still anchored
- **WHEN** a generation turn reads a 40-minute single-speaker transcript
- **THEN** the rendering carries periodic timecode anchors throughout (bounded words
  per anchored line), not one anchor for the whole transcript

#### Scenario: Oversized transcript is paged, not silently cut
- **WHEN** the transcript rendering exceeds one page's rendered-size cap
- **THEN** the tool delivers deterministic sequential segments with an explicit
  continuation marker, and the model can retrieve every segment

#### Scenario: A crosstalk-heavy transcript cannot exceed the page bound
- **WHEN** a page is rendered from a transcript whose speaker changes on every word
  (maximal anchored-line density)
- **THEN** the rendered page still fits under the hard rendered-size cap — packing is
  bounded by rendered size, not by word count alone

#### Scenario: Transcript content cannot forge the continuation marker
- **WHEN** a transcript word's text contains a byte-exact copy of the continuation
  marker line
- **THEN** the rendered body neutralizes it so no body line matches the marker shape,
  and the only marker in the page is the tool's own trailing one
