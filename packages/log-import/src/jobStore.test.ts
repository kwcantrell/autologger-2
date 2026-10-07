// Unit tests for the log-import job store over the KvStore port (shared-request-state D1, D4):
// the creator field, the record's expiry while running and after finishing, finishedAtMs
// stamping, writes queued per job in issue order, the final stale failure and the runner
// stopping once its record changed, a throwing kv never rejecting out of the runner path, and a
// record written by one store instance read through another. The kv is the in-package MemoryKv
// (an exact copy of the Postgres store's semantics); time comes from an injected fake Clock that
// the MemoryKv's expiry reads too. The in-memory map and its 200-job size cap are gone (ADR 0021
// slice 9b), so the size-cap suite went with them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogImportJobStore, type LogImportJobStore, STALE_JOB_ERROR } from './jobStore';
import { makeFakeClock } from './test/fakeClock';
import { MemoryKv } from './test/memoryKv';

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;

let clock: ReturnType<typeof makeFakeClock>['clock'];
let tick: ReturnType<typeof makeFakeClock>['tick'];
let kv: MemoryKv;
let store: LogImportJobStore;

beforeEach(() => {
  vi.useFakeTimers(); // tick() advances vitest's timer queue in lockstep (fakeClock.ts)
  ({ clock, tick } = makeFakeClock());
  kv = new MemoryKv(clock);
  store = createLogImportJobStore(kv, clock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The raw record as stored, for checks the job shape does not carry (seq, expiry). */
function rawRecord(id: string): Record<string, unknown> | null {
  const row = kv.rows.get(`log-import-job:${id}`);
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
}

function rawExpiry(id: string): number | null | undefined {
  return kv.rows.get(`log-import-job:${id}`)?.expiresAt;
}

describe('creator principal', () => {
  it('stores the creating user id on the job', async () => {
    const job = await store.create('user-1');
    expect(job.createdByUserId).toBe('user-1');
    expect((await store.get(job.id))?.createdByUserId).toBe('user-1');
  });
});

describe('create, append, status and heartbeat', () => {
  it('records lines and status in order, under the log-import-job: key', async () => {
    const job = await store.create('user-1');
    expect(job.status).toBe('queued');
    expect(rawRecord(job.id)).toMatchObject({ v: 1, status: 'queued', seq: 0 });
    await store.setStatus(job.id, 'running');
    await store.appendLine(job.id, 'one');
    await store.appendLine(job.id, 'two');
    await store.setStatus(job.id, 'completed', 'note');
    expect(await store.get(job.id)).toMatchObject({
      id: job.id,
      status: 'completed',
      lines: ['one', 'two'],
      error: 'note',
    });
    expect(rawRecord(job.id)).toMatchObject({ seq: 4 });
  });

  it('heartbeat stamps heartbeatMs from the clock', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'running');
    tick(10 * SECOND_MS);
    await store.heartbeat(job.id);
    expect((await store.get(job.id))?.heartbeatMs).toBe(clock.now());
  });

  it('an unknown id reads as null', async () => {
    expect(await store.get('nope')).toBeNull();
  });
});

describe('record expiry', () => {
  it('expires 2 h after the last write while running, and 1 h after finishing', async () => {
    const job = await store.create('user-1');
    expect(rawExpiry(job.id)).toBe(clock.now() + 2 * HOUR_MS);
    await store.setStatus(job.id, 'running');
    tick(5 * 60 * SECOND_MS);
    await store.setStatus(job.id, 'completed');
    expect(rawExpiry(job.id)).toBe(clock.now() + HOUR_MS);
  });

  it('keeps a completed job within the hour and drops it after', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'completed');
    tick(HOUR_MS - 1);
    expect((await store.get(job.id))?.status).toBe('completed');
    tick(2);
    expect(await store.get(job.id)).toBeNull();
  });

  it('measures the terminal expiry from finish time, not creation time', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'running');
    for (let i = 0; i < 3 * 360; i++) {
      tick(10 * SECOND_MS); // a 3 h import, heartbeating every 10 s
      await store.heartbeat(job.id);
    }
    await store.setStatus(job.id, 'completed');
    tick(HOUR_MS - 1);
    expect((await store.get(job.id))?.status).toBe('completed');
    tick(2);
    expect(await store.get(job.id)).toBeNull();
  });

  it('expires failed jobs the same way as completed ones', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'failed', 'boom');
    tick(HOUR_MS + 1);
    expect(await store.get(job.id)).toBeNull();
  });

  it('a heartbeating job stays readable past its 2 h initial expiry (sheets-log-import "Running jobs survive the size cap")', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'running');
    for (let i = 0; i < 2 * 360 + 60; i++) {
      tick(10 * SECOND_MS);
      await store.heartbeat(job.id);
    }
    expect(clock.now() - job.createdAtMs).toBeGreaterThan(2 * HOUR_MS);
    expect((await store.get(job.id))?.status).toBe('running');
  });
});

describe('finishedAtMs stamping', () => {
  it('is null while queued and stays null through running', async () => {
    const job = await store.create('user-1');
    expect(job.finishedAtMs).toBeNull();
    await store.setStatus(job.id, 'running');
    expect((await store.get(job.id))?.finishedAtMs).toBeNull();
  });

  it('stamps the current time on completion', async () => {
    const job = await store.create('user-1');
    tick(5 * SECOND_MS);
    await store.setStatus(job.id, 'completed');
    expect((await store.get(job.id))?.finishedAtMs).toBe(job.createdAtMs + 5 * SECOND_MS);
  });

  it('stamps the current time on failure, same as completion', async () => {
    const job = await store.create('user-1');
    tick(SECOND_MS);
    await store.setStatus(job.id, 'failed', 'boom');
    expect((await store.get(job.id))?.finishedAtMs).toBe(clock.now());
  });

  it('clears finishedAtMs if a terminal job is moved back to a non-terminal status', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'completed');
    expect((await store.get(job.id))?.finishedAtMs).not.toBeNull();
    await store.setStatus(job.id, 'running');
    expect((await store.get(job.id))?.finishedAtMs).toBeNull();
  });

  it('re-stamps to the later time when a job transitions terminal twice', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'completed');
    const firstStamp = (await store.get(job.id))?.finishedAtMs;
    tick(30 * SECOND_MS);
    await store.setStatus(job.id, 'failed', 'boom');
    const secondStamp = (await store.get(job.id))?.finishedAtMs;
    expect(secondStamp).toBe(clock.now());
    expect(secondStamp).not.toBe(firstStamp);
  });
});

describe('writes are queued per job, in issue order', () => {
  it('a delayed heartbeat never overwrites a later terminal status', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'running');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let delayed = false;
    kv.before = async (op) => {
      if (op === 'replaceIf' && !delayed) {
        delayed = true;
        await gate; // the heartbeat's write stalls
      }
    };
    const hb = store.heartbeat(job.id);
    const line = store.appendLine(job.id, 'Done.');
    const done = store.setStatus(job.id, 'completed');
    release();
    await Promise.all([hb, line, done]);
    expect(await store.get(job.id)).toMatchObject({ status: 'completed', lines: ['Done.'] });
    expect(store.isLost(job.id)).toBe(false);
  });

  it('every write is one compare-and-swap against the last value written', async () => {
    const job = await store.create('user-1');
    const spy = vi.spyOn(kv, 'replaceIf');
    const putSpy = vi.spyOn(kv, 'put');
    const before = kv.rows.get(`log-import-job:${job.id}`)?.value;
    await store.appendLine(job.id, 'a');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(before);
    expect(spy.mock.calls[0]?.[3]).toEqual({ expirationTtl: 2 * 60 * 60 });
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('a stale job is failed, finally', () => {
  it('a running job with no heartbeat for 61 s reads as failed with the lines so far', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'running');
    await store.appendLine(job.id, 'Loaded 2 sheet(s).');
    tick(61 * SECOND_MS);
    const read = await store.get(job.id);
    expect(read).toMatchObject({
      status: 'failed',
      error: STALE_JOB_ERROR,
      lines: ['Loaded 2 sheet(s).'],
      finishedAtMs: clock.now(),
    });
    expect(STALE_JOB_ERROR).toBe('The server running this import stopped.');
    // The switch was written, so it is final for every reader.
    expect(rawRecord(job.id)).toMatchObject({ status: 'failed' });
    expect(rawExpiry(job.id)).toBe(clock.now() + HOUR_MS);
  });

  it('a job heartbeating within 60 s is not stale', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'running');
    tick(60 * SECOND_MS);
    expect((await store.get(job.id))?.status).toBe('running');
  });

  it('a queued job goes stale the same way', async () => {
    const job = await store.create('user-1');
    tick(61 * SECOND_MS);
    expect((await store.get(job.id))?.status).toBe('failed');
  });

  it('the runner stops once its record changed: it is lost and writes nothing more', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'running');
    await store.appendLine(job.id, 'before');
    tick(61 * SECOND_MS);
    const poller = createLogImportJobStore(kv, clock); // a poll through another process
    expect((await poller.get(job.id))?.status).toBe('failed');
    const failed = kv.rows.get(`log-import-job:${job.id}`)?.value;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.appendLine(job.id, 'after'); // the runner wakes
    expect(store.isLost(job.id)).toBe(true);
    await store.setStatus(job.id, 'completed');
    await store.heartbeat(job.id);
    expect(kv.rows.get(`log-import-job:${job.id}`)?.value).toBe(failed);
    expect((await poller.get(job.id))?.lines).toEqual(['before']);
  });
});

describe('a throwing kv never rejects out of the runner path', () => {
  it('appendLine, setStatus and heartbeat resolve when every kv call throws', async () => {
    const job = await store.create('user-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    kv.before = () => {
      throw new Error('kv down');
    };
    await expect(store.appendLine(job.id, 'x')).resolves.toBeUndefined();
    await expect(store.setStatus(job.id, 'running')).resolves.toBeUndefined();
    await expect(store.heartbeat(job.id)).resolves.toBeUndefined();
    await expect(store.release(job.id)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(store.isLost(job.id)).toBe(false);
  });

  it('a failed write is carried by the next one', async () => {
    const job = await store.create('user-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    kv.before = () => {
      if (fail) {
        fail = false;
        throw new Error('kv blip');
      }
    };
    await store.appendLine(job.id, 'lost-then-carried');
    await store.appendLine(job.id, 'next');
    expect((await store.get(job.id))?.lines).toEqual(['lost-then-carried', 'next']);
  });
});

describe('shared across store instances', () => {
  it('a record written by one store instance is read through another', async () => {
    const job = await store.create('user-1');
    await store.setStatus(job.id, 'running');
    await store.appendLine(job.id, 'hello');
    const other = createLogImportJobStore(kv, clock);
    expect(await other.get(job.id)).toMatchObject({
      id: job.id,
      status: 'running',
      lines: ['hello'],
      createdByUserId: 'user-1',
    });
  });
});

describe('release', () => {
  it('awaits the queued writes; later writes for the job are dropped', async () => {
    const job = await store.create('user-1');
    void store.appendLine(job.id, 'queued-before-release');
    void store.setStatus(job.id, 'completed');
    await store.release(job.id);
    expect(await store.get(job.id)).toMatchObject({
      status: 'completed',
      lines: ['queued-before-release'],
    });
    await store.appendLine(job.id, 'late');
    expect((await store.get(job.id))?.lines).toEqual(['queued-before-release']);
  });
});
