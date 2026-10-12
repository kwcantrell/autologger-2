import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIdbFactory, FakeKeyRange } from '../../../../test/fakes/idb';
import { FakeOpfs } from '../../../../test/fakes/opfs';
import { createIdbBackend } from './idbBackend';
import {
  type ChunkStore,
  type ChunkStoreOptions,
  createChunkStore,
  STORE_MAX_AGE_MS,
} from './index';
import { createMemoryBackend } from './memoryBackend';
import { createInProcessOpfsTransport, createOpfsBackend } from './opfsBackend';
import type { ChunkBackend } from './types';

// --- media-worker A.1: per-user chunk store (design D10) ---
//
// Every backend is exercised through the same store API: OPFS (the worker's request handler run
// in-process over the fake OPFS), IndexedDB (over the fake factory) and memory. Backend choice is
// by a real write probe, never feature detection (spike 0.3: ephemeral WebKit has both APIs and
// both fail).

const T0 = Date.parse('2026-10-12T10:00:00.000Z');

function bytesOf(n: number, fill: number): Blob {
  return new Blob([new Uint8Array(n).fill(fill)], { type: 'audio/webm;codecs=opus' });
}

async function blobBytes(b: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await b.arrayBuffer()));
}

interface Env {
  opfs: FakeOpfs;
  idb: FakeIdbFactory;
  clock: { t: number };
  warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  onDegraded: ReturnType<typeof vi.fn<(message: string) => void>>;
  estimate: ReturnType<typeof vi.fn<() => Promise<{ quota?: number; usage?: number }>>>;
}

function env(): Env {
  return {
    opfs: new FakeOpfs(),
    idb: new FakeIdbFactory(),
    clock: { t: T0 },
    warn: vi.fn<(message: string) => void>(),
    onDegraded: vi.fn<(message: string) => void>(),
    estimate: vi.fn<() => Promise<{ quota?: number; usage?: number }>>(async () => ({
      quota: 10 * 1024 ** 3,
      usage: 0,
    })),
  };
}

function opfsBackend(e: Env): ChunkBackend {
  return createOpfsBackend(createInProcessOpfsTransport(e.opfs.getDirectory));
}

function idbBackend(e: Env): ChunkBackend {
  return createIdbBackend({
    factory: e.idb as unknown as IDBFactory,
    keyRange: FakeKeyRange as unknown as typeof IDBKeyRange,
  });
}

function store(
  e: Env,
  backends: Array<() => ChunkBackend>,
  extra: Partial<ChunkStoreOptions> = {},
): ChunkStore {
  return createChunkStore({
    backends,
    now: () => e.clock.t,
    warn: e.warn,
    onDegraded: e.onDegraded,
    estimate: e.estimate,
    expectedChunkBytes: 1000,
    ...extra,
  });
}

const META = {
  userId: 'user-a',
  sessionId: 'sess-1',
  recordingOrdinal: 3,
  chunkIndex: 0,
  startedAtUtc: '2026-10-12T10:00:00.000Z',
  mimeType: 'audio/webm;codecs=opus',
};

const BACKENDS: Array<[string, (e: Env) => ChunkBackend]> = [
  ['opfs', opfsBackend],
  ['idb', idbBackend],
  ['memory', () => createMemoryBackend()],
];

describe.each(BACKENDS)('chunk store over the %s backend', (kind, make) => {
  let e: Env;
  let s: ChunkStore;
  beforeEach(() => {
    e = env();
    s = store(e, [() => make(e)]);
  });

  it('selects the backend by a real probe write', async () => {
    expect(await s.ready()).toBe(kind);
  });

  it('open → append → finalize round-trips the bytes and records the manifest', async () => {
    const h = await s.openChunk({ ...META, pendingFinalize: ['2026-10-12T10:00:00.000Z'] });
    e.clock.t += 5000;
    await s.append(h, bytesOf(3, 1));
    e.clock.t += 5000;
    await s.append(h, bytesOf(2, 2));
    await s.finalize(h, '2026-10-12T10:00:10.000Z');

    const [m, ...rest] = await s.list('user-a');
    expect(rest).toEqual([]);
    expect(m).toMatchObject({
      kind: 'chunk',
      id: h.id,
      userId: 'user-a',
      sessionId: 'sess-1',
      recordingOrdinal: 3,
      chunkIndex: 0,
      startedAtUtc: META.startedAtUtc,
      endedAtUtc: '2026-10-12T10:00:10.000Z',
      mimeType: 'audio/webm;codecs=opus',
      bytes: 5,
      sliceLog: [
        { at: T0 + 5000, bytes: 3 },
        { at: T0 + 10000, bytes: 2 },
      ],
      finalized: true,
      pendingFinalize: ['2026-10-12T10:00:00.000Z'],
      safari: false,
    });
    const read = await s.read('user-a', h.id);
    expect(await blobBytes(read)).toEqual([1, 1, 1, 2, 2]);
    expect(read.type).toBe('audio/webm;codecs=opus');
  });

  it('lists a partial (unfinalized) chunk with its metadata', async () => {
    const h = await s.openChunk(META);
    await s.append(h, bytesOf(4, 7));
    const [m] = await s.list('user-a');
    expect(m).toMatchObject({ id: h.id, finalized: false, endedAtUtc: null, bytes: 4 });
    expect(await blobBytes(await s.read('user-a', h.id))).toEqual([7, 7, 7, 7]);
  });

  it('keeps chunks per user: list and wipe touch only that user', async () => {
    const a = await s.openChunk(META);
    await s.append(a, bytesOf(1, 1));
    const b = await s.openChunk({ ...META, userId: 'user-b' });
    await s.append(b, bytesOf(1, 2));

    expect((await s.list('user-a')).map((m) => m.id)).toEqual([a.id]);
    expect((await s.list('user-b')).map((m) => m.id)).toEqual([b.id]);

    await s.wipe('user-a');
    expect(await s.list('user-a')).toEqual([]);
    expect((await s.list('user-b')).map((m) => m.id)).toEqual([b.id]);
    expect(await blobBytes(await s.read('user-b', b.id))).toEqual([2]);
  });

  it('remove deletes the bytes and the manifest', async () => {
    const h = await s.openChunk(META);
    await s.append(h, bytesOf(2, 1));
    const other = await s.openChunk({ ...META, chunkIndex: 1 });
    await s.append(other, bytesOf(1, 9));
    await s.remove('user-a', h.id);
    expect((await s.list('user-a')).map((m) => m.id)).toEqual([other.id]);
  });

  it('a finalize record carries the window list until removed', async () => {
    await s.saveFinalize('user-a', {
      sessionId: 'sess-1',
      recordingOrdinal: 3,
      windows: ['w1', 'w2'],
    });
    // Saving again for the same recording overwrites, never duplicates.
    await s.saveFinalize('user-a', {
      sessionId: 'sess-1',
      recordingOrdinal: 3,
      windows: ['w1', 'w2', 'w3'],
    });
    const listed = await s.list('user-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      kind: 'finalize',
      sessionId: 'sess-1',
      recordingOrdinal: 3,
      pendingFinalize: ['w1', 'w2', 'w3'],
    });
    await s.removeFinalize('user-a', 'sess-1', 3);
    expect(await s.list('user-a')).toEqual([]);
  });

  it('deletes entries older than 30 days at scan, with a console warning naming them', async () => {
    const old = await s.openChunk(META);
    await s.append(old, bytesOf(1, 1));
    e.clock.t += STORE_MAX_AGE_MS + 1;
    const fresh = await s.openChunk({ ...META, chunkIndex: 1 });
    await s.append(fresh, bytesOf(1, 2));

    expect((await s.list('user-a')).map((m) => m.id)).toEqual([fresh.id]);
    expect(e.warn).toHaveBeenCalledTimes(1);
    expect(String(e.warn.mock.calls[0][0])).toMatch(/sess-1.*recording 3|recording 3.*sess-1/);
    // And it is really gone, not just hidden.
    expect((await s.list('user-a')).map((m) => m.id)).toEqual([fresh.id]);
    expect(e.warn).toHaveBeenCalledTimes(1);
  });
});

describe('OPFS layout', () => {
  it('stores bytes and manifest under autologger-chunks/<userId>/', async () => {
    const e = env();
    const s = store(e, [() => opfsBackend(e)]);
    const h = await s.openChunk(META);
    await s.append(h, bytesOf(2, 1));
    expect(e.opfs.namesAt('autologger-chunks')).toEqual(['user-a']);
    expect(e.opfs.namesAt('autologger-chunks/user-a')).toEqual([`${h.id}.bin`, `${h.id}.json`]);
  });

  it('a partial chunk is read back cut at its last whole slice (crash mid-append)', async () => {
    const e = env();
    const s = store(e, [() => opfsBackend(e)]);
    const h = await s.openChunk(META);
    await s.append(h, bytesOf(3, 1));
    await s.append(h, bytesOf(2, 2));
    // A third slice's bytes landed but the tab died before its manifest write.
    const file = e.opfs.fileAt(`autologger-chunks/user-a/${h.id}.bin`);
    if (!file) throw new Error('missing bin');
    file.data = new Uint8Array([...file.data, 3, 3, 3]);

    const fresh = store(e, [() => opfsBackend(e)]);
    expect(await blobBytes(await fresh.read('user-a', h.id))).toEqual([1, 1, 1, 2, 2]);
  });
});

describe('backend selection (probe with a real write)', () => {
  it('OPFS present but failing (ephemeral WebKit) falls through to IndexedDB', async () => {
    const e = env();
    e.opfs.failGetDirectory = true;
    const s = store(e, [() => opfsBackend(e), () => idbBackend(e), () => createMemoryBackend()]);
    expect(await s.ready()).toBe('idb');
    expect(e.onDegraded).not.toHaveBeenCalled();
  });

  it('OPFS without the sync access handle falls through to IndexedDB', async () => {
    const e = env();
    e.opfs.noSyncHandle = true;
    const s = store(e, [() => opfsBackend(e), () => idbBackend(e), () => createMemoryBackend()]);
    expect(await s.ready()).toBe('idb');
  });

  it('both failing (OPFS UnknownError and an IndexedDB Blob put error) → memory, one warning', async () => {
    const e = env();
    e.opfs.failGetDirectory = true;
    e.idb.failBlobPut = true;
    const s = store(e, [() => opfsBackend(e), () => idbBackend(e), () => createMemoryBackend()]);
    expect(await s.ready()).toBe('memory');
    expect(e.onDegraded).toHaveBeenCalledTimes(1);
    // Recording still works in memory.
    const h = await s.openChunk(META);
    await s.append(h, bytesOf(2, 5));
    expect(await blobBytes(await s.read('user-a', h.id))).toEqual([5, 5]);
    expect(e.onDegraded).toHaveBeenCalledTimes(1);
  });

  it('a backend factory that throws is skipped', async () => {
    const e = env();
    const s = store(e, [
      () => {
        throw new Error('no Worker');
      },
      () => createMemoryBackend(),
    ]);
    expect(await s.ready()).toBe('memory');
  });
});

describe('quota pressure', () => {
  it('free quota under 2 × the expected chunk size → that chunk moves to memory, one warning', async () => {
    const e = env();
    const s = store(e, [() => opfsBackend(e)]);
    const h = await s.openChunk(META);
    await s.append(h, bytesOf(2, 1));
    e.estimate.mockResolvedValue({ quota: 10_000, usage: 9_000 }); // 1000 free < 2 × 1000
    await s.append(h, bytesOf(2, 2));
    await s.append(h, bytesOf(1, 3));
    expect(e.onDegraded).toHaveBeenCalledTimes(1);
    // All bytes are still readable (the persisted prefix moved with the chunk).
    expect(await blobBytes(await s.read('user-a', h.id))).toEqual([1, 1, 2, 2, 3]);
    // Nothing is left on disk for it, and later chunks stay in memory.
    expect(e.opfs.namesAt('autologger-chunks/user-a')).toEqual([]);
    const next = await s.openChunk({ ...META, chunkIndex: 1 });
    await s.append(next, bytesOf(1, 4));
    expect(e.opfs.namesAt('autologger-chunks/user-a')).toEqual([]);
    expect(e.onDegraded).toHaveBeenCalledTimes(1);
  });

  it('a write that throws QuotaExceededError degrades the same way and never fails the append', async () => {
    const e = env();
    const s = store(e, [() => opfsBackend(e)]);
    const h = await s.openChunk(META);
    await s.append(h, bytesOf(1, 1));
    e.opfs.failWrites = true;
    await expect(s.append(h, bytesOf(1, 2))).resolves.toBeUndefined();
    expect(await blobBytes(await s.read('user-a', h.id))).toEqual([1, 2]);
    expect(e.onDegraded).toHaveBeenCalledTimes(1);
  });
});

describe('Safari flag', () => {
  it('marks entries written by Safari (7-day eviction applies)', async () => {
    const e = env();
    const s = store(e, [() => createMemoryBackend()], { isSafari: true });
    const h = await s.openChunk(META);
    await s.append(h, bytesOf(1, 1));
    expect((await s.list('user-a'))[0].safari).toBe(true);
  });
});

describe('heartbeat', () => {
  it('touch refreshes heartbeatAt of an open chunk', async () => {
    const e = env();
    const s = store(e, [() => createMemoryBackend()]);
    const h = await s.openChunk(META);
    e.clock.t += 12_000;
    await s.touch('user-a', h.id);
    expect((await s.list('user-a'))[0].heartbeatAt).toBe(T0 + 12_000);
  });
});
