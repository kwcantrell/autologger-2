// Value-based KV over the catalog kv table (login sessions, OAuth CSRF,
// companion last_command). Lazy expiry on get; purgeExpired() runs once at
// startup — no background sweep (spec: scope #3).
//
// Moved from server/src/node/kvStore.ts (persistence-package-extraction task
// 2.2): the former `= systemClock` default imported the composition root's
// concrete adapter (server/src/node/systemClock.ts), which a package cannot
// reach. Task 2.4 makes `clock` a required constructor parameter (no
// default, no local DEFAULT_CLOCK literal) — `config.ts` already passes the
// clock explicitly (systemClock), so the only call site that needed updating
// was this package's own test.

import type { Clock, KvStore as KvStorePort } from '@autologger/ports';
import type { Database } from 'better-sqlite3';

export class KvStore implements KvStorePort {
  constructor(
    private db: Database,
    private clock: Clock,
  ) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value, expires_at FROM kv WHERE key = ?').get(key) as
      | { value: string; expires_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= this.clock.now()) {
      this.delete(key);
      return null;
    }
    return row.value;
  }

  put(key: string, value: string, opts: { expirationTtl?: number } = {}): void {
    const expiresAt = opts.expirationTtl ? this.clock.now() + opts.expirationTtl * 1000 : null;
    this.db
      .prepare(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      )
      .run(key, value, expiresAt);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  purgeExpired(): void {
    this.db
      .prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(this.clock.now());
  }
}
