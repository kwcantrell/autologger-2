// Value-based KV over the catalog kv table (login sessions, OAuth CSRF,
// companion last_command). Lazy expiry on get; purgeExpired() runs once at
// startup — no background sweep (spec: scope #3). Runs on the async catalog
// adapter, so it shares the catalog connection's lock and waits for an open
// catalog transaction instead of joining it (async-catalog-adapter D5).
//
// Moved from server/src/node/kvStore.ts (persistence-package-extraction task
// 2.2): the former `= systemClock` default imported the composition root's
// concrete adapter (server/src/node/systemClock.ts), which a package cannot
// reach. Task 2.4 makes `clock` a required constructor parameter (no
// default, no local DEFAULT_CLOCK literal) — `config.ts` already passes the
// clock explicitly (systemClock), so the only call site that needed updating
// was this package's own test.

import type { AsyncCatalogDb, Clock, KvStore as KvStorePort } from '@autologger/ports';

export class KvStore implements KvStorePort {
  constructor(
    private db: AsyncCatalogDb,
    private clock: Clock,
  ) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.first<{ value: string; expires_at: number | null }>(
      'SELECT value, expires_at FROM kv WHERE key = ?',
      key,
    );
    if (!row) return null;
    const now = this.clock.now();
    if (row.expires_at !== null && row.expires_at <= now) {
      // Conditional: the read and this delete are separate lock acquisitions, so a value re-put
      // in between must survive (async-catalog-adapter D5).
      await this.db.run('DELETE FROM kv WHERE key = ? AND expires_at <= ?', key, now);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, opts: { expirationTtl?: number } = {}): Promise<void> {
    const expiresAt = opts.expirationTtl ? this.clock.now() + opts.expirationTtl * 1000 : null;
    await this.db.run(
      'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      key,
      value,
      expiresAt,
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.run('DELETE FROM kv WHERE key = ?', key);
  }

  async purgeExpired(): Promise<void> {
    await this.db.run(
      'DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?',
      this.clock.now(),
    );
  }
}
