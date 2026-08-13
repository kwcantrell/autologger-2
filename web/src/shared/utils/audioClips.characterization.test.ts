import { describe, expect, it } from 'vitest';
import type { AudioSegment, LogEvent, SessionStatus } from '../../api/types';
import { rebuildAudioClips } from './audioClips';

// Characterization guard for `rebuildAudioClips` / `matchAudioSegmentsToIntervalsGreedy`
// (module-private, exercised only through `rebuildAudioClips`) / the legacy
// `rebuildAudioClipsLegacyOrdinalAndChain` path (chunked-live-recording, task 1.1).
//
// These pin TODAY's behavior exactly — no production code changes accompany this
// file. They exist so task 2.1 (D4: chunk-group interval matching) has a concrete,
// numeric "before" to diff against. Every pinned value below was captured by
// running the real function against the fixture, not hand-computed — see the
// design doc's D4/"Current state, measured" section and the
// web-session-console delta's "Single-segment sessions are unchanged" scenario
// this suite backs.
//
// Where a pin encodes a behavior task 2.1 will DELIBERATELY change (chunk-group
// matching / event-wall-time placement), the assertion carries a
// "PRE-CHANGE PIN" comment calling that out.

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
  title: 'characterization',
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

/** Legacy (ordinal-less) `Log Audio Recording Started/Stopped` pair. */
function legacyEvents(startSec: number, stopSec: number, idSuffix: string): LogEvent[] {
  return [
    ev({
      event_id: `leg-start-${idSuffix}`,
      message: 'Log Audio Recording Started',
      wall_time_utc: wallAt(startSec),
      timecode_total_frames: startSec * 24,
    }),
    ev({
      event_id: `leg-stop-${idSuffix}`,
      message: 'Log Audio Recording Stopped',
      wall_time_utc: wallAt(stopSec),
      timecode_total_frames: stopSec * 24,
    }),
  ];
}

describe('rebuildAudioClips — one segment per recording (normal shape, greedy path)', () => {
  it('lays out two single-segment recordings at their exact event timecodes', () => {
    const events = [...recordingEvents(1, 10, 70), ...recordingEvents(2, 200, 260)];
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
      seg({ id: 'seg-2', ordinal: 1, recording_ordinal: 2, started_at_utc: wallAt(200) }),
    ];
    const out = rebuildAudioClips(segments, [55, 55], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 55,
        missingAudio: false,
      },
      {
        segmentId: 'seg-2',
        url: 'blob:seg',
        startSec: 200,
        endSec: 260,
        duration: 55,
        missingAudio: false,
      },
    ]);
    // Exact ordering: output is sorted by startSec.
    expect(out.map((c) => c.segmentId)).toEqual(['seg-1', 'seg-2']);
  });
});

describe('rebuildAudioClips — null recording_ordinal segments (sync-from-disk shape)', () => {
  it('a null-ordinal, null-started_at_utc segment still lands on its sole interval via sequential pairing', () => {
    const events = recordingEvents(1, 10, 70);
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: null, started_at_utc: null }),
    ];
    const out = rebuildAudioClips(segments, [55], events, status);

    // The greedy matcher's wall-clock pass can't place a segment with no
    // started_at_utc, but the chronological sequential-pairing fallback (n-th
    // unmatched segment <-> n-th unused interval) still lands it on the one
    // available interval — exact interval timecodes, not a placeholder.
    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 55,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — legacy ordinal-less events (greedy path, ordinal: null interval)', () => {
  it('legacy ordinal-less Started/Stopped pair still builds an interval (isRecordingStartedMessage/isRecordingStoppedMessage match the legacy strings too) -> greedy path, not the legacy function; the segment lands on the ordinal: null interval', () => {
    // `Log Audio Recording Started/Stopped` matches isRecordingStartedMessage
    // / isRecordingStoppedMessage (they OR in the legacy string alongside the
    // `Recording N ...` regex), so buildRecordingIntervalsFromInternalEvents
    // still produces one interval here (ordinal: null, since
    // parseRecordingOrdinalFromMessage returns null for the legacy message).
    // intervals.length === 1, so rebuildAudioClips takes the GREEDY path
    // (matchAudioSegmentsToIntervalsGreedy + placeChunkGroupWithinInterval),
    // never rebuildAudioClipsLegacyOrdinalAndChain. Only sessions with ZERO
    // parseable Started/Stopped events of either shape (buildRecordingIntervalsFromInternalEvents
    // returns []) reach the true legacy path -- see U2's chunk-groups test
    // for a genuine legacy-path pin.
    const events = legacyEvents(10, 70, 'a');
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: null, started_at_utc: wallAt(10) }),
    ];
    const out = rebuildAudioClips(segments, [55], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 55,
        missingAudio: false,
      },
    ]);
  });

  it('greedy path: a segment with recording_ordinal set still lands on the sole ordinal: null interval via the null-ordinal (singleton) wall-clock-nearest fallback', () => {
    // `recording_ordinal: 1` is set on the segment, but the ONLY internal
    // events present are the ordinal-less legacy pair, which builds ONE
    // interval with ordinal: null (see the preceding test's comment). A
    // non-null-ordinal group only matches an interval sharing its ordinal
    // directly (D4) -- there is no ordinal=1 interval here, so this
    // single-member group falls through to the null-ordinal (singleton)
    // wall-clock-nearest matching pass, which claims the one available
    // ordinal: null interval.
    const events = legacyEvents(10, 70, 'a');
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
    ];
    const out = rebuildAudioClips(segments, [55], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 55,
        missingAudio: false,
      },
    ]);
  });

  it('legacy path: two ordinal-less, started_at_utc-less segments fall through to index pairing against sorted start/stop events', () => {
    const events = [...legacyEvents(10, 70, '1'), ...legacyEvents(200, 260, '2')];
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: null, started_at_utc: null }),
      seg({ id: 'seg-2', ordinal: 1, recording_ordinal: null, started_at_utc: null }),
    ];
    const out = rebuildAudioClips(segments, [55, 55], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 55,
        missingAudio: false,
      },
      {
        segmentId: 'seg-2',
        url: 'blob:seg',
        startSec: 200,
        endSec: 260,
        duration: 55,
        missingAudio: false,
      },
    ]);
  });

  it('legacy path: an extra segment beyond the recording-ordinal pool chains onto the prior clip end', () => {
    // Only ONE legacy Started/Stopped pair exists, so recordingOrdinals is
    // EMPTY (no `Recording N` events at all -> startEventByOrd is empty too).
    // seg-1 has no recording_ordinal and no matched startEventByOrd entry, so
    // it falls to index pairing against startEvents[0]/stopEvents[0] (the
    // legacy pair). seg-2 has neither an ordinal match nor an index-pairing
    // slot (startEvents[1] doesn't exist) -- PRE-CHANGE PIN: it chains
    // directly after seg-1's clip end using its own probed duration.
    const events = legacyEvents(10, 70, 'a');
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: null, started_at_utc: wallAt(10) }),
      seg({ id: 'seg-2', ordinal: 1, recording_ordinal: null, started_at_utc: null }),
    ];
    const out = rebuildAudioClips(segments, [55, 20], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 55,
        missingAudio: false,
      },
      {
        // PRE-CHANGE PIN: task 2.1's chunk-group reshape of the legacy path
        // will treat same-recording chunk groups differently -- this
        // end-of-timeline chain for an unresolved second segment is the
        // "before" this pin exists to diff against.
        segmentId: 'seg-2',
        url: 'blob:seg',
        startSec: 70,
        endSec: 90,
        duration: 20,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — repeated-N cycles (two distinct Recording 2 blocks)', () => {
  it('two Recording 2 Started/Stopped cycles each get their own segment via wall-clock greedy matching', () => {
    // buildRecordingIntervalsFromInternalEvents explicitly supports multiple
    // cycles sharing the same ordinal N (FIFO pairing of Started/Stopped).
    // PRE-CHANGE PIN: today's greedy matcher treats each cycle as an
    // independent interval and matches each segment to its nearest
    // wall-clock interval regardless of shared ordinal -- task 2.1 will
    // instead split same-N segments into per-cycle GROUPS by wall-clock
    // adjacency (functionally similar for this well-separated fixture, but
    // the matching MECHANISM changes).
    const events = [...recordingEvents(2, 10, 70), ...recordingEvents(2, 200, 260)];
    const segments = [
      seg({ id: 'seg-a', ordinal: 0, recording_ordinal: 2, started_at_utc: wallAt(10) }),
      seg({ id: 'seg-b', ordinal: 1, recording_ordinal: 2, started_at_utc: wallAt(200) }),
    ];
    const out = rebuildAudioClips(segments, [55, 55], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-a',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 55,
        missingAudio: false,
      },
      {
        segmentId: 'seg-b',
        url: 'blob:seg',
        startSec: 200,
        endSec: 260,
        duration: 55,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — segments with missing started_at_utc (placeholder + end-of-timeline chaining)', () => {
  it('a segment with no started_at_utc and a genuinely unclaimed interval produces a red placeholder, chaining the real file at the timeline end', () => {
    // Only ONE real segment exists (for Recording 1); Recording 2's interval
    // has NO segment at all -- it must surface as an unmatched placeholder
    // clip (missingAudio: true), not silently vanish.
    const events = [...recordingEvents(1, 10, 70), ...recordingEvents(2, 200, 260)];
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
    ];
    const out = rebuildAudioClips(segments, [55], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 55,
        missingAudio: false,
      },
      {
        segmentId: null,
        url: null,
        startSec: 200,
        endSec: 260,
        duration: 60,
        missingAudio: true,
      },
    ]);
  });

  it('a same-recording_ordinal segment groups with its sibling inside the shared interval (post-task-2.1 chunk-group behavior, MAJOR-1 over-run floor)', () => {
    // Two segments sharing recording_ordinal=1 form one chunk group (D4) and
    // place inside the one interval by event-wall-time delta: seg-1 at the
    // interval start (delta 0), seg-2 at interval start + (500-10)s = 500 --
    // its true wall-clock delta from the start event, past the interval's
    // nominal end (70) already by position alone. As the group's last
    // member, its clip extends to Math.max(intervalEnd, pos + d) = Math.max(
    // 70, 500 + 30) = 530 (MAJOR-1: the probed-duration floor applies here
    // too, not just Math.max(intervalEnd, clipStart + 0.05)).
    const events = recordingEvents(1, 10, 70);
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
      seg({ id: 'seg-2', ordinal: 1, recording_ordinal: 1, started_at_utc: wallAt(500) }),
    ];
    const out = rebuildAudioClips(segments, [55, 30], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 500,
        duration: 55,
        missingAudio: false,
      },
      {
        segmentId: 'seg-2',
        url: 'blob:seg',
        startSec: 500,
        endSec: 530,
        duration: 30,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — probe-failure durations (null duration -> d=1 fallback)', () => {
  it('greedy path: a null probed duration falls back to d=1, but endSec still derives from the matched interval', () => {
    const events = recordingEvents(1, 10, 70);
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
    ];
    const out = rebuildAudioClips(segments, [null], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 1,
        missingAudio: false,
      },
    ]);
  });

  it('legacy path: a null probed duration falls back to d=1, but endSec still derives from the paired stop event', () => {
    const events = legacyEvents(10, 70, 'a');
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: null, started_at_utc: wallAt(10) }),
    ];
    const out = rebuildAudioClips(segments, [null], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 70,
        duration: 1,
        missingAudio: false,
      },
    ]);
  });
});

describe('rebuildAudioClips — probed-duration over-run floor (d > interval span)', () => {
  it('greedy path: a pre-change-shape singleton whose probed duration exceeds the interval span extends to start + d (bit-identical to old rebuildAudioClips: endSec = Math.max(endSec, startSec + d, startSec + 0.05))', () => {
    // Interval [10, 70) has a 60s span. The segment's probed duration (90s)
    // exceeds that span -- e.g. a paused-transport recording where the actual
    // audio ran longer than the wall-clock Started/Stopped bracket. The
    // pre-change function's floor (`Math.max(endSec, startSec + d, startSec +
    // 0.05)`, see git show 47102ac^:web/src/shared/utils/audioClips.ts line
    // 405) computed endSec = Math.max(70, 10 + 90, 10.05) = 100. This test
    // pins that MAJOR-1's restored floor reproduces that exact number: the
    // singleton's `pos` equals `startSec` (event wall time matches
    // started_at_utc exactly, delta 0), so `Math.max(intervalEnd, pos + d)` =
    // `Math.max(70, 10 + 90)` = 100 -- the same derivation, same value.
    const events = recordingEvents(1, 10, 70);
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
    ];
    const out = rebuildAudioClips(segments, [90], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 100,
        duration: 90,
        missingAudio: false,
      },
    ]);
  });

  it('greedy path: a multi-chunk group whose last chunk audio runs past the interval end extends the last clip past it, while the non-last member still extends only to the next chunk', () => {
    // Two segments share recording_ordinal=1 inside interval [10, 70) (span
    // 60s). seg-1 sits at the interval start (delta 0 from the start event);
    // seg-2 (the group's last member) sits at interval start + 30s = 40,
    // still inside the interval's nominal span -- but its own probed
    // duration (50s) would run to 40 + 50 = 90, past the interval end (70).
    // MAJOR-1 generalizes the restored floor to chunk groups: the last
    // member's clip extends to Math.max(intervalEnd, pos + d) = Math.max(70,
    // 90) = 90. The non-last member (seg-1) is unaffected by the floor --
    // it still extends only to the next placed member's position (40).
    const events = recordingEvents(1, 10, 70);
    const segments = [
      seg({ id: 'seg-1', ordinal: 0, recording_ordinal: 1, started_at_utc: wallAt(10) }),
      seg({ id: 'seg-2', ordinal: 1, recording_ordinal: 1, started_at_utc: wallAt(40) }),
    ];
    const out = rebuildAudioClips(segments, [55, 50], events, status);

    expect(out).toEqual([
      {
        segmentId: 'seg-1',
        url: 'blob:seg',
        startSec: 10,
        endSec: 40,
        duration: 55,
        missingAudio: false,
      },
      {
        segmentId: 'seg-2',
        url: 'blob:seg',
        startSec: 40,
        endSec: 90,
        duration: 50,
        missingAudio: false,
      },
    ]);
  });
});
