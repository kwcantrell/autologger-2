import type { ChunkBackend, ChunkManifest } from './types';

/**
 * The last-resort backend (design D10): today's behaviour, bytes live only as long as the tab.
 * Always probes successfully. Also the target a chunk moves to when quota runs short mid-take.
 */
export function createMemoryBackend(): ChunkBackend {
  const users = new Map<string, Map<string, { manifest: ChunkManifest; parts: Blob[] }>>();

  const userMap = (userId: string) => {
    let m = users.get(userId);
    if (!m) {
      m = new Map();
      users.set(userId, m);
    }
    return m;
  };

  return {
    kind: 'memory',
    async probe() {},
    async create(userId, manifest) {
      userMap(userId).set(manifest.id, { manifest: { ...manifest }, parts: [] });
    },
    async append(userId, manifest, bytes) {
      const entry = userMap(userId).get(manifest.id);
      if (!entry) throw new Error(`chunkStore(memory): no entry ${manifest.id}`);
      entry.parts.push(bytes);
      entry.manifest = { ...manifest };
    },
    async writeManifest(userId, manifest) {
      const entry = userMap(userId).get(manifest.id);
      if (entry) entry.manifest = { ...manifest };
      else userMap(userId).set(manifest.id, { manifest: { ...manifest }, parts: [] });
    },
    async read(userId, id, mimeType, maxBytes) {
      const entry = userMap(userId).get(id);
      if (!entry) throw new Error(`chunkStore(memory): no entry ${id}`);
      const whole = new Blob(entry.parts, { type: mimeType });
      return maxBytes !== undefined && maxBytes < whole.size
        ? whole.slice(0, maxBytes, mimeType)
        : whole;
    },
    async list(userId) {
      return Array.from(userMap(userId).values(), (e) => ({ ...e.manifest }));
    },
    async remove(userId, id) {
      userMap(userId).delete(id);
    },
    async wipe(userId) {
      users.delete(userId);
    },
  };
}
