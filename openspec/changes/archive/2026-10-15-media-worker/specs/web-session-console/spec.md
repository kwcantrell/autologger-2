## MODIFIED Requirements

### Requirement: Recording intervals lay out multi-chunk segments contiguously

Timeline clip layout SHALL treat segments sharing a `recording_ordinal` as a **chunk
group** (segments with a null `recording_ordinal` are each their own group, preserving
legacy behavior exactly): interval matching (greedy wall-clock matching and the legacy
ordinal path alike) SHALL consume one recording interval per *group*, never scattering a
group's members across other intervals or letting a group claim another recording's
interval. When multiple intervals share an ordinal (same-N re-run cycles, which interval
building explicitly supports), same-N segments split into per-cycle groups by wall-clock
adjacency (each segment belongs to the cycle whose start event most nearly precedes its
`started_at_utc`), FIFO per ordinal. A group whose recording has no paired interval
(e.g. a crash left a `Recording N Started` with no `Stopped`) SHALL keep the pre-existing
unmatched-segment behavior and never consume another recording's interval.

Within a matched interval, each member's position SHALL be **event-wall-time derived**:
`interval start + max(0, (started_at_utc(member) − wall_time_utc(interval's start
event)) / 1000)` seconds when both timestamps are parseable — so a chunk's placement
never depends on which sibling chunks survived. Fallbacks preserving pre-change behavior
exactly: when the start event's wall time is unparseable, the group's base
(lowest-ordinal member — the single-flight upload pipeline keeps segment ordinals in
capture order) sits at the interval start and follow-ons derive from the base's
`started_at_utc`; members lacking a parseable `started_at_utc` keep the pre-existing
fallback behavior (a singleton group's member sits at the interval start as today;
otherwise placeholder / end-of-timeline chaining). Each chunk's clip SHALL extend to the
next chunk's position; the last chunk extends to **at least** the interval end, and
beyond it by its own probed duration when the audio genuinely runs longer than the
interval span (e.g. a paused-transport recording, or a last chunk whose captured audio
outlasts its `Recording N Stopped` bracket) — preserving the pre-change over-run
behavior for existing sessions. So the interval stays covered from the first surviving
chunk onward by construction — including when a chunk's duration probe fails — and the
existing jump/seek coverage requirements are unaffected there; any lead gap before the
first surviving chunk (mic-open latency, normally ~0–2 s, or a discarded leading chunk)
is truthfully uncovered and takes the existing no-coverage jump behavior. For every
pre-change session (one segment per recording, `started_at_utc` equal to its start
event's wall time) the derived delta is 0, and the clip width matches the pre-change
`Math.max(intervalEnd, startSec + d)` floor exactly, so layout SHALL be exactly as
before this change.

A segment's clip duration SHALL come from the server's `duration_ms` when it is present,
and from the media-element metadata probe only when it is `null`; the 1 s placeholder
applies only when both are missing. A recording the server has merged into one segment
(media-processing "A stopped recording is merged into one verified segment") SHALL lay out
as **one clip per seam**: each clip plays the merged segment's URL from its seam's
`offset_ms`, is positioned from that seam's own `started_at_utc` exactly as a chunk was, and
extends to the next seam's position (the last to the interval end or its remaining
duration), so a merged recording renders, seeks and plays exactly as its chunks did and no
drift accumulates across the rollover gaps. While a recording still has
two or more segments and any of them has `media_status: "pending"`, the interval's
waveform slot SHALL show "Finalizing recording…" in place of "Generating waveform…"; the
clip layout is the chunk layout above until the merged segment arrives through
`audio.changed`. The browser SHALL NOT decode a segment for waveform peaks while its
`media_status` is `"pending"`; it keeps decoding segments whose `media_status` is `null`
(rows that predate server-side processing) and shows "Waveform unavailable" for
`"failed"` as for a failed decode.

#### Scenario: A three-chunk recording renders inside one interval
- **WHEN** a recording interval has three segments sharing its `recording_ordinal`, each
  with sequential `started_at_utc` values
- **THEN** three clips render inside that one interval, positioned by their wall-clock
  start deltas and extending to their successor's position, leaving the interval fully
  covered, and no other interval or the timeline tail receives any of them

#### Scenario: Single-segment sessions are unchanged
- **WHEN** an existing session where every recording has exactly one segment is laid out
- **THEN** clip positions and interval matching are identical to the pre-change behavior

#### Scenario: A probe failure does not uncover the interval
- **WHEN** a middle chunk's duration probe fails
- **THEN** its clip still spans from its wall-clock position to the next chunk's
  position, and feed jumps into that span still start playback per the existing jump
  requirements

#### Scenario: A discarded first chunk does not shift the survivors
- **WHEN** a three-chunk recording's first chunk was permanently lost and discarded, so
  only chunks 2 and 3 exist as segments
- **THEN** chunks 2 and 3 render at their true wall-clock deltas from the interval's
  start event (leaving the missing lead truthfully uncovered), not shifted to the
  interval start

#### Scenario: Same-N re-run cycles keep their own intervals
- **WHEN** a session has two distinct `Recording 1` cycles with segments in each
- **THEN** each cycle's segments group to their own interval by wall-clock adjacency, and
  neither cycle's interval is starved into a placeholder by the other's segments

#### Scenario: A crashed recording's chunks never steal another interval
- **WHEN** a session has one completed recording (paired events) and one crashed
  recording (`Started` without `Stopped`) with two uploaded chunks
- **THEN** the completed recording's interval receives only its own segment(s), and the
  crashed recording's chunks take the pre-existing unmatched behavior

#### Scenario: Playback and seeks treat chunk clips like any other clips
- **WHEN** a feed-row jump resolves to a second covered by a follow-on chunk's clip
- **THEN** playback starts within that chunk at the correct offset, using the existing
  jump/seek requirements without modification

#### Scenario: A merged recording lays out by its seams
- **WHEN** a recording's three chunks have been merged by the server into one segment with
  three seams and `duration_ms = 1 812 345`
- **THEN** the interval shows three clips at the seams' wall-clock positions, each playing
  the merged segment from its seam's `offset_ms`, with no media-element probe and no 1 s
  placeholder, and a feed-row jump into the third clip starts playback at the same media
  position it did when the chunk was a separate segment

#### Scenario: Seam clips do not drift over a long recording
- **WHEN** a three-hour recording with eighteen seams whose rollover gaps sum to 1.1 s is laid
  out
- **THEN** the eighteenth clip starts at its seam's wall-clock position, not 1.1 s early

#### Scenario: Finalizing is shown while the merge is pending
- **WHEN** a recording has three segments and the client has just finalized it
- **THEN** the interval's waveform slot reads "Finalizing recording…" until the
  `audio.changed` message delivers the merged segment, and the clips stay laid out as
  chunks meanwhile

#### Scenario: Pending segments are not decoded in the browser
- **WHEN** a freshly uploaded chunk lists `media_status: "pending"` and no peaks
- **THEN** the browser does not fetch and decode its audio; the slot shows "Generating
  waveform…" and the server's peaks replace it on `audio.changed`
