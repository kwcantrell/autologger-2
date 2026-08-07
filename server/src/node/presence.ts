// In-memory companion presence — the Python CompanionHub shape (nothing
// persisted; rebuilt by browser heartbeats after a restart). Replaces the
// earlier KV-metadata presence keys (spec panel: all reviewers).

import type {
  Clock,
  PresenceMeta,
  PresenceRegistry as PresenceRegistryPort,
} from '@autologger/ports';
import { systemClock } from './systemClock';

export type { PresenceMeta };

export const PRESENCE_FRESH_MS = 15_000;

export class PresenceRegistry implements PresenceRegistryPort {
  private map = new Map<string, PresenceMeta>();

  constructor(private clock: Clock = systemClock) {}

  upsert(clientId: string, meta: PresenceMeta): void {
    this.map.set(clientId, meta);
  }

  remove(clientId: string): void {
    this.map.delete(clientId);
  }

  /** Fresh entries only (≤15s old); stale ones are pruned as a side effect. */
  list(): PresenceMeta[] {
    const now = this.clock.now();
    const out: PresenceMeta[] = [];
    for (const [cid, meta] of this.map) {
      if (now - meta.updated <= PRESENCE_FRESH_MS) out.push(meta);
      else this.map.delete(cid);
    }
    return out;
  }
}
