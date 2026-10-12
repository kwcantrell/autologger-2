// media-worker B.2 (design D3, D5, D6, D7, D18) over the harness registry, which the composition
// root wires with the media ports: the idempotent segment insert (seam + ingest job in one
// transaction, a replay or a concurrent duplicate answered with the holder), finalize and the
// straggler's merge, and the apply of ingest and merge results as the system caller.

import { mergedSegmentId } from '@autologger/session-core/audioStore';
import { SessionHub } from '@autologger/session-core/SessionHub';
import { systemCaller } from '@autologger/session-core/sessionCaller';
import { audioSeams } from '@autologger/storage/audioSeams';
import { mediaJobs } from '@autologger/storage/mediaJobs';
import { describe, expect, it } from 'vitest';
import { env } from '../harness';
import { catalogRoot, createSessionRow, harnessHub, testHub, testStorage } from './sessionRows';

const sys = () => catalogRoot().bindSystem('test-seed');
const at = (min: number) => new Date(Date.UTC(2026, 9, 12, 10, min)).toISOString();

async function jobs(sessionId: string) {
  return sys().all<{
    id: string;
    kind: string;
    target: string;
    status: string;
    input_bytes: number;
    error: string | null;
  }>(
    'SELECT id, kind, target, status, input_bytes, error FROM media_jobs WHERE session_id = ? ORDER BY created_at_ms, id',
    sessionId,
  );
}

async function seams(sessionId: string) {
  return sys().all<{
    started_at_utc: string;
    segment_id: string;
    offset_ms: number;
    source_key: string;
  }>(
    'SELECT started_at_utc, segment_id, offset_ms, source_key FROM session_audio_seams WHERE session_id = ? ORDER BY started_at_utc',
    sessionId,
  );
}

async function setDone(jobId: string, result: unknown) {
  await sys().run(
    `UPDATE media_jobs SET status = 'done', result_json = ? WHERE id = ?`,
    JSON.stringify(result),
    jobId,
  );
}

function chunk(sessionId: string, min: number, over: { ro?: number; bytes?: number } = {}) {
  return {
    sessionId,
    mimeType: 'audio/webm',
    startedAtUtc: at(min),
    endedAtUtc: at(min + 10),
    recordingOrdinal: over.ro ?? 1,
    inputBytes: over.bytes ?? 1000,
  };
}

describe('segment insert with seam and ingest job (D5, D18)', () => {
  it('a new chunk is pending with its own seam and one ingest job carrying input_bytes', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    const seg = await hub.addAudioSegment(chunk(sid, 0, { bytes: 4242 }));
    expect(seg).toMatchObject({
      existing: false,
      media_status: 'pending',
      duration_ms: null,
      seams: null,
    });
    expect(await seams(sid)).toEqual([
      { started_at_utc: at(0), segment_id: seg.id, offset_ms: 0, source_key: seg.r2_key },
    ]);
    expect(await jobs(sid)).toMatchObject([
      { kind: 'ingest', target: seg.id, status: 'queued', input_bytes: 4242 },
    ]);
  });

  it('a replay of the window answers the first segment and stores nothing', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    const first = await hub.addAudioSegment(chunk(sid, 0));
    const again = await hub.addAudioSegment(chunk(sid, 0));
    expect(again.existing).toBe(true);
    expect(again.id).toBe(first.id);
    expect(await hub.listAudioSegments()).toHaveLength(1);
    expect(await jobs(sid)).toHaveLength(1);
  });

  it('two concurrent uploads of one window converge on one row', async () => {
    const sid = await createSessionRow();
    // Two hubs over the same session (two processes): their transactions really race, where one
    // hub would serialise the calls.
    const media = { jobs: mediaJobs, seams: audioSeams, blobBytes: async () => 0 };
    const hubs = [
      testHub(await SessionHub.open(sid, testStorage(sid), undefined, undefined, media)),
      testHub(await SessionHub.open(sid, testStorage(sid), undefined, undefined, media)),
    ];
    const [a, b] = await Promise.all(hubs.map((h) => h.addAudioSegment(chunk(sid, 0))));
    expect(a?.id).toBe(b?.id);
    expect([a?.existing, b?.existing].sort()).toEqual([false, true]);
    const rows = await sys().all('SELECT id FROM session_audio_segments WHERE session_id = ?', sid);
    expect(rows).toHaveLength(1);
    expect(await jobs(sid)).toHaveLength(1);
  });

  it('an upload without recording_ordinal gets no seam and still an ingest job', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    await hub.addAudioSegment({ ...chunk(sid, 0), recordingOrdinal: null });
    await hub.addAudioSegment({ ...chunk(sid, 0), recordingOrdinal: null });
    expect(await hub.listAudioSegments()).toHaveLength(2);
    expect(await seams(sid)).toEqual([]);
    expect(await jobs(sid)).toHaveLength(2);
  });

  it('imports and sync-from-disk enqueue per inserted row', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    const { segment } = await hub.addImportedAudioSegment({
      sessionId: sid,
      mimeType: 'audio/wav',
      startedAtUtc: at(0),
      endedAtUtc: at(5),
      inputBytes: 99,
    });
    const id = crypto.randomUUID();
    await hub.syncAudioFromBlobs([
      { r2_key: `audio/${sid}/0009_${id}.webm`, ordinal: 9, bytes: 7 },
    ]);
    expect(await jobs(sid)).toMatchObject([
      { kind: 'ingest', target: segment.id, input_bytes: 99 },
      { kind: 'ingest', target: id, input_bytes: 7 },
    ]);
    expect((await hub.getAudioSegment(id))?.media_status).toBe('pending');
  });
});

describe('finalize (D6)', () => {
  it('waiting until the straggler arrives, which enqueues the merge once', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    await hub.addAudioSegment(chunk(sid, 0));
    await hub.addAudioSegment(chunk(sid, 10));
    await hub.addAudioSegment(chunk(sid, 30));
    const windows = [at(0), at(10), at(20), at(30)];
    expect(await hub.finalizeRecording(1, windows)).toBe('waiting');
    expect((await jobs(sid)).filter((j) => j.kind === 'merge')).toEqual([]);
    await hub.addAudioSegment(chunk(sid, 20));
    const merges = (await jobs(sid)).filter((j) => j.kind === 'merge');
    expect(merges).toMatchObject([{ target: '1', status: 'queued' }]);
    expect(await hub.finalizeRecording(1, windows)).toBe('already-queued');
  });

  it('queued then already-queued; one segment is not-needed', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    await hub.addAudioSegment(chunk(sid, 0, { ro: 1 }));
    await hub.addAudioSegment(chunk(sid, 10, { ro: 1 }));
    await hub.addAudioSegment(chunk(sid, 40, { ro: 2 }));
    expect(await hub.finalizeRecording(1, [at(0), at(10)])).toBe('queued');
    expect(await hub.finalizeRecording(1, [at(0), at(10)])).toBe('already-queued');
    expect(await hub.finalizeRecording(2, [at(40)])).toBe('not-needed');
    expect((await jobs(sid)).filter((j) => j.kind === 'merge')).toHaveLength(1);
  });
});

const PEAKS = Array.from({ length: 8 }, (_, i) => i / 8);
const apply = async (sid: string) =>
  (await env.ports.sessions.get(sid)).as(systemCaller('media-apply'));

describe('apply (D3, D5, D7) as media-apply', () => {
  it('an ingest result sets duration, peaks and done; a FLAC swaps key and mime', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    const seg = await hub.addAudioSegment({ ...chunk(sid, 0), mimeType: 'audio/wav' });
    const [job] = await jobs(sid);
    await setDone(job?.id as string, {});
    const flacKey = `audio/${sid}/0001_${seg.id}.flac`;
    const out = await (await apply(sid)).applyMediaIngest(job?.id as string, {
      segmentId: seg.id,
      durationMs: 1234,
      peaks: PEAKS,
      flac: { key: flacKey, mime: 'audio/flac' },
    });
    expect(out).toEqual({ kind: 'applied', replacedKey: seg.r2_key });
    expect(await hub.getAudioSegment(seg.id)).toMatchObject({
      duration_ms: 1234,
      media_status: 'done',
      waveform_peaks: PEAKS,
      waveform_db_floor: -48,
      r2_key: flacKey,
      mime_type: 'audio/flac',
    });
    expect((await jobs(sid))[0]?.status).toBe('applied');
    // Applying again changes nothing: the job is no longer done.
    expect(
      await (await apply(sid)).applyMediaIngest(job?.id as string, {
        segmentId: seg.id,
        durationMs: 1,
        peaks: PEAKS,
        flac: null,
      }),
    ).toEqual({ kind: 'stale' });
    expect((await hub.getAudioSegment(seg.id))?.duration_ms).toBe(1234);
  });

  it('an ingest whose target row is gone is cancelled', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    const seg = await hub.addAudioSegment(chunk(sid, 0));
    const [job] = await jobs(sid);
    await setDone(job?.id as string, {});
    await hub.deleteAudioSegment(seg.id);
    expect(
      await (await apply(sid)).applyMediaIngest(job?.id as string, {
        segmentId: seg.id,
        durationMs: 5,
        peaks: PEAKS,
        flac: null,
      }),
    ).toEqual({ kind: 'cancelled' });
    expect((await jobs(sid))[0]).toMatchObject({ status: 'cancelled', error: 'inputs-changed' });
  });

  async function threeChunks(sid: string) {
    const hub = await harnessHub(sid);
    const segs = [];
    for (const m of [0, 10, 20]) segs.push(await hub.addAudioSegment(chunk(sid, m)));
    expect(await hub.finalizeRecording(1, [at(0), at(10), at(20)])).toBe('queued');
    const merge = (await jobs(sid)).find((j) => j.kind === 'merge');
    await setDone(merge?.id as string, {});
    return { hub, segs, mergeId: merge?.id as string };
  }

  function mergeApply(sid: string, mergeId: string, segs: { id: string; r2_key: string }[]) {
    const mergedId = mergedSegmentId(mergeId);
    return {
      recordingOrdinal: 1,
      mergedId,
      key: `audio/${sid}/0001_${mergedId}.webm`,
      mime: 'audio/webm',
      durationMs: 1_800_000,
      peaks: PEAKS,
      seams: segs.map((s, i) => ({
        offsetMs: i * 600_000,
        startedAtUtc: at(i * 10),
        endedAtUtc: at(i * 10 + 10),
        sourceKey: s.r2_key,
      })),
      inputIds: segs.map((s) => s.id),
    };
  }

  it('a merge with matching inputs swaps in one transaction and a replay answers the merged dict', async () => {
    const sid = await createSessionRow();
    const { hub, segs, mergeId } = await threeChunks(sid);
    const a = mergeApply(sid, mergeId, segs);
    const out = await (await apply(sid)).applyMediaMerge(mergeId, a);
    expect(out).toEqual({ kind: 'applied', trashKeys: segs.map((s) => s.r2_key) });
    const list = await hub.listAudioSegments();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: a.mergedId,
      ordinal: segs[0]?.ordinal,
      started_at_utc: at(0),
      ended_at_utc: at(30),
      duration_ms: 1_800_000,
      media_status: 'done',
      recording_ordinal: 1,
      seams: [
        { offset_ms: 0, started_at_utc: at(0), ended_at_utc: at(10) },
        { offset_ms: 600_000, started_at_utc: at(10), ended_at_utc: at(20) },
        { offset_ms: 1_200_000, started_at_utc: at(20), ended_at_utc: at(30) },
      ],
    });
    expect((await seams(sid)).map((x) => x.segment_id)).toEqual([
      a.mergedId,
      a.mergedId,
      a.mergedId,
    ]);
    const all = await jobs(sid);
    expect(all.find((j) => j.id === mergeId)?.status).toBe('applied');
    expect(all.filter((j) => j.target === a.mergedId)).toEqual([]);
    const replay = await hub.addAudioSegment(chunk(sid, 10));
    expect(replay).toMatchObject({ existing: true, id: a.mergedId });
  });

  it('changed inputs cancel the merge and enqueue a new one', async () => {
    const sid = await createSessionRow();
    const { hub, segs, mergeId } = await threeChunks(sid);
    await hub.addAudioSegment(chunk(sid, 30));
    const out = await (await apply(sid)).applyMediaMerge(mergeId, mergeApply(sid, mergeId, segs));
    expect(out).toEqual({ kind: 'cancelled' });
    const merges = (await jobs(sid)).filter((j) => j.kind === 'merge');
    expect(merges.map((j) => j.status)).toEqual(['cancelled', 'queued']);
    expect(await hub.listAudioSegments()).toHaveLength(4);
  });

  it('a held transcript-generation lease leaves the job done and every row as it was', async () => {
    const sid = await createSessionRow();
    const { hub, segs, mergeId } = await threeChunks(sid);
    expect(await hub.claimRunLease('transcript-generation', 'srv:test:run')).toBe(true);
    const out = await (await apply(sid)).applyMediaMerge(mergeId, mergeApply(sid, mergeId, segs));
    expect(out).toEqual({ kind: 'deferred' });
    expect((await jobs(sid)).find((j) => j.id === mergeId)?.status).toBe('done');
    expect(await hub.listAudioSegments()).toHaveLength(3);
  });

  it('a result that drops a held window fails invalid-result and changes nothing', async () => {
    const sid = await createSessionRow();
    const { hub, segs, mergeId } = await threeChunks(sid);
    const a = mergeApply(sid, mergeId, segs);
    const out = await (await apply(sid)).applyMediaMerge(mergeId, {
      ...a,
      seams: a.seams.slice(0, 2),
    });
    expect(out).toEqual({ kind: 'invalid' });
    expect((await jobs(sid)).find((j) => j.id === mergeId)).toMatchObject({
      status: 'failed',
      error: 'invalid-result',
    });
    expect(await hub.listAudioSegments()).toHaveLength(3);
  });

  it('markMediaFailed sets failed with the code', async () => {
    const sid = await createSessionRow();
    const hub = await harnessHub(sid);
    const seg = await hub.addAudioSegment(chunk(sid, 0));
    expect(await (await apply(sid)).markMediaFailed(seg.id, 'decode-failed')).toBe(true);
    expect(await hub.getAudioSegment(seg.id)).toMatchObject({
      media_status: 'failed',
      media_error: 'decode-failed',
    });
  });
});
