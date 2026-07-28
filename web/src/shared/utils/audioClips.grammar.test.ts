import { describe, expect, it } from 'vitest';
import type { LogEvent } from '../../api/types';
import {
  isRecordingStartedMessage,
  isRecordingStoppedMessage,
  parseRecordingOrdinalFromMessage,
  sortAudioInternalByOrdinalThenTime,
} from './audioClips';

// Consolidated internal-audio message-grammar suite (code-health-tail task 4.2,
// finding 2.3): recording.ts formerly re-implemented this grammar verbatim except
// for `?? ''` vs `|| ''` coalescing; audioClips.ts is now the single source and
// recording.ts imports it.
//
// `??`/`||` RECONCILIATION (D12/W2, pinned here): the duplicated phrasings were
// `String(msg ?? '')` (recording.ts) vs `String(msg || '')` (audioClips.ts), and
// likewise for `wall_time_utc` in the sort tiebreak. Over the declared input
// domains — `msg: string | null | undefined` and `wall_time_utc: string | null` —
// the two are extensionally EQUAL: the only falsy string is `''`, which both
// operators map to `''` (and `String('')` is `''` regardless), while `null`/
// `undefined` map to `''` under both. No input within the types can distinguish
// them; they diverge only for out-of-type values (e.g. the number 0 → '0' vs ''),
// which the frozen JSON contract never delivers. The canonical file's `|| ''`
// phrasing is therefore kept unchanged. The empty-string-vs-null cases below pin
// that chosen semantics.

function ev(partial: Partial<LogEvent>): LogEvent {
  return {
    event_id: 'e',
    category: 'internal',
    category_label: 'Internal',
    category_color: '#000000',
    message: '',
    timecode: '00:00:00',
    timecode_total_frames: null,
    frame_rate: null,
    wall_time_utc: null,
    metadata: {},
    ...partial,
  };
}

describe('parseRecordingOrdinalFromMessage', () => {
  it('parses Started and Stopped ordinals', () => {
    expect(parseRecordingOrdinalFromMessage('Recording 1 Started')).toBe(1);
    expect(parseRecordingOrdinalFromMessage('Recording 42 Stopped')).toBe(42);
  });

  it('is anchored — prefixes/suffixes and case variants do not parse', () => {
    expect(parseRecordingOrdinalFromMessage('x Recording 1 Started')).toBeNull();
    expect(parseRecordingOrdinalFromMessage('Recording 1 Started x')).toBeNull();
    expect(parseRecordingOrdinalFromMessage('recording 1 started')).toBeNull();
  });

  it('legacy marker strings carry no ordinal', () => {
    expect(parseRecordingOrdinalFromMessage('Log Audio Recording Started')).toBeNull();
    expect(parseRecordingOrdinalFromMessage('Log Audio Recording Stopped')).toBeNull();
  });

  it('empty string, null and undefined all yield null (`|| ""` semantics pinned)', () => {
    expect(parseRecordingOrdinalFromMessage('')).toBeNull();
    expect(parseRecordingOrdinalFromMessage(null)).toBeNull();
    expect(parseRecordingOrdinalFromMessage(undefined)).toBeNull();
  });
});

describe('isRecordingStartedMessage / isRecordingStoppedMessage', () => {
  it('accepts ordinal and legacy forms, on the matching side only', () => {
    expect(isRecordingStartedMessage('Recording 3 Started')).toBe(true);
    expect(isRecordingStartedMessage('Log Audio Recording Started')).toBe(true);
    expect(isRecordingStartedMessage('Recording 3 Stopped')).toBe(false);
    expect(isRecordingStartedMessage('Log Audio Recording Stopped')).toBe(false);
    expect(isRecordingStoppedMessage('Recording 3 Stopped')).toBe(true);
    expect(isRecordingStoppedMessage('Log Audio Recording Stopped')).toBe(true);
    expect(isRecordingStoppedMessage('Recording 3 Started')).toBe(false);
    expect(isRecordingStoppedMessage('Log Audio Recording Started')).toBe(false);
  });

  it('empty string, null and undefined are neither started nor stopped', () => {
    for (const v of ['', null, undefined] as const) {
      expect(isRecordingStartedMessage(v)).toBe(false);
      expect(isRecordingStoppedMessage(v)).toBe(false);
    }
  });
});

describe('sortAudioInternalByOrdinalThenTime', () => {
  it('orders by ordinal when both sides have one', () => {
    const a = ev({
      event_id: 'a',
      message: 'Recording 2 Started',
      wall_time_utc: '2026-01-01T00:00:00Z',
    });
    const b = ev({
      event_id: 'b',
      message: 'Recording 1 Started',
      wall_time_utc: '2026-01-01T00:00:09Z',
    });
    expect(sortAudioInternalByOrdinalThenTime([a, b]).map((e) => e.event_id)).toEqual(['b', 'a']);
  });

  it('falls back to wall-time compare when either side lacks an ordinal', () => {
    const legacy = ev({
      event_id: 'l',
      message: 'Log Audio Recording Started',
      wall_time_utc: '2026-01-01T00:00:05Z',
    });
    const later = ev({
      event_id: 'x',
      message: 'Recording 9 Started',
      wall_time_utc: '2026-01-01T00:00:09Z',
    });
    expect(sortAudioInternalByOrdinalThenTime([later, legacy]).map((e) => e.event_id)).toEqual([
      'l',
      'x',
    ]);
  });

  it('treats null and empty-string wall_time_utc identically (`|| ""` semantics pinned)', () => {
    // Both coalesce to '' before localeCompare, so a null-vs-'' pair is a tie and
    // the sort (stable per ES2019) preserves input order — under `?? ''` the
    // outcome is byte-identical; this test is the reconciliation evidence.
    const withNull = ev({
      event_id: 'n',
      message: 'Log Audio Recording Started',
      wall_time_utc: null,
    });
    const withEmpty = ev({
      event_id: 'e',
      message: 'Log Audio Recording Started',
      wall_time_utc: '',
    });
    expect(
      sortAudioInternalByOrdinalThenTime([withNull, withEmpty]).map((e) => e.event_id),
    ).toEqual(['n', 'e']);
    expect(
      sortAudioInternalByOrdinalThenTime([withEmpty, withNull]).map((e) => e.event_id),
    ).toEqual(['e', 'n']);
  });

  it('does not mutate its input', () => {
    const a = ev({ event_id: 'a', message: 'Recording 2 Started' });
    const b = ev({ event_id: 'b', message: 'Recording 1 Started' });
    const input = [a, b];
    sortAudioInternalByOrdinalThenTime(input);
    expect(input.map((e) => e.event_id)).toEqual(['a', 'b']);
  });
});
