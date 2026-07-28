import { describe, expect, it } from 'vitest';
import type { LogEvent, SessionStatus } from '../../../api/types';
import { eventTimelineSec } from '../../../shared/utils/audioClips';
import { groupTimelineMarkers } from './markerGrouping';

// Group-equality test for the shared marker-grouping util (code-health-tail
// task 4.3, finding 2.6). MarkerNav and Timeline previously carried
// outcome-equivalent, phrasing-different copies of this grouping; both prior
// implementations are reproduced VERBATIM below (only renamed) and run against
// a mixed fixture alongside the shared util, asserting the shared util yields
// exactly the grouping each call site previously produced.

// ── Verbatim prior implementation 1: MarkerNav.tsx `groupMarkers` ────────────
interface LegacyMarkerNavEntry {
  sec: number;
  event: LogEvent;
  isInternal: boolean;
}
function legacyMarkerNavGroupMarkers(
  events: LogEvent[],
  status: SessionStatus | null | undefined,
): LegacyMarkerNavEntry[] {
  const grouped = new Map<string, LegacyMarkerNavEntry>();
  for (const e of events) {
    const sec = eventTimelineSec(e, status);
    if (!(Number.isFinite(sec) && sec >= 0)) continue;
    const key = sec.toFixed(3);
    const isInternal = String(e.category ?? '').toLowerCase() === 'internal';
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { sec, event: e, isInternal });
    } else if (existing.isInternal && !isInternal) {
      grouped.set(key, { sec, event: e, isInternal });
    }
  }
  return Array.from(grouped.values()).sort((a, b) => a.sec - b.sec);
}

// ── Verbatim prior implementation 2: Timeline.tsx currentNavMarker grouping ──
interface LegacyTimelineEntry {
  sec: number;
  cat: string;
  msg: string;
  col: string;
  isInternal: boolean;
}
function legacyTimelineGroupMarks(
  events: LogEvent[],
  status: SessionStatus | null | undefined,
): LegacyTimelineEntry[] {
  const grouped = new Map<string, LegacyTimelineEntry>();
  for (const e of events) {
    const sec = eventTimelineSec(e, status);
    if (!Number.isFinite(sec) || sec < 0) continue;
    const key = sec.toFixed(3);
    const isInternal = String(e.category ?? '').toLowerCase() === 'internal';
    const existing = grouped.get(key);
    if (!existing || (existing.isInternal && !isInternal)) {
      grouped.set(key, {
        sec,
        cat: String(e.category_label || e.category || '—'),
        msg: String(e.message || '—'),
        col: String(e.category_color || '').trim() || '#6b7280',
        isInternal,
      });
    }
  }
  return Array.from(grouped.values()).sort((a, b) => a.sec - b.sec);
}

// ── Fixture ──────────────────────────────────────────────────────────────────

let seq = 0;
function ev(partial: Partial<LogEvent>): LogEvent {
  seq += 1;
  return {
    event_id: `e${seq}`,
    session_id: 's',
    category: 'take',
    category_label: 'Take',
    category_color: '#e53935',
    message: `msg-${seq}`,
    timecode: '00:00:00',
    timecode_hms: '00:00:00',
    // frame_rate 10000 → sec = timecode_total_frames / 10000, giving exact
    // sub-millisecond control over toFixed(3) bucketing.
    timecode_total_frames: 0,
    frame_rate: 10000,
    wall_time_utc: null,
    metadata: {},
    ...partial,
  };
}

const status: SessionStatus | null = null;

// Mixed fixture: exact ties, internal-vs-normal collisions in both arrival
// orders, internal-internal collision, non-finite/negative secs, and
// sub-millisecond near-ties both inside and across toFixed(3) buckets.
const FIXTURE: LogEvent[] = [
  // Bucket "10.000": normal arrives first, internal second → first (normal) holds.
  ev({ event_id: 'n1', timecode_total_frames: 100000 }), // 10.0000
  ev({ event_id: 'i1', timecode_total_frames: 100000, category: 'internal' }),
  // Bucket "20.000": internal first, normal second → internal LOSES, normal replaces.
  ev({ event_id: 'i2', timecode_total_frames: 200000, category: 'internal' }),
  ev({ event_id: 'n2', timecode_total_frames: 200000 }),
  // Bucket "30.000": internal-internal collision → FIRST internal holds.
  ev({ event_id: 'i3', timecode_total_frames: 300000, category: 'internal' }),
  ev({ event_id: 'i4', timecode_total_frames: 300000, category: 'INTERNAL' }), // case-folded
  // Bucket "40.000": exact tie of two normals → first holds.
  ev({ event_id: 'n3', timecode_total_frames: 400000, message: 'first' }),
  ev({ event_id: 'n4', timecode_total_frames: 400000, message: 'second' }),
  // Sub-millisecond near-tie INSIDE one bucket: 50.0000 and 50.0004 both key
  // "50.000" (internal-first order → normal replaces it).
  ev({ event_id: 'i5', timecode_total_frames: 500000, category: 'internal' }),
  ev({ event_id: 'n5', timecode_total_frames: 500004 }),
  // Sub-millisecond near-tie ACROSS buckets: 60.0006 keys "60.001", distinct
  // from 60.0000's "60.000" → both markers survive.
  ev({ event_id: 'n6', timecode_total_frames: 600000 }),
  ev({ event_id: 'n7', timecode_total_frames: 600006 }),
  // Negative sec: no usable frames and an unparseable timecode → eventTimelineSec
  // returns -1 → dropped.
  ev({ event_id: 'bad1', timecode_total_frames: null, frame_rate: null, timecode: 'garbage' }),
  // Non-finite frames path: falls through to the (invalid) timecode → dropped.
  ev({
    event_id: 'bad2',
    timecode_total_frames: Number.NaN as unknown as number,
    frame_rate: null,
    timecode: 'not-a-timecode',
  }),
  // Out-of-order arrival: an early marker appended last still sorts first.
  ev({ event_id: 'n0', timecode_total_frames: 50000 }), // 5.0000
];

describe('groupTimelineMarkers', () => {
  it('produces the exact grouping MarkerNav previously produced (verbatim copy)', () => {
    expect(groupTimelineMarkers(FIXTURE, status)).toEqual(
      legacyMarkerNavGroupMarkers(FIXTURE, status),
    );
  });

  it("produces the exact grouping Timeline previously produced (verbatim copy, after Timeline's display mapping)", () => {
    const viaShared = groupTimelineMarkers(FIXTURE, status).map(
      ({ sec, event: e, isInternal }) => ({
        sec,
        cat: String(e.category_label || e.category || '—'),
        msg: String(e.message || '—'),
        col: String(e.category_color || '').trim() || '#6b7280',
        isInternal,
      }),
    );
    expect(viaShared).toEqual(legacyTimelineGroupMarks(FIXTURE, status));
  });

  it('pins the mixed fixture outcome: winners, drops, buckets and order', () => {
    const got = groupTimelineMarkers(FIXTURE, status).map((m) => [
      m.event.event_id,
      m.sec.toFixed(3),
      m.isInternal,
    ]);
    expect(got).toEqual([
      ['n0', '5.000', false], // late arrival, earliest sec
      ['n1', '10.000', false], // normal-first tie with internal → holds
      ['n2', '20.000', false], // internal-first → internal loses
      ['i3', '30.000', true], // internal-internal → first holds (case-folded)
      ['n3', '40.000', false], // normal-normal tie → first holds
      ['n5', '50.000', false], // sub-ms near-tie inside bucket → internal loses
      ['n6', '60.000', false], // sub-ms near-tie across buckets:
      ['n7', '60.001', false], //   both survive
      // bad1/bad2 dropped (negative / unparseable timeline sec)
    ]);
  });
});
