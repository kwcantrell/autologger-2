// Value-based KV over the catalog kv table (login sessions, OAuth CSRF,
// companion last_command). Lazy expiry on get; purgeExpired() runs once at
// startup and every 10 minutes (catalog-concurrency-hazards). Runs on the catalog
// adapter's root handle, so a call never joins an open catalog transaction
// (core-ports-architecture "The Postgres catalog adapter").
//
// Moved from server/src/node/kvStore.ts (persistence-package-extraction task
// 2.2): the former `= systemClock` default imported the composition root's
// concrete adapter (server/src/node/systemClock.ts), which a package cannot
// reach. Task 2.4 makes `clock` a required constructor parameter (no
// default, no local DEFAULT_CLOCK literal) — `config.ts` already passes the
// clock explicitly (systemClock), so the only call site that needed updating
// was this package's own test.

import type { CatalogDb, Clock, KvStore as KvStorePort } from '@autologger/ports';

export class KvStore implements KvStorePort {
  constructor(
    private db: CatalogDb,
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
      // Conditional: the read and this delete are separate statements, so a value re-put in
      // between must survive (retire-sqlite-catalog D2 tests it).
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

  /** One statement, so it is atomic on any engine: of concurrent takes of one key, exactly one
   * sees the value (async-catalog-stores D4). An expired entry is removed and reads as absent. */
  async take(key: string): Promise<string | null> {
    const row = await this.db.first<{ value: string; expires_at: number | null }>(
      'DELETE FROM kv WHERE key = ? RETURNING value, expires_at',
      key,
    );
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= this.clock.now()) return null;
    return row.value;
  }

  async replaceIf(key: string, expected: string, next: string): Promise<boolean> {
    const res = await this.db.run(
      'UPDATE kv SET value = ? WHERE key = ? AND value = ? AND (expires_at IS NULL OR expires_at > ?)',
      next,
      key,
      expected,
      this.clock.now(),
    );
    return res.changes > 0;
  }

  async purgeExpired(): Promise<void> {
    await this.db.run(
      'DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?',
      this.clock.now(),
    );
  }
}
