// media-worker B.3 (design D6, D16, D18): the idempotent segment POST over the real routes and the
// recording finalize endpoint (api-contract-freeze "Recording finalize endpoint", "Segment upload
// is idempotent per recording window", "Audio segments carry duration, media status and seams").

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mergedSegmentId } from '@autologger/session-core/audioStore';
import { systemCaller } from '@autologger/session-core/sessionCaller';
import { describe, expect, it } from 'vitest';
import { app, env, testDirs } from '../test/harness';
import { seededSession } from '../test/helpers';
import { catalogRoot } from '../test/session/sessionRows';

const at = (min: number) => new Date(Date.UTC(2026, 9, 12, 10, min)).toISOString();

type Dict = Record<string, unknown> & { id: string; r2_key?: never };

async function post(sid: string, q: Record<string, string>, bytes = [1, 2, 3]) {
  const qs = new URLSearchParams(q).toString();
  return app.request(
    `/api/sessions/${sid}/audio/segments?${qs}`,
    { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(bytes) },
    { ...env },
  );
}

const chunkQ = (min: number, ro = 1) => ({
  recording_ordinal: String(ro),
  started_at_utc: at(min),
  ended_at_utc: at(min + 10),
});

async function list(sid: string): Promise<Dict[]> {
  const res = await app.request(
    `/api/sessions/${sid}/audio/segments`,
    { method: 'GET' },
    { ...env },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { segments: Dict[] }).segments;
}

function blobFiles(sid: string): string[] {
  try {
    return readdirSync(join(testDirs().blobDir, 'audio', sid));
  } catch {
    return [];
  }
}

async function finalize(sid: string, ordinal: string, body: unknown) {
  return app.request(
    `/api/sessions/${sid}/audio/recordings/${ordinal}/finalize`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { ...env },
  );
}

async function mergeJobs(sid: string) {
  return catalogRoot()
    .bindSystem('test-seed')
    .all<{ id: string; status: string }>(
      "SELECT id, status FROM media_jobs WHERE session_id = ? AND kind = 'merge' ORDER BY created_at_ms",
      sid,
    );
}

describe('segment POST is idempotent per recording window (D18)', () => {
  it('a fresh chunk is pending with 12 keys; a replay answers the same dict and stores nothing', async () => {
    const { sessionId: sid } = await seededSession();
    const first = await post(sid, chunkQ(0));
    expect(first.status).toBe(200);
    const d1 = (await first.json()) as Dict;
    expect(Object.keys(d1)).toHaveLength(12);
    expect(d1).toMatchObject({ media_status: 'pending', duration_ms: null, seams: null });
    const again = await post(sid, chunkQ(0), [9, 9, 9, 9]);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(d1);
    expect(await list(sid)).toHaveLength(1);
    expect(blobFiles(sid)).toHaveLength(1);
  });

  it('two concurrent uploads of one window converge on one row and one blob', async () => {
    const { sessionId: sid } = await seededSession();
    const [a, b] = await Promise.all([post(sid, chunkQ(0)), post(sid, chunkQ(0))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [da, db] = [(await a.json()) as Dict, (await b.json()) as Dict];
    expect(da.id).toBe(db.id);
    expect(await list(sid)).toHaveLength(1);
    expect(blobFiles(sid)).toHaveLength(1);
  });

  it('a chunk merged away answers the merged segment and creates nothing', async () => {
    const { sessionId: sid } = await seededSession();
    const ids: string[] = [];
    for (const m of [0, 10]) ids.push(((await (await post(sid, chunkQ(m))).json()) as Dict).id);
    const fin = await finalize(sid, '1', { chunks: [at(0), at(10)] });
    expect(await fin.json()).toEqual({ ok: true, merge: 'queued' });
    const [job] = await mergeJobs(sid);
    await catalogRoot()
      .bindSystem('test-seed')
      .run(
        "UPDATE media_jobs SET status = 'done', result_json = '{}' WHERE id = ?",
        job?.id as string,
      );
    const before = await list(sid);
    const mergedId = mergedSegmentId(job?.id as string);
    const hub = (await env.ports.sessions.get(sid)).as(systemCaller('media-apply'));
    const out = await hub.applyMediaMerge(job?.id as string, {
      recordingOrdinal: 1,
      mergedId,
      key: `audio/${sid}/0001_${mergedId}.webm`,
      mime: 'audio/webm',
      durationMs: 1_200_000,
      peaks: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
      seams: before.map((s, i) => ({
        offsetMs: i * 600_000,
        startedAtUtc: String(s.started_at_utc),
        endedAtUtc: String(s.ended_at_utc),
        sourceKey: `audio/${sid}/x${i}`,
      })),
      inputIds: ids,
    });
    expect(out.kind).toBe('applied');
    const files = blobFiles(sid).length;
    const replay = await post(sid, chunkQ(10));
    expect(replay.status).toBe(200);
    const d = (await replay.json()) as Dict;
    expect(d).toMatchObject({
      id: mergedId,
      media_status: 'done',
      duration_ms: 1_200_000,
      seams: [
        { offset_ms: 0, started_at_utc: at(0), ended_at_utc: at(10) },
        { offset_ms: 600_000, started_at_utc: at(10), ended_at_utc: at(20) },
      ],
    });
    expect(await list(sid)).toHaveLength(1);
    expect(blobFiles(sid)).toHaveLength(files);
  });

  it('uploads without recording_ordinal are unchanged: each stores a row', async () => {
    const { sessionId: sid } = await seededSession();
    const q = { started_at_utc: at(0) };
    expect((await post(sid, q)).status).toBe(200);
    expect((await post(sid, q)).status).toBe(200);
    expect(await list(sid)).toHaveLength(2);
  });
});

describe('POST …/audio/recordings/:recordingOrdinal/finalize (D6)', () => {
  it('400 for a bad ordinal or bad chunks, 404 for an unknown session', async () => {
    const { sessionId: sid } = await seededSession();
    for (const ord of ['0', 'abc', '-1', '1.5', '99999999999999999999']) {
      const res = await finalize(sid, ord, { chunks: [at(0)] });
      expect(res.status, ord).toBe(400);
      expect(await res.json()).toHaveProperty('detail');
    }
    for (const body of [{}, { chunks: [] }, { chunks: [1] }, { chunks: ['not a date'] }]) {
      const res = await finalize(sid, '1', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toHaveProperty('detail');
    }
    const missing = await finalize(crypto.randomUUID(), '1', { chunks: [at(0)] });
    expect(missing.status).toBe(404);
  });

  it('not-needed for one segment; queued then already-queued for two', async () => {
    const { sessionId: sid } = await seededSession();
    await post(sid, chunkQ(0, 1));
    expect(await (await finalize(sid, '1', { chunks: [at(0)] })).json()).toEqual({
      ok: true,
      merge: 'not-needed',
    });
    await post(sid, chunkQ(20, 2));
    await post(sid, chunkQ(30, 2));
    const body = { chunks: [at(20), at(30)] };
    expect(await (await finalize(sid, '2', body)).json()).toEqual({ ok: true, merge: 'queued' });
    expect(await (await finalize(sid, '2', body)).json()).toEqual({
      ok: true,
      merge: 'already-queued',
    });
    expect(await mergeJobs(sid)).toHaveLength(1);
  });

  it('waiting while a listed window is missing; the straggler enqueues the merge', async () => {
    const { sessionId: sid } = await seededSession();
    for (const m of [0, 10, 30]) await post(sid, chunkQ(m));
    const body = { chunks: [at(0), at(10), at(20), at(30)] };
    expect(await (await finalize(sid, '1', body)).json()).toEqual({ ok: true, merge: 'waiting' });
    expect(await mergeJobs(sid)).toEqual([]);
    expect((await post(sid, chunkQ(20))).status).toBe(200);
    expect(await mergeJobs(sid)).toMatchObject([{ status: 'queued' }]);
  });

  it('window keys are normalised like the segment POST (…Z vs +00:00)', async () => {
    const { sessionId: sid } = await seededSession();
    await post(sid, { recording_ordinal: '1', started_at_utc: '2026-10-12T10:00:00+00:00' });
    await post(sid, { recording_ordinal: '1', started_at_utc: '2026-10-12T10:10:00Z' });
    const res = await finalize(sid, '1', {
      chunks: ['2026-10-12T10:00:00.000Z', '2026-10-12T10:10:00.000+00:00'],
    });
    expect(await res.json()).toEqual({ ok: true, merge: 'queued' });
  });
});
