// Session rows for the DB-backed session tests on Postgres (session-tables D12): the
// `catalog.sessions` row a hub needs, the session storage over the harness's adapter, registries
// over it, and raw reads and writes of the session tables with `session_id` filled in. Test
// infrastructure.

import type { Row, SessionStorage, SqlValue } from '@autologger/session-core/sessionCore';
import { SessionHubRegistry } from '@autologger/session-core/SessionHub';
import type { Clock } from '@autologger/ports';
import { PostgresCatalogDb, PostgresSessionDb } from '@autologger/storage';
import type { vi } from 'vitest';
import { env } from '../harness';

/** The harness's adapter, under the retry counter when `CATALOG_RETRY_LOG` wraps it. */
export function catalogRoot(): PostgresCatalogDb {
  let root: unknown = env.ports.catalog;
  while (!(root instanceof PostgresCatalogDb)) {
    root = (root as { inner?: unknown }).inner;
    if (root === undefined) throw new Error('the harness catalog is not a PostgresCatalogDb');
  }
  return root;
}

/** Session storage over `root` (the harness's adapter by default), as the composition root builds
 * it. */
export function sessionDb(root: PostgresCatalogDb = catalogRoot()): PostgresSessionDb {
  return new PostgresSessionDb(root.bindSystem('session-hub'));
}

let made = 0;

/** Inserts a `catalog.sessions` row (no show) and returns its id. */
export async function createSessionRow(id = `s-${++made}-${crypto.randomUUID().slice(0, 8)}`) {
  await catalogRoot().bindSystem('test-seed').run('INSERT INTO sessions (id) VALUES (?)', id);
  return id;
}

/** One session's storage, carrying its id for the raw helpers below. */
export interface TestStorage extends SessionStorage {
  readonly sessionId: string;
}

export function testStorage(sessionId: string, db: PostgresSessionDb = sessionDb()): TestStorage {
  const s = db.forSession(sessionId);
  return { sessionId, tx: (fn) => s.tx(fn), snapshot: (fn) => s.snapshot(fn) };
}

/** A registry over the harness's adapter, as the composition root builds it. `autoCreate` inserts
 * a session's catalog row on its first use, for tests that name sessions freely; `wrap` wraps each
 * session's storage (a slow or failing one). */
export function testRegistry(
  opts: {
    clock?: Clock;
    autoCreate?: boolean;
    db?: PostgresSessionDb;
    wrap?: (storage: SessionStorage, sessionId: string) => SessionStorage;
  } = {},
): SessionHubRegistry {
  const db = opts.db ?? sessionDb();
  const rows = new Map<string, { promise: Promise<unknown> }>();
  const ensureRow = (id: string): Promise<unknown> => {
    let row = rows.get(id);
    if (!row) {
      row = {
        promise: catalogRoot()
          .bindSystem('test-seed')
          .run('INSERT INTO sessions (id) VALUES (?) ON CONFLICT DO NOTHING', id),
      };
      rows.set(id, row);
    }
    return row.promise;
  };
  const storage = (id: string): SessionStorage => {
    const inner = db.forSession(id);
    const base: SessionStorage = opts.autoCreate
      ? {
          tx: async (fn) => {
            await ensureRow(id);
            return inner.tx(fn);
          },
          snapshot: async (fn) => {
            await ensureRow(id);
            return inner.snapshot(fn);
          },
        }
      : inner;
    return opts.wrap ? opts.wrap(base, id) : base;
  };
  return new SessionHubRegistry({ storage, clock: opts.clock });
}

/** The session's rows of `table`, without `session_id`. */
export async function rawRows(
  storage: TestStorage,
  table: string,
  opts: { columns?: string; where?: string; binds?: SqlValue[]; orderBy?: string } = {},
): Promise<Row[]> {
  const where = opts.where ? ` AND (${opts.where})` : '';
  const order = opts.orderBy ? ` ORDER BY ${opts.orderBy}` : '';
  const rows = await storage.snapshot((t) =>
    t.all<Row>(
      `SELECT ${opts.columns ?? '*'} FROM ${table} WHERE session_id = ?${where}${order}`,
      storage.sessionId,
      ...(opts.binds ?? []),
    ),
  );
  return rows.map(({ session_id: _, ...rest }) => rest);
}

/** Inserts `rows` (one row, or several with the same columns) into `table` for the session, as
 * one statement in its own transaction. */
export async function insertRaw(
  storage: TestStorage,
  table: string,
  rows: Record<string, SqlValue> | Record<string, SqlValue>[],
): Promise<void> {
  const all = Array.isArray(rows) ? rows : [rows];
  if (all.length === 0) return;
  const cols = Object.keys(all[0]);
  const values = all.map(() => `(?, ${cols.map(() => '?').join(', ')})`).join(', ');
  await storage.tx((t) =>
    t.run(
      `INSERT INTO ${table} (session_id, ${cols.join(', ')}) VALUES ${values}`,
      ...all.flatMap((row) => [storage.sessionId, ...cols.map((c) => row[c] as SqlValue)]),
    ),
  );
}

/** Fake timers the database driver survives (session-tables D12): postgres.js opens connections
 * and flushes writes through `setTimeout(…, 0)` and `setImmediate`, so `setImmediate` stays real
 * and the faked clock also advances with real time, which lets a zero-delay timer fire. Tests
 * that only move `Date` fake `Date` alone. */
export const DRIVER_SAFE_FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = {
  shouldAdvanceTime: true,
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
};
