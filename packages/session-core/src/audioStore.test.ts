// media-worker B.2 (design D5, D6, D7, D16, D18): the segment meta's media fields and seams, the
// idempotent segment insert with its seam and ingest job, the finalize bookkeeping and the
// deterministic merged-segment identity. Over a SessionCore bound to a recording fake handle and
// fake media ports; the Postgres behaviour is covered by server/src/test/session/audioMedia.int.test.ts.

import type {
  AudioSeam,
  AudioSeamsPort,
  MediaJobEnqueue,
  MediaJobsPort,
} from '@autologger/ports/media';
import { describe, expect, it } from 'vitest';
import {
  AudioStore,
  audioRowToMeta,
  dictSeams,
  mergedSegmentId,
  type SessionMediaPorts,
} from './audioStore';
import { type Row, SessionCore, type SessionSql, type SqlValue } from './sessionCore';

const SID = 'sess-1';

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: 'seg-1',
    ordinal: 1,
    started_at_utc: '2026-10-12T10:00:00.000Z',
    ended_at_utc: '2026-10-12T10:10:00.000Z',
    mime_type: 'audio/webm',
    r2_key: `audio/${SID}/0001_seg-1.webm`,
    recording_ordinal: 1,
    waveform_peaks_json: null,
    waveform_db_floor: null,
    duration_ms: null,
    media_status: null,
    media_error: null,
    ...over,
  };
}

const seam = (over: Partial<AudioSeam> = {}): AudioSeam => ({
  sessionId: SID,
  recordingOrdinal: 1,
  startedAtUtc: '2026-10-12T10:00:00.000Z',
  endedAtUtc: '2026-10-12T10:10:00.000Z',
  segmentId: 'seg-1',
  offsetMs: 0,
  sourceKey: `audio/${SID}/0001_seg-1.webm`,
  ...over,
});

describe('audioRowToMeta media fields (D16)', () => {
  it('maps duration, status and error, and a legacy row to nulls', () => {
    expect(audioRowToMeta(baseRow())).toMatchObject({
      duration_ms: null,
      media_status: null,
      media_error: null,
      seams: null,
    });
    expect(
      audioRowToMeta(
        baseRow({ duration_ms: '61234', media_status: 'failed', media_error: 'decode-failed' }),
      ),
    ).toMatchObject({ duration_ms: 61234, media_status: 'failed', media_error: 'decode-failed' });
  });

  it('joins the seams given for the row, in media order', () => {
    const m = audioRowToMeta(baseRow({ media_status: 'done' }), [
      seam({ startedAtUtc: '2026-10-12T10:10:00.000Z', endedAtUtc: null, offsetMs: 600000 }),
      seam(),
    ]);
    expect(m.seams).toEqual([
      {
        offset_ms: 0,
        started_at_utc: '2026-10-12T10:00:00.000Z',
        ended_at_utc: '2026-10-12T10:10:00.000Z',
      },
      { offset_ms: 600000, started_at_utc: '2026-10-12T10:10:00.000Z', ended_at_utc: null },
    ]);
  });
});

describe('dictSeams (D16: null for none or a single seam at offset 0)', () => {
  it('is null for no seam and for the chunk its own window', () => {
    expect(dictSeams([])).toBeNull();
    expect(dictSeams([seam()])).toBeNull();
  });
  it('lists a single seam at a non-zero offset and two or more seams', () => {
    expect(dictSeams([seam({ offsetMs: 5 })])).toHaveLength(1);
    expect(dictSeams([seam(), seam({ offsetMs: 9, startedAtUtc: 'b' })])).toHaveLength(2);
  });
});

describe('mergedSegmentId (D3: derived from the job id)', () => {
  it('is a deterministic RFC 4122 v5 uuid per job id', () => {
    const a = mergedSegmentId('job-1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mergedSegmentId('job-1')).toBe(a);
    expect(mergedSegmentId('job-2')).not.toBe(a);
  });
});

// -- AudioStore over a recording fake ------------------------------------------------------------

interface Recorded {
  sql: string;
  binds: SqlValue[];
}

/** A handle answering the statements AudioStore sends, recording every write. */
function fakeSql(state: { rows: Row[]; writes: Recorded[] }): SessionSql {
  const handle: SessionSql = {
    async all<T>(sql: string, ...binds: SqlValue[]): Promise<T[]> {
      if (/MAX\(ordinal\)/.test(sql)) {
        const max = state.rows.reduce((m, r) => Math.max(m, Number(r.ordinal)), 0);
        return [{ n: max + 1 }] as T[];
      }
      if (/FROM session_audio_segments WHERE session_id = \? AND id = \?/.test(sql)) {
        return state.rows.filter((r) => r.id === binds[1]) as T[];
      }
      if (/FROM session_audio_seams/.test(sql)) return [] as T[];
      if (/FROM session_audio_segments/.test(sql)) return state.rows as T[];
      return [] as T[];
    },
    async run(sql: string, ...binds: SqlValue[]) {
      state.writes.push({ sql, binds });
      if (/INSERT INTO session_audio_segments/.test(sql)) {
        state.rows.push({ id: binds[1], ordinal: binds[2], r2_key: binds[6] } as Row);
      }
      return { changes: 1 };
    },
    tx: (fn) => fn(handle),
  };
  return handle;
}

function fakeMedia(found: AudioSeam | null = null) {
  const calls = {
    enqueued: [] as MediaJobEnqueue[],
    seams: [] as AudioSeam[],
    finds: 0,
  };
  const jobs = {
    enqueue: async (_db: unknown, job: MediaJobEnqueue) => {
      calls.enqueued.push(job);
      return true;
    },
  } as unknown as MediaJobsPort;
  const seams = {
    findWindow: async () => {
      calls.finds += 1;
      return found;
    },
    insert: async (_db: unknown, s: AudioSeam) => {
      calls.seams.push(s);
    },
  } as unknown as AudioSeamsPort;
  const media: SessionMediaPorts = { jobs, seams, blobBytes: async () => 0 };
  return { media, calls };
}

function store(media: SessionMediaPorts | null, rows: Row[] = []) {
  const state = { rows, writes: [] as Recorded[] };
  const runtime = {
    sessionId: SID,
    clock: { now: () => Date.parse('2026-10-12T12:00:00.000Z') },
    sockets: () => [],
    setAlarm: () => {},
  };
  const core = new SessionCore(runtime, fakeSql(state));
  return { audio: new AudioStore(core, media), state };
}

const chunk = {
  sessionId: SID,
  mimeType: 'audio/webm',
  startedAtUtc: '2026-10-12T10:00:00.000Z',
  endedAtUtc: '2026-10-12T10:10:00.000Z',
  recordingOrdinal: 1,
  inputBytes: 4096,
};

describe('AudioStore.addAudioSegment (D5, D18)', () => {
  it('a new window writes the row pending, its seam (offset 0, own key) and an ingest job', async () => {
    const { media, calls } = fakeMedia(null);
    const { audio, state } = store(media);
    const seg = await audio.addAudioSegment(chunk);
    expect(seg.existing).toBe(false);
    expect(seg.media_status).toBe('pending');
    const insert = state.writes.find((w) => /INSERT INTO session_audio_segments/.test(w.sql));
    expect(insert?.sql).toMatch(/media_status/);
    expect(insert?.binds).toContain('pending');
    expect(calls.seams).toEqual([
      {
        sessionId: SID,
        recordingOrdinal: 1,
        startedAtUtc: chunk.startedAtUtc,
        endedAtUtc: chunk.endedAtUtc,
        segmentId: seg.id,
        offsetMs: 0,
        sourceKey: seg.r2_key,
      },
    ]);
    expect(calls.enqueued).toMatchObject([
      { kind: 'ingest', sessionId: SID, target: seg.id, inputBytes: 4096 },
    ]);
  });

  it('a held window answers the holding segment and writes nothing', async () => {
    const merged = baseRow({ id: 'merged-1', media_status: 'done', duration_ms: 1200000 });
    const { media, calls } = fakeMedia(seam({ segmentId: 'merged-1', offsetMs: 600000 }));
    const { audio, state } = store(media, [merged]);
    const seg = await audio.addAudioSegment(chunk);
    expect(seg.existing).toBe(true);
    expect(seg.id).toBe('merged-1');
    expect(state.writes).toEqual([]);
    expect(calls.seams).toEqual([]);
    expect(calls.enqueued).toEqual([]);
  });

  it('an upload without recording_ordinal is unchanged: no lookup, no seam, still an ingest job', async () => {
    const { media, calls } = fakeMedia(seam());
    const { audio } = store(media);
    const seg = await audio.addAudioSegment({ ...chunk, recordingOrdinal: null });
    expect(seg.existing).toBe(false);
    expect(calls.finds).toBe(0);
    expect(calls.seams).toEqual([]);
    expect(calls.enqueued).toHaveLength(1);
  });

  it('without media ports (legacy hubs) it inserts the plain row', async () => {
    const { audio, state } = store(null);
    const seg = await audio.addAudioSegment(chunk);
    expect(seg.existing).toBe(false);
    expect(state.writes).toHaveLength(1);
  });
});

describe('AudioStore.syncAudioFromBlobs enqueues per inserted row (D5)', () => {
  it('one ingest job per adopted key, none for a skipped one', async () => {
    const { media, calls } = fakeMedia(null);
    const { audio } = store(media);
    const id = crypto.randomUUID();
    const out = await audio.syncAudioFromBlobs([
      { r2_key: `audio/${SID}/0001_${id}.webm`, ordinal: 1, bytes: 77 },
      { r2_key: `audio/${SID}/not-a-segment.txt`, ordinal: 2 },
    ]);
    expect(out).toEqual({ inserted: 1 });
    expect(calls.enqueued).toMatchObject([{ kind: 'ingest', target: id, inputBytes: 77 }]);
  });
});
