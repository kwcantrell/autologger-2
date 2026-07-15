// Unit tests for timeline remapping of DeepGram words onto the session's
// SMPTE timeline (design D4 / spec "Timeline remapping of word timestamps").
// Pure module — no hub/router access, no I/O.

import { describe, expect, it } from 'vitest';
import type { DeepgramWord } from './deepgram';
import {
  recordingStartAnchors,
  remapTranscriptWords,
  type GroupWords,
  type SegmentAnchorInfo,
} from './transcriptRemap';

function word(w: string, start: number, end: number, speaker = 0): DeepgramWord {
  return { word: w, start, end, speaker };
}

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
    expect(anchors).toEqual([
      { recordingOrdinal: 1, anchorSeconds: 0 },
      { recordingOrdinal: 2, anchorSeconds: 100 },
    ]);
  });

  it('ignores non-internal categories, non-matching messages, and frame-less events', () => {
    const anchors = recordingStartAnchors([
      { category: 'cam', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
      { category: 'internal', message: 'Recording 1 Stopped', timecode_total_frames: 0, frame_rate: 24 },
      { category: 'internal', message: 'Recording 3 Started', timecode_total_frames: null, frame_rate: 24 },
      { category: 'internal', message: 'Recording 4 Started', timecode_total_frames: 10, frame_rate: 0 },
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
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
      { category: 'internal', message: 'Recording 2 Started', timecode_total_frames: 2400, frame_rate: 24 },
    ]);

    const out = remapTranscriptWords(groups, segmentInfo, anchors, 24);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ word: 'a', start_sec: 1, session_time: '00:00:01:00' });
    // NOT 5 + 1 = 6 (immediately after recording 1's words) — the second
    // recording's own interval position, 100 + (6 - 5) = 101.
    expect(out[1]).toMatchObject({ word: 'b', start_sec: 101, session_time: '00:01:41:00' });
  });

  it('keeps an anchorless segment\'s words with empty session_time and zeroed seconds', () => {
    const groups: GroupWords[] = [
      {
        segments: [{ path: 'segX', offsetSeconds: 0, durationSeconds: 3 }],
        words: [word('hi', 0.5, 1.0, 1)],
      },
    ];
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'segX', ordinal: 1, recordingOrdinal: null }];

    const out = remapTranscriptWords(groups, segmentInfo, [], 24);

    expect(out).toEqual([
      { session_time: '', speaker: '1', word: 'hi', start_sec: 0, end_sec: 0 },
    ]);
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
      { category: 'internal', message: 'Recording 7 Started', timecode_total_frames: 240, frame_rate: 24 },
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
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
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
