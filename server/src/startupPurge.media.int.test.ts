// media-worker B.5 (design D6): the merge reconcile over Postgres. Only recordings with two or more
// processed segments (non-null media_status) whose newest chunk ended over 30 min ago, with no live
// merge and no failed/cancelled merge in the last 24 h, get a merge job.
import { mediaJobs } from '@autologger/storage/mediaJobs';
import { describe, expect, it } from 'vitest';
import { reconcileMergesOnce } from './startupPurge';
import { app, env } from './test/harness';
import { seededSession } from './test/helpers';
import { catalogRoot } from './test/session/sessionRows';

const sys = () => catalogRoot().bindSystem('test-seed');
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const at = (min: number) => new Date(Date.UTC(2026, 9, 12, 10, min)).toISOString();

async function chunk(sid: string, ro: number, min: number) {
  const q = new URLSearchParams({
    recording_ordinal: String(ro),
    started_at_utc: at(min),
    ended_at_utc: at(min + 10),
  });
  const res = await app.request(
    `/api/sessions/${sid}/audio/segments?${q}`,
    {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: new Uint8Array([1, 2, 3, 4]),
    },
    { ...env },
  );
  expect(res.status).toBe(200);
}

const merges = async (sid: string) =>
  sys().all<{ target: string; status: string; input_bytes: number }>(
    "SELECT target, status, input_bytes FROM media_jobs WHERE session_id = ? AND kind = 'merge' ORDER BY target, created_at_ms",
    sid,
  );

const run = (now = NOW) =>
  reconcileMergesOnce({
    db: env.ports.catalog.bindSystem('media-reconcile') as never,
    jobs: mediaJobs,
    clock: { now: () => now },
    blobBytes: async () => 4,
    warn: () => {},
  });

describe('reconcileMergesOnce (D6)', () => {
  it("enqueues a stale multi-chunk recording once, with its inputs' bytes", async () => {
    const { sessionId: sid } = await seededSession();
    await chunk(sid, 1, 0);
    await chunk(sid, 1, 10);
    await run();
    await run();
    expect(await merges(sid)).toEqual([{ target: '1', status: 'queued', input_bytes: 8 }]);
  });

  it('skips a recent, single-chunk or legacy (null media_status) recording', async () => {
    const { sessionId: sid } = await seededSession();
    await chunk(sid, 1, 0);
    await chunk(sid, 1, 10);
    await chunk(sid, 2, 30);
    await chunk(sid, 3, 40);
    await chunk(sid, 3, 50);
    await sys().run(
      'UPDATE session_audio_segments SET media_status = NULL WHERE session_id = ? AND recording_ordinal = 3',
      sid,
    );
    // A legacy recording the operator backfilled: a status but no seams (chunked before seams).
    await chunk(sid, 4, 60);
    await chunk(sid, 4, 70);
    await sys().run(
      'DELETE FROM session_audio_seams WHERE session_id = ? AND recording_ordinal = 4',
      sid,
    );
    // 10:20 + 30 min is not yet past at 10:45.
    await run(Date.UTC(2026, 9, 12, 10, 45));
    expect(await merges(sid)).toEqual([]);
    await run(Date.UTC(2026, 9, 12, 13, 0));
    expect((await merges(sid)).map((m) => m.target)).toEqual(['1']);
  });

  it('holds off 24 h after a failed or cancelled merge', async () => {
    const { sessionId: sid } = await seededSession();
    await chunk(sid, 1, 0);
    await chunk(sid, 1, 10);
    await run();
    await sys().run(
      "UPDATE media_jobs SET status = 'failed', error = 'mixed-codecs', updated_at_ms = ? WHERE session_id = ? AND kind = 'merge'",
      NOW - 3_600_000,
      sid,
    );
    await run();
    expect((await merges(sid)).map((m) => m.status)).toEqual(['failed']);
    await run(NOW + 24 * 3_600_000);
    expect((await merges(sid)).map((m) => m.status)).toEqual(['failed', 'queued']);
  });
});

/** The apply loop's failed-job pass, which records a deterministic merge failure. */
async function reflectFailures() {
  const { applyFailedJobs } = await import('./mediaApply');
  await applyFailedJobs({
    db: env.ports.catalog.bindSystem('media-apply') as never,
    jobs: mediaJobs,
    sessions: env.ports.sessions,
    blobs: env.ports.mediaBlobs,
    clock: env.ports.clock,
    log: () => {},
  });
}

describe('reconcile and deterministic merge failures (B.9)', () => {
  it('mixed-codecs or interleaved-input blocks the same inputs for good; a new chunk lifts it', async () => {
    for (const code of ['mixed-codecs', 'interleaved-input']) {
      const { sessionId: sid } = await seededSession();
      await chunk(sid, 1, 0);
      await chunk(sid, 1, 10);
      await run();
      await sys().run(
        "UPDATE media_jobs SET status = 'failed', error = ?, updated_at_ms = ? WHERE session_id = ? AND kind = 'merge'",
        code,
        NOW,
        sid,
      );
      await reflectFailures();
      await run(NOW + 30 * 24 * 3_600_000);
      // Even once the terminal row is swept away, the block holds for this input set.
      await sys().run("DELETE FROM media_jobs WHERE session_id = ? AND kind = 'merge'", sid);
      await run(NOW + 31 * 24 * 3_600_000);
      expect(await merges(sid), code).toEqual([]);
      await chunk(sid, 1, 20);
      await run(NOW + 32 * 24 * 3_600_000);
      expect(
        (await merges(sid)).map((m) => m.status),
        code,
      ).toEqual(['queued']);
    }
  });

  it('a non-deterministic failure (verify-mismatch) is retried after 24 h', async () => {
    const { sessionId: sid } = await seededSession();
    await chunk(sid, 1, 0);
    await chunk(sid, 1, 10);
    await run();
    await sys().run(
      "UPDATE media_jobs SET status = 'failed', error = 'verify-mismatch', updated_at_ms = ? WHERE session_id = ? AND kind = 'merge'",
      NOW,
      sid,
    );
    await reflectFailures();
    await run(NOW + 25 * 3_600_000);
    expect((await merges(sid)).map((m) => m.status)).toEqual(['failed', 'queued']);
  });
});

describe('trashOrphanBlobsOnce (blob-before-row crash residue)', () => {
  it('trashes an hour-old blob no row names; keeps named, fresh and pending-merge blobs', async () => {
    const { mkdirSync, utimesSync, writeFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { mergedSegmentId } = await import('@autologger/session-core/audioStore');
    const { trashOrphanBlobsOnce } = await import('./startupPurge');
    const { testDirs } = await import('./test/harness');
    const { sessionId: sid } = await seededSession();
    await chunk(sid, 1, 0);
    await chunk(sid, 1, 10);
    await run();
    const [merge] = await sys().all<{ id: string }>(
      "SELECT id FROM media_jobs WHERE session_id = ? AND kind = 'merge'",
      sid,
    );
    const dir = join(testDirs().blobDir, 'audio', sid);
    mkdirSync(dir, { recursive: true });
    const old = (Date.now() - 2 * 3_600_000) / 1000;
    const orphan = `0099_${crypto.randomUUID()}.webm`;
    const fresh = `0098_${crypto.randomUUID()}.webm`;
    const pending = `0001_${mergedSegmentId(String(merge?.id))}.webm`;
    for (const f of [orphan, fresh, pending]) writeFileSync(join(dir, f), 'x');
    utimesSync(join(dir, orphan), old, old);
    utimesSync(join(dir, pending), old, old);
    const named = (
      await sys().all<{ r2_key: string }>(
        'SELECT r2_key FROM session_audio_segments WHERE session_id = ?',
        sid,
      )
    ).map((r) => r.r2_key);
    for (const k of named) utimesSync(join(testDirs().blobDir, k), old, old);
    const moved = await trashOrphanBlobsOnce({
      db: env.ports.catalog.bindSystem('media-sweep') as never,
      blobs: env.ports.mediaBlobs as never,
      clock: { now: () => Date.now() },
      warn: () => {},
    });
    expect(moved).toBe(1);
    expect(existsSync(join(dir, orphan))).toBe(false);
    for (const f of [fresh, pending]) expect(existsSync(join(dir, f)), f).toBe(true);
    for (const k of named) expect(existsSync(join(testDirs().blobDir, k)), k).toBe(true);
  });
});
