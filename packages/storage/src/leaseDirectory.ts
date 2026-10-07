// The LeaseDirectory port on the Postgres catalog adapter (run-status-and-sweeper design D5): the
// cross-session reads and the silent expiry delete over `catalog.session_leases`. It binds its own
// reviewed system reason, `lease-directory` (catalog-roles D11; RLS `catalog_system` allow-all on
// `session_leases`), so no caller can hand it another role. Session revisions are never touched:
// run rows have no client, revision or frame (session-run-leases D2), and recording rows are only
// listed here; the sweeper frees them through the session hub (D6).

import type { CatalogDb, CatalogRoot, LeaseDirectory } from '@autologger/ports';

/** The run kinds `deleteExpiredRunLeases` may delete: an explicit allow-list, so a future kind is
 * never swept silently. It matches session-core's `RunLeaseKind` (a server test pins it). */
export const RUN_LEASE_KINDS = ['ai-turn', 'transcript-generation', 'youtube-import'] as const;

export class PostgresLeaseDirectory implements LeaseDirectory {
  private readonly db: CatalogDb;

  constructor(root: CatalogRoot) {
    this.db = root.bindSystem('lease-directory');
  }

  async earliestLiveRun(
    kind: string,
    nowMs: number,
  ): Promise<{ sessionId: string; startedAtMs: number } | null> {
    const row = await this.db.first<{ session_id: string; started_at_ms: number }>(
      `SELECT session_id, started_at_ms FROM session_leases
        WHERE kind = ? AND expires_at_ms > ? AND started_at_ms IS NOT NULL
        ORDER BY started_at_ms, session_id LIMIT 1`,
      kind,
      nowMs,
    );
    return row ? { sessionId: row.session_id, startedAtMs: Number(row.started_at_ms) } : null;
  }

  async deleteExpiredRunLeases(nowMs: number): Promise<number> {
    const { changes } = await this.db.run(
      `DELETE FROM session_leases
        WHERE kind IN ('ai-turn', 'transcript-generation', 'youtube-import')
          AND expires_at_ms <= ?`,
      nowMs,
    );
    return changes;
  }

  async expiredRecordingSessions(nowMs: number, limit: number): Promise<string[]> {
    const rows = await this.db.all<{ session_id: string }>(
      `SELECT session_id FROM session_leases
        WHERE kind = 'recording' AND expires_at_ms <= ?
        ORDER BY expires_at_ms, session_id LIMIT ?`,
      nowMs,
      limit,
    );
    return rows.map((r) => r.session_id);
  }
}
