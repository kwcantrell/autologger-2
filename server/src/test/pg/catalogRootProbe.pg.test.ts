// catalog-roles design D14 (owner decision B): a concurrency probe of the catalog adapter's root
// path. Skipped unless CATALOG_ROOT_PROBE=1. It seeds a user, a team, a show, a session and a KV
// login session on a cloned test database, then runs N = 20 concurrent request mixes for 10 rounds
// against one adapter with the server's pool sizes. Each request does what the auth middleware
// does (registry load, KV session lookup, user read), then one route step from a rotating mix. A
// wrapper times every root call and counts root timeouts; the probe prints one JSON line and
// asserts only that every request completed. Run before the bindings (task 1.2) and after (8.3):
// the middleware's calls as `system('auth-resolve')` and `bindSystem('kv')`, the route mix on
// `forUser(id)`, as the server binds them (catalog-roles D9).
// catalog-policies D12 (test-only): `CATALOG_PROBE_ANALYZE=1` runs `ANALYZE` on the clone as
// `postgres` after seeding, and the adapter is wrapped in a `RetryCountingRoot` (D11), so the line
// also carries `retries`, `rate` (retries per transaction call) and `exhausted`.
import { Catalog, createCatalog } from '@autologger/catalog';
import type { CatalogDb, CatalogRoot } from '@autologger/ports';
import { CatalogRootTimeoutError, KvStore, PostgresCatalogDb } from '@autologger/storage';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';
import { createLoginSession, resolveSessionUser } from '../../auth/identity';
import { RetryCountingRoot } from '../retryCounter';

const N = 20;
const ROUNDS = 10;

const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

interface Stats {
  latencies: number[];
  timeouts: number;
  txs: number;
}

/** Times every root call (outside a transaction); a transaction body gets the adapter's own
 * transaction handle, so its statements are not counted as root calls. */
function timed(db: CatalogDb, stats: Stats): CatalogDb {
  const time = async <T>(call: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await call();
    } catch (error) {
      if (error instanceof CatalogRootTimeoutError) stats.timeouts++;
      throw error;
    } finally {
      stats.latencies.push(performance.now() - start);
    }
  };
  return {
    all: (sql, ...binds) => time(() => db.all(sql, ...binds)),
    first: (sql, ...binds) => time(() => db.first(sql, ...binds)),
    run: (sql, ...binds) => time(() => db.run(sql, ...binds)),
    tx: (fn) => {
      stats.txs++;
      return db.tx(fn);
    },
  };
}

/** The adapter with every handle it hands out timed. */
function timedRoot(root: CatalogRoot, stats: Stats): CatalogRoot {
  return {
    bindUser: (id) => timed(root.bindUser(id), stats),
    bindSystem: (reason) => timed(root.bindSystem(reason), stats),
    close: () => root.close(),
  };
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const ms = (n: number): number => Math.round(n * 100) / 100;

describe.skipIf(process.env.CATALOG_ROOT_PROBE !== '1')('catalog root probe (design D14)', () => {
  it('runs 20 concurrent signed-in request mixes for 10 rounds and prints root-call latency', async () => {
    const { app, admin } = await createTestDatabase();
    const adapter = new PostgresCatalogDb(app);
    open.push(adapter);
    const db = adapter.bindSystem('test-seed');

    // Seed through the real stores.
    const seed = new Catalog(db);
    const kvSeed = new KvStore(db, { now: () => Date.now() });
    const userId = await seed.auth.authCreateUserGoogle({
      id: 'probe-user',
      email: 'probe@example.com',
      googleSub: 'probe-sub',
      givenName: 'Probe',
      familyName: 'User',
      pictureUrl: '',
    });
    if (userId === null) throw new Error('probe user not created');
    await seed.studios.adminCreateStudio('probe-team', 'Probe Team');
    await seed.auth.authAddMembershipWithRole(userId, 'probe-team', 'admin');
    const showId = await seed.shows.createShow({
      studioId: 'probe-team',
      name: 'Probe Show',
      showCode: 'PS',
      categoriesJson: '[]',
      paletteJson: '[]',
      paletteCustomJson: '[]',
    });
    const now = new Date().toISOString();
    const sessionId = await seed.sessions.createSessionIndex({
      showId,
      title: 'Probe Session',
      frameRate: 24,
      startOffsetFrames: 0,
      episode: '001',
      notes: '',
      startedAtUtc: now,
      createdAtUtc: now,
    });
    const cookie = await createLoginSession(kvSeed, userId, 1);

    if (process.env.CATALOG_PROBE_ANALYZE === '1') {
      const sql = postgres({ ...admin, max: 1, onnotice: () => {} });
      try {
        await sql.unsafe('analyze');
      } finally {
        await sql.end();
      }
    }

    const stats: Stats = { latencies: [], timeouts: 0, txs: 0 };
    const counting = new RetryCountingRoot(adapter);
    const root = timedRoot(counting, stats);
    const kv = new KvStore(root.bindSystem('kv'), { now: () => Date.now() });
    const ctx = { oauthConfigured: false, adminMeta: {} };

    let n = 0;
    const request = async (i: number): Promise<void> => {
      // The middleware: registry load, then the KV lookup and the user read.
      const sys = createCatalog(root).system('auth-resolve');
      await sys.init();
      const user = await resolveSessionUser(kv, sys, cookie);
      if (user === null) throw new Error('probe session did not resolve');
      const catalog = sys.forUser(user.id);
      switch (i % 4) {
        case 0:
          await catalog.profile.profilePayload(user, ctx);
          break;
        case 1:
          await catalog.sessions.listSessionsForShow(showId);
          break;
        case 2:
          await catalog.shows.getShowRow(showId);
          break;
        default:
          await catalog.sessions.updateSessionIndex(sessionId, { title: `Probe ${i}` });
      }
      n++;
    };

    const started = performance.now();
    for (let round = 0; round < ROUNDS; round++) {
      await Promise.all(Array.from({ length: N }, (_, i) => request(round * N + i)));
    }
    const wallMs = performance.now() - started;

    const sorted = [...stats.latencies].sort((a, b) => a - b);
    const retries = counting.calls.reduce((sum, c) => sum + c.runs - 1, 0);
    // Written past vitest's console capture so the line lands in the run's log.
    process.stdout.write(
      `${JSON.stringify({
        rootCalls: sorted.length,
        p50: ms(pct(sorted, 0.5)),
        p95: ms(pct(sorted, 0.95)),
        max: ms(sorted.at(-1) ?? 0),
        timeouts: stats.timeouts,
        txs: stats.txs,
        wallMs: ms(wallMs),
        analyze: process.env.CATALOG_PROBE_ANALYZE === '1',
        retries,
        rate: counting.calls.length === 0 ? 0 : retries / counting.calls.length,
        exhausted: counting.calls.filter((c) => c.exhausted).length,
      })}\n`,
    );
    expect(n).toBe(N * ROUNDS);
  }, 120_000);
});
