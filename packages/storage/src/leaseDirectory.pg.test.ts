// The lease directory (run-status-and-sweeper design D5) against the Postgres catalog adapter, as
// the app's least-privilege role on a cloned test database. Rows are seeded on a test system
// handle; the directory binds its own `lease-directory` reason.
import type { CatalogDb } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresLeaseDirectory, RUN_LEASE_KINDS } from './leaseDirectory';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { createTestDatabase } from './test/pgDb';

const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const NOW = 1_750_000_000_000;

interface Lease {
  session: string;
  kind: string;
  expires: number;
  started?: number | null;
}

async function env(sessions: string[], leases: Lease[]) {
  const root = new PostgresCatalogDb((await createTestDatabase()).app);
  open.push(root);
  const db: CatalogDb = root.bindSystem('test');
  for (const id of sessions) await db.run('INSERT INTO sessions (id) VALUES (?)', id);
  for (const [i, l] of leases.entries()) {
    await db.run(
      `INSERT INTO session_leases (session_id, kind, holder_client_id, holder_user_id,
         heartbeat_at_ms, expires_at_ms, started_at_ms) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      l.session,
      l.kind,
      `holder-${i}`,
      l.expires - 40_000,
      l.expires,
      l.started ?? null,
    );
  }
  const dir = new PostgresLeaseDirectory(root);
  const rows = () =>
    db.all<{ session_id: string; kind: string }>(
      'SELECT session_id, kind FROM session_leases ORDER BY session_id, kind',
    );
  const revisions = () =>
    db.all<{ id: string; revision: number }>('SELECT id, revision FROM sessions ORDER BY id');
  return { dir, db, rows, revisions };
}

describe('LeaseDirectory.earliestLiveRun (run-status-and-sweeper D5)', () => {
  it('names the live run of the kind with the earliest start, ties broken by session id', async () => {
    const { dir } = await env(
      ['s1', 's2', 's3', 's4', 's5', 's6'],
      [
        // Expired, with the earliest start of all: skipped.
        { session: 's1', kind: 'transcript-generation', expires: NOW, started: NOW - 90_000 },
        // Live with no start (a pre-9c row): skipped.
        { session: 's2', kind: 'transcript-generation', expires: NOW + 30_000, started: null },
        // Another kind, earlier: skipped.
        { session: 's3', kind: 'ai-turn', expires: NOW + 30_000, started: NOW - 80_000 },
        // Two live rows with the same start: the lower session id wins.
        { session: 's5', kind: 'transcript-generation', expires: NOW + 1, started: NOW - 50_000 },
        { session: 's4', kind: 'transcript-generation', expires: NOW + 1, started: NOW - 50_000 },
        // Live, later start.
        { session: 's6', kind: 'transcript-generation', expires: NOW + 40_000, started: NOW - 1 },
      ],
    );
    expect(await dir.earliestLiveRun('transcript-generation', NOW)).toEqual({
      sessionId: 's4',
      startedAtMs: NOW - 50_000,
    });
    expect(await dir.earliestLiveRun('ai-turn', NOW)).toEqual({
      sessionId: 's3',
      startedAtMs: NOW - 80_000,
    });
    // Once s4 and s5 expire (`expires_at_ms <= now`), the later run is the earliest.
    expect(await dir.earliestLiveRun('transcript-generation', NOW + 1)).toEqual({
      sessionId: 's6',
      startedAtMs: NOW - 1,
    });
    expect(await dir.earliestLiveRun('youtube-import', NOW)).toBeNull();
    expect(await dir.earliestLiveRun('transcript-generation', NOW + 40_000)).toBeNull();
  });

  it('a recording row (no start) is never named', async () => {
    const { dir } = await env(['s1'], [{ session: 's1', kind: 'recording', expires: NOW + 1 }]);
    expect(await dir.earliestLiveRun('recording', NOW)).toBeNull();
  });
});

describe('LeaseDirectory.deleteExpiredRunLeases (run-status-and-sweeper D5)', () => {
  it('the allow-list is exactly the three run kinds', () => {
    expect([...RUN_LEASE_KINDS].sort()).toEqual([
      'ai-turn',
      'transcript-generation',
      'youtube-import',
    ]);
  });

  it('deletes only expired run rows, leaves an expired recording row and every revision', async () => {
    const live = { expires: NOW + 1, started: NOW - 10 };
    const dead = { expires: NOW, started: NOW - 50_000 };
    const { dir, rows, revisions } = await env(
      ['s1', 's2'],
      [
        ...RUN_LEASE_KINDS.map((kind) => ({ session: 's1', kind, ...dead })),
        { session: 's1', kind: 'recording', expires: NOW - 5_000 },
        ...RUN_LEASE_KINDS.map((kind) => ({ session: 's2', kind, ...live })),
        { session: 's2', kind: 'recording', expires: NOW + 1 },
      ],
    );
    const before = await revisions();
    expect(await dir.deleteExpiredRunLeases(NOW)).toBe(3);
    expect(await rows()).toEqual([
      { session_id: 's1', kind: 'recording' },
      { session_id: 's2', kind: 'ai-turn' },
      { session_id: 's2', kind: 'recording' },
      { session_id: 's2', kind: 'transcript-generation' },
      { session_id: 's2', kind: 'youtube-import' },
    ]);
    expect(await revisions()).toEqual(before);
    // A second sweep deletes nothing.
    expect(await dir.deleteExpiredRunLeases(NOW)).toBe(0);
    expect(await revisions()).toEqual(before);
  });
});

describe('LeaseDirectory.expiredRecordingSessions (run-status-and-sweeper D5)', () => {
  it('lists expired recording leases, the longest-expired first, at most `limit`', async () => {
    const { dir } = await env(
      ['s1', 's2', 's3', 's4', 's5'],
      [
        { session: 's1', kind: 'recording', expires: NOW - 1_000 },
        { session: 's2', kind: 'recording', expires: NOW - 3_000 },
        { session: 's3', kind: 'recording', expires: NOW },
        // Live: not listed.
        { session: 's4', kind: 'recording', expires: NOW + 1 },
        // An expired run row: not listed.
        { session: 's5', kind: 'ai-turn', expires: NOW - 9_000, started: NOW - 50_000 },
      ],
    );
    expect(await dir.expiredRecordingSessions(NOW, 100)).toEqual(['s2', 's1', 's3']);
    expect(await dir.expiredRecordingSessions(NOW, 2)).toEqual(['s2', 's1']);
    expect(await dir.expiredRecordingSessions(NOW - 2_000, 100)).toEqual(['s2']);
  });
});
