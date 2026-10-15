import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIdbImportSessionMemory,
  createIdbUploadMemory,
  createMemoryUploadMemory,
  fileGroupIdentity,
  IMPORT_PARTS_THRESHOLD_BYTES,
  IMPORT_SESSION_MEMORY_TTL_MS,
  PartsUploadError,
  partBackoffMs,
  UPLOAD_MEMORY_TTL_MS,
  UPLOAD_PART_BYTES,
  type UploadMemory,
  uploadInParts,
  uploadSegmentInParts,
} from './uploads';

// media-worker D.3 (design D12, batch-audio-import "Large imports upload in parts",
// api-contract-freeze "Resumable audio upload endpoints"). The server below is a fake of the frozen
// route shapes (B.4 owns the real ones): create → PUT parts → GET status → complete → DELETE.

const MiB = 1024 * 1024;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  size?: number;
}

/** A fake of the upload routes for session `s1`. Tests tweak `fail` to inject errors. */
function fakeServer(partSize: number) {
  const calls: Call[] = [];
  const uploads = new Map<
    string,
    { sizeBytes: number; hashes: string[]; received: Set<number>; contentType: string }
  >();
  let nextId = 1;
  const fail: { put?: (n: number, attempt: number) => Response | 'network' | null } = {};
  const putAttempts = new Map<number, number>();
  let createStatus: { status: number; detail: string } | null = null;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const handler = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://x');
    const method = init.method ?? 'GET';
    const path = url.pathname;
    const headers = new Headers(init.headers);
    const call: Call = { method, path, search: url.searchParams, headers };
    calls.push(call);
    const base = '/api/sessions/s1/audio/uploads';
    if (method === 'POST' && path === base) {
      if (createStatus) return json(createStatus.status, { detail: createStatus.detail });
      const body = JSON.parse(String(init.body));
      const id = `u${nextId++}`;
      uploads.set(id, {
        sizeBytes: body.size_bytes,
        hashes: body.part_sha256,
        received: new Set(),
        contentType: body.content_type,
      });
      return json(201, {
        upload_id: id,
        part_size: partSize,
        parts_total: Math.ceil(body.size_bytes / partSize),
        expires_at_utc: '2026-10-13T00:00:00.000Z',
      });
    }
    const m = /^\/api\/sessions\/s1\/audio\/uploads\/([^/]+)(\/parts\/(\d+)|\/complete)?$/.exec(
      path,
    );
    const up = m ? uploads.get(m[1]) : undefined;
    if (!m || !up) return json(404, { detail: 'no such upload' });
    if (method === 'PUT' && m[3]) {
      const n = Number(m[3]);
      const attempt = (putAttempts.get(n) ?? 0) + 1;
      putAttempts.set(n, attempt);
      const bytes = await new Response(init.body as BodyInit).arrayBuffer();
      call.size = bytes.byteLength;
      const injected = fail.put?.(n, attempt) ?? null;
      if (injected === 'network') throw new TypeError('Failed to fetch');
      if (injected) return injected;
      if ((await sha256Hex(bytes)) !== up.hashes[n - 1]) return json(400, { detail: 'hash' });
      up.received.add(n);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET') {
      return json(200, {
        upload_id: m[1],
        status: 'open',
        size_bytes: up.sizeBytes,
        part_size: partSize,
        parts_total: up.hashes.length,
        received: [...up.received].sort((a, b) => a - b),
        expires_at_utc: '2026-10-13T00:00:00.000Z',
      });
    }
    if (method === 'POST' && m[2] === '/complete') {
      const missing = up.hashes.map((_, i) => i + 1).filter((n) => !up.received.has(n));
      if (missing.length) return json(409, { detail: 'missing', missing_parts: missing });
      uploads.delete(m[1]);
      return json(200, { ok: true, segment_id: `seg-${m[1]}` });
    }
    if (method === 'DELETE') {
      uploads.delete(m[1]);
      return new Response(null, { status: 204 });
    }
    return json(405, { detail: 'nope' });
  };
  return {
    calls,
    uploads,
    fail,
    setCreateStatus: (s: { status: number; detail: string } | null) => {
      createStatus = s;
    },
    handler,
  };
}

/** A Blob whose whole-file `arrayBuffer()` must never be called (D12: per-part hashing only). */
class NoWholeBufferBlob extends Blob {
  override arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('whole-file arrayBuffer() called');
  }
}

const noSleep = async () => undefined;

let server: ReturnType<typeof fakeServer>;
beforeEach(() => {
  server = fakeServer(8);
  vi.stubGlobal('fetch', vi.fn(server.handler));
});
afterEach(() => vi.unstubAllGlobals());

function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251));
}

describe('uploadInParts — create, parts in order, complete', () => {
  it('hashes each 32 MiB slice with crypto.subtle and never buffers the whole file', async () => {
    const big = fakeServer(UPLOAD_PART_BYTES);
    vi.stubGlobal('fetch', vi.fn(big.handler));
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const blob = new NoWholeBufferBlob([new Uint8Array(2 * UPLOAD_PART_BYTES + MiB)]);
    const out = await uploadInParts({
      sessionId: 's1',
      blob,
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 12.5, seamParts: [{ duration_s: 12.5 }] },
      sleep: noSleep,
    });
    expect(out).toEqual({ segmentId: 'seg-u1' });
    // The client hashes every part before the create call; the fake server's own re-hash of each
    // PUT body follows (the last three digests).
    const hashed = digest.mock.calls.map(([, data]) => (data as ArrayBuffer).byteLength);
    expect(hashed.slice(0, 3)).toEqual([UPLOAD_PART_BYTES, UPLOAD_PART_BYTES, MiB]);
    const puts = big.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.path.split('/').pop())).toEqual(['1', '2', '3']);
    expect(puts.map((c) => c.size)).toEqual([UPLOAD_PART_BYTES, UPLOAD_PART_BYTES, MiB]);
    digest.mockRestore();
  });

  it('creates with the content type, size and per-part hashes, then completes in import mode', async () => {
    const data = bytes(20);
    await uploadInParts({
      sessionId: 's1',
      blob: new Blob([data]),
      contentType: 'audio/flac',
      completion: {
        mode: 'import',
        durationS: 3.25,
        seamParts: [{ duration_s: 1 }, { duration_s: 2.25 }],
      },
      partSizeBytes: 8,
      sleep: noSleep,
    });
    const create = server.calls[0];
    expect(create.method).toBe('POST');
    const up = server.uploads.size === 0; // completed uploads are removed by the fake
    expect(up).toBe(true);
    const expected = await Promise.all(
      [data.slice(0, 8), data.slice(8, 16), data.slice(16)].map((p) => sha256Hex(p.buffer)),
    );
    const createBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as Record<
      string,
      unknown
    >;
    expect(createBody).toEqual({
      content_type: 'audio/flac',
      size_bytes: 20,
      part_sha256: expected,
    });
    const complete = server.calls.at(-1) as Call;
    expect(complete.path).toBe('/api/sessions/s1/audio/uploads/u1/complete');
    expect(complete.search.get('duration_s')).toBe('3.25');
    expect(JSON.parse(complete.headers.get('X-Audio-Seam-Parts') ?? 'null')).toEqual([
      { duration_s: 1 },
      { duration_s: 2.25 },
    ]);
  });

  it('completes in segment mode with the recording window (the 413 fallback A.3 calls)', async () => {
    const out = await uploadSegmentInParts(
      's1',
      new Blob([bytes(10)], { type: 'audio/webm' }),
      {
        recordingOrdinal: 3,
        startedAtUtc: '2026-10-12T10:00:00.000Z',
        endedAtUtc: '2026-10-12T10:10:00.000Z',
      },
      { partSizeBytes: 8, sleep: noSleep },
    );
    expect(out).toEqual({ segmentId: 'seg-u1' });
    const complete = server.calls.at(-1) as Call;
    expect(complete.path).toBe('/api/sessions/s1/audio/uploads/u1/complete');
    expect(Object.fromEntries(complete.search)).toEqual({
      recording_ordinal: '3',
      started_at_utc: '2026-10-12T10:00:00.000Z',
      ended_at_utc: '2026-10-12T10:10:00.000Z',
    });
    expect(complete.headers.get('X-Audio-Seam-Parts')).toBeNull();
  });

  it('reports progress per part', async () => {
    const seen: string[] = [];
    await uploadInParts({
      sessionId: 's1',
      blob: new Blob([bytes(20)]),
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 1 },
      partSizeBytes: 8,
      sleep: noSleep,
      onProgress: (p) => seen.push(`${p.partsDone}/${p.partsTotal}`),
    });
    expect(seen).toEqual(['0/3', '1/3', '2/3', '3/3']);
  });
});

describe('uploadInParts — retries and resume', () => {
  it('retries a failed part with backoff and re-reads the status to skip received parts', async () => {
    server.fail.put = (n, attempt) => (n === 2 && attempt === 1 ? 'network' : null);
    const sleeps: number[] = [];
    await uploadInParts({
      sessionId: 's1',
      blob: new Blob([bytes(24)]),
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 1 },
      partSizeBytes: 8,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    });
    expect(sleeps).toEqual([2000]);
    const seq = server.calls.map(
      (c) => `${c.method} ${c.path.replace('/api/sessions/s1/audio/uploads', '')}`,
    );
    expect(seq).toEqual([
      'POST ',
      'PUT /u1/parts/1',
      'PUT /u1/parts/2',
      'GET /u1',
      'PUT /u1/parts/2',
      'PUT /u1/parts/3',
      'POST /u1/complete',
    ]);
  });

  it('uses the chunk backoff schedule: 2 s doubling to a 5 min cap, jittered ×0.5–1.5', () => {
    expect(partBackoffMs(1, () => 0.5)).toBe(2000);
    expect(partBackoffMs(2, () => 0.5)).toBe(4000);
    expect(partBackoffMs(20, () => 0.5)).toBe(300_000);
    expect(partBackoffMs(1, () => 0)).toBe(1000);
    expect(partBackoffMs(1, () => 0.999999)).toBeCloseTo(3000, -1);
  });

  it('gives up after the retry budget with a resumable error and keeps the upload remembered', async () => {
    server.fail.put = (n) => (n === 2 ? new Response('{}', { status: 503 }) : null);
    const memory = createMemoryUploadMemory();
    const err = await uploadInParts({
      sessionId: 's1',
      blob: new Blob([bytes(24)]),
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 1 },
      partSizeBytes: 8,
      resumeKey: 'group-A',
      memory,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartsUploadError);
    expect((err as PartsUploadError).resumable).toBe(true);
    expect((await memory.get('group-A'))?.uploadId).toBe('u1');
  });

  it('resumes from IndexedDB in another tab: same group identity sends only the missing parts', async () => {
    const idb = fakeIndexedDb();
    const tabA = createIdbUploadMemory(idb);
    const data = new Blob([bytes(56)]);
    server.fail.put = (n) => (n >= 4 ? 'network' : null);
    await uploadInParts({
      sessionId: 's1',
      blob: data,
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 1 },
      partSizeBytes: 8,
      resumeKey: 'group-A',
      memory: tabA,
      sleep: noSleep,
      maxAttemptsPerPart: 2,
    }).catch(() => undefined);
    // Parts 1-3 of 7 landed; the user re-runs the import in a new tab.
    server.fail.put = undefined;
    server.calls.length = 0;
    const tabB = createIdbUploadMemory(idb);
    const out = await uploadInParts({
      sessionId: 's1',
      blob: data,
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 1 },
      partSizeBytes: 8,
      resumeKey: 'group-A',
      memory: tabB,
      sleep: noSleep,
    });
    expect(out.segmentId).toBe('seg-u1');
    const seq = server.calls.map(
      (c) => `${c.method} ${c.path.replace('/api/sessions/s1/audio/uploads', '')}`,
    );
    expect(seq).toEqual([
      'GET /u1',
      'PUT /u1/parts/4',
      'PUT /u1/parts/5',
      'PUT /u1/parts/6',
      'PUT /u1/parts/7',
      'POST /u1/complete',
    ]);
    expect(await tabB.get('group-A')).toBeNull();
  });

  it('forgets a remembered upload after 24 hours', async () => {
    let now = 1_000_000;
    const memory = createIdbUploadMemory(fakeIndexedDb(), () => now);
    await memory.put('k', {
      uploadId: 'u9',
      sessionId: 's1',
      sizeBytes: 1,
      partSize: 8,
      partSha256: ['x'],
      contentType: 'audio/wav',
      savedAtMs: now,
    });
    now += UPLOAD_MEMORY_TTL_MS - 1;
    expect((await memory.get('k'))?.uploadId).toBe('u9');
    now += 2;
    expect(await memory.get('k')).toBeNull();
  });

  it('starts a new upload when the remembered one no longer matches the bytes', async () => {
    const memory = createMemoryUploadMemory();
    await memory.put('group-A', {
      uploadId: 'stale',
      sessionId: 's1',
      sizeBytes: 16,
      partSize: 8,
      partSha256: ['a'.repeat(64), 'b'.repeat(64)],
      contentType: 'audio/wav',
      savedAtMs: Date.now(),
    });
    const out = await uploadInParts({
      sessionId: 's1',
      blob: new Blob([bytes(16)]),
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 1 },
      partSizeBytes: 8,
      resumeKey: 'group-A',
      memory,
      sleep: noSleep,
    });
    expect(out.segmentId).toBe('seg-u1');
    expect(server.calls[0].method).toBe('DELETE');
    expect(server.calls[0].path).toBe('/api/sessions/s1/audio/uploads/stale');
  });
});

describe('uploadInParts — caps and low disk', () => {
  it.each([
    [429, 'capacity'],
    [507, 'disk'],
  ] as const)('a %i at create surfaces as a %s message, not resumable', async (status, kind) => {
    server.setCreateStatus({ status, detail: 'server says no' });
    const err = await uploadInParts({
      sessionId: 's1',
      blob: new Blob([bytes(16)]),
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 1 },
      partSizeBytes: 8,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartsUploadError);
    const e = err as PartsUploadError;
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(e.resumable).toBe(false);
    expect(e.message).toMatch(kind === 'capacity' ? /uploads/i : /disk/i);
  });

  it('a 507 on a part stops without retrying and stays resumable', async () => {
    server.fail.put = (n) =>
      n === 2
        ? new Response(JSON.stringify({ detail: 'low disk' }), {
            status: 507,
            headers: { 'content-type': 'application/json' },
          })
        : null;
    const memory = createMemoryUploadMemory();
    const err = await uploadInParts({
      sessionId: 's1',
      blob: new Blob([bytes(24)]),
      contentType: 'audio/wav',
      completion: { mode: 'import', durationS: 1 },
      partSizeBytes: 8,
      resumeKey: 'g',
      memory,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect((err as PartsUploadError).kind).toBe('disk');
    expect((err as PartsUploadError).resumable).toBe(true);
    expect(server.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });
});

describe('import session memory', () => {
  it('remembers the session an import created, across tabs, for 30 days', async () => {
    let now = 5_000;
    const idb = fakeIndexedDb();
    const tabA = createIdbImportSessionMemory(idb, () => now);
    await tabA.put('group-A', 'sess-1');
    const tabB = createIdbImportSessionMemory(idb, () => now);
    expect(await tabB.get('group-A')).toBe('sess-1');
    // Shares the database with the upload memory without clobbering it.
    const uploads = createIdbUploadMemory(idb, () => now);
    expect(await uploads.get('group-A')).toBeNull();
    now += IMPORT_SESSION_MEMORY_TTL_MS;
    expect(await tabB.get('group-A')).toBeNull();
    await tabA.put('group-B', 'sess-2');
    await tabA.delete('group-B');
    expect(await tabB.get('group-B')).toBeNull();
  });

  it('pins the 30-day window', () => {
    expect(IMPORT_SESSION_MEMORY_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('group identity and threshold', () => {
  it('keys a file group by its ordered names, sizes and last-modified times', () => {
    const a = new File(['aa'], 'YMH_001-1.mp3', { lastModified: 1 });
    const b = new File(['bbb'], 'YMH_001-2.mp3', { lastModified: 2 });
    expect(fileGroupIdentity([a, b])).toBe(fileGroupIdentity([a, b]));
    expect(fileGroupIdentity([a, b])).not.toBe(fileGroupIdentity([b, a]));
    const touched = new File(['aa'], 'YMH_001-1.mp3', { lastModified: 3 });
    expect(fileGroupIdentity([touched, b])).not.toBe(fileGroupIdentity([a, b]));
  });

  it('pins the design constants', () => {
    expect(UPLOAD_PART_BYTES).toBe(32 * MiB);
    expect(IMPORT_PARTS_THRESHOLD_BYTES).toBe(40 * MiB);
    expect(UPLOAD_MEMORY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// --- a minimal IndexedDB fake: one shared backing store per factory, as an origin's tabs share --

function fakeIndexedDb(): IDBFactory {
  const databases = new Map<string, Map<string, Map<IDBValidKey, unknown>>>();
  const later = (fn: () => void) => queueMicrotask(fn);
  function request<T>(run: () => T): IDBRequest<T> {
    const req = {
      result: undefined as T,
      error: null,
      onsuccess: null,
      onerror: null,
    } as unknown as {
      result: T;
      onsuccess: ((ev: Event) => void) | null;
    };
    later(() => {
      req.result = run();
      req.onsuccess?.({ target: req } as unknown as Event);
    });
    return req as unknown as IDBRequest<T>;
  }
  return {
    open(name: string) {
      const isNew = !databases.has(name);
      if (isNew) databases.set(name, new Map());
      const stores = databases.get(name) as Map<string, Map<IDBValidKey, unknown>>;
      const db = {
        objectStoreNames: { contains: (s: string) => stores.has(s) },
        createObjectStore: (s: string) => {
          stores.set(s, new Map());
        },
        transaction: (s: string) => {
          const store = stores.get(s) as Map<IDBValidKey, unknown>;
          const tx = { oncomplete: null as null | (() => void), onerror: null };
          const objectStore = () => ({
            get: (k: IDBValidKey) => request(() => structuredClone(store.get(k))),
            put: (v: unknown, k: IDBValidKey) =>
              request(() => {
                store.set(k, structuredClone(v));
                later(() => tx.oncomplete?.());
                return k;
              }),
            delete: (k: IDBValidKey) =>
              request(() => {
                store.delete(k);
                later(() => tx.oncomplete?.());
                return undefined;
              }),
          });
          return {
            ...tx,
            objectStore,
            set oncomplete(f: () => void) {
              tx.oncomplete = f;
            },
          };
        },
        close: () => undefined,
      };
      const req = {
        result: db,
        error: null,
        onsuccess: null as null | ((ev: Event) => void),
        onerror: null,
        onupgradeneeded: null as null | ((ev: Event) => void),
      };
      later(() => {
        if (isNew) req.onupgradeneeded?.({ target: req } as unknown as Event);
        req.onsuccess?.({ target: req } as unknown as Event);
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

// Unused-type guard: the memory interface is part of the published API.
const _memoryType: UploadMemory | null = null;
void _memoryType;
