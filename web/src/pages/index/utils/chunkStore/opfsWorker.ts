/**
 * The OPFS side of the chunk store (media-worker design D10), run in a dedicated Worker because
 * `createSyncAccessHandle` (the only OPFS write API Safari supports) exists only there.
 *
 * Layout: `autologger-chunks/<encoded userId>/<id>.bin` (the appended bytes) and `<id>.json`
 * (the manifest). Bytes are written and flushed before the manifest, so the manifest's slice log
 * never claims bytes that are not on disk. Every sync handle is closed before the request answers:
 * a handle is exclusive, and another tab's recovery scan must be able to read the entry.
 *
 * The request handler is exported for tests, which run it in-process over the fake OPFS
 * (`web/src/test/fakes/opfs.ts`); in a worker the bottom of this module wires it to messages.
 */

import type { ChunkManifest } from './types';

export const OPFS_ROOT_DIR = 'autologger-chunks';

/** The structural subset of the OPFS handle types this module uses. */
export interface OpfsSyncHandle {
  getSize(): number;
  read(buffer: Uint8Array, opts?: { at?: number }): number;
  write(buffer: Uint8Array, opts?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

export interface OpfsFileHandle {
  readonly kind: string;
  createSyncAccessHandle(): Promise<OpfsSyncHandle>;
  getFile(): Promise<Blob>;
}

export interface OpfsDirHandle {
  readonly kind: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, { kind: string }]>;
}

export type OpfsRequest =
  | { op: 'probe' }
  | { op: 'create'; userId: string; manifest: ChunkManifest }
  | { op: 'append'; userId: string; manifest: ChunkManifest; bytes: ArrayBuffer }
  | { op: 'writeManifest'; userId: string; manifest: ChunkManifest }
  | { op: 'read'; userId: string; id: string; maxBytes?: number }
  | { op: 'list'; userId: string }
  | { op: 'remove'; userId: string; id: string }
  | { op: 'wipe'; userId: string };

/** Results: `read` → `ArrayBuffer`, `list` → manifests, everything else → `null`. */
export type OpfsResult = ArrayBuffer | ChunkManifest[] | null;

const isNotFound = (err: unknown) =>
  !!err && typeof err === 'object' && (err as { name?: string }).name === 'NotFoundError';

const userDirName = (userId: string) => encodeURIComponent(userId);

async function withSyncHandle<T>(
  dir: OpfsDirHandle,
  name: string,
  fn: (h: OpfsSyncHandle) => T,
): Promise<T> {
  const file = await dir.getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
}

async function writeWhole(dir: OpfsDirHandle, name: string, bytes: Uint8Array): Promise<void> {
  await withSyncHandle(dir, name, (h) => {
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  });
}

async function removeQuiet(dir: OpfsDirHandle, name: string, recursive = false): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/**
 * Build the request handler over an OPFS root. Requests are serialised: two sync handles on the
 * same file would conflict, and `append` must see the previous append's size.
 */
export function createOpfsHandler(
  getRoot: () => Promise<OpfsDirHandle>,
): (req: OpfsRequest) => Promise<OpfsResult> {
  let chain: Promise<unknown> = Promise.resolve();
  const encoder = new TextEncoder();

  async function base(): Promise<OpfsDirHandle> {
    return (await getRoot()).getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
  }

  async function userDir(userId: string, create: boolean): Promise<OpfsDirHandle | null> {
    try {
      return await (await base()).getDirectoryHandle(userDirName(userId), { create });
    } catch (err) {
      if (!create && isNotFound(err)) return null;
      throw err;
    }
  }

  const manifestBytes = (m: ChunkManifest) => encoder.encode(JSON.stringify(m));

  async function run(req: OpfsRequest): Promise<OpfsResult> {
    switch (req.op) {
      case 'probe': {
        const dir = await base();
        const name = `.probe-${Math.random().toString(36).slice(2)}`;
        const expected = new Uint8Array([1, 2, 3, 4]);
        const got = await withSyncHandle(dir, name, (h) => {
          h.truncate(0);
          h.write(expected, { at: 0 });
          h.flush();
          const back = new Uint8Array(h.getSize());
          h.read(back, { at: 0 });
          return back;
        });
        await removeQuiet(dir, name);
        if (got.length !== expected.length || got.some((b, i) => b !== expected[i])) {
          throw new Error('OPFS probe read back the wrong bytes');
        }
        return null;
      }
      case 'create': {
        const dir = (await userDir(req.userId, true)) as OpfsDirHandle;
        await withSyncHandle(dir, `${req.manifest.id}.bin`, (h) => {
          h.truncate(0);
          h.flush();
        });
        await writeWhole(dir, `${req.manifest.id}.json`, manifestBytes(req.manifest));
        return null;
      }
      case 'append': {
        const dir = (await userDir(req.userId, true)) as OpfsDirHandle;
        await withSyncHandle(dir, `${req.manifest.id}.bin`, (h) => {
          h.write(new Uint8Array(req.bytes), { at: h.getSize() });
          h.flush();
        });
        await writeWhole(dir, `${req.manifest.id}.json`, manifestBytes(req.manifest));
        return null;
      }
      case 'writeManifest': {
        const dir = (await userDir(req.userId, true)) as OpfsDirHandle;
        await writeWhole(dir, `${req.manifest.id}.json`, manifestBytes(req.manifest));
        return null;
      }
      case 'read': {
        const dir = await userDir(req.userId, false);
        if (!dir) throw new Error(`chunkStore(opfs): no entry ${req.id}`);
        const file = await dir.getFileHandle(`${req.id}.bin`);
        const handle = await file.createSyncAccessHandle();
        try {
          const size = Math.min(handle.getSize(), req.maxBytes ?? Number.POSITIVE_INFINITY);
          const out = new Uint8Array(size);
          handle.read(out, { at: 0 });
          return out.buffer;
        } finally {
          handle.close();
        }
      }
      case 'list': {
        const dir = await userDir(req.userId, false);
        if (!dir) return [];
        const out: ChunkManifest[] = [];
        for await (const [name, entry] of dir.entries()) {
          if (entry.kind !== 'file' || !name.endsWith('.json')) continue;
          try {
            const file = await dir.getFileHandle(name);
            const text = await (await file.getFile()).text();
            // A manifest this module wrote itself (local OPFS, never an API response).
            out.push(JSON.parse(text) as ChunkManifest);
          } catch {
            // Torn or locked by another tab mid-write: skipped this scan, seen by the next.
          }
        }
        return out;
      }
      case 'remove': {
        const dir = await userDir(req.userId, false);
        if (!dir) return null;
        await removeQuiet(dir, `${req.id}.json`);
        await removeQuiet(dir, `${req.id}.bin`);
        return null;
      }
      case 'wipe': {
        await removeQuiet(await base(), userDirName(req.userId), true);
        return null;
      }
    }
  }

  return (req) => {
    const next = chain.then(
      () => run(req),
      () => run(req),
    );
    chain = next.catch(() => undefined);
    return next;
  };
}

/** Message envelope between `opfsBackend.ts` and this worker. */
export interface OpfsEnvelope {
  seq: number;
  req: OpfsRequest;
}

export interface OpfsReply {
  seq: number;
  ok: boolean;
  result?: OpfsResult;
  error?: string;
}

interface WorkerScope {
  addEventListener(type: 'message', fn: (ev: { data: OpfsEnvelope }) => void): void;
  postMessage(msg: OpfsReply, transfer?: Transferable[]): void;
  navigator: { storage: { getDirectory(): Promise<unknown> } };
}

declare const WorkerGlobalScope: unknown;

// Wire the handler when this module runs as a dedicated worker (never in the page or tests).
if (typeof WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as WorkerScope;
  const handle = createOpfsHandler(
    async () => (await scope.navigator.storage.getDirectory()) as OpfsDirHandle,
  );
  scope.addEventListener('message', (ev) => {
    const { seq, req } = ev.data;
    handle(req).then(
      (result) =>
        scope.postMessage({ seq, ok: true, result }, result instanceof ArrayBuffer ? [result] : []),
      (err: unknown) =>
        scope.postMessage({
          seq,
          ok: false,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        }),
    );
  });
}
