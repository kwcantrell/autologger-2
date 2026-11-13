// The MCP OAuth storage ports on the system-only `catalog.mcp_*` tables (ADR 0035 decisions 5, 16,
// 17; design docs/design/custom-session-dashboards.md sections 4.3, 4.7 and 4.9;
// mcp-authorization). Two reviewed system reasons, one per class:
// - `mcp-oauth` (`PostgresMcpOAuthStore`): client registration and the rate-limit windows;
// - `mcp-sweep` (`PostgresMcpOAuthSweeper`): the cleanup.
// The tables have no user RLS (`catalog_user` holds no privilege on them). Every time read or
// written comes from the Clock port, as ISO `*_utc` text (epoch milliseconds for the windows).

import type {
  CatalogDb,
  Clock,
  McpOAuthStore,
  McpOAuthSweeper,
  McpOAuthSweepResult,
  NewMcpClient,
  RegisterMcpClientResult,
} from '@autologger/ports';
import type { PostgresCatalogDb } from './postgresCatalogStore';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A client never authorized is deleted once it is older than this (design 4.3, 4.9). */
export const MCP_UNUSED_CLIENT_MS = DAY;
/** Ended grants, and clients whose last grant ended, are kept this long (design 4.9). */
export const MCP_ENDED_GRANT_KEEP_MS = 30 * DAY;
/** Refresh tokens are deleted this long after they expired (design 4.9). */
export const MCP_EXPIRED_REFRESH_KEEP_MS = DAY;
/** Rate windows that started longer ago than this are deleted (design 4.9). */
export const MCP_RATE_WINDOW_KEEP_MS = HOUR;
/** The most rows each delete of one sweep removes (design 4.9). */
export const MCP_SWEEP_LIMIT = 1000;
/** The refresh grace window's default, in seconds (ADR 0035 decision 17). J3 adds its setting. */
export const MCP_REFRESH_GRACE_DEFAULT_SECONDS = 30;

const iso = (ms: number) => new Date(ms).toISOString();

export class PostgresMcpOAuthStore implements McpOAuthStore {
  private readonly db: CatalogDb;

  constructor(
    root: PostgresCatalogDb,
    private readonly clock: Clock,
  ) {
    this.db = root.bindSystem('mcp-oauth');
  }

  async takeRateSlot(
    bucket: string,
    windowMs: number,
  ): Promise<{ count: number; retryAfterMs: number }> {
    const now = this.clock.now();
    const start = now - (now % windowMs);
    const row = await this.db.first<{ n: number }>(
      `INSERT INTO mcp_rate_windows (bucket, window_start_ms, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start_ms) DO UPDATE SET count = mcp_rate_windows.count + 1
       RETURNING count::int AS n`,
      bucket,
      start,
    );
    if (row === null) throw new Error('mcp rate window upsert returned no row');
    return { count: Number(row.n), retryAfterMs: start + windowMs - now };
  }

  /** The count and the insert are one statement. Under concurrent registrations at the cap a few
   * may each see the count below it, so the cap can be passed by the number racing; it bounds
   * abuse, it is not an exact quota. */
  async registerClient(client: NewMcpClient, maxClients: number): Promise<RegisterMcpClientResult> {
    const createdAt = iso(this.clock.now());
    const row = await this.db.first<{ id: string }>(
      `INSERT INTO mcp_clients (id, client_name, redirect_uris_json, registered_from, created_at_utc)
       SELECT ?, ?, ?, ?, ?
        WHERE (SELECT count(*) FROM mcp_clients) < ?
       RETURNING id`,
      client.id,
      client.client_name,
      JSON.stringify(client.redirect_uris),
      client.registered_from,
      createdAt,
      maxClients,
    );
    return row === null ? { kind: 'cap-reached' } : { kind: 'created', created_at_utc: createdAt };
  }
}

export class PostgresMcpOAuthSweeper implements McpOAuthSweeper {
  private readonly db: CatalogDb;

  constructor(
    root: PostgresCatalogDb,
    private readonly clock: Clock,
    private readonly limit = MCP_SWEEP_LIMIT,
  ) {
    this.db = root.bindSystem('mcp-sweep');
  }

  /** Each step is its own bounded statement, run in order; a failure rejects with the earlier
   * steps' work kept, the caller warns, and the next tick runs every step again. Idempotent across
   * processes: a second sweep at the same time deletes nothing. */
  async sweepOnce(graceSeconds: number): Promise<McpOAuthSweepResult> {
    const now = this.clock.now();
    const nowIso = iso(now);
    const endedBefore = iso(now - MCP_ENDED_GRANT_KEEP_MS);
    const n = this.limit;

    const accessTokens = await this.db.run(
      `DELETE FROM mcp_access_tokens WHERE token_hash IN (
         SELECT token_hash FROM mcp_access_tokens WHERE expires_at_utc <= ? LIMIT ?)`,
      nowIso,
      n,
    );
    const refreshTokens = await this.db.run(
      `DELETE FROM mcp_refresh_tokens WHERE token_hash IN (
         SELECT token_hash FROM mcp_refresh_tokens WHERE expires_at_utc < ? LIMIT ?)`,
      iso(now - MCP_EXPIRED_REFRESH_KEEP_MS),
      n,
    );
    // Used longer ago than the window: a reuse at exactly the window is still inside it (design
    // 4.5), so its seal is kept until the window has passed.
    const sealsCleared = await this.db.run(
      `UPDATE mcp_refresh_tokens SET successor_sealed = NULL WHERE token_hash IN (
         SELECT token_hash FROM mcp_refresh_tokens
          WHERE successor_sealed IS NOT NULL AND used_at_utc < ? LIMIT ?)`,
      iso(now - graceSeconds * 1000),
      n,
    );
    // Revoked, or past the 90-day cap, more than 30 days ago; the tokens cascade.
    const grants = await this.db.run(
      `DELETE FROM mcp_grants WHERE id IN (
         SELECT id FROM mcp_grants
          WHERE revoked_at_utc < ? OR expires_at_utc < ? LIMIT ?)`,
      endedBefore,
      endedBefore,
      n,
    );
    // No grant that is live or ended within 30 days, and either never authorized and over 24 h
    // old, or last authorized more than 30 days ago. A grant ends at its revocation or its cap.
    const clients = await this.db.run(
      `DELETE FROM mcp_clients WHERE id IN (
         SELECT c.id FROM mcp_clients c
          WHERE ((c.last_authorized_at_utc IS NULL AND c.created_at_utc < ?)
                 OR c.last_authorized_at_utc < ?)
            AND NOT EXISTS (
                  SELECT 1 FROM mcp_grants g
                   WHERE g.client_id = c.id
                     AND coalesce(g.revoked_at_utc, g.expires_at_utc) >= ?)
          LIMIT ?)`,
      iso(now - MCP_UNUSED_CLIENT_MS),
      endedBefore,
      endedBefore,
      n,
    );
    const rateWindows = await this.db.run(
      `DELETE FROM mcp_rate_windows WHERE (bucket, window_start_ms) IN (
         SELECT bucket, window_start_ms FROM mcp_rate_windows WHERE window_start_ms < ? LIMIT ?)`,
      now - MCP_RATE_WINDOW_KEEP_MS,
      n,
    );
    return {
      accessTokens: accessTokens.changes,
      refreshTokens: refreshTokens.changes,
      sealsCleared: sealsCleared.changes,
      grants: grants.changes,
      clients: clients.changes,
      rateWindows: rateWindows.changes,
    };
  }
}
