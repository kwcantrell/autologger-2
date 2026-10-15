// media-worker design D2 (task S.3): the media job statements of `mediaJobs.ts`. API-side
// statements run on a `catalog_system` binding of the Postgres catalog adapter; worker-side ones on
// postgres.js connections as `autologger_media` (its grants and guard trigger apply), through
// `postgresMediaSql`. The role's connection limit is 4: this file holds at most three of them.
import type { CatalogDb } from '@autologger/ports';
import type { MediaSql } from '@autologger/ports/media';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { mediaJobs, postgresMediaSql } from './mediaJobs';
import { MEDIA_JOB_LEASE_MS, mediaJobBackoffMs } from './mediaLimits';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { createTestDatabase } from './test/pgDb';

const roots: PostgresCatalogDb[] = [];
const clients: postgres.Sql[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => r.close()));
  await Promise.all(clients.splice(0).map((c) => c.end()));
});

const MiB = 1024 * 1024;

async function env(workers = 1) {
  const db = await createTestDatabase();
  const root = new PostgresCatalogDb(db.app);
  roots.push(root);
  const sys: CatalogDb = root.bindSystem('test');
  await sys.run(`INSERT INTO sessions (id) VALUES ('s1'), ('s2')`);
  const ws: MediaSql[] = [];
  for (let i = 0; i < workers; i++) {
    const c = postgres({ ...db.media, max: 1, onnotice: () => {} });
    clients.push(c);
    ws.push(postgresMediaSql(c));
  }
  let n = 0;
  const enqueue = (
    over: Partial<Parameters<typeof mediaJobs.enqueue>[1]> = {},
  ): Promise<boolean> => {
    n += 1;
    return mediaJobs.enqueue(sys, {
      id: `j${n}`,
      kind: 'ingest',
      sessionId: 's1',
      target: `seg-${n}`,
      inputBytes: 1000,
      nowMs: Date.now() - 1000 + n,
      ...over,
    });
  };
  return { db, sys, ws, enqueue };
}

const W = (i: number) => `worker-${i}`;

describe('enqueue (D2)', () => {
  it('coalesces on the live unique index and records input_bytes', async () => {
    const { sys, enqueue } = await env(0);
    const now = Date.now();
    expect(await enqueue({ id: 'a', target: 'seg', inputBytes: 12_345, nowMs: now })).toBe(true);
    expect(await enqueue({ id: 'b', target: 'seg', nowMs: now })).toBe(false);
    // Another kind or another target is another job.
    expect(await enqueue({ id: 'c', target: 'seg', kind: 'merge', nowMs: now })).toBe(true);
    expect(await enqueue({ id: 'd', target: 'seg2', nowMs: now })).toBe(true);
    const a = await mediaJobs.get(sys, 'a');
    expect(a).toMatchObject({
      id: 'a',
      kind: 'ingest',
      sessionId: 's1',
      target: 'seg',
      status: 'queued',
      attempts: 0,
      maxAttempts: 5,
      inputBytes: 12_345,
      runAfterMs: now,
      lockedBy: null,
      lockedUntilMs: null,
      resultJson: null,
      error: null,
      createdAtMs: now,
      updatedAtMs: now,
      appliedAtMs: null,
    });
    expect(await mediaJobs.get(sys, 'b')).toBeNull();
    expect((await mediaJobs.liveJob(sys, 'ingest', 's1', 'seg'))?.id).toBe('a');
    // Once the live job is terminal, the target can be enqueued again.
    expect(await mediaJobs.markCancelled(sys, 'a', 'inputs-changed', now)).toBe(true);
    expect(await mediaJobs.liveJob(sys, 'ingest', 's1', 'seg')).toBeNull();
    expect(await enqueue({ id: 'e', target: 'seg', nowMs: now })).toBe(true);
  });

  it('commits with the transaction that causes it and wakes listeners', async () => {
    const { db, sys, enqueue } = await env(0);
    const listener = postgres({ ...db.media, max: 1, onnotice: () => {} });
    clients.push(listener);
    const got: string[] = [];
    await listener.listen('media_jobs', (p) => got.push(`[${p}]`));
    await expect(
      sys.tx(async (t) => {
        await mediaJobs.enqueue(t, {
          id: 'rolled-back',
          kind: 'ingest',
          sessionId: 's1',
          target: 'x',
          inputBytes: 1,
          nowMs: Date.now(),
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await mediaJobs.get(sys, 'rolled-back')).toBeNull();
    expect(await enqueue()).toBe(true);
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(['[]']);
  });
});

describe('claim (D2)', () => {
  it('hands each job to exactly one of two concurrent claimers', async () => {
    const { ws, enqueue } = await env(2);
    for (let i = 0; i < 12; i++) await enqueue();
    const claimed: string[][] = [[], []];
    await Promise.all(
      [0, 1].map(async (i) => {
        for (;;) {
          const job = await mediaJobs.claim(ws[i] as MediaSql, {
            workerId: W(i),
            nowMs: Date.now(),
            maxInputBytes: Number.MAX_SAFE_INTEGER,
          });
          if (!job) return;
          expect(job).toMatchObject({ status: 'running', lockedBy: W(i), attempts: 1 });
          claimed[i]?.push(job.id);
        }
      }),
    );
    const all = [...(claimed[0] ?? []), ...(claimed[1] ?? [])].sort();
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
  });

  it('with one queued job and two claimers at once, exactly one receives it', async () => {
    const { ws, enqueue } = await env(2);
    await enqueue({ id: 'only' });
    const got = await Promise.all(
      [0, 1].map((i) =>
        mediaJobs.claim(ws[i] as MediaSql, {
          workerId: W(i),
          nowMs: Date.now(),
          maxInputBytes: 10 * MiB,
        }),
      ),
    );
    expect(got.filter((j) => j !== null).map((j) => j?.id)).toEqual(['only']);
  });

  it('takes the earliest due run_after_ms, then the earliest created, within the lane and kinds', async () => {
    const { ws, enqueue } = await env(1);
    const w = ws[0] as MediaSql;
    const now = Date.now();
    await enqueue({ id: 'late', nowMs: now - 100 });
    await enqueue({ id: 'big', nowMs: now - 500, inputBytes: 65 * MiB });
    await enqueue({ id: 'first', nowMs: now - 300 });
    await enqueue({ id: 'second', nowMs: now - 300, kind: 'merge', target: '1' });
    await enqueue({ id: 'future', nowMs: now + 60_000 });
    const claim = (maxInputBytes: number, kinds?: ('ingest' | 'merge')[]) =>
      mediaJobs.claim(w, { workerId: W(0), nowMs: now, maxInputBytes, kinds });
    // `first` and `second` share run_after_ms; creation order breaks the tie (same ms here, so the
    // id); the small lane skips `big`, which the large lane takes first.
    expect((await claim(64 * MiB, ['ingest']))?.id).toBe('first');
    expect((await claim(64 * MiB, ['ingest']))?.id).toBe('late');
    expect(await claim(64 * MiB, ['ingest'])).toBeNull();
    expect((await claim(64 * MiB))?.id).toBe('second');
    expect((await claim(Number.MAX_SAFE_INTEGER))?.id).toBe('big');
    expect(await claim(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('sets the lease from the claim time', async () => {
    const { ws, enqueue } = await env(1);
    await enqueue({ id: 'a' });
    const now = Date.now();
    const job = await mediaJobs.claim(ws[0] as MediaSql, {
      workerId: W(0),
      nowMs: now,
      maxInputBytes: MiB,
    });
    expect(job).toMatchObject({ lockedUntilMs: now + MEDIA_JOB_LEASE_MS, updatedAtMs: now });
  });
});

describe('renew, finish, fail and release are fenced on the lease (D2)', () => {
  async function claimed() {
    const e = await env(2);
    await e.enqueue({ id: 'a' });
    const w = e.ws[0] as MediaSql;
    const job = await mediaJobs.claim(w, { workerId: W(0), nowMs: Date.now(), maxInputBytes: MiB });
    expect(job?.id).toBe('a');
    return { ...e, w, w2: e.ws[1] as MediaSql };
  }

  it('the holder renews and finishes; the result and the done notification land', async () => {
    const { sys, db, w } = await claimed();
    const listener = postgres({ ...db.app, max: 1, onnotice: () => {} });
    clients.push(listener);
    const got: string[] = [];
    await listener.listen('media_jobs_done', (p) => got.push(`[${p}]`));
    const now = Date.now();
    expect(await mediaJobs.renew(w, { id: 'a', workerId: W(0), nowMs: now })).toBe(true);
    expect((await mediaJobs.get(sys, 'a'))?.lockedUntilMs).toBe(now + MEDIA_JOB_LEASE_MS);
    expect(
      await mediaJobs.finish(w, { id: 'a', workerId: W(0), nowMs: now, resultJson: '{"x":1}' }),
    ).toBe(true);
    expect(await mediaJobs.get(sys, 'a')).toMatchObject({
      status: 'done',
      resultJson: '{"x":1}',
      lockedBy: W(0),
      attempts: 1,
    });
    expect((await mediaJobs.doneJobs(sys, 10)).map((j) => j.id)).toEqual(['a']);
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(['[]']);
    // Finished: no further worker statement applies.
    expect(await mediaJobs.renew(w, { id: 'a', workerId: W(0), nowMs: now })).toBe(false);
  });

  it('after a takeover, the old holder changes nothing', async () => {
    const { sys, w, w2 } = await claimed();
    // The lease expires (as seen from the future), a sweep re-queues it, another worker claims it.
    const later = Date.now() + MEDIA_JOB_LEASE_MS + 1;
    expect(await mediaJobs.requeueExpired(w2, later)).toBe(1);
    const taken = await mediaJobs.claim(w2, {
      workerId: W(1),
      nowMs: later + mediaJobBackoffMs(1),
      maxInputBytes: MiB,
      // The trigger bounds a lease to 15 min past the database clock (S.7); this claim's clock is
      // ~10.5 min ahead.
      leaseMs: 60_000,
    });
    expect(taken).toMatchObject({ id: 'a', lockedBy: W(1), attempts: 2 });
    const now = Date.now();
    expect(await mediaJobs.renew(w, { id: 'a', workerId: W(0), nowMs: now })).toBe(false);
    expect(
      await mediaJobs.finish(w, { id: 'a', workerId: W(0), nowMs: now, resultJson: '{}' }),
    ).toBe(false);
    expect(
      await mediaJobs.fail(w, { id: 'a', workerId: W(0), nowMs: now, error: 'internal' }),
    ).toBe(false);
    expect(
      await mediaJobs.release(w, { id: 'a', workerId: W(0), nowMs: now, runAfterMs: now }),
    ).toBe(false);
    expect(await mediaJobs.get(sys, 'a')).toMatchObject({
      status: 'running',
      lockedBy: W(1),
      resultJson: null,
    });
  });

  it('fail backs off 30 s doubling, then fails for good at max_attempts', async () => {
    const { sys, w } = await claimed();
    let now = Date.now();
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(
        await mediaJobs.fail(w, { id: 'a', workerId: W(0), nowMs: now, error: 'decode-failed' }),
      ).toBe(true);
      const job = await mediaJobs.get(sys, 'a');
      if (attempt < 5) {
        expect(job, `attempt ${attempt}`).toMatchObject({
          status: 'queued',
          error: 'decode-failed',
          attempts: attempt,
          runAfterMs: now + 30_000 * 2 ** (attempt - 1),
          lockedUntilMs: null,
        });
        now = job?.runAfterMs ?? now;
        expect(
          // A short lease: this clock runs ahead of the database's (the S.7 bound is 15 min).
          (
            await mediaJobs.claim(w, {
              workerId: W(0),
              nowMs: now,
              maxInputBytes: MiB,
              leaseMs: 60_000,
            })
          )?.id,
        ).toBe('a');
      } else {
        expect(job).toMatchObject({ status: 'failed', error: 'decode-failed', attempts: 5 });
      }
    }
  });

  it('a final failure fails at once; a release gives the attempt back', async () => {
    const { sys, w, enqueue } = await claimed();
    const now = Date.now();
    expect(
      await mediaJobs.release(w, {
        id: 'a',
        workerId: W(0),
        nowMs: now,
        runAfterMs: now + 5000,
        error: 'low-disk',
      }),
    ).toBe(true);
    expect(await mediaJobs.get(sys, 'a')).toMatchObject({
      status: 'queued',
      attempts: 0,
      runAfterMs: now + 5000,
      error: 'low-disk',
    });
    await enqueue({ id: 'b' });
    expect((await mediaJobs.claim(w, { workerId: W(0), nowMs: now, maxInputBytes: MiB }))?.id).toBe(
      'b',
    );
    expect(
      await mediaJobs.fail(w, {
        id: 'b',
        workerId: W(0),
        nowMs: now,
        error: 'mixed-codecs',
        final: true,
      }),
    ).toBe(true);
    expect(await mediaJobs.get(sys, 'b')).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('the backoff is capped at one hour', () => {
    expect([1, 2, 3, 7, 8, 20].map(mediaJobBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
  });
});

describe('requeueExpired (D2)', () => {
  it('re-queues expired running jobs with backoff, fails exhausted ones, leaves live leases', async () => {
    const { sys, ws, enqueue } = await env(1);
    const w = ws[0] as MediaSql;
    const now = Date.now();
    await enqueue({ id: 'x' });
    await enqueue({ id: 'y' });
    await enqueue({ id: 'z' });
    for (const id of ['x', 'y', 'z']) {
      expect(
        (await mediaJobs.claim(w, { workerId: W(0), nowMs: now, maxInputBytes: MiB }))?.id,
      ).toBe(id);
    }
    // y has spent its attempts; z's lease is renewed past the sweep time.
    await sys.run(`UPDATE media_jobs SET max_attempts = 1 WHERE id = 'y'`);
    const sweep = now + MEDIA_JOB_LEASE_MS + 1;
    expect(
      await mediaJobs.renew(w, { id: 'z', workerId: W(0), nowMs: sweep, leaseMs: 60_000 }),
    ).toBe(true);
    expect(await mediaJobs.requeueExpired(sys, sweep)).toBe(2);
    expect(await mediaJobs.get(sys, 'x')).toMatchObject({
      status: 'queued',
      error: 'timeout',
      runAfterMs: sweep + 30_000,
      lockedUntilMs: null,
    });
    expect(await mediaJobs.get(sys, 'y')).toMatchObject({ status: 'failed', error: 'timeout' });
    expect((await mediaJobs.get(sys, 'z'))?.status).toBe('running');
  });
});

describe('the API side (D3, D6)', () => {
  it('marks done jobs applied or failed, cancels live ones, and deletes old terminal rows', async () => {
    const { sys, ws, enqueue } = await env(1);
    const w = ws[0] as MediaSql;
    const now = Date.now();
    for (const id of ['a', 'b']) {
      await enqueue({ id });
      await mediaJobs.claim(w, { workerId: W(0), nowMs: now, maxInputBytes: MiB });
      await mediaJobs.finish(w, { id, workerId: W(0), nowMs: now, resultJson: '{}' });
    }
    await enqueue({ id: 'c' });
    expect(await mediaJobs.markApplied(sys, 'a', now + 1)).toBe(true);
    expect(await mediaJobs.markApplied(sys, 'a', now + 1)).toBe(false);
    expect(await mediaJobs.markFailed(sys, 'c', 'invalid-result', now + 1)).toBe(false);
    expect(await mediaJobs.markFailed(sys, 'b', 'invalid-result', now + 1)).toBe(true);
    expect(await mediaJobs.markCancelled(sys, 'c', 'inputs-changed', now + 2)).toBe(true);
    expect(await mediaJobs.markCancelled(sys, 'c', 'inputs-changed', now + 2)).toBe(false);
    expect(await mediaJobs.get(sys, 'a')).toMatchObject({
      status: 'applied',
      appliedAtMs: now + 1,
    });
    expect(await mediaJobs.get(sys, 'b')).toMatchObject({
      status: 'failed',
      error: 'invalid-result',
    });
    expect(await mediaJobs.get(sys, 'c')).toMatchObject({
      status: 'cancelled',
      error: 'inputs-changed',
    });
    await enqueue({ id: 'd' });
    expect(await mediaJobs.deleteTerminalBefore(sys, now + 2)).toBe(2);
    expect(
      (await sys.all<{ id: string }>('SELECT id FROM media_jobs ORDER BY id')).map((r) => r.id),
    ).toEqual(['c', 'd']);
  });

  it('hasRecentTerminalMerge sees only failed or cancelled merges of that recording in the window', async () => {
    const { sys, enqueue } = await env(0);
    const now = Date.now();
    const DAY = 86_400_000;
    await enqueue({ id: 'm1', kind: 'merge', target: '1', nowMs: now - DAY - 10 });
    await mediaJobs.markCancelled(sys, 'm1', 'inputs-changed', now - DAY - 10);
    await enqueue({ id: 'm2', kind: 'merge', target: '2', nowMs: now });
    await mediaJobs.markCancelled(sys, 'm2', 'inputs-changed', now - 1000);
    await enqueue({ id: 'm3', kind: 'merge', target: '3', nowMs: now });
    await enqueue({ id: 'i4', kind: 'ingest', target: '4', nowMs: now });
    await mediaJobs.markCancelled(sys, 'i4', 'inputs-changed', now);
    const since = now - DAY;
    expect(await mediaJobs.hasRecentTerminalMerge(sys, 's1', 1, since)).toBe(false);
    expect(await mediaJobs.hasRecentTerminalMerge(sys, 's1', 2, since)).toBe(true);
    expect(await mediaJobs.hasRecentTerminalMerge(sys, 's2', 2, since)).toBe(false);
    expect(await mediaJobs.hasRecentTerminalMerge(sys, 's1', 3, since)).toBe(false);
    expect(await mediaJobs.hasRecentTerminalMerge(sys, 's1', 4, since)).toBe(false);
  });
});
