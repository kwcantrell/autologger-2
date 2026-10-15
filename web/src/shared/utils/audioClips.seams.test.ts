import { describe, expect, it } from 'vitest';
import type { AudioSegment, LogEvent, SessionStatus } from '../../api/types';
import { resolvePlayPosition } from '../../pages/index/components/AudioPlayer';
import {
  clipIsFinalizing,
  clipMediaOffsetSec,
  clipMediaPositionSec,
  clipMediaStatus,
  rebuildAudioClips,
  seamClipPeaks,
  timelineSecAtMediaPosition,
} from './audioClips';

// media-worker D16 (web-session-console "Recording intervals lay out multi-chunk segments
// contiguously"): a merged segment lays out as one clip per seam, each with the segment's URL, the
// seam's media offset, and the position its chunk had, so layout, seeks and playback match the
// pre-merge chunk layout and no linear drift accumulates. Fixture style follows
// `audioClips.chunkGroups.test.ts`.

function wallAt(offsetSec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetSec * 1000).toISOString();
}

function ev(overrides: Partial<LogEvent>): LogEvent {
  return {
    version: 1,
    event_id: `ev-${Math.random()}`,
    category: 'internal',
    category_label: 'Internal',
    category_color: '#4488ff',
    message: '',
    timecode: '00:00:00:00',
    timecode_total_frames: 0,
    frame_rate: 24,
    wall_time_utc: wallAt(0),
    metadata: {},
    ...overrides,
  };
}

function seg(overrides: Partial<AudioSegment>): AudioSegment {
  return {
    id: 'seg',
    ordinal: 0,
    recording_ordinal: null,
    started_at_utc: null,
    ended_at_utc: null,
    mime_type: 'audio/webm',
    url: 'blob:seg',
    waveform_peaks: null,
    waveform_db_floor: null,
    ...overrides,
  };
}

const status: SessionStatus = {
  is_rolling: false,
  timecode: '05:00:00:00',
  session_timecode: '05:00:00:00',
  master_timecode: '05:00:00:00',
  frame_rate: 24,
  current_take: 0,
  audio_recording_lease_alive: false,
  audio_recording_lease_holder_id: null,
  event_count: 0,
  logged_event_count: 0,
  title: 'seams',
  deck_title: '',
  show_name: null,
  show_code: null,
  episode: '',
  session_created_at_utc: null,
  now_utc: wallAt(20000),
  notes: '',
  show_id: null,
  events_stream_revision: 1,
};

function recordingEvents(n: number, startSec: number, stopSec: number): LogEvent[] {
  return [
    ev({
      event_id: `r${n}-start`,
      message: `Recording ${n} Started`,
      wall_time_utc: wallAt(startSec),
      timecode_total_frames: startSec * 24,
    }),
    ev({
      event_id: `r${n}-stop`,
      message: `Recording ${n} Stopped`,
      wall_time_utc: wallAt(stopSec),
      timecode_total_frames: stopSec * 24,
    }),
  ];
}

// Recording 1 runs [10, 100) on the timeline and starts at wall time 10. Its three 30 s chunks
// start at wall 10, 40.03 and 70.08 (30 ms and 50 ms rollover gaps).
const events = recordingEvents(1, 10, 100);
const chunkWall = [10, 40.03, 70.08];
const chunks = chunkWall.map((w, i) =>
  seg({
    id: `c${i + 1}`,
    ordinal: i,
    recording_ordinal: 1,
    started_at_utc: wallAt(w),
    url: `blob:c${i + 1}`,
  }),
);
const merged = seg({
  id: 'm',
  ordinal: 0,
  recording_ordinal: 1,
  started_at_utc: wallAt(10),
  url: 'blob:m',
  duration_ms: 90_000,
  media_status: 'done',
  seams: chunkWall.map((w, i) => ({
    offset_ms: i * 30_000,
    started_at_utc: wallAt(w),
    ended_at_utc: wallAt(w + 30),
  })),
});

describe('rebuildAudioClips — a merged recording lays out by its seams', () => {
  it('lays three seams out as three clips at the pre-merge chunk positions', () => {
    const before = rebuildAudioClips(chunks, [30, 30, 30], events, status);
    const after = rebuildAudioClips([merged], [90], events, status);
    expect(after).toHaveLength(3);
    after.forEach((clip, i) => {
      expect(clip.segmentId).toBe('m');
      expect(clip.url).toBe('blob:m');
      expect(clip.startSec).toBeCloseTo(before[i].startSec, 9);
      expect(clip.endSec).toBeCloseTo(before[i].endSec, 9);
      expect(clip.duration).toBeCloseTo(before[i].duration, 9);
      expect(clip.missingAudio).toBe(false);
      expect(clipMediaOffsetSec(clip)).toBe(i * 30);
    });
    expect(after.map((c) => c.startSec)).toEqual(
      [10, 40.03, 70.08].map((v) => expect.closeTo(v, 9)),
    );
  });

  it('places the last of eighteen seams over three hours at its wall-clock position', () => {
    // 18 × 600 s chunks; the 17 rollover gaps sum to 1.1 s of wall-clock time.
    const gap = 1.1 / 17;
    const wall = Array.from({ length: 18 }, (_, i) => 10 + i * (600 + gap));
    const long = seg({
      id: 'long',
      recording_ordinal: 1,
      started_at_utc: wallAt(10),
      url: 'blob:long',
      duration_ms: 18 * 600_000,
      media_status: 'done',
      seams: wall.map((w, i) => ({
        offset_ms: i * 600_000,
        started_at_utc: wallAt(w),
        ended_at_utc: null,
      })),
    });
    const out = rebuildAudioClips([long], [10_800], recordingEvents(1, 10, 10_812), status);
    expect(out).toHaveLength(18);
    expect(out[17].startSec).toBeCloseTo(10 + 17 * 600 + 1.1, 3);
    // A single linear clip would have put that audio 1.1 s early.
    expect(out[17].startSec - (10 + 17 * 600)).toBeGreaterThan(1.09);
    expect(clipMediaOffsetSec(out[17])).toBe(17 * 600);
  });

  it('keeps the chunk layout unchanged for segments whose seams are null', () => {
    const legacy = chunks.map((c) => ({
      ...c,
      seams: null,
      media_status: null,
      duration_ms: null,
    }));
    const out = rebuildAudioClips(legacy, [30, 30, 30], events, status);
    expect(out).toStrictEqual([
      {
        segmentId: 'c1',
        url: 'blob:c1',
        startSec: 10,
        endSec: 40.03,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'c2',
        url: 'blob:c2',
        startSec: 40.03,
        endSec: 70.08,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'c3',
        url: 'blob:c3',
        startSec: 70.08,
        endSec: 100.08,
        duration: 30,
        missingAudio: false,
      },
    ]);
  });

  it('a feed-row seek into a seam clip lands on the same media position the chunk had', () => {
    const before = rebuildAudioClips(chunks, [30, 30, 30], events, status);
    const after = rebuildAudioClips([merged], [90], events, status);
    const sec = 85.5; // inside the third chunk
    const pre = resolvePlayPosition(sec, before);
    const post = resolvePlayPosition(sec, after);
    expect(pre?.clipIdx).toBe(2);
    expect(post?.clipIdx).toBe(2);
    // Within the chunk's own file vs. within the merged file, minus the seam's offset.
    expect(clipMediaPositionSec(before[2], sec)).toBeCloseTo(sec - 70.08, 9);
    expect(clipMediaPositionSec(after[2], sec) - 60).toBeCloseTo(
      clipMediaPositionSec(before[2], sec),
      9,
    );
  });
});

describe('seam clip waveform peaks (media-worker D16)', () => {
  it('slices a merged segment’s peaks across its seam clips by media offset', () => {
    const clips = rebuildAudioClips([merged], [90], events, status);
    const peaks = Float32Array.from({ length: 90 }, (_, i) => i / 90);
    const { clips: drawn, peaksById } = seamClipPeaks(clips, new Map([['m', peaks]]));
    expect(drawn).toHaveLength(3);
    const ids = drawn.map((c) => c.segmentId);
    expect(new Set(ids).size).toBe(3);
    const second = peaksById.get(ids[1] as string);
    expect(second?.length).toBe(30);
    expect(second?.[0]).toBeCloseTo(30 / 90, 6);
    expect(drawn.map((c) => c.startSec)).toEqual(clips.map((c) => c.startSec));
  });

  it('passes ordinary clips and their peaks through untouched', () => {
    const clips = rebuildAudioClips(chunks, [30, 30, 30], events, status);
    const map = new Map([['c1', new Float32Array(16)]]);
    const out = seamClipPeaks(clips, map);
    expect(out.clips).toBe(clips);
    expect(out.peaksById).toBe(map);
  });
});

describe('clip media status (media-worker D16)', () => {
  it('carries the segment media_status and flags a pending multi-segment recording as finalizing', () => {
    const pending = chunks.map((c, i) => ({
      ...c,
      media_status: i === 2 ? ('pending' as const) : ('done' as const),
    }));
    const out = rebuildAudioClips(pending, [30, 30, 30], events, status);
    expect(out.map(clipMediaStatus)).toEqual(['done', 'done', 'pending']);
    expect(out.every(clipIsFinalizing)).toBe(true);
  });

  it('a single pending segment is not finalizing', () => {
    const one = [{ ...chunks[0], media_status: 'pending' as const }];
    const out = rebuildAudioClips(one, [30], events, status);
    expect(out.map(clipMediaStatus)).toEqual(['pending']);
    expect(out.some(clipIsFinalizing)).toBe(false);
  });

  it('a failed segment carries its failed status', () => {
    const out = rebuildAudioClips([{ ...chunks[0], media_status: 'failed' }], [30], events, status);
    expect(clipMediaStatus(out[0])).toBe('failed');
  });
});

describe('timelineSecAtMediaPosition (media-worker D16)', () => {
  it('maps a merged file’s media time to the seam clip holding it, in any clip order', () => {
    const clips = rebuildAudioClips([merged], [90], events, status).reverse();
    expect(timelineSecAtMediaPosition(clips, 'm', 5)).toBeCloseTo(15, 9);
    expect(timelineSecAtMediaPosition(clips, 'm', 35)).toBeCloseTo(45.03, 9);
    expect(timelineSecAtMediaPosition(clips, 'm', 61)).toBeCloseTo(71.08, 9);
    expect(timelineSecAtMediaPosition(clips, 'other', 1)).toBeNull();
  });
});
