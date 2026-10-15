import type { ChunkBackend, ChunkManifest } from './types';

/**
 * IndexedDB backend (design D10): used when OPFS or its sync access handle is unavailable.
 * Database `autologger-chunks`, two stores keyed by strings that start with the user id, so a
 * user's entries are one key range (`list`/`wipe` never read another user's rows):
 * - `manifests`: `{key: <user>\0<id>, manifest}`
 * - `parts`:     `{key: <user>\0<id>\0<seq>, blob}`, one `Blob` per appended slice.
 */

const DB_NAME = 'autologger-chunks';
const DB_VERSION = 1;
const SEP = '\u0000';
const HIGH = '￿';

export interface IdbBackendDeps {
  factory: IDBFactory;
  keyRange: typeof IDBKeyRange;
}

interface ManifestRow {
  key: string;
  manifest: ChunkManifest;
}

interface PartRow {
  key: string;
  blob: Blob;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

const manifestKey = (userId: string, id: string) => `${userId}${SEP}${id}`;
const partPrefix = (userId: string, id: string) => `${userId}${SEP}${id}${SEP}`;
const partKey = (userId: string, id: string, seq: number) =>
  `${partPrefix(userId, id)}${String(seq).padStart(8, '0')}`;

export function createIdbBackend(deps: IdbBackendDeps): ChunkBackend {
  const { factory, keyRange } = deps;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const d = request.result;
          if (!d.objectStoreNames.contains('manifests')) {
            d.createObjectStore('manifests', { keyPath: 'key' });
          }
          if (!d.objectStoreNames.contains('parts')) {
            d.createObjectStore('parts', { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      });
      dbPromise.catch(() => {
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  const prefixRange = (prefix: string) => keyRange.bound(prefix, `${prefix}${HIGH}`);

  async function partCount(userId: string, id: string): Promise<number> {
    const d = await db();
    const tx = d.transaction('parts', 'readonly');
    const rows = await promisify(
      tx.objectStore('parts').getAll(prefixRange(partPrefix(userId, id))),
    );
    return rows.length;
  }

  return {
    kind: 'idb',

    async probe() {
      const d = await db();
      const key = `${SEP}probe`;
      const write = d.transaction('parts', 'readwrite');
      write.objectStore('parts').put({ key, blob: new Blob([new Uint8Array([1, 2, 3])]) });
      await done(write);
      const read = d.transaction('parts', 'readonly');
      const row = (await promisify(read.objectStore('parts').get(key))) as PartRow | undefined;
      const cleanup = d.transaction('parts', 'readwrite');
      cleanup.objectStore('parts').delete(key);
      await done(cleanup);
      if (!row || !(row.blob instanceof Blob) || row.blob.size !== 3) {
        throw new Error('IndexedDB probe read back the wrong bytes');
      }
    },

    async create(userId, manifest) {
      const d = await db();
      const tx = d.transaction(['manifests', 'parts'], 'readwrite');
      tx.objectStore('parts').delete(prefixRange(partPrefix(userId, manifest.id)));
      tx.objectStore('manifests').put({ key: manifestKey(userId, manifest.id), manifest });
      await done(tx);
    },

    async append(userId, manifest, bytes) {
      const seq = await partCount(userId, manifest.id);
      const d = await db();
      const tx = d.transaction(['manifests', 'parts'], 'readwrite');
      tx.objectStore('parts').put({ key: partKey(userId, manifest.id, seq), blob: bytes });
      tx.objectStore('manifests').put({ key: manifestKey(userId, manifest.id), manifest });
      await done(tx);
    },

    async writeManifest(userId, manifest) {
      const d = await db();
      const tx = d.transaction('manifests', 'readwrite');
      tx.objectStore('manifests').put({ key: manifestKey(userId, manifest.id), manifest });
      await done(tx);
    },

    async read(userId, id, mimeType, maxBytes) {
      const d = await db();
      const tx = d.transaction('parts', 'readonly');
      const rows = (await promisify(
        tx.objectStore('parts').getAll(prefixRange(partPrefix(userId, id))),
      )) as PartRow[];
      const whole = new Blob(
        rows.map((r) => r.blob),
        { type: mimeType },
      );
      return maxBytes !== undefined && maxBytes < whole.size
        ? whole.slice(0, maxBytes, mimeType)
        : whole;
    },

    async list(userId) {
      const d = await db();
      const tx = d.transaction('manifests', 'readonly');
      const rows = (await promisify(
        tx.objectStore('manifests').getAll(prefixRange(`${userId}${SEP}`)),
      )) as ManifestRow[];
      return rows.map((r) => r.manifest);
    },

    async remove(userId, id) {
      const d = await db();
      const tx = d.transaction(['manifests', 'parts'], 'readwrite');
      tx.objectStore('manifests').delete(manifestKey(userId, id));
      tx.objectStore('parts').delete(prefixRange(partPrefix(userId, id)));
      await done(tx);
    },

    async wipe(userId) {
      const d = await db();
      const tx = d.transaction(['manifests', 'parts'], 'readwrite');
      tx.objectStore('manifests').delete(prefixRange(`${userId}${SEP}`));
      tx.objectStore('parts').delete(prefixRange(`${userId}${SEP}`));
      await done(tx);
    },
  };
}
