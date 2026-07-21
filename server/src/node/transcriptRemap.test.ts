// Unit tests for timeline remapping of DeepGram words onto the session's
// SMPTE timeline (design D4 / spec "Timeline remapping of word timestamps"),
// and for remapping paragraph/sentiment enrichment onto that same timeline
// per-group, before the global word sort (spec "Enrichment timeline
// remapping", design D2). Pure module — no hub/router access, no I/O.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractEnrichment, type DeepgramSentimentSegment, type DeepgramWord } from './deepgram';
import {
  recordingStartAnchors,
  remapTranscriptEnrichment,
  remapTranscriptWords,
  type EnrichmentGroup,
  type GroupWords,
  type SegmentAnchorInfo,
} from './transcriptRemap';

// Real captured DeepGram response (design D7: record-once, replay-always).
// 89 words / 3 paragraphs / 3 sentiment segments (word spans 0-48, 49-61,
// 62-88) — same fixture `extractEnrichment`'s own tests replay.
const enrichmentFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'test', 'fixtures', 'deepgram-enrichment-response.json'), 'utf8'),
);

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
    return raw.map((w) => ({ word: w.punctuated_word ?? w.word, start: w.start, end: w.end, speaker: w.speaker }));
  }

  it("sentiment segment inherits its words' timeline position, not group-file seconds", () => {
    const group = realFixtureGroup();
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'real-seg', ordinal: 1, recordingOrdinal: 1 }];
    const anchors = recordingStartAnchors([
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 24000, frame_rate: 24 },
    ]); // anchor at t=1000

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    // Leading token check: text 'Okay...' vs words[0].word 'Okay' — passes.
    expect(out.sentiment[0]).toMatchObject({ start_sec: 1000 + 1.28, end_sec: 1000 + 25.305, sentiment: 'neutral' });
    expect(out.sentiment[1]).toMatchObject({ start_sec: 1000 + 27.385, end_sec: 1000 + 32.170002, sentiment: 'negative' });
    expect(out.sentiment[2]).toMatchObject({ start_sec: 1000 + 32.81, end_sec: 1000 + 46.33, sentiment: 'neutral' });
  });

  it('paragraph seconds remap through the same anchor chain as words, as a single-anchor interval', () => {
    const group = realFixtureGroup();
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'real-seg', ordinal: 1, recordingOrdinal: 1 }];
    const anchors = recordingStartAnchors([
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 24000, frame_rate: 24 },
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
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 2400, frame_rate: 24 }, // t=100
      { category: 'internal', message: 'Recording 2 Started', timecode_total_frames: 240000, frame_rate: 24 }, // t=10000
    ]);

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    // Both start (4) and end (7) resolve against segA's anchor (t=100),
    // NOT segB's (t=10000) even though 7 falls in segB's raw [5,10) range:
    // 100 + 4 = 104, 100 + 7 = 107. A segB-anchored end would be ~10002.
    expect(out.paragraphs).toEqual([{ start_sec: 104, end_sec: 107, speaker: '0', text: 'straddles the seam' }]);
  });

  it('anchorless-group enrichment is retained with NULL start/end, not dropped', () => {
    const group: EnrichmentGroup = {
      segments: [{ path: 'segX', offsetSeconds: 0, durationSeconds: 5 }],
      words: [word('hi', 0, 0.5)],
      paragraphs: [{ speaker: 0, start: 0, end: 1, text: 'para' }],
      sentiments: [{ text: 'hi', start_word: 0, end_word: 0, sentiment: 'neutral', sentiment_score: 0 }],
    };
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'segX', ordinal: 1, recordingOrdinal: null }];

    const out = remapTranscriptEnrichment([group], segmentInfo, []);

    expect(out.paragraphs).toEqual([{ start_sec: null, end_sec: null, speaker: '0', text: 'para' }]);
    expect(out.sentiment).toEqual([
      { start_sec: null, end_sec: null, sentiment: 'neutral', sentiment_score: 0, text: 'hi' },
    ]);
  });

  it('clamps out-of-range, negative, and non-integer sentiment indices to the group word bounds', () => {
    const group: EnrichmentGroup = {
      segments: [{ path: 'seg1', offsetSeconds: 0, durationSeconds: 5 }],
      words: [word('a', 0, 0.5), word('b', 0.5, 1), word('c', 1, 1.5), word('d', 1.5, 2), word('e', 2, 2.5)],
      paragraphs: [],
      sentiments: [
        sentSeg('a', -5, 999, 'x1'), // negative + out-of-range -> clamp to [0, 4]
        sentSeg('c', 2.9, 2.9, 'x2'), // non-integer -> truncated (2) within bounds
      ],
    };
    const segmentInfo: SegmentAnchorInfo[] = [{ path: 'seg1', ordinal: 1, recordingOrdinal: 1 }];
    const anchors = recordingStartAnchors([
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
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
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
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
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
      { category: 'internal', message: 'Recording 2 Started', timecode_total_frames: 0, frame_rate: 24 },
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
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
    ]);

    const out = remapTranscriptEnrichment([group], segmentInfo, anchors);

    // Not dropped — degraded to NULL start/end, text/sentiment/score kept.
    expect(out.sentiment).toEqual([
      { start_sec: null, end_sec: null, sentiment: 'mismatched', sentiment_score: 0, text: 'Goodbye everyone' },
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
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 },
    ]);

    const out = remapTranscriptEnrichment(groups, segmentInfo, anchors);

    // Anchored first, then anchorless ordered by segment ordinal (2 before
    // 3), matching remapTranscriptWords' documented order.
    expect(out.paragraphs.map((p) => p.text)).toEqual(['p-anchored', 'p-anchorless-1', 'p-anchorless-2']);
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
      { category: 'internal', message: 'Recording 1 Started', timecode_total_frames: 0, frame_rate: 24 }, // t=0
      { category: 'internal', message: 'Recording 2 Started', timecode_total_frames: 24000, frame_rate: 24 }, // t=1000
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
