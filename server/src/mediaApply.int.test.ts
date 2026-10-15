// media-worker B.5 (design D3, D5, D7, D8) over real bindings: the apply loop adopts the worker's
// files from a real BLOB_DIR/media/<job>/ (owned by this test process, standing in for the worker's
// uid), writes the rows through the hub as media-apply, and trashes replaced blobs.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { mergedSegmentId } from '@autologger/session-core/audioStore';
import { mediaJobs } from '@autologger/storage/mediaJobs';
import { describe, expect, it } from 'vitest';
import { applyMediaJobsOnce, type MediaApplyDeps } from './mediaApply';
import { app, env, testDirs } from './test/harness';
import { seededSession } from './test/helpers';
import { catalogRoot } from './test/session/sessionRows';

const PEAKS = Array.from({ length: 8 }, (_, i) => i / 8);
const at = (min: number) => new Date(Date.UTC(2026, 9, 12, 10, min)).toISOString();
const sys = () => catalogRoot().bindSystem('test-seed');

function deps(): MediaApplyDeps {
  return {
    db: env.ports.catalog.bindSystem('media-apply') as unknown as MediaApplyDeps['db'],
    jobs: mediaJobs,
    sessions: env.ports.sessions,
    blobs: env.ports.mediaBlobs,
    clock: env.ports.clock,
    workerUid: process.getuid?.() ?? 0,
    log: () => {},
  };
}

type Seg = {
  id: string;
  ordinal: number;
  mime_type: string;
  duration_ms: number | null;
  media_status: string | null;
  waveform_peaks: number[] | null;
  seams: unknown;
};

async function upload(
  sid: string,
  q: Record<string, string>,
  mime = 'audio/webm',
  bytes = [1, 2, 3],
) {
  const res = await app.request(
    `/api/sessions/${sid}/audio/segments?${new URLSearchParams(q).toString()}`,
    { method: 'POST', headers: { 'content-type': mime }, body: new Uint8Array(bytes) },
    { ...env },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Seg;
}

async function list(sid: string): Promise<Seg[]> {
  const res = await app.request(
    `/api/sessions/${sid}/audio/segments`,
    { method: 'GET' },
    { ...env },
  );
  return ((await res.json()) as { segments: Seg[] }).segments;
}

async function jobsOf(sid: string) {
  return sys().all<{
    id: string;
    kind: string;
    target: string;
    status: string;
    error: string | null;
  }>(
    'SELECT id, kind, target, status, error FROM media_jobs WHERE session_id = ? ORDER BY created_at_ms, id',
    sid,
  );
}

/** The worker's side: files under media/<job>/ and the job `done` with `result`. */
function workerOutput(jobId: string, files: Record<string, Uint8Array | string>): void {
  const dir = join(testDirs().blobDir, 'media', jobId);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

async function finish(jobId: string, result: unknown) {
  await sys().run(
    `UPDATE media_jobs SET status = 'done', result_json = ? WHERE id = ?`,
    JSON.stringify(result),
    jobId,
  );
}

function trashed(): string[] {
  const root = join(testDirs().blobDir, '.trash');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

const blobPath = (key: string) => join(testDirs().blobDir, key);

describe('ingest results (D5)', () => {
  it('a done ingest sets peaks, duration and done, marks applied and removes the job directory', async () => {
    const { sessionId: sid } = await seededSession();
    const seg = await upload(sid, { recording_ordinal: '1', started_at_utc: at(0) });
    const [job] = await jobsOf(sid);
    workerOutput(job?.id as string, { 'note.txt': 'x' });
    await finish(job?.id as string, {
      duration_ms: 4321,
      peaks: PEAKS,
      codec: 'opus',
      sample_rate: 48000,
      channels: 1,
      flac: null,
    });
    expect((await applyMediaJobsOnce(deps())).applied).toBe(1);
    expect((await list(sid))[0]).toMatchObject({
      id: seg.id,
      duration_ms: 4321,
      media_status: 'done',
      waveform_peaks: PEAKS,
    });
    expect((await jobsOf(sid))[0]?.status).toBe('applied');
    expect(existsSync(join(testDirs().blobDir, 'media', job?.id as string))).toBe(false);
  });

  it('a FLAC result is copied by handle, swaps key and mime, and the WAV goes to the trash', async () => {
    const { sessionId: sid } = await seededSession();
    const seg = await upload(sid, {}, 'audio/wav', [7, 7, 7, 7]);
    const [job] = await jobsOf(sid);
    const flac = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 1, 2, 3]);
    workerOutput(job?.id as string, { 'converted.flac': flac });
    await finish(job?.id as string, {
      duration_ms: 10,
      peaks: PEAKS,
      codec: 'pcm_s16le',
      sample_rate: 48000,
      channels: 1,
      flac: { key: `media/${job?.id}/converted.flac`, mime: 'audio/flac' },
    });
    expect((await applyMediaJobsOnce(deps())).applied).toBe(1);
    const [row] = await list(sid);
    expect(row).toMatchObject({ id: seg.id, mime_type: 'audio/flac', media_status: 'done' });
    const key = (
      await (
        await env.ports.sessions.get(sid)
      )
        .as((await import('@autologger/session-core')).systemCaller('media-apply'))
        .getAudioSegmentKey(seg.id)
    )?.r2_key as string;
    expect(key.endsWith(`${seg.id}.flac`)).toBe(true);
    expect([...readFileSync(blobPath(key))]).toEqual([...flac]);
    expect(trashed().some((n) => n.endsWith(`${seg.id}.wav`))).toBe(true);
    expect(readdirSync(join(testDirs().blobDir, 'audio', sid))).toEqual([key.split('/').pop()]);
  });

  it('an ingest whose target row is gone is cancelled', async () => {
    const { sessionId: sid } = await seededSession();
    const seg = await upload(sid, {});
    const [job] = await jobsOf(sid);
    await sys().run(
      'DELETE FROM session_audio_segments WHERE session_id = ? AND id = ?',
      sid,
      seg.id,
    );
    await finish(job?.id as string, { duration_ms: 5, peaks: PEAKS, flac: null });
    expect((await applyMediaJobsOnce(deps())).cancelled).toBe(1);
    expect((await jobsOf(sid))[0]?.status).toBe('cancelled');
  });

  it('a bad key, bad peaks or a symlinked output fails invalid-result; the segment lists failed', async () => {
    for (const variant of ['key', 'peaks', 'symlink'] as const) {
      const { sessionId: sid } = await seededSession();
      const seg = await upload(sid, {}, 'audio/wav');
      const [job] = await jobsOf(sid);
      const id = job?.id as string;
      if (variant === 'symlink') {
        workerOutput(id, {});
        const other = await upload(sid, { started_at_utc: at(5) });
        void other;
        const target = readdirSync(join(testDirs().blobDir, 'audio', sid))[0] as string;
        symlinkSync(
          join(testDirs().blobDir, 'audio', sid, target),
          join(testDirs().blobDir, 'media', id, 'c.flac'),
        );
      }
      await finish(id, {
        duration_ms: 5,
        peaks: variant === 'peaks' ? [...PEAKS.slice(1), 3] : PEAKS,
        flac: {
          key: variant === 'key' ? 'media/../audio/x.flac' : `media/${id}/c.flac`,
          mime: 'audio/flac',
        },
      });
      await applyMediaJobsOnce(deps());
      expect(
        (await jobsOf(sid)).find((j) => j.id === id),
        variant,
      ).toMatchObject({
        status: 'failed',
        error: 'invalid-result',
      });
      const row = (await list(sid)).find((s) => s.id === seg.id);
      expect(row, variant).toMatchObject({ media_status: 'failed', mime_type: 'audio/wav' });
    }
  });

  it('a job the worker failed sets the segment failed once', async () => {
    const { sessionId: sid } = await seededSession();
    const seg = await upload(sid, {});
    const [job] = await jobsOf(sid);
    await sys().run(
      "UPDATE media_jobs SET status = 'failed', error = 'decode-failed' WHERE id = ?",
      job?.id as string,
    );
    await applyMediaJobsOnce(deps());
    expect((await list(sid))[0]).toMatchObject({ id: seg.id, media_status: 'failed' });
    const [r] = await sys().all<{ applied_at_ms: number | null }>(
      'SELECT applied_at_ms FROM media_jobs WHERE id = ?',
      job?.id as string,
    );
    expect(r?.applied_at_ms).not.toBeNull();
  });
});

describe('merge results (D7)', () => {
  async function recording(sid: string) {
    const segs: Seg[] = [];
    for (const m of [0, 10, 20]) {
      segs.push(
        await upload(sid, {
          recording_ordinal: '1',
          started_at_utc: at(m),
          ended_at_utc: at(m + 10),
        }),
      );
    }
    const fin = await app.request(
      `/api/sessions/${sid}/audio/recordings/1/finalize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chunks: [at(0), at(10), at(20)] }),
      },
      { ...env },
    );
    expect(await fin.json()).toEqual({ ok: true, merge: 'queued' });
    const job = (await jobsOf(sid)).find((j) => j.kind === 'merge');
    return { segs, jobId: job?.id as string };
  }

  function mergeResult(jobId: string, segs: Seg[], extra: Record<string, unknown> = {}) {
    return {
      key: `media/${jobId}/merged.webm`,
      mime: 'audio/webm',
      duration_ms: 1_800_000,
      peaks: PEAKS,
      seams: segs.map((s, i) => ({
        offset_ms: i * 600_000,
        started_at_utc: at(i * 10),
        ended_at_utc: at(i * 10 + 10),
        // A result naming keys is never used to decide what to delete.
        source_key: `audio/elsewhere/${s.id}.webm`,
      })),
      input_ids: segs.map((s) => s.id),
      verify: { merged_samples: 1, expected_samples: 1 },
      ...extra,
    };
  }

  it('matching inputs: one done row under the job-derived key, inputs deleted and trashed, applied', async () => {
    const { sessionId: sid } = await seededSession();
    const { segs, jobId } = await recording(sid);
    const before = readdirSync(join(testDirs().blobDir, 'audio', sid));
    workerOutput(jobId, { 'merged.webm': new Uint8Array([1, 0x45, 0xdf, 0xa3, 9]) });
    await finish(jobId, mergeResult(jobId, segs));
    expect((await applyMediaJobsOnce(deps())).applied).toBe(1);
    const rows = await list(sid);
    const mergedId = mergedSegmentId(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: mergedId, media_status: 'done', duration_ms: 1_800_000 });
    expect(rows[0]?.seams as unknown[]).toHaveLength(3);
    const files = readdirSync(join(testDirs().blobDir, 'audio', sid));
    expect(files).toEqual([`0001_${mergedId}.webm`]);
    for (const f of before) expect(trashed()).toContain(f);
    const all = await jobsOf(sid);
    expect(all.find((j) => j.id === jobId)?.status).toBe('applied');
    expect(all.filter((j) => j.target === mergedId)).toEqual([]);
    expect(existsSync(join(testDirs().blobDir, 'media', jobId))).toBe(false);
  });

  it('idempotent across a crash between the copy and the commit', async () => {
    const { sessionId: sid } = await seededSession();
    const { segs, jobId } = await recording(sid);
    const mergedId = mergedSegmentId(jobId);
    // The previous attempt copied the file and removed the job directory, then died.
    writeFileSync(blobPath(`audio/${sid}/0001_${mergedId}.webm`), new Uint8Array([5, 5]));
    await finish(jobId, mergeResult(jobId, segs));
    expect((await applyMediaJobsOnce(deps())).applied).toBe(1);
    expect((await list(sid)).map((s) => s.id)).toEqual([mergedId]);
    expect(readdirSync(join(testDirs().blobDir, 'audio', sid))).toEqual([`0001_${mergedId}.webm`]);
  });

  it('changed inputs cancel the job, remove its directory and enqueue a new merge', async () => {
    const { sessionId: sid } = await seededSession();
    const { segs, jobId } = await recording(sid);
    await upload(sid, { recording_ordinal: '1', started_at_utc: at(30) });
    workerOutput(jobId, { 'merged.webm': new Uint8Array([1]) });
    await finish(jobId, mergeResult(jobId, segs));
    expect((await applyMediaJobsOnce(deps())).cancelled).toBe(1);
    const merges = (await jobsOf(sid)).filter((j) => j.kind === 'merge');
    expect(merges.map((j) => [j.status, j.error])).toEqual([
      ['cancelled', 'inputs-changed'],
      ['queued', null],
    ]);
    expect(existsSync(join(testDirs().blobDir, 'media', jobId))).toBe(false);
    expect(await list(sid)).toHaveLength(4);
  });

  it('a held transcript-generation lease leaves the job done and nothing changed', async () => {
    const { sessionId: sid } = await seededSession();
    const { segs, jobId } = await recording(sid);
    const hub = await env.ports.sessions.get(sid);
    const { systemCaller } = await import('@autologger/session-core');
    expect(
      await hub.as(systemCaller('media-apply')).claimRunLease('transcript-generation', 'srv:t:run'),
    ).toBe(true);
    workerOutput(jobId, { 'merged.webm': new Uint8Array([1]) });
    await finish(jobId, mergeResult(jobId, segs));
    expect((await applyMediaJobsOnce(deps())).deferred).toBe(1);
    expect((await jobsOf(sid)).find((j) => j.id === jobId)?.status).toBe('done');
    expect(await list(sid)).toHaveLength(3);
    expect(existsSync(join(testDirs().blobDir, 'media', jobId, 'merged.webm'))).toBe(true);
  });

  it('an oversize or foreign-key merge result fails invalid-result and the chunks stay', async () => {
    const { sessionId: sid } = await seededSession();
    const { segs, jobId } = await recording(sid);
    await finish(jobId, mergeResult(jobId, segs, { key: 'media/other-job/merged.webm' }));
    await applyMediaJobsOnce(deps());
    expect((await jobsOf(sid)).find((j) => j.id === jobId)).toMatchObject({
      status: 'failed',
      error: 'invalid-result',
    });
    expect(await list(sid)).toHaveLength(3);
  });
});

// Implementation panel (B.9): a transient error never cancels a job; worker error text is mapped.
describe('apply failures (B.9)', () => {
  it('a session lookup that fails transiently leaves the job done; a missing session cancels it', async () => {
    const { SessionNotFoundError } = await import('@autologger/storage');
    const { sessionId: sid } = await seededSession();
    await upload(sid, {});
    const [job] = await jobsOf(sid);
    await finish(job?.id as string, { duration_ms: 5, peaks: PEAKS, flac: null });
    const flaky = {
      ...deps(),
      sessions: { get: async () => Promise.reject(new Error('ECONNRESET')) } as never,
    };
    const out = await applyMediaJobsOnce(flaky);
    expect(out.error).toBe(1);
    expect((await jobsOf(sid))[0]?.status).toBe('done');
    const gone = {
      ...deps(),
      sessions: { get: async () => Promise.reject(new SessionNotFoundError('gone')) } as never,
    };
    expect((await applyMediaJobsOnce(gone)).cancelled).toBe(1);
    expect((await jobsOf(sid))[0]?.status).toBe('cancelled');
  });
});
