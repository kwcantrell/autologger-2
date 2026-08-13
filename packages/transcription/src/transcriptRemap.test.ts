// Unit tests for timeline remapping of DeepGram words onto the session's
// SMPTE timeline (design D4 / spec "Timeline remapping of word timestamps"),
// and for remapping paragraph/sentiment enrichment onto that same timeline
// per-group, before the global word sort (spec "Enrichment timeline
// remapping", design D2). Pure module — no hub/router access, no I/O.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DeepgramSentimentSegment, type DeepgramWord, extractEnrichment } from './deepgram';
import { TRANSCRIPTION_FIXTURES_DIR } from './fixturesDir';
import {
  type EnrichmentGroup,
  type GroupWords,
  recordingStartAnchors,
  remapTranscriptEnrichment,
  remapTranscriptWords,
  type SegmentAnchorInfo,
} from './transcriptRemap';

// Real captured DeepGram response (design D7: record-once, replay-always).
// 89 words / 3 paragraphs / 3 sentiment segments (word spans 0-48, 49-61,
// 62-88) — same fixture `extractEnrichment`'s own tests replay.
const enrichmentFixture = JSON.parse(
  readFileSync(join(TRANSCRIPTION_FIXTURES_DIR, 'deepgram-enrichment-response.json'), 'utf8'),
);

function word(w: string, start: number, end: number, speaker = 0): DeepgramWord {
  return { word: w, start, end, speaker };
}

// chunked-live-recording task 3.0 (design D5/D9) — the E-A per-member anchor
// formula `A + max(0, (started_at_utc(member) - wall_time_utc(E)) / 1000)`
// does not exist yet in `resolveAnchors` (task 3.2 implements it); this pins
// the CLAMP PREMISE itself as a standalone arithmetic fact, decoupled from
// the not-yet-written resolver, per the task's own "write something concrete
// now" preference over deferring entirely. Historical import rows (pre-D9)
// have a NEGATIVE raw delta (the event's stored wall time postdates the
// segment's started_at_utc — see .apply/u3-halt-report.md's measured gap),
// which this floors to 0 — the exact property design D5/D9 rely on to keep
// existing import-path placements bit-identical without a data migration.
// The block below pins the clamp as isolated arithmetic; the real resolver
// exercise (a historical-shape segment/event pair, negative delta, THROUGH
// resolveAnchors via remapTranscriptWords) lives in the "resolveAnchors
// chunk-group derivation" describe block below (task 3.2), in the
// 'historical import shape: negative delta floors to 0 through the real
// resolver' test.
describe('E-A clamp premise (design D5/D9) — negative deltas floor to 0', () => {
  function clampedDeltaSec(startedAtUtc: string, eventWallTimeUtc: string): number {
    const startedMs = Date.parse(startedAtUtc);
    const eventMs = Date.parse(eventWallTimeUtc);
    return Math.max(0, (startedMs - eventMs) / 1000);
  }

  it('a historical-shape row (event wall time LATER than segment started_at) floors to delta 0', () => {
    // Mirrors the halt report's measured YouTube/local-import ordering:
    // segment.started_at_utc captured BEFORE the blob put; the pre-D9 event
    // wall time stamped AFTER it (a later timestamp) — started - event < 0.
    const segmentStartedAtUtc = '2026-08-12T00:00:00.000Z';
    const eventWallTimeUtc = '2026-08-12T00:00:05.000Z'; // 5s later (the put gap)
    expect(clampedDeltaSec(segmentStartedAtUtc, eventWallTimeUtc)).toBe(0);
  });

  it('a positive delta (member captured after its anchor event) is NOT clamped', () => {
    const eventWallTimeUtc = '2026-08-12T00:00:00.000Z';
    const memberStartedAtUtc = '2026-08-12T00:00:03.000Z'; // 3s after the anchor
    expect(clampedDeltaSec(memberStartedAtUtc, eventWallTimeUtc)).toBe(3);
  });

  it('a zero delta (post-D9 threaded import, or any live-recorded segment) stays 0', () => {
    const sameInstant = '2026-08-12T00:00:00.000Z';
    expect(clampedDeltaSec(sameInstant, sameInstant)).toBe(0);
  });
});

// chunked-live-recording task 3.2 (design D5) — `resolveAnchors`' chunk-group
// event-wall-time derivation, exercised THROUGH `remapTranscriptWords`/
// `remapTranscriptEnrichment` (resolveAnchors itself is not exported; the
// task 3.0 clamp-premise block above pinned the isolated arithmetic, this
// block exercises the real resolver per its own TODO).
describe('resolveAnchors chunk-group derivation (design D5, task 3.2)', () => {
  // A `Recording N Started` internal event with an explicit event wall time
  // and frame-derived anchor seconds.
  function startedEvent(
    n: number,
    totalFrames: number,
    frameRate: number,
    wallTimeUtc: string,
  ) {
    return {
      category: 'internal',
      message: `Recording ${n} Started`,
      timecode_total_frames: totalFrames,
      frame_rate: frameRate,
      wall_time_utc: wallTimeUtc,
    };
  }

  it('chunked-recording placement: each chunk anchors at A + its own wall-clock delta from the event', () => {
    // Recording 2 has three chunk segments sharing recording_ordinal = 2,
    // each captured (started_at_utc) at a real gap from the Started event
    // and from each other, exactly the chunked-live-recording headline case.
    const eventWallTimeUtc = '2026-08-12T10:00:00.000Z';
    const anchors = recordingStartAnchors([startedEvent(2, 2400, 24, eventWallTimeUtc)]); // A = 100
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'c1', ordinal: 1, recordingOrdinal: 2, startedAtUtc: '2026-08-12T10:00:00.000Z' }, // delta 0
      { path: 'c2', ordinal: 2, recordingOrdinal: 2, startedAtUtc: '2026-08-12T10:10:00.000Z' }, // delta 600
      { path: 'c3', ordinal: 3, recordingOrdinal: 2, startedAtUtc: '2026-08-12T10:20:00.000Z' }, // delta 1200
    ];
    const groups: GroupWords[] = [
      {
        segments: [
          { path: 'c1', offsetSeconds: 0, durationSeconds: 5 },
          { path: 'c2', offsetSeconds: 5, durationSeconds: 5 },
          { path: 'c3', offsetSeconds: 10, durationSeconds: 5 },
        ],
        words: [word('one', 1, 1.5), word('two', 6, 6.5), word('three', 11, 11.5)],
      },
    ];

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    // c1: 100 + 1 = 101 (delta 0 + within-segment offset 1).
    expect(out.find((w) => w.word === 'one')).toMatchObject({ start_sec: 101 });
    // c2: 100 + 600 + (6 - 5) = 701 — never all at 100 (overlapping c1).
    expect(out.find((w) => w.word === 'two')).toMatchObject({ start_sec: 701 });
    // c3: 100 + 1200 + (11 - 10) = 1301.
    expect(out.find((w) => w.word === 'three')).toMatchObject({ start_sec: 1301 });
  });

  it('discarded-first-chunk survivor placement: chunks 2 and 3 keep their true deltas, not shifted early', () => {
    // Same recording as above, but chunk 1 was permanently lost — only c2
    // and c3 exist as segments. c2 (now the group's base, lowest ordinal
    // among survivors) must still place at its OWN wall-clock delta from the
    // event, not at the recording start (A) and not shifted early by c1's
    // missing duration.
    const eventWallTimeUtc = '2026-08-12T10:00:00.000Z';
    const anchors = recordingStartAnchors([startedEvent(2, 2400, 24, eventWallTimeUtc)]); // A = 100
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'c2', ordinal: 2, recordingOrdinal: 2, startedAtUtc: '2026-08-12T10:10:00.000Z' }, // delta 600
      { path: 'c3', ordinal: 3, recordingOrdinal: 2, startedAtUtc: '2026-08-12T10:20:00.000Z' }, // delta 1200
    ];
    const groups: GroupWords[] = [
      {
        segments: [
          { path: 'c2', offsetSeconds: 0, durationSeconds: 5 },
          { path: 'c3', offsetSeconds: 5, durationSeconds: 5 },
        ],
        words: [word('two', 1, 1.5), word('three', 6, 6.5)],
      },
    ];

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    // 100 + 600 + 1 = 701 — true wall-clock delta, not 100 + 1 = 101.
    expect(out.find((w) => w.word === 'two')).toMatchObject({ start_sec: 701 });
    // 100 + 1200 + 1 = 1301 — not shifted early by c1's missing ~5s duration.
    expect(out.find((w) => w.word === 'three')).toMatchObject({ start_sec: 1301 });
  });

  it('existing-single-segment identity: delta 0 places the word at exactly A', () => {
    const eventWallTimeUtc = '2026-08-12T10:00:00.000Z';
    const anchors = recordingStartAnchors([startedEvent(1, 0, 24, eventWallTimeUtc)]); // A = 0
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'seg1', ordinal: 1, recordingOrdinal: 1, startedAtUtc: eventWallTimeUtc }, // delta 0
    ];
    const groups: GroupWords[] = [
      {
        segments: [{ path: 'seg1', offsetSeconds: 0, durationSeconds: 5 }],
        words: [word('hi', 2, 2.5)],
      },
    ];

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    expect(out[0]).toMatchObject({ start_sec: 2 }); // A(0) + delta(0) + offset(2)
  });

  it('historical import shape: negative delta floors to 0 through the real resolver', () => {
    // A historical (pre-D9) import row: the segment's started_at_utc was
    // captured BEFORE the anchor event's stored wall_time_utc (the event's
    // wall time postdates the segment — see the halt report's measured
    // import-path gap, same shape as the isolated "E-A clamp premise" block
    // above), so the raw delta (started - event) is NEGATIVE. This exercises
    // that same clamp THROUGH the real resolver: the member must anchor at
    // exactly A, not before it.
    const eventWallTimeUtc = '2026-08-12T10:00:05.000Z'; // stamped 5s AFTER the segment
    const anchors = recordingStartAnchors([startedEvent(1, 2400, 24, eventWallTimeUtc)]); // A = 100
    const segmentInfo: SegmentAnchorInfo[] = [
      {
        path: 'hist1',
        ordinal: 1,
        recordingOrdinal: 1,
        startedAtUtc: '2026-08-12T10:00:00.000Z', // 5s EARLIER than the event -> delta -5, clamped to 0
      },
    ];
    const groups: GroupWords[] = [
      {
        segments: [{ path: 'hist1', offsetSeconds: 0, durationSeconds: 5 }],
        words: [word('past', 2, 2.5)],
      },
    ];

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    // A(100) + clamp(-5 -> 0) + offset(2) = 102, never 97 (unclamped).
    expect(out[0]).toMatchObject({ start_sec: 102 });
  });

  it('a follow-on chunk with a missing started_at_utc goes anchorless, never mis-paired', () => {
    const eventWallTimeUtc = '2026-08-12T10:00:00.000Z';
    const anchors = recordingStartAnchors([startedEvent(2, 2400, 24, eventWallTimeUtc)]); // A = 100
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'c1', ordinal: 1, recordingOrdinal: 2, startedAtUtc: eventWallTimeUtc },
      { path: 'c2', ordinal: 2, recordingOrdinal: 2, startedAtUtc: null }, // missing
    ];
    const groups: GroupWords[] = [
      {
        segments: [
          { path: 'c1', offsetSeconds: 0, durationSeconds: 5 },
          { path: 'c2', offsetSeconds: 5, durationSeconds: 5 },
        ],
        words: [word('base', 1, 1.5), word('orphan', 6, 6.5)],
      },
    ];

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    expect(out.find((w) => w.word === 'base')).toMatchObject({ start_sec: 101 });
    const orphan = out.find((w) => w.word === 'orphan');
    expect(orphan).toMatchObject({ session_time: '', start_sec: 0, end_sec: 0 });
  });

  it('same-N re-runs keep their anchors apart: the second cycle pairs with the nearest-preceding second anchor', () => {
    // First (fully discarded) Recording 1 cycle left its Started event
    // behind at t=0 / wall 09:00. The second cycle's Started event is at
    // t=1000 / wall 11:00, with two chunk segments captured well after it.
    const anchors = recordingStartAnchors([
      startedEvent(1, 0, 24, '2026-08-12T09:00:00.000Z'), // cycle 1: A=0
      startedEvent(1, 24000, 24, '2026-08-12T11:00:00.000Z'), // cycle 2: A=1000
    ]);
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'k1', ordinal: 1, recordingOrdinal: 1, startedAtUtc: '2026-08-12T11:00:00.000Z' }, // delta 0 from cycle 2
      { path: 'k2', ordinal: 2, recordingOrdinal: 1, startedAtUtc: '2026-08-12T11:05:00.000Z' }, // delta 300 from cycle 2
    ];
    const groups: GroupWords[] = [
      {
        segments: [
          { path: 'k1', offsetSeconds: 0, durationSeconds: 5 },
          { path: 'k2', offsetSeconds: 5, durationSeconds: 5 },
        ],
        words: [word('k1w', 1, 1.5), word('k2w', 6, 6.5)],
      },
    ];

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    // Both chunks land near t=1000 (cycle 2), never near t=0 (cycle 1).
    expect(out.find((w) => w.word === 'k1w')).toMatchObject({ start_sec: 1001 });
    expect(out.find((w) => w.word === 'k2w')).toMatchObject({ start_sec: 1301 }); // 1000 + 300 + 1
  });

  it('unresolved-base case: a group whose base cannot claim any anchor (ordinal or index) is entirely anchorless', () => {
    // Segment's recording_ordinal (9) matches no anchor, AND there are zero
    // leftover anchors for step 2 to index-pair against (the only anchor
    // present was already claimed by another, lower-ordinal group in step 1)
    // — the group exhausts the whole chain and every member is anchorless.
    const anchors = recordingStartAnchors([startedEvent(1, 0, 24, '2026-08-12T10:00:00.000Z')]);
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'claims-it', ordinal: 1, recordingOrdinal: 1, startedAtUtc: '2026-08-12T10:00:00.000Z' },
      { path: 'orphan-a', ordinal: 2, recordingOrdinal: 9, startedAtUtc: '2026-08-12T10:05:00.000Z' },
      { path: 'orphan-b', ordinal: 3, recordingOrdinal: 9, startedAtUtc: '2026-08-12T10:06:00.000Z' },
    ];
    const groups: GroupWords[] = [
      {
        segments: [
          { path: 'claims-it', offsetSeconds: 0, durationSeconds: 2 },
          { path: 'orphan-a', offsetSeconds: 2, durationSeconds: 2 },
          { path: 'orphan-b', offsetSeconds: 4, durationSeconds: 2 },
        ],
        words: [word('claimed', 0.5, 1), word('a', 2.5, 3), word('b', 4.5, 5)],
      },
    ];

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    expect(out.find((w) => w.word === 'claimed')).toMatchObject({ start_sec: 0.5 }); // A(0)+delta(0)+0.5
    expect(out.find((w) => w.word === 'a')).toMatchObject({
      session_time: '',
      start_sec: 0,
      end_sec: 0,
    });
    expect(out.find((w) => w.word === 'b')).toMatchObject({
      session_time: '',
      start_sec: 0,
      end_sec: 0,
    });
  });

  it('chunked placement equals the unsplit-take equivalent, including under a mid-take transport pause', () => {
    // The correctness criterion (design D5): "a chunked take places words
    // exactly where the unsplit take would have." Construct BOTH shapes from
    // the same underlying timeline and assert identical output.
    //
    // Timeline: Recording 1 starts at frame-derived A=50s, wall 10:00:00.
    // The take runs continuously in wall-clock time, but transport is PAUSED
    // between wall-clock offset 120s and 300s (an operator pause mid-take) —
    // `timecodeForMark` would freeze during that window in the real system,
    // but since this formula derives purely from WALL-CLOCK deltas (not
    // transport state), the paused window doesn't perturb placement: it
    // affects only what timecode a human would see, not the wall-clock math
    // this resolver performs. Three chunks roll over at wall-clock offsets
    // 0, 200, 400 (chunk 2 starts inside/after the pause).
    const eventWallTimeUtc = '2026-08-12T10:00:00.000Z';
    const totalFrames = 50 * 24;
    const anchors = recordingStartAnchors([startedEvent(1, totalFrames, 24, eventWallTimeUtc)]); // A = 50

    // Unsplit take: one segment, one group, words placed at their raw
    // group-file offsets from t=0.
    const unsplitSegmentInfo: SegmentAnchorInfo[] = [
      { path: 'whole', ordinal: 1, recordingOrdinal: 1, startedAtUtc: eventWallTimeUtc },
    ];
    const unsplitGroups: GroupWords[] = [
      {
        segments: [{ path: 'whole', offsetSeconds: 0, durationSeconds: 600 }],
        words: [word('w0', 10, 10.5), word('w1', 210, 210.5), word('w2', 410, 410.5)],
      },
    ];
    const unsplitOut = remapTranscriptWords(unsplitGroups, unsplitSegmentInfo, anchors, 24);

    // Chunked take: three chunks, real per-chunk started_at_utc at the wall
    // offsets above, each chunk's words at ITS OWN within-chunk group-file
    // offset (0-based per chunk, mirroring real per-chunk merge groups).
    const chunkedSegmentInfo: SegmentAnchorInfo[] = [
      { path: 'ch0', ordinal: 1, recordingOrdinal: 1, startedAtUtc: '2026-08-12T10:00:00.000Z' },
      { path: 'ch1', ordinal: 2, recordingOrdinal: 1, startedAtUtc: '2026-08-12T10:03:20.000Z' }, // +200s
      { path: 'ch2', ordinal: 3, recordingOrdinal: 1, startedAtUtc: '2026-08-12T10:06:40.000Z' }, // +400s
    ];
    const chunkedGroups: GroupWords[] = [
      {
        segments: [
          { path: 'ch0', offsetSeconds: 0, durationSeconds: 200 },
          { path: 'ch1', offsetSeconds: 200, durationSeconds: 200 },
          { path: 'ch2', offsetSeconds: 400, durationSeconds: 200 },
        ],
        // Same raw content-relative timing as the unsplit take (word w1's
        // in-chunk position: 210 - 200 (chunk boundary) = 10, offset by the
        // group's own 200s chunk-2 base -> 210 in group-file terms, matching
        // the merged-group layout `mergeAudioSegments` would produce).
        words: [word('w0', 10, 10.5), word('w1', 210, 210.5), word('w2', 410, 410.5)],
      },
    ];
    const chunkedOut = remapTranscriptWords(chunkedGroups, chunkedSegmentInfo, anchors, 24);

    expect(chunkedOut.map((w) => ({ word: w.word, start_sec: w.start_sec }))).toEqual(
      unsplitOut.map((w) => ({ word: w.word, start_sec: w.start_sec })),
    );
    // Concretely: A(50) + delta + in-chunk offset all land at the same
    // absolute seconds regardless of chunking, pause or no pause.
    expect(chunkedOut.find((w) => w.word === 'w0')).toMatchObject({ start_sec: 60 }); // 50+0+10
    expect(chunkedOut.find((w) => w.word === 'w1')).toMatchObject({ start_sec: 260 }); // 50+200+10
    expect(chunkedOut.find((w) => w.word === 'w2')).toMatchObject({ start_sec: 460 }); // 50+400+10
  });

  it('enrichment inherits derived anchors: a paragraph anchored through a derived (non-base) chunk gets non-null seconds', () => {
    const eventWallTimeUtc = '2026-08-12T10:00:00.000Z';
    const anchors = recordingStartAnchors([startedEvent(2, 2400, 24, eventWallTimeUtc)]); // A = 100
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'c1', ordinal: 1, recordingOrdinal: 2, startedAtUtc: eventWallTimeUtc },
      { path: 'c2', ordinal: 2, recordingOrdinal: 2, startedAtUtc: '2026-08-12T10:10:00.000Z' }, // delta 600
    ];
    const group: EnrichmentGroup = {
      segments: [
        { path: 'c1', offsetSeconds: 0, durationSeconds: 5 },
        { path: 'c2', offsetSeconds: 5, durationSeconds: 5 },
      ],
      words: [word('a', 6, 6.5)],
      paragraphs: [{ speaker: 0, start: 6, end: 7, text: 'on the derived chunk' }],
      sentiments: [],
    };

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    // The paragraph's [6,7) group-file range falls in c2 (offset 5), the
    // non-base derived member: 100 + 600 + (6-5) = 701, not null.
    expect(out.paragraphs).toEqual([
      { start_sec: 701, end_sec: 702, speaker: '0', text: 'on the derived chunk' },
    ]);
  });
});

describe('recordingStartAnchors', () => {
  it('parses "Recording N Started" internal events into frame-arithmetic seconds', () => {
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
      {
        category: 'internal',
        message: 'Recording 2 Started',
        timecode_total_frames: 2400,
        frame_rate: 24,
      },
    ]);
    // chunked-live-recording task 3.1 (design D5) added `eventWallTimeUtc`;
    // these fixture events carry no `wall_time_utc`, so it falls back to
    // `null` per `recordingStartAnchors`' own `e.wall_time_utc ?? null`.
    expect(anchors).toEqual([
      { recordingOrdinal: 1, anchorSeconds: 0, eventWallTimeUtc: null },
      { recordingOrdinal: 2, anchorSeconds: 100, eventWallTimeUtc: null },
    ]);
  });

  it('ignores non-internal categories, non-matching messages, and frame-less events', () => {
    const anchors = recordingStartAnchors([
      { category: 'cam', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
      {
        category: 'internal',
        message: 'Recording 1 Stopped',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
      {
        category: 'internal',
        message: 'Recording 3 Started',
        timecode_total_frames: null,
        frame_rate: 24,
      },
      {
        category: 'internal',
        message: 'Recording 4 Started',
        timecode_total_frames: 10,
        frame_rate: 0,
      },
    ]);
    expect(anchors).toEqual([]);
  });
});

describe('remapTranscriptWords', () => {
  it('places words from a second recording at its own interval, not immediately after the first', () => {
    // Two segments packet-copied back-to-back into one group file: seg1
    // spans [0,5) group-file seconds, seg2 spans [5,9). On the session
    // timeline, recording 1 starts at t=0 and recording 2 starts much later
    // (t=100) — a real gap between recordings.
    const groups: GroupWords[] = [
      {
        segments: [
          { path: 'seg1', offsetSeconds: 0, durationSeconds: 5 },
          { path: 'seg2', offsetSeconds: 5, durationSeconds: 4 },
        ],
        words: [word('a', 1, 1.4), word('b', 6, 6.5)],
      },
    ];
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'seg1', ordinal: 1, recordingOrdinal: 1 },
      { path: 'seg2', ordinal: 2, recordingOrdinal: 2 },
    ];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
      {
        category: 'internal',
        message: 'Recording 2 Started',
        timecode_total_frames: 2400,
        frame_rate: 24,
      },
    ]);

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ word: 'a', start_sec: 1, session_time: '00:00:01:00' });
    // NOT 5 + 1 = 6 (immediately after recording 1's words) — the second
    // recording's own interval position, 100 + (6 - 5) = 101.
    expect(out[1]).toMatchObject({ word: 'b', start_sec: 101, session_time: '00:01:41:00' });
  });

  it("keeps an anchorless segment's words with empty session_time and zeroed seconds", () => {
    const groups: GroupWords[] = [
      {
        segments: [{ path: 'segX', offsetSeconds: 0, durationSeconds: 3 }],
        words: [word('hi', 0.5, 1.0, 1)],
      },
    ];
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'segX', ordinal: 1, recordingOrdinal: null }];

    const out = remapTranscriptWords(groups, segmentInfo, [], 24);

    expect(out).toEqual([{ session_time: '', speaker: '1', word: 'hi', start_sec: 0, end_sec: 0 }]);
  });

  it('pairs an unmatched segment with an unmatched anchor by ordinal/time order (step 2)', () => {
    // Neither segment's recording_ordinal matches any anchor's parsed
    // ordinal directly, but there's exactly one segment and one anchor left
    // over after step 1 finds nothing — index pairing (step 2) anchors it.
    const groups: GroupWords[] = [
      {
        segments: [{ path: 'seg1', offsetSeconds: 0, durationSeconds: 2 }],
        words: [word('x', 0.5, 1.0)],
      },
    ];
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'seg1', ordinal: 1, recordingOrdinal: 9 }];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 7 Started',
        timecode_total_frames: 240,
        frame_rate: 24,
      },
    ]);

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    expect(out[0]).toMatchObject({ word: 'x', start_sec: 10.5 }); // 10 + 0.5
  });

  it('orders anchored words by remapped position, then anchorless words grouped by segment ordinal', () => {
    const groups: GroupWords[] = [
      {
        segments: [
          { path: 'anchored', offsetSeconds: 0, durationSeconds: 2 },
          { path: 'anchorless-2', offsetSeconds: 2, durationSeconds: 2 },
          { path: 'anchorless-1', offsetSeconds: 4, durationSeconds: 2 },
        ],
        words: [word('anchored-word', 0, 0.5), word('two', 2.5, 3), word('one', 4.5, 5)],
      },
    ];
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'anchored', ordinal: 1, recordingOrdinal: 1 },
      { path: 'anchorless-1', ordinal: 2, recordingOrdinal: null },
      { path: 'anchorless-2', ordinal: 3, recordingOrdinal: null },
    ];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
    ]);

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    expect(out.map((w) => w.word)).toEqual(['anchored-word', 'one', 'two']);
    expect(out[0].session_time).not.toBe('');
    expect(out[1].session_time).toBe('');
    expect(out[2].session_time).toBe('');
  });

  it('stores the speaker id as a decimal string', () => {
    const groups: GroupWords[] = [
      {
        segments: [{ path: 'seg1', offsetSeconds: 0, durationSeconds: 2 }],
        words: [word('hey', 0, 0.5, 2)],
      },
    ];
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'seg1', ordinal: 1, recordingOrdinal: null }];

    const out = remapTranscriptWords(groups, segmentInfo, [], 24);

    expect(out[0].speaker).toBe('2');
  });
});

describe('remapTranscriptEnrichment', () => {
  function realFixtureGroup(): EnrichmentGroup {
    const { paragraphs, sentiments } = extractEnrichment(enrichmentFixture);
    return {
      segments: [{ path: 'real-seg', offsetSeconds: 0, durationSeconds: 50 }],
      words: extractWordsForTest(),
      paragraphs,
      sentiments,
    };
  }

  // `extractWords` isn't exported; the real fixture's words are only needed
  // here to build group-local word arrays for index resolution, so pull them
  // via the same channel path `extractWords` reads (mirrors its punctuation
  // preference) rather than duplicating provider-shape parsing.
  function extractWordsForTest(): DeepgramWord[] {
    const raw = enrichmentFixture.results.channels[0].alternatives[0].words as Array<{
      word: string;
      punctuated_word?: string;
      start: number;
      end: number;
      speaker: number;
    }>;
    return raw.map((w) => ({
      word: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
      speaker: w.speaker,
    }));
  }

  it("sentiment segment inherits its words' timeline position, not group-file seconds", () => {
    const group = realFixtureGroup();
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'real-seg', ordinal: 1, recordingOrdinal: 1 },
    ];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 24000,
        frame_rate: 24,
      },
    ]); // anchor at t=1000

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    // Leading token check: text 'Okay...' vs words[0].word 'Okay' — passes.
    expect(out.sentiment[0]).toMatchObject({
      start_sec: 1000 + 1.28,
      end_sec: 1000 + 25.305,
      sentiment: 'neutral',
    });
    expect(out.sentiment[1]).toMatchObject({
      start_sec: 1000 + 27.385,
      end_sec: 1000 + 32.170002,
      sentiment: 'negative',
    });
    expect(out.sentiment[2]).toMatchObject({
      start_sec: 1000 + 32.81,
      end_sec: 1000 + 46.33,
      sentiment: 'neutral',
    });
  });

  it('paragraph seconds remap through the same anchor chain as words, as a single-anchor interval', () => {
    const group = realFixtureGroup();
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'real-seg', ordinal: 1, recordingOrdinal: 1 },
    ];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 24000,
        frame_rate: 24,
      },
    ]); // anchor at t=1000

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    expect(out.paragraphs).toEqual([
      expect.objectContaining({ start_sec: 1000 + 1.28, end_sec: 1000 + 13.36, speaker: '0' }),
      expect.objectContaining({ start_sec: 1000 + 15.465, end_sec: 1000 + 40.89, speaker: '0' }),
      expect.objectContaining({ start_sec: 1000 + 42.65, end_sec: 1000 + 46.33, speaker: '0' }),
    ]);
  });

  it('a paragraph straddling a concat seam anchors both ends to the segment containing its start', () => {
    const group: EnrichmentGroup = {
      segments: [
        { path: 'segA', offsetSeconds: 0, durationSeconds: 5 },
        { path: 'segB', offsetSeconds: 5, durationSeconds: 5 },
      ],
      words: [],
      paragraphs: [{ speaker: 0, start: 4, end: 7, text: 'straddles the seam' }],
      sentiments: [],
    };
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'segA', ordinal: 1, recordingOrdinal: 1 },
      { path: 'segB', ordinal: 2, recordingOrdinal: 2 },
    ];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 2400,
        frame_rate: 24,
      }, // t=100
      {
        category: 'internal',
        message: 'Recording 2 Started',
        timecode_total_frames: 240000,
        frame_rate: 24,
      }, // t=10000
    ]);

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    // Both start (4) and end (7) resolve against segA's anchor (t=100),
    // NOT segB's (t=10000) even though 7 falls in segB's raw [5,10) range:
    // 100 + 4 = 104, 100 + 7 = 107. A segB-anchored end would be ~10002.
    expect(out.paragraphs).toEqual([
      { start_sec: 104, end_sec: 107, speaker: '0', text: 'straddles the seam' },
    ]);
  });

  it('anchorless-group enrichment is retained with NULL start/end, not dropped', () => {
    const group: EnrichmentGroup = {
      segments: [{ path: 'segX', offsetSeconds: 0, durationSeconds: 5 }],
      words: [word('hi', 0, 0.5)],
      paragraphs: [{ speaker: 0, start: 0, end: 1, text: 'para' }],
      sentiments: [
        { text: 'hi', start_word: 0, end_word: 0, sentiment: 'neutral', sentiment_score: 0 },
      ],
    };
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'segX', ordinal: 1, recordingOrdinal: null }];

    const out = remapTranscriptEnrichment([group], segmentInfo, []);

    expect(out.paragraphs).toEqual([
      { start_sec: null, end_sec: null, speaker: '0', text: 'para' },
    ]);
    expect(out.sentiment).toEqual([
      { start_sec: null, end_sec: null, sentiment: 'neutral', sentiment_score: 0, text: 'hi' },
    ]);
  });

  it('clamps out-of-range, negative, and non-integer sentiment indices to the group word bounds', () => {
    const group: EnrichmentGroup = {
      segments: [{ path: 'seg1', offsetSeconds: 0, durationSeconds: 5 }],
      words: [
        word('a', 0, 0.5),
        word('b', 0.5, 1),
        word('c', 1, 1.5),
        word('d', 1.5, 2),
        word('e', 2, 2.5),
      ],
      paragraphs: [],
      sentiments: [
        sentSeg('a', -5, 999, 'x1'), // negative + out-of-range -> clamp to [0, 4]
        sentSeg('c', 2.9, 2.9, 'x2'), // non-integer -> truncated (2) within bounds
      ],
    };
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'seg1', ordinal: 1, recordingOrdinal: 1 }];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
    ]);

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    const byLabel = (label: string) => out.sentiment.find((s) => s.sentiment === label);
    expect(byLabel('x1')).toMatchObject({ start_sec: 0, end_sec: 2.5 }); // words[0].start..words[4].end
    expect(byLabel('x2')).toMatchObject({ start_sec: 1, end_sec: 1.5 }); // words[2] both ends
  });

  it('normalizes end_word < start_word so the stored interval is end >= start', () => {
    const group: EnrichmentGroup = {
      segments: [{ path: 'seg1', offsetSeconds: 0, durationSeconds: 5 }],
      words: [word('a', 0, 0.5), word('b', 0.5, 1), word('c', 1, 1.5), word('d', 1.5, 2)],
      paragraphs: [],
      sentiments: [sentSeg('d', 3, 1, 'backwards')],
    };
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'seg1', ordinal: 1, recordingOrdinal: 1 }];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
    ]);

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    // Normalized to start_word = end_word = 3 (words[3] = 'd').
    expect(out.sentiment[0]).toMatchObject({ start_sec: 1.5, end_sec: 2 });
  });

  it('drops a sentiment segment in a zero-word group', () => {
    const zeroWordGroup: EnrichmentGroup = {
      segments: [{ path: 'segEmpty', offsetSeconds: 0, durationSeconds: 5 }],
      words: [],
      paragraphs: [],
      sentiments: [sentSeg('ghost', 0, 0, 'ghost')],
    };
    const realGroup: EnrichmentGroup = {
      segments: [{ path: 'segReal', offsetSeconds: 0, durationSeconds: 5 }],
      words: [word('a', 0, 0.5)],
      paragraphs: [],
      sentiments: [sentSeg('a', 0, 0, 'kept')],
    };
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'segEmpty', ordinal: 1, recordingOrdinal: 1 },
      { path: 'segReal', ordinal: 2, recordingOrdinal: 2 },
    ];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
      {
        category: 'internal',
        message: 'Recording 2 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
    ]);

    const out = remapTranscriptEnrichment([zeroWordGroup, realGroup], segmentInfo, anchors);

    expect(out.sentiment).toHaveLength(1);
    expect(out.sentiment[0].sentiment).toBe('kept');
  });

  it("index-base guard degrades a segment whose leading text token doesn't match words[start_word]", () => {
    const group: EnrichmentGroup = {
      segments: [{ path: 'seg1', offsetSeconds: 0, durationSeconds: 5 }],
      words: [word('Hello', 0, 0.5), word('World', 0.5, 1)],
      paragraphs: [],
      sentiments: [sentSeg('Goodbye everyone', 0, 1, 'mismatched')],
    };
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'seg1', ordinal: 1, recordingOrdinal: 1 }];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
    ]);

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    // Not dropped — degraded to NULL start/end, text/sentiment/score kept.
    expect(out.sentiment).toEqual([
      {
        start_sec: null,
        end_sec: null,
        sentiment: 'mismatched',
        sentiment_score: 0,
        text: 'Goodbye everyone',
      },
    ]);
  });

  it('orders anchored items by start_sec, then anchorless items in group/segment order (two-bucket determinism)', () => {
    const groups: EnrichmentGroup[] = [
      {
        segments: [
          { path: 'anchored', offsetSeconds: 0, durationSeconds: 2 },
          { path: 'anchorless-2', offsetSeconds: 2, durationSeconds: 2 },
          { path: 'anchorless-1', offsetSeconds: 4, durationSeconds: 2 },
        ],
        words: [word('a', 0, 0.5), word('b', 2.5, 3), word('c', 4.5, 5)],
        paragraphs: [
          { speaker: 0, start: 0, end: 0.5, text: 'p-anchored' },
          { speaker: 0, start: 2.5, end: 3, text: 'p-anchorless-2' },
          { speaker: 0, start: 4.5, end: 5, text: 'p-anchorless-1' },
        ],
        sentiments: [],
      },
    ];
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'anchored', ordinal: 1, recordingOrdinal: 1 },
      { path: 'anchorless-1', ordinal: 2, recordingOrdinal: null },
      { path: 'anchorless-2', ordinal: 3, recordingOrdinal: null },
    ];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      },
    ]);

    const out = remapTranscriptEnrichment(groups, segmentInfo, anchors);

    // Anchored first, then anchorless ordered by segment ordinal (2 before
    // 3), matching remapTranscriptWords' documented order.
    expect(out.paragraphs.map((p) => p.text)).toEqual([
      'p-anchored',
      'p-anchorless-1',
      'p-anchorless-2',
    ]);
  });

  it('a synthetic 2-group composition (real fixture duplicated onto a second, later-anchored group) merges and orders deterministically', () => {
    const groupA = realFixtureGroup();
    const groupB: EnrichmentGroup = {
      ...realFixtureGroup(),
      segments: [{ path: 'dup-seg', offsetSeconds: 0, durationSeconds: 50 }],
    };
    const segmentInfo: SegmentAnchorInfo[] = [
      { path: 'real-seg', ordinal: 1, recordingOrdinal: 1 },
      { path: 'dup-seg', ordinal: 2, recordingOrdinal: 2 },
    ];
    const anchors = recordingStartAnchors([
      {
        category: 'internal',
        message: 'Recording 1 Started',
        timecode_total_frames: 0,
        frame_rate: 24,
      }, // t=0
      {
        category: 'internal',
        message: 'Recording 2 Started',
        timecode_total_frames: 24000,
        frame_rate: 24,
      }, // t=1000
    ]);

    const out = remapTranscriptEnrichment([groupA, groupB], segmentInfo, anchors);

    expect(out.paragraphs).toHaveLength(6);
    expect(out.sentiment).toHaveLength(6);
    // All anchored -> pure ascending start_sec order; group A's (t < 50)
    // entirely precede group B's (t > 1000).
    const paraStarts = out.paragraphs.map((p) => p.start_sec as number);
    expect(paraStarts).toEqual([...paraStarts].sort((a, b) => a - b));
    expect(paraStarts[2]).toBeLessThan(50);
    expect(paraStarts[3]).toBeGreaterThan(1000);
    const sentStarts = out.sentiment.map((s) => s.start_sec as number);
    expect(sentStarts).toEqual([...sentStarts].sort((a, b) => a - b));
  });

  it('never throws on an empty groups array', () => {
    expect(() => remapTranscriptEnrichment([], [], [])).not.toThrow();
    expect(remapTranscriptEnrichment([], [], [])).toEqual({ paragraphs: [], sentiment: [] });
  });
});

function sentSeg(
  text: string,
  start_word: number,
  end_word: number,
  sentiment: string,
  sentiment_score = 0,
): DeepgramSentimentSegment {
  return { text, start_word, end_word, sentiment, sentiment_score };
}
