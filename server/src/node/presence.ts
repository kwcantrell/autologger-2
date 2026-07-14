// In-memory companion presence — the Python CompanionHub shape (nothing
// persisted; rebuilt by browser heartbeats after a restart). Replaces the
// earlier KV-metadata presence keys (spec panel: all reviewers).

export const PRESENCE_FRESH_MS = 15_000;

export interface PresenceMeta {
  session_id: string;
  visible: boolean;
  is_playing: boolean;
  updated: number;
}

export class PresenceRegistry {
  private map = new Map<string, PresenceMeta>();

  upsert(clientId: string, meta: PresenceMeta): void {
    this.map.set(clientId, meta);
  }

  remove(clientId: string): void {
    this.map.delete(clientId);
  }

  /** Fresh entries only (≤15s old); stale ones are pruned as a side effect. */
  list(): PresenceMeta[] {
    const now = Date.now();
    const out: PresenceMeta[] = [];
    for (const [cid, meta] of this.map) {
      if (now - meta.updated <= PRESENCE_FRESH_MS) out.push(meta);
      else this.map.delete(cid);
    }
    return out;
  }
}
