// Resumable parts upload for big audio (media-worker D12; batch-audio-import "Large imports upload
// in parts"; api-contract-freeze "Resumable audio upload endpoints").
//
// Flow: hash each part with WebCrypto over that part's own slice (never the whole file in one
// buffer) → `POST …/audio/uploads` → `PUT …/parts/:n` in order, one in flight, each part retried on
// the chunk upload's backoff after re-reading the status to skip parts already received → `POST
// …/complete` in import mode (`duration_s` + `X-Audio-Seam-Parts`, local-audio-import's semantics)
// or segment mode (the recording window, the segment POST's semantics; the live queue's `413`
// fallback). An `upload_id` is remembered in IndexedDB by the file group's identity for 24 h, so a
// re-run of the same import, in this tab or another, resumes instead of starting over.

import { ApiError, apiFetch } from './client';
import type { AudioUploadCompleted, AudioUploadCreated, AudioUploadStatus } from './types';

/** The server's part size (design D12, `UPLOAD_PART_BYTES`); the parts are hashed at this size
 * before the create call answers with its `part_size`, which must equal it. */
export const UPLOAD_PART_BYTES = 32 * 1024 * 1024;
/** Blobs over this go through the parts flow; smaller ones keep `local-audio-import` (D12). */
export const IMPORT_PARTS_THRESHOLD_BYTES = 40 * 1024 * 1024;
/** How long a remembered `upload_id` is offered for resume (the server's expiry, D12). */
export const UPLOAD_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
/** Attempts per part before the run gives up (the upload stays remembered for a resume). */
export const DEFAULT_MAX_ATTEMPTS_PER_PART = 6;

/** The chunk upload's backoff (design D11): `min(300 s, 2 s × 2^(attempt−1)) × U(0.5, 1.5)`. */
export function partBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(300_000, 2000 * 2 ** Math.max(0, attempt - 1));
  return base * (0.5 + random());
}

// --- resume memory --------------------------------------------------------------------------

/** What is remembered about an open upload, keyed by the file group's identity. */
export interface RememberedUpload {
  uploadId: string;
  sessionId: string;
  sizeBytes: number;
  partSize: number;
  partSha256: string[];
  contentType: string;
  savedAtMs: number;
}

export interface UploadMemory {
  /** The record for `key`, or null when absent or older than 24 h. */
  get(key: string): Promise<RememberedUpload | null>;
  put(key: string, value: RememberedUpload): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Identity of a file group for resume: its ordered file names, sizes and last-modified times
 * (D12), so a re-run of the same folder finds the upload and a changed file does not.
 */
export function fileGroupIdentity(
  files: readonly Pick<File, 'name' | 'size' | 'lastModified'>[],
): string {
  return JSON.stringify(files.map((f) => [f.name, f.size, f.lastModified]));
}

function fresh(value: RememberedUpload | null | undefined, now: number): RememberedUpload | null {
  if (!value) return null;
  return now - value.savedAtMs < UPLOAD_MEMORY_TTL_MS ? value : null;
}

/** In-process memory: the fallback when IndexedDB is unavailable (no cross-tab resume). */
export function createMemoryUploadMemory(now: () => number = Date.now): UploadMemory {
  const map = new Map<string, RememberedUpload>();
  return {
    async get(key) {
      const v = fresh(map.get(key), now());
      if (!v) map.delete(key);
      return v;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const IDB_NAME = 'autologger-uploads';
const IDB_STORE = 'uploads';
const IDB_SESSIONS_STORE = 'import-sessions';

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Opens `autologger-uploads` (both stores are created at version 1) once per memory and hands
 * out an object store of it per call. */
function idbStoreOpener(
  factory: IDBFactory,
  storeName: string,
): (mode: IDBTransactionMode) => Promise<IDBObjectStore> {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = factory.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const name of [IDB_STORE, IDB_SESSIONS_STORE]) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      }).catch((err: unknown) => {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  };
  return async (mode) => (await open()).transaction(storeName, mode).objectStore(storeName);
}

/**
 * IndexedDB-backed memory (`autologger-uploads`, shared by every tab of the origin; never
 * `sessionStorage`, which a new tab does not share). Any IndexedDB failure degrades to "nothing
 * remembered": a resume is a convenience, never a requirement.
 */
export function createIdbUploadMemory(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  now: () => number = Date.now,
): UploadMemory {
  if (!factory) return createMemoryUploadMemory(now);
  const store = idbStoreOpener(factory, IDB_STORE);
  return {
    async get(key) {
      try {
        const v = (await idbRequest((await store('readonly')).get(key))) as
          | RememberedUpload
          | undefined;
        const ok = fresh(v, now());
        if (v && !ok) await idbRequest((await store('readwrite')).delete(key));
        return ok;
      } catch {
        return null;
      }
    },
    async put(key, value) {
      try {
        await idbRequest((await store('readwrite')).put(value, key));
      } catch {
        // Best effort: without memory the upload still completes, it just cannot resume.
      }
    },
    async delete(key) {
      try {
        await idbRequest((await store('readwrite')).delete(key));
      } catch {
        // Best effort, as above.
      }
    },
  };
}

let defaultMemory: UploadMemory | null = null;
/** The page's shared memory (IndexedDB when available). */
export function defaultUploadMemory(): UploadMemory {
  if (!defaultMemory) defaultMemory = createIdbUploadMemory();
  return defaultMemory;
}

/** The remembered upload for a group, if any (the batch import resumes into its session). */
export function findRememberedUpload(
  resumeKey: string,
  memory: UploadMemory = defaultUploadMemory(),
): Promise<RememberedUpload | null> {
  return memory.get(resumeKey);
}

// --- the session an import created ----------------------------------------------------------

/** How long the importer remembers the session it created for a file group (outlives the 24 h
 * upload memory, so a re-run after the upload expired still recognises its own empty session). */
export const IMPORT_SESSION_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** File-group identity → id of the session the batch import created for it. */
export interface ImportSessionMemory {
  get(key: string): Promise<string | null>;
  put(key: string, sessionId: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface ImportSessionRecord {
  sessionId: string;
  savedAtMs: number;
}

/** IndexedDB-backed (same database as the upload memory, store `import-sessions`); in-process
 * when IndexedDB is unavailable. Failures degrade to "nothing remembered". */
export function createIdbImportSessionMemory(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  now: () => number = Date.now,
): ImportSessionMemory {
  const live = (v: ImportSessionRecord | undefined) =>
    v && now() - v.savedAtMs < IMPORT_SESSION_MEMORY_TTL_MS ? v.sessionId : null;
  if (!factory) {
    const map = new Map<string, ImportSessionRecord>();
    return {
      async get(key) {
        return live(map.get(key));
      },
      async put(key, sessionId) {
        map.set(key, { sessionId, savedAtMs: now() });
      },
      async delete(key) {
        map.delete(key);
      },
    };
  }
  const store = idbStoreOpener(factory, IDB_SESSIONS_STORE);
  return {
    async get(key) {
      try {
        const v = (await idbRequest((await store('readonly')).get(key))) as
          | ImportSessionRecord
          | undefined;
        const id = live(v);
        if (v && id === null) await idbRequest((await store('readwrite')).delete(key));
        return id;
      } catch {
        return null;
      }
    },
    async put(key, sessionId) {
      try {
        await idbRequest(
          (await store('readwrite')).put(
            { sessionId, savedAtMs: now() } satisfies ImportSessionRecord,
            key,
          ),
        );
      } catch {
        // Best effort.
      }
    },
    async delete(key) {
      try {
        await idbRequest((await store('readwrite')).delete(key));
      } catch {
        // Best effort.
      }
    },
  };
}

let defaultSessionMemory: ImportSessionMemory | null = null;
function defaultImportSessionMemory(): ImportSessionMemory {
  if (!defaultSessionMemory) defaultSessionMemory = createIdbImportSessionMemory();
  return defaultSessionMemory;
}

/** The session the batch import created for this file group, if remembered. */
export function findImportSession(groupKey: string): Promise<string | null> {
  return defaultImportSessionMemory().get(groupKey);
}

export function rememberImportSession(groupKey: string, sessionId: string): Promise<void> {
  return defaultImportSessionMemory().put(groupKey, sessionId);
}

export function forgetImportSession(groupKey: string): Promise<void> {
  return defaultImportSessionMemory().delete(groupKey);
}

// --- errors -----------------------------------------------------------------------------------

/**
 * Why a parts upload stopped. `capacity` (`429`: two open uploads or 3 GiB staged for this user)
 * and `disk` (`507`: the server is below its free-disk floor) are per-group messages; `rejected`
 * is any other refusal; `failed` is a transient failure that outlasted the retry budget.
 * `resumable` is true when an upload exists and is remembered, so a re-run continues it.
 */
export class PartsUploadError extends Error {
  constructor(
    readonly kind: 'capacity' | 'disk' | 'rejected' | 'failed',
    message: string,
    readonly status: number | null,
    readonly resumable: boolean,
  ) {
    super(message);
    this.name = 'PartsUploadError';
  }
}

const CAPACITY_MESSAGE =
  'Too many large uploads are open or staged for your account; let them finish (or wait a day for them to expire), then re-run the import.';
const DISK_MESSAGE =
  'The server is low on disk space for uploads; try again later or ask the operator to free space.';

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status >= 500 || err.status === 408 || err.status === 429 || err.status === 400;
  }
  return !isAbort(err); // a network failure (fetch rejects with TypeError)
}

function toUploadError(err: unknown, resumable: boolean): PartsUploadError {
  if (err instanceof PartsUploadError) return err;
  if (err instanceof ApiError) {
    if (err.status === 429)
      return new PartsUploadError('capacity', CAPACITY_MESSAGE, 429, resumable);
    if (err.status === 507) return new PartsUploadError('disk', DISK_MESSAGE, 507, resumable);
    return new PartsUploadError('rejected', err.message, err.status, resumable);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new PartsUploadError('failed', detail, null, resumable);
}

// --- the upload -------------------------------------------------------------------------------

/** How the completed upload is attached (D12). */
export type UploadCompletion =
  | {
      /** One imported take, exactly like `local-audio-import`. */
      mode: 'import';
      durationS: number;
      /** Ordered per-part durations for the `X-Audio-Seam-Parts` header. */
      seamParts?: readonly { duration_s: number }[];
    }
  | {
      /** One live chunk, exactly like `POST …/audio/segments` (idempotent per window). */
      mode: 'segment';
      recordingOrdinal: number;
      startedAtUtc: string;
      endedAtUtc: string;
    };

export interface PartsUploadProgress {
  partsDone: number;
  partsTotal: number;
}

export interface PartsUploadOptions {
  sessionId: string;
  blob: Blob;
  contentType: string;
  completion: UploadCompletion;
  /** File-group identity (`fileGroupIdentity`) to remember the upload by; none → no resume. */
  resumeKey?: string | null;
  memory?: UploadMemory;
  signal?: AbortSignal;
  onProgress?: (p: PartsUploadProgress) => void;
  /** Test seams. */
  partSizeBytes?: number;
  maxAttemptsPerPart?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 of each part, each computed from that part's own slice (never one whole-file buffer). */
async function hashParts(blob: Blob, partSize: number, signal?: AbortSignal): Promise<string[]> {
  const hashes: string[] = [];
  for (let off = 0; off < blob.size; off += partSize) {
    throwIfAborted(signal);
    const bytes = await blob.slice(off, Math.min(blob.size, off + partSize)).arrayBuffer();
    hashes.push(hex(await crypto.subtle.digest('SHA-256', bytes)));
  }
  return hashes;
}

function uploadsPath(sessionId: string, rest = ''): string {
  return `sessions/${encodeURIComponent(sessionId)}/audio/uploads${rest}`;
}

// One call site per route (each is checked against its captured fixture or exempted by the
// apiResponseShapes repo guard).
function getUploadStatus(
  sessionId: string,
  uploadId: string,
  signal?: AbortSignal,
): Promise<AudioUploadStatus> {
  return apiFetch<AudioUploadStatus>(uploadsPath(sessionId, `/${encodeURIComponent(uploadId)}`), {
    signal,
  });
}

/** Best-effort `DELETE` (`204`): drops the server's staging for an upload this client abandons. */
async function deleteUpload(sessionId: string, uploadId: string): Promise<void> {
  try {
    await apiFetch(uploadsPath(sessionId, `/${encodeURIComponent(uploadId)}`), {
      method: 'DELETE',
    });
  } catch {
    // The server's expiry sweep removes it within 24 h anyway.
  }
}

function sameHashes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

/**
 * Upload `blob` in parts and attach it per `completion`. Resolves with the new (or, in segment mode,
 * the existing) segment's id. Throws `PartsUploadError` on a refusal or an exhausted retry budget,
 * and the `AbortError` when `signal` aborts (the upload stays remembered).
 */
export async function uploadInParts(opts: PartsUploadOptions): Promise<{ segmentId: string }> {
  const { sessionId, blob, contentType, completion, signal } = opts;
  const partSize = opts.partSizeBytes ?? UPLOAD_PART_BYTES;
  const maxAttempts = opts.maxAttemptsPerPart ?? DEFAULT_MAX_ATTEMPTS_PER_PART;
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;
  const resumeKey = opts.resumeKey ?? null;
  const memory = resumeKey ? (opts.memory ?? defaultUploadMemory()) : null;

  const hashes = await hashParts(blob, partSize, signal);
  const partsTotal = hashes.length;

  // Resume a remembered upload of the same bytes into the same session, else start a new one.
  let uploadId: string | null = null;
  let received = new Set<number>();
  if (memory && resumeKey) {
    const prior = await memory.get(resumeKey);
    if (prior) {
      const matches =
        prior.sessionId === sessionId &&
        prior.sizeBytes === blob.size &&
        prior.partSize === partSize &&
        sameHashes(prior.partSha256, hashes);
      if (matches) {
        try {
          const st = await getUploadStatus(sessionId, prior.uploadId, signal);
          uploadId = prior.uploadId;
          received = new Set(st.received);
        } catch (err) {
          if (isAbort(err)) throw err;
          await memory.delete(resumeKey);
        }
      } else {
        if (prior.sessionId === sessionId) await deleteUpload(sessionId, prior.uploadId);
        await memory.delete(resumeKey);
      }
    }
  }

  if (uploadId === null) {
    let created: AudioUploadCreated;
    try {
      created = await apiFetch<AudioUploadCreated>(uploadsPath(sessionId), {
        method: 'POST',
        body: JSON.stringify({
          content_type: contentType,
          size_bytes: blob.size,
          part_sha256: hashes,
        }),
        signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw toUploadError(err, false);
    }
    if (created.part_size !== partSize || created.parts_total !== partsTotal) {
      await deleteUpload(sessionId, created.upload_id);
      throw new PartsUploadError(
        'rejected',
        `The server's part size (${created.part_size} bytes) differs from this client's (${partSize}); reload the page and retry.`,
        null,
        false,
      );
    }
    uploadId = created.upload_id;
    if (memory && resumeKey) {
      await memory.put(resumeKey, {
        uploadId,
        sessionId,
        sizeBytes: blob.size,
        partSize,
        partSha256: hashes,
        contentType,
        savedAtMs: Date.now(),
      });
    }
  }
  const id = uploadId;
  const resumable = memory !== null;

  const report = () => opts.onProgress?.({ partsDone: received.size, partsTotal });
  report();

  const sendPart = async (n: number): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      throwIfAborted(signal);
      try {
        const off = (n - 1) * partSize;
        await apiFetch(uploadsPath(sessionId, `/${encodeURIComponent(id)}/parts/${n}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob.slice(off, Math.min(blob.size, off + partSize)),
          signal,
        });
        received.add(n);
        report();
        return;
      } catch (err) {
        if (isAbort(err)) throw err;
        if (err instanceof ApiError && err.status === 404) {
          // Expired, completed elsewhere or aborted: nothing left to resume.
          if (memory && resumeKey) await memory.delete(resumeKey);
          throw toUploadError(err, false);
        }
        if (!isTransient(err) || (err instanceof ApiError && err.status === 507)) {
          throw toUploadError(err, resumable);
        }
        if (attempt >= maxAttempts) throw toUploadError(err, resumable);
        await sleep(partBackoffMs(attempt, random), signal);
        // Re-read the status before the retry: the failed PUT may have landed after all.
        try {
          const st = await getUploadStatus(sessionId, id, signal);
          received = new Set(st.received);
          if (received.has(n)) {
            report();
            return;
          }
        } catch (statusErr) {
          if (isAbort(statusErr)) throw statusErr;
          // The status read failing is just another failed attempt; the loop retries the PUT.
        }
      }
    }
  };

  const complete = async (): Promise<AudioUploadCompleted> => {
    const params = new URLSearchParams();
    const headers: Record<string, string> = {};
    if (completion.mode === 'import') {
      params.set('duration_s', String(completion.durationS));
      if (completion.seamParts)
        headers['X-Audio-Seam-Parts'] = JSON.stringify(completion.seamParts);
    } else {
      params.set('recording_ordinal', String(completion.recordingOrdinal));
      params.set('started_at_utc', completion.startedAtUtc);
      params.set('ended_at_utc', completion.endedAtUtc);
    }
    return apiFetch<AudioUploadCompleted>(
      uploadsPath(sessionId, `/${encodeURIComponent(id)}/complete?${params.toString()}`),
      { method: 'POST', headers, signal },
    );
  };

  for (let pass = 0; ; pass += 1) {
    for (let n = 1; n <= partsTotal; n += 1) {
      if (!received.has(n)) await sendPart(n);
    }
    try {
      const done = await complete();
      if (memory && resumeKey) await memory.delete(resumeKey);
      return { segmentId: done.segment_id };
    } catch (err) {
      if (isAbort(err)) throw err;
      const missing = (
        err instanceof ApiError && err.status === 409
          ? (err.body as { missing_parts?: unknown } | undefined)?.missing_parts
          : undefined
      ) as number[] | undefined;
      if (Array.isArray(missing) && missing.length > 0 && pass === 0) {
        for (const n of missing) received.delete(n);
        continue;
      }
      if (err instanceof ApiError && err.status === 400) {
        // A re-hash or size mismatch aborts the upload server-side.
        if (memory && resumeKey) await memory.delete(resumeKey);
        throw toUploadError(err, false);
      }
      throw toUploadError(err, resumable && !(err instanceof ApiError && err.status === 404));
    }
  }
}

/**
 * Segment mode for one live chunk over the 50 MB segment cap (design D11: the queue's `413`
 * fallback). Same semantics as `POST …/audio/segments` with the window, including the server's
 * idempotency per window, so a replay resolves to the segment that holds it.
 */
export function uploadSegmentInParts(
  sessionId: string,
  blob: Blob,
  window: { recordingOrdinal: number; startedAtUtc: string; endedAtUtc: string },
  opts: Pick<
    PartsUploadOptions,
    'signal' | 'onProgress' | 'partSizeBytes' | 'maxAttemptsPerPart' | 'sleep' | 'random'
  > & { contentType?: string } = {},
): Promise<{ segmentId: string }> {
  return uploadInParts({
    ...opts,
    sessionId,
    blob,
    contentType: opts.contentType ?? (blob.type || 'audio/webm'),
    completion: { mode: 'segment', ...window },
    resumeKey: null,
  });
}
