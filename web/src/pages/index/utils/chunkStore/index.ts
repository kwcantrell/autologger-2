/**
 * Per-user browser chunk store (media-worker design D10; spec live-recording-chunks "Finished
 * chunks are persisted locally until the server confirms them").
 *
 * Every chunk is written as it is captured (one append per 5 s timeslice) and kept until the
 * server confirms it, the user discards it, or it is older than 30 days. Backends, tried in
 * order by a **real write probe** (spike 0.3: ephemeral WebKit exposes both APIs and both fail,
 * so feature detection would pick a dead backend):
 * 1. OPFS through a dedicated worker (`opfsBackend.ts` / `opfsWorker.ts`);
 * 2. IndexedDB (`idbBackend.ts`);
 * 3. memory (today's behaviour), with one visible warning.
 * A chunk also moves to memory, with the same single warning, when the free quota drops under
 * twice the expected chunk size or a write fails: persistence never prevents recording.
 *
 * Layout is per user (`autologger-chunks/<userId>/…`): `list`/`read`/`wipe` take the user id and
 * never read another user's entries (panel A, shared machines).
 */

import { createIdbBackend } from './idbBackend';
import { createMemoryBackend } from './memoryBackend';
import { createOpfsBackend, createWorkerOpfsTransport } from './opfsBackend';
import type { BackendKind, ChunkBackend, ChunkManifest } from './types';

export type { BackendKind, ChunkBackend, ChunkManifest, SliceLogEntry } from './types';

/** Stored entries older than this are deleted at scan with a console warning (design D10). */
export const STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A probe that has not answered by then counts as failed (a hung worker must not block Record). */
export const PROBE_TIMEOUT_MS = 3000;
/** ~10 MB per 10-minute Opus chunk (chunked-live-recording D2) with headroom. */
export const DEFAULT_EXPECTED_CHUNK_BYTES = 12 * 1024 * 1024;

export const STORAGE_DEGRADED_WARNING =
  'This browser cannot save recorded audio locally right now. Recording continues; keep this tab open until the upload finishes.';

export interface ChunkStoreOptions {
  /** Backend factories in preference order; a factory that throws is skipped. */
  backends: Array<() => ChunkBackend>;
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  now?: () => number;
  /** Console-level warnings (old entries deleted). */
  warn?: (message: string) => void;
  /** The single visible warning when persistence falls back to memory. */
  onDegraded?: (message: string) => void;
  expectedChunkBytes?: number;
  /** Safari evicts site storage after 7 days without use; entries record it. */
  isSafari?: boolean;
  newId?: () => string;
  /** Test seam (default `PROBE_TIMEOUT_MS`). */
  probeTimeoutMs?: number;
}

export interface OpenChunkMeta {
  userId: string;
  sessionId: string;
  recordingOrdinal: number;
  chunkIndex: number;
  startedAtUtc: string;
  mimeType: string;
  pendingFinalize?: string[] | null;
}

/** An open chunk being captured. Opaque to callers beyond its ids. */
export interface ChunkHandle {
  readonly id: string;
  readonly userId: string;
}

export interface FinalizeRecordInput {
  sessionId: string;
  recordingOrdinal: number;
  windows: string[];
}

export interface ChunkStore {
  /** Pick the backend (once); resolves with its kind. Never rejects. */
  ready(): Promise<BackendKind>;
  backendKind(): BackendKind | null;
  openChunk(meta: OpenChunkMeta): Promise<ChunkHandle>;
  /**
   * Append one slice. Never rejects: when a write fails (or quota runs short) the bytes already
   * on disk stay there and this chunk's later slices are kept in memory. An unknown handle
   * (removed meanwhile) is a no-op, like every handle method below.
   */
  append(handle: ChunkHandle, bytes: Blob): Promise<void>;
  /** Mark the chunk complete with its end time (and the mime type learned from its data). */
  finalize(handle: ChunkHandle, endedAtUtc: string, mimeType?: string): Promise<void>;
  setPendingFinalize(handle: ChunkHandle, windows: string[]): Promise<void>;
  /** The current manifest of an open handle. */
  manifestOf(handle: ChunkHandle): ChunkManifest;
  saveFinalize(userId: string, input: FinalizeRecordInput): Promise<void>;
  removeFinalize(userId: string, sessionId: string, recordingOrdinal: number): Promise<void>;
  /** The user's entries (chunks and finalize records); entries older than 30 days are deleted. */
  list(userId: string): Promise<ChunkManifest[]>;
  /** The chunk's bytes cut at its last whole slice (the slice log is the truth). */
  read(userId: string, id: string): Promise<Blob>;
  remove(userId: string, id: string): Promise<void>;
  wipe(userId: string): Promise<void>;
  /** Refresh an open chunk's heartbeat (the lease where Web Locks are missing). */
  touch(userId: string, id: string): Promise<void>;
}

export function finalizeRecordId(sessionId: string, recordingOrdinal: number): string {
  return `fin.${encodeURIComponent(sessionId)}.${recordingOrdinal}`;
}

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('probe timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface OpenEntry {
  manifest: ChunkManifest;
  backend: ChunkBackend;
  /**
   * Slices kept in memory after persistence degraded mid-chunk (A.8): the first `diskBytes` stay
   * durable on `backend` (a crash still recovers that prefix, container header included) and the
   * tail lives here until upload. `null` while every slice is on `backend`.
   */
  tail: Blob[] | null;
  diskBytes: number;
  /** Serialises this chunk's writes (slices must land in order). */
  chain: Promise<void>;
}

export function createChunkStore(opts: ChunkStoreOptions): ChunkStore {
  const now = opts.now ?? (() => Date.now());
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const onDegraded = opts.onDegraded ?? (() => {});
  const expected = opts.expectedChunkBytes ?? DEFAULT_EXPECTED_CHUNK_BYTES;
  const newId = opts.newId ?? defaultId;
  const memory = createMemoryBackend();

  let primary: ChunkBackend | null = null;
  let selecting: Promise<BackendKind> | null = null;
  /** True once anything fell back to memory: later chunks start there too. */
  let degraded = false;
  let warned = false;
  const open = new Map<string, OpenEntry>();
  /** Where an entry this page touched lives, when not the primary backend. */
  const location = new Map<string, ChunkBackend>();

  function degrade(): void {
    degraded = true;
    if (warned) return;
    warned = true;
    onDegraded(STORAGE_DEGRADED_WARNING);
  }

  function ready(): Promise<BackendKind> {
    if (!selecting) {
      selecting = (async () => {
        for (const factory of opts.backends) {
          let backend: ChunkBackend;
          try {
            backend = factory();
          } catch {
            continue;
          }
          try {
            await withTimeout(backend.probe(), opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
          } catch {
            // A failed or hung probe must not leave its worker running.
            try {
              backend.dispose?.();
            } catch {
              /* already gone */
            }
            continue;
          }
          primary = backend;
          if (backend.kind === 'memory') degrade();
          return backend.kind;
        }
        primary = memory;
        degrade();
        return 'memory';
      })();
    }
    return selecting;
  }

  async function target(): Promise<ChunkBackend> {
    await ready();
    if (degraded || !primary) return memory;
    return primary;
  }

  /** Every backend that may hold this user's entries. */
  async function backendsFor(): Promise<ChunkBackend[]> {
    await ready();
    return primary && primary !== memory ? [primary, memory] : [memory];
  }

  async function locate(id: string): Promise<ChunkBackend> {
    const known = open.get(id)?.backend ?? location.get(id);
    if (known) return known;
    await ready();
    return primary ?? memory;
  }

  async function quotaShort(): Promise<boolean> {
    if (!opts.estimate) return false;
    try {
      const { quota, usage } = await opts.estimate();
      if (typeof quota !== 'number' || typeof usage !== 'number') return false;
      return quota - usage < 2 * expected;
    } catch {
      return false;
    }
  }

  /**
   * Stop persisting this chunk: the bytes already written stay on disk (never moved or removed,
   * so a failed read can never cost the durable prefix) and later slices go to memory.
   */
  function startTail(entry: OpenEntry): void {
    degrade();
    if (entry.backend === memory || entry.tail) return;
    entry.tail = [];
    entry.diskBytes = entry.manifest.bytes;
  }

  /** A resolved no-op (handle methods on a removed or unknown handle). */
  function noop(): Promise<void> {
    return Promise.resolve();
  }

  function serial(entry: OpenEntry, fn: () => Promise<void>): Promise<void> {
    const next = entry.chain.then(fn, fn);
    entry.chain = next.catch(() => undefined);
    return next;
  }

  async function writeManifestSafe(userId: string, entry: OpenEntry): Promise<void> {
    // With a memory tail the disk manifest keeps describing the durable prefix only.
    if (entry.tail) return;
    try {
      await entry.backend.writeManifest(userId, entry.manifest);
    } catch {
      startTail(entry);
    }
  }

  return {
    ready,
    backendKind: () => primary?.kind ?? null,

    async openChunk(meta) {
      const t = now();
      const manifest: ChunkManifest = {
        kind: 'chunk',
        id: newId(),
        userId: meta.userId,
        sessionId: meta.sessionId,
        recordingOrdinal: meta.recordingOrdinal,
        chunkIndex: meta.chunkIndex,
        startedAtUtc: meta.startedAtUtc,
        endedAtUtc: null,
        mimeType: meta.mimeType,
        bytes: 0,
        sliceLog: [],
        finalized: false,
        pendingFinalize: meta.pendingFinalize ?? null,
        createdAt: t,
        updatedAt: t,
        heartbeatAt: t,
        safari: opts.isSafari === true,
      };
      let backend = await target();
      try {
        await backend.create(meta.userId, manifest);
      } catch {
        degrade();
        backend = memory;
        await memory.create(meta.userId, manifest);
      }
      open.set(manifest.id, {
        manifest,
        backend,
        chain: Promise.resolve(),
        tail: null,
        diskBytes: 0,
      });
      if (backend !== primary) location.set(manifest.id, backend);
      return { id: manifest.id, userId: meta.userId };
    },

    append(handle, bytes) {
      const entry = open.get(handle.id);
      if (!entry) return noop();
      return serial(entry, async () => {
        if (bytes.size === 0) return;
        if (entry.backend !== memory && !entry.tail && (await quotaShort())) startTail(entry);
        const t = now();
        const next: ChunkManifest = {
          ...entry.manifest,
          mimeType: entry.manifest.mimeType || bytes.type,
          bytes: entry.manifest.bytes + bytes.size,
          sliceLog: [...entry.manifest.sliceLog, { at: t, bytes: bytes.size }],
          updatedAt: t,
          heartbeatAt: t,
        };
        if (!entry.tail) {
          try {
            await entry.backend.append(handle.userId, next, bytes);
          } catch {
            startTail(entry);
          }
        }
        if (entry.tail) entry.tail.push(bytes);
        entry.manifest = next;
      });
    },

    finalize(handle, endedAtUtc, mimeType) {
      const entry = open.get(handle.id);
      if (!entry) return noop();
      return serial(entry, async () => {
        const t = now();
        entry.manifest = {
          ...entry.manifest,
          endedAtUtc,
          mimeType: mimeType || entry.manifest.mimeType,
          finalized: true,
          updatedAt: t,
          heartbeatAt: t,
        };
        await writeManifestSafe(handle.userId, entry);
      });
    },

    setPendingFinalize(handle, windows) {
      const entry = open.get(handle.id);
      if (!entry) return noop();
      return serial(entry, async () => {
        entry.manifest = { ...entry.manifest, pendingFinalize: [...windows], updatedAt: now() };
        await writeManifestSafe(handle.userId, entry);
      });
    },

    manifestOf(handle) {
      const entry = open.get(handle.id);
      if (!entry) throw new Error(`chunkStore: unknown handle ${handle.id}`);
      return { ...entry.manifest };
    },

    async saveFinalize(userId, input) {
      const t = now();
      const manifest: ChunkManifest = {
        kind: 'finalize',
        id: finalizeRecordId(input.sessionId, input.recordingOrdinal),
        userId,
        sessionId: input.sessionId,
        recordingOrdinal: input.recordingOrdinal,
        chunkIndex: -1,
        startedAtUtc: input.windows[0] ?? '',
        endedAtUtc: null,
        mimeType: '',
        bytes: 0,
        sliceLog: [],
        finalized: true,
        pendingFinalize: [...input.windows],
        createdAt: t,
        updatedAt: t,
        heartbeatAt: t,
        safari: opts.isSafari === true,
      };
      const backend = await target();
      try {
        await backend.writeManifest(userId, manifest);
        if (backend !== primary) location.set(manifest.id, backend);
      } catch {
        degrade();
        await memory.writeManifest(userId, manifest);
        location.set(manifest.id, memory);
      }
    },

    async removeFinalize(userId, sessionId, recordingOrdinal) {
      const id = finalizeRecordId(sessionId, recordingOrdinal);
      for (const b of await backendsFor()) {
        try {
          await b.remove(userId, id);
        } catch {
          /* already gone */
        }
      }
      location.delete(id);
    },

    async list(userId) {
      const cutoff = now() - STORE_MAX_AGE_MS;
      const out: ChunkManifest[] = [];
      for (const b of await backendsFor()) {
        let listed: ChunkManifest[];
        try {
          listed = await b.list(userId);
        } catch {
          continue;
        }
        for (const m of listed) {
          if (m.userId !== userId) continue;
          if (m.updatedAt < cutoff) {
            warn(
              `Deleted a stored audio ${m.kind === 'finalize' ? 'finalize record' : 'chunk'} older than 30 days: session ${m.sessionId}, recording ${m.recordingOrdinal}${m.kind === 'chunk' ? `, chunk ${m.chunkIndex + 1}` : ''}.`,
            );
            try {
              await b.remove(userId, m.id);
            } catch {
              /* next scan retries */
            }
            continue;
          }
          if (b !== primary) location.set(m.id, b);
          out.push(m);
        }
      }
      return out;
    },

    async read(userId, id) {
      const entry = open.get(id);
      if (entry) await entry.chain;
      if (entry?.tail) {
        const { mimeType } = entry.manifest;
        const prefix =
          entry.diskBytes > 0
            ? await entry.backend.read(userId, id, mimeType, entry.diskBytes)
            : new Blob([], { type: mimeType });
        return new Blob([prefix, ...entry.tail], { type: mimeType });
      }
      const backend = await locate(id);
      let manifest = entry?.manifest;
      if (!manifest) {
        manifest = (await backend.list(userId)).find((m) => m.id === id);
        if (!manifest) throw new Error(`chunkStore: no entry ${id}`);
      }
      return backend.read(userId, id, manifest.mimeType, manifest.bytes);
    },

    async remove(userId, id) {
      const entry = open.get(id);
      if (entry) await entry.chain;
      const backend = await locate(id);
      try {
        await backend.remove(userId, id);
      } finally {
        open.delete(id);
        location.delete(id);
      }
    },

    async wipe(userId) {
      for (const b of await backendsFor()) {
        try {
          await b.wipe(userId);
        } catch {
          /* best effort per backend */
        }
      }
      for (const [id, entry] of open) if (entry.manifest.userId === userId) open.delete(id);
    },

    async touch(userId, id) {
      const entry = open.get(id);
      if (!entry) return;
      await serial(entry, async () => {
        entry.manifest = { ...entry.manifest, heartbeatAt: now() };
        await writeManifestSafe(userId, entry);
      });
    },
  };
}

/** Safari (not Chrome/Edge/Firefox on iOS, which also say "Safari"). */
export function detectSafari(ua: string): boolean {
  return /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|android/i.test(ua);
}

/**
 * The production backends in preference order: OPFS through its worker, IndexedDB, memory. Each
 * factory throws when its API is missing; the probe decides the rest.
 */
export function defaultBackends(): Array<() => ChunkBackend> {
  return [
    () => {
      const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } })
        .navigator?.storage;
      if (typeof storage?.getDirectory !== 'function') throw new Error('no OPFS');
      return createOpfsBackend(createWorkerOpfsTransport());
    },
    () => {
      if (typeof indexedDB === 'undefined' || typeof IDBKeyRange === 'undefined') {
        throw new Error('no IndexedDB');
      }
      return createIdbBackend({ factory: indexedDB, keyRange: IDBKeyRange });
    },
    () => createMemoryBackend(),
  ];
}

let singleton: ChunkStore | null = null;
let degradedListener: ((message: string) => void) | null = null;

/** Where the single "persistence fell back to memory" warning goes (the recorder sets a toast). */
export function setChunkStoreDegradedListener(fn: ((message: string) => void) | null): void {
  degradedListener = fn;
}

/** The tab's chunk store with the production backends. */
export function getChunkStore(): ChunkStore {
  if (!singleton) {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    singleton = createChunkStore({
      backends: defaultBackends(),
      estimate: async () =>
        nav?.storage?.estimate ? nav.storage.estimate() : { quota: undefined, usage: undefined },
      onDegraded: (m) => degradedListener?.(m),
      isSafari: detectSafari(nav?.userAgent ?? ''),
    });
  }
  return singleton;
}

/** Test seam: install a store (or drop it so the next `getChunkStore()` builds a fresh one). */
export function setChunkStoreForTesting(store: ChunkStore | null): void {
  singleton = store;
}
