// The PresenceRegistry port on `catalog.companion_presence` (companion-devices D4; core-ports-
// architecture "Companion presence is shared by every process"). It binds its own reviewed system
// reason, `companion-presence` (RLS `catalog_system` allow-all; `catalog_user` has no privilege on
// the table), so every process sharing the database sees the same presence. Every time it reads
// or writes comes from the Clock port.

import type {
  CatalogDb,
  CatalogRoot,
  Clock,
  PresenceMeta,
  PresenceRegistry,
  PresenceRow,
} from '@autologger/ports';
import { PRESENCE_FRESH_MS } from '@autologger/ports/presenceRegistry';

interface Stored {
  client_id: string;
  user_id: string;
  session_id: string | null;
  visible: boolean;
  is_playing: boolean;
  updated_at_ms: number;
}

export class PostgresPresence implements PresenceRegistry {
  private readonly db: CatalogDb;

  constructor(
    root: CatalogRoot,
    private readonly clock: Clock,
  ) {
    this.db = root.bindSystem('companion-presence');
  }

  /** Ownership (D3): an existing row is updated only when it is the same user's, or stale (older
   * than PRESENCE_FRESH_MS); a fresh row of another user is left unchanged. */
  async upsert(clientId: string, meta: PresenceMeta): Promise<void> {
    const now = this.clock.now();
    await this.db.run(
      `INSERT INTO companion_presence
         (client_id, user_id, session_id, visible, is_playing, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET
         user_id = excluded.user_id,
         session_id = excluded.session_id,
         visible = excluded.visible,
         is_playing = excluded.is_playing,
         updated_at_ms = excluded.updated_at_ms
       WHERE companion_presence.user_id = excluded.user_id
          OR companion_presence.updated_at_ms < ?`,
      clientId,
      meta.user_id,
      meta.session_id || null,
      meta.visible,
      meta.is_playing,
      now,
      now - PRESENCE_FRESH_MS,
    );
  }

  async remove(clientId: string, userId: string): Promise<void> {
    await this.db.run(
      'DELETE FROM companion_presence WHERE client_id = ? AND user_id = ?',
      clientId,
      userId,
    );
  }

  async list(userId: string): Promise<PresenceRow[]> {
    const rows = await this.db.all<Stored>(
      `SELECT client_id, user_id, session_id, visible, is_playing, updated_at_ms
         FROM companion_presence
        WHERE user_id = ? AND updated_at_ms >= ?
        ORDER BY updated_at_ms DESC, client_id`,
      userId,
      this.clock.now() - PRESENCE_FRESH_MS,
    );
    return rows.map((r) => ({
      client_id: r.client_id,
      user_id: r.user_id,
      session_id: r.session_id,
      visible: r.visible,
      is_playing: r.is_playing,
      updated: Number(r.updated_at_ms),
    }));
  }

  async deleteOlderThan(cutoffMs: number): Promise<void> {
    await this.db.run('DELETE FROM companion_presence WHERE updated_at_ms < ?', cutoffMs);
  }
}
