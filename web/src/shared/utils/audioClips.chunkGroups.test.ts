import { describe, expect, it } from 'vitest';
import type { AudioSegment, LogEvent, SessionStatus } from '../../api/types';
import { rebuildAudioClips } from './audioClips';

// New multi-chunk clip-layout behavior (chunked-live-recording, task 2.1, D4 /
// the web-session-console delta's "Recording intervals lay out multi-chunk
// segments contiguously" requirement). Follows the fixture style of
// `audioClips.characterization.test.ts`.

function wallAt(offsetSec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSec)).toISOString();
}

function ev(overrides: Partial<LogEvent>): LogEvent {
  return {
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
  timecode: '01:00:00:00',
  session_timecode: '01:00:00:00',
  master_timecode: '01:00:00:00',
  frame_rate: 24,
  current_take: 0,
  audio_recording_lease_alive: false,
  audio_recording_lease_holder_id: null,
  event_count: 0,
  logged_event_count: 0,
  title: 'chunk-groups',
  deck_title: '',
  show_name: null,
  show_code: null,
  episode: '',
  session_created_at_utc: null,
  now_utc: wallAt(10000),
  notes: '',
  show_id: null,
  events_stream_revision: 1,
};

/** Recording N Started/Stopped internal-event pair at [startSec, stopSec). */
function recordingEvents(n: number, startSec: number, stopSec: number): LogEvent[] {
  return [
    ev({
      event_id: `r${n}-start-${startSec}`,
      message: `Recording ${n} Started`,
      wall_time_utc: wallAt(startSec),
      timecode_total_frames: startSec * 24,
    }),
    ev({
      event_id: `r${n}-stop-${stopSec}`,
      message: `Recording ${n} Stopped`,
      wall_time_utc: wallAt(stopSec),
      timecode_total_frames: stopSec * 24,
    }),
  ];
}

describe('rebuildAudioClips — three-chunk recording renders inside one interval', () => {
  it('places three chunks by wall-clock delta from the start event, each extending to the next', () => {
    const events = recordingEvents(1, 10, 100);
    const segments = [
      seg({ id: 'c1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
      seg({ id: 'c2', ordinal: 1, recording_ordinal: 1, started_at_utc: wallAt(40) }),
      seg({ id: 'c3', ordinal: 2, recording_ordinal: 1, started_at_utc: wallAt(70) }),
    ];
    const out = rebuildAudioClips(segments, [30, 30, 30], events, status);

    expect(out).toEqual([
      {
        segmentId: 'c1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 40,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'c2',
        url: 'blob:seg',
        startSec: 40,
        endSec: 70,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'c3',
        url: 'blob:seg',
        startSec: 70,
        endSec: 100,
        duration: 30,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — same-N re-run cycles keep their own intervals', () => {
  it('splits two Recording 1 cycles into separate chunk groups by wall-clock adjacency', () => {
    // Cycle A: Recording 1 [10,70) with 2 chunks. Cycle B: Recording 1 [200,260) with 2 chunks.
    const events = [...recordingEvents(1, 10, 70), ...recordingEvents(1, 200, 260)];
    const segments = [
      seg({ id: 'a1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
      seg({ id: 'a2', ordinal: 1, recording_ordinal: 1, started_at_utc: wallAt(40) }),
      seg({ id: 'b1', ordinal: 2, recording_ordinal: 1, started_at_utc: wallAt(200) }),
      seg({ id: 'b2', ordinal: 3, recording_ordinal: 1, started_at_utc: wallAt(230) }),
    ];
    const out = rebuildAudioClips(segments, [30, 30, 30, 30], events, status);

    expect(out).toEqual([
      {
        segmentId: 'a1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 40,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'a2',
        url: 'blob:seg',
        startSec: 40,
        endSec: 70,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'b1',
        url: 'blob:seg',
        startSec: 200,
        endSec: 230,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'b2',
        url: 'blob:seg',
        startSec: 230,
        endSec: 260,
        duration: 30,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — a crashed recording never steals another interval', () => {
  it('the completed recording gets only its own segment; the crashed recording chunks take unmatched fallback', () => {
    // Recording 1: completed [10,70) with one segment.
    // Recording 2: Started with no Stopped (crash) -- two uploaded chunks, no paired interval.
    const events = [
      ...recordingEvents(1, 10, 70),
      ev({
        event_id: 'r2-start',
        message: 'Recording 2 Started',
        wall_time_utc: wallAt(200),
        timecode_total_frames: 200 * 24,
      }),
    ];
    const segments = [
      seg({ id: 'good', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
      seg({ id: 'crash1', ordinal: 1, recording_ordinal: 2, started_at_utc: wallAt(200) }),
      seg({ id: 'crash2', ordinal: 2, recording_ordinal: 2, started_at_utc: wallAt(230) }),
    ];
    const out = rebuildAudioClips(segments, [55, 25, 25], events, status);

    // The completed recording's clip is untouched by the crash's chunks.
    expect(out[0]).toEqual({
      segmentId: 'good',
      url: 'blob:seg',
      startSec: 10,
      endSec: 70,
      duration: 55,
      missingAudio: false,
    });
    // Crash chunks never appear inside [10,70) and never displace `good`.
    const crashClips = out.filter((c) => c.segmentId === 'crash1' || c.segmentId === 'crash2');
    expect(crashClips).toHaveLength(2);
    for (const c of crashClips) {
      expect(c.startSec).toBeGreaterThanOrEqual(70);
    }
    expect(out.map((c) => c.segmentId)).toEqual(['good', 'crash1', 'crash2']);
  });
});

describe('rebuildAudioClips — a discarded first chunk does not shift the survivors', () => {
  it('surviving chunks 2 and 3 sit at their true wall-clock deltas, leaving the lead uncovered', () => {
    // Chunk 1 (would-be [10,40)) never made it as a segment (permanently lost + discarded).
    const events = recordingEvents(1, 10, 100);
    const segments = [
      seg({ id: 'c2', ordinal: 1, recording_ordinal: 1, started_at_utc: wallAt(40) }),
      seg({ id: 'c3', ordinal: 2, recording_ordinal: 1, started_at_utc: wallAt(70) }),
    ];
    const out = rebuildAudioClips(segments, [30, 30], events, status);

    // Survivors sit at their real wall-clock deltas from the start event (40, 70),
    // NOT shifted to the interval start (10).
    expect(out).toEqual([
      {
        segmentId: 'c2',
        url: 'blob:seg',
        startSec: 40,
        endSec: 70,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'c3',
        url: 'blob:seg',
        startSec: 70,
        endSec: 100,
        duration: 30,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — a probe failure does not uncover the interval', () => {
  it('a middle chunk whose duration probe failed still spans to the next chunk position', () => {
    const events = recordingEvents(1, 10, 100);
    const segments = [
      seg({ id: 'c1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
      seg({ id: 'c2', ordinal: 1, recording_ordinal: 1, started_at_utc: wallAt(40) }),
      seg({ id: 'c3', ordinal: 2, recording_ordinal: 1, started_at_utc: wallAt(70) }),
    ];
    // Middle chunk's probe failed (null duration -> d=1 fallback), but its span
    // must still cover [40,70), not collapse to [40,41).
    const out = rebuildAudioClips(segments, [30, null, 30], events, status);

    expect(out).toEqual([
      {
        segmentId: 'c1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 40,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'c2',
        url: 'blob:seg',
        startSec: 40,
        endSec: 70,
        duration: 1,
        missingAudio: false,
      },
      {
        segmentId: 'c3',
        url: 'blob:seg',
        startSec: 70,
        endSec: 100,
        duration: 30,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — legacy path (rebuildAudioClipsLegacyOrdinalAndChain) chunk groups', () => {
  it('a crashed recording (unpaired Started, the only recording activity) reaches the legacy function and groups its chunks', () => {
    // A lone `Recording 1 Started` with no `Stopped` is the ONLY internal
    // recording event in this session -- buildRecordingIntervalsFromInternalEvents
    // produces zero pairable intervals (confirmed by direct instrumentation:
    // intervals.length === 0 here, unlike a legacy ordinal-less
    // Started/Stopped PAIR, which pairs into one `ordinal: null` interval and
    // routes through the GREEDY path instead -- D4's own rationale for why
    // rebuildAudioClipsLegacyOrdinalAndChain is reworked: "a tab killed
    // mid-take produces a Recording N Started with no Stopped -- no pairable
    // interval... the session lands on the legacy path"). Two chunks share
    // recording_ordinal=1; they group together (D4) and the group's base
    // sits at the start event (delta 0), the follow-on at its own wall-clock
    // delta from the start event, chained since there is no stop event.
    const events = [
      ev({
        event_id: 'r1-start',
        message: 'Recording 1 Started',
        wall_time_utc: wallAt(10),
        timecode_total_frames: 10 * 24,
      }),
    ];
    const segments = [
      seg({ id: 'c1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
      seg({ id: 'c2', ordinal: 1, recording_ordinal: 1, started_at_utc: wallAt(40) }),
    ];
    const out = rebuildAudioClips(segments, [30, 30], events, status);

    expect(out).toEqual([
      {
        segmentId: 'c1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 40,
        duration: 30,
        missingAudio: false,
      },
      {
        segmentId: 'c2',
        url: 'blob:seg',
        startSec: 40,
        endSec: 70,
        duration: 30,
        missingAudio: false,
      },
    ]);
  });
});
