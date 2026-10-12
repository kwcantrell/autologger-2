import {
  createOpfsHandler,
  type OpfsDirHandle,
  type OpfsEnvelope,
  type OpfsReply,
  type OpfsRequest,
  type OpfsResult,
} from './opfsWorker';
import type { ChunkBackend, ChunkManifest } from './types';

/**
 * OPFS backend (design D10): the page side. Every operation is a request to the dedicated worker
 * in `opfsWorker.ts` (the sync access handle exists only there). The transport is injectable:
 * tests run the worker's handler in-process over the fake OPFS.
 */
export interface OpfsTransport {
  call(req: OpfsRequest, transfer?: Transferable[]): Promise<OpfsResult>;
}

/** Runs the worker's handler on this thread (tests; never production, which has no sync API). */
export function createInProcessOpfsTransport(getRoot: () => Promise<unknown>): OpfsTransport {
  const handle = createOpfsHandler(async () => (await getRoot()) as OpfsDirHandle);
  return {
    call: (req) => {
      // Mimic the structured clone of postMessage so no caller relies on shared references.
      const cloned = 'manifest' in req ? { ...req, manifest: structuredClone(req.manifest) } : req;
      return handle(cloned);
    },
  };
}

/**
 * The production transport: a module worker built from `opfsWorker.ts`. Throws synchronously
 * when workers are unavailable, so the store skips this backend; an asynchronous failure (a
 * CSP-blocked worker) rejects the pending calls, so the probe fails and the store falls through.
 */
export function createWorkerOpfsTransport(): OpfsTransport {
  if (typeof Worker === 'undefined') throw new Error('Worker is unavailable');
  const worker = new Worker(new URL('./opfsWorker.ts', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (r: OpfsResult) => void; reject: (e: Error) => void }
  >();
  const failAll = (message: string) => {
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
  };
  worker.addEventListener('message', (ev: MessageEvent<OpfsReply>) => {
    const p = pending.get(ev.data.seq);
    if (!p) return;
    pending.delete(ev.data.seq);
    if (ev.data.ok) p.resolve(ev.data.result ?? null);
    else p.reject(new Error(ev.data.error ?? 'OPFS worker error'));
  });
  worker.addEventListener('error', () => failAll('OPFS worker failed'));
  worker.addEventListener('messageerror', () => failAll('OPFS worker message error'));
  return {
    call(req, transfer = []) {
      seq += 1;
      const envelope: OpfsEnvelope = { seq, req };
      return new Promise<OpfsResult>((resolve, reject) => {
        pending.set(envelope.seq, { resolve, reject });
        worker.postMessage(envelope, transfer);
      });
    },
  };
}

export function createOpfsBackend(transport: OpfsTransport): ChunkBackend {
  const call = transport.call.bind(transport);
  return {
    kind: 'opfs',
    async probe() {
      await call({ op: 'probe' });
    },
    async create(userId, manifest) {
      await call({ op: 'create', userId, manifest });
    },
    async append(userId, manifest, bytes) {
      const buffer = await bytes.arrayBuffer();
      await call({ op: 'append', userId, manifest, bytes: buffer }, [buffer]);
    },
    async writeManifest(userId, manifest) {
      await call({ op: 'writeManifest', userId, manifest });
    },
    async read(userId, id, mimeType, maxBytes) {
      const buffer = (await call({ op: 'read', userId, id, maxBytes })) as ArrayBuffer;
      return new Blob([buffer], { type: mimeType });
    },
    async list(userId) {
      return (await call({ op: 'list', userId })) as ChunkManifest[];
    },
    async remove(userId, id) {
      await call({ op: 'remove', userId, id });
    },
    async wipe(userId) {
      await call({ op: 'wipe', userId });
    },
  };
}
