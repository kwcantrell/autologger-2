// The MCP OAuth storage ports on the system-only `catalog.mcp_*` tables (ADR 0035 decisions 5, 16,
// 17; design docs/design/custom-session-dashboards.md sections 4.3, 4.7 and 4.9;
// mcp-authorization). Two reviewed system reasons, one per class:
// - `mcp-oauth` (`PostgresMcpOAuthStore`): client registration and the rate-limit windows (J2),
//   grants, token issue, refresh rotation and revocation (J3);
// - `mcp-sweep` (`PostgresMcpOAuthSweeper`): the cleanup.
// The tables have no user RLS (`catalog_user` holds no privilege on them). Every time read or
// written comes from the Clock port, as ISO `*_utc` text (epoch milliseconds for the windows).

import type {
  CatalogDb,
  Clock,
  McpClient,
  McpConnectedApp,
  McpIssuedTokens,
  McpMintedTokens,
  McpOAuthStore,
  McpOAuthSweeper,
  McpOAuthSweepResult,
  McpRefreshRequest,
  McpRefreshResult,
  NewMcpClient,
  NewMcpGrant,
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
/** The refresh grace window's default, in seconds (ADR 0035 decision 17); the server reads
 * `MCP_REFRESH_GRACE_SECONDS` (`mcpRefreshGraceSeconds` in env.ts). */
export const MCP_REFRESH_GRACE_DEFAULT_SECONDS = 30;
/** A grant's `last_used_at_utc` is updated at most once per this interval (design 4.6). */
export const MCP_GRANT_TOUCH_MS = MINUTE;
/** Every grant's hard cap, from its creation (ADR 0035 decision 16). Fixed, not a setting. */
export const MCP_GRANT_CAP_MS = 90 * DAY;
/** An access token's life, cut short by the grant's cap (design 4.5). */
export const MCP_ACCESS_TOKEN_MS = HOUR;
/** A refresh token's life from its issue, cut short by the grant's cap (design 4.5). */
export const MCP_REFRESH_TOKEN_MS = 30 * DAY;

/** A refresh token joined to its grant and the grant's user, as the refresh steps read it. */
interface RefreshRow {
  grant_id: string;
  expires_at_utc: string;
  used_at_utc: string | null;
  successor_sealed: string | null;
  client_id: string;
  scope: string;
  grant_expires_at_utc: string;
  revoked_at_utc: string | null;
  disabled_at_utc: string | null;
}

const REFRESH_ROW = `SELECT r.grant_id, r.expires_at_utc, r.used_at_utc, r.successor_sealed,
                            g.client_id, g.scope, g.expires_at_utc AS grant_expires_at_utc,
                            g.revoked_at_utc, u.disabled_at_utc
                       FROM mcp_refresh_tokens r
                       JOIN mcp_grants g ON g.id = r.grant_id
                       JOIN users u ON u.id = g.user_id
                      WHERE r.token_hash = ?`;

/** Revokes a grant and deletes every token of it, inside the caller's transaction. */
async function revokeIn(t: CatalogDb, grantId: string, nowIso: string): Promise<boolean> {
  const g = await t.run(
    'UPDATE mcp_grants SET revoked_at_utc = coalesce(revoked_at_utc, ?) WHERE id = ?',
    nowIso,
    grantId,
  );
  await t.run('DELETE FROM mcp_access_tokens WHERE grant_id = ?', grantId);
  await t.run('DELETE FROM mcp_refresh_tokens WHERE grant_id = ?', grantId);
  return g.changes > 0;
}

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

  async getClient(id: string): Promise<McpClient | null> {
    const row = await this.db.first<{
      id: string;
      client_name: string;
      redirect_uris_json: string;
    }>('SELECT id, client_name, redirect_uris_json FROM mcp_clients WHERE id = ?', id);
    if (row === null) return null;
    const uris: unknown = JSON.parse(row.redirect_uris_json);
    return {
      id: row.id,
      client_name: row.client_name,
      redirect_uris: Array.isArray(uris)
        ? uris.filter((u): u is string => typeof u === 'string')
        : [],
    };
  }

  /** One transaction: the grant (only for a live client and an enabled user) and the client's
   * first-authorized stamp. */
  async createGrant(grant: NewMcpGrant): Promise<{ expiresAtMs: number } | null> {
    const now = this.clock.now();
    const expiresAtMs = now + MCP_GRANT_CAP_MS;
    return this.db.tx(async (t) => {
      const row = await t.first<{ id: string }>(
        `INSERT INTO mcp_grants (id, user_id, client_id, scope, resource, created_at_utc, expires_at_utc)
         SELECT ?, u.id, c.id, ?, ?, ?, ?
           FROM users u, mcp_clients c
          WHERE u.id = ? AND u.disabled_at_utc IS NULL AND c.id = ?
         RETURNING id`,
        grant.id,
        grant.scope,
        grant.resource,
        iso(now),
        iso(expiresAtMs),
        grant.userId,
        grant.clientId,
      );
      if (row === null) return null;
      await t.run(
        'UPDATE mcp_clients SET last_authorized_at_utc = ? WHERE id = ?',
        iso(now),
        grant.clientId,
      );
      return { expiresAtMs };
    });
  }

  async issueTokens(
    grantId: string,
    clientId: string,
    tokens: McpMintedTokens,
  ): Promise<McpIssuedTokens | null> {
    const now = this.clock.now();
    const nowIso = iso(now);
    return this.db.tx(async (t) => {
      const g = await t.first<{ scope: string; expires_at_utc: string }>(
        `SELECT g.scope, g.expires_at_utc
           FROM mcp_grants g JOIN users u ON u.id = g.user_id
          WHERE g.id = ? AND g.client_id = ? AND g.revoked_at_utc IS NULL
            AND g.expires_at_utc > ? AND u.disabled_at_utc IS NULL`,
        grantId,
        clientId,
        nowIso,
      );
      if (g === null) return null;
      return this.insertPair(t, grantId, g.scope, Date.parse(g.expires_at_utc), now, tokens);
    });
  }

  /** Inserts a new access and refresh token for the grant, each cut short by its cap. */
  private async insertPair(
    t: CatalogDb,
    grantId: string,
    scope: string,
    capMs: number,
    now: number,
    tokens: McpMintedTokens,
  ): Promise<McpIssuedTokens> {
    const accessExpiresAtMs = Math.min(now + MCP_ACCESS_TOKEN_MS, capMs);
    const refreshExpiresAtMs = Math.min(now + MCP_REFRESH_TOKEN_MS, capMs);
    await t.run(
      'INSERT INTO mcp_access_tokens (token_hash, grant_id, expires_at_utc) VALUES (?, ?, ?)',
      tokens.accessHash,
      grantId,
      iso(accessExpiresAtMs),
    );
    await t.run(
      `INSERT INTO mcp_refresh_tokens (token_hash, grant_id, issued_at_utc, expires_at_utc)
       VALUES (?, ?, ?, ?)`,
      tokens.refreshHash,
      grantId,
      iso(now),
      iso(refreshExpiresAtMs),
    );
    return {
      grantId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAtMs,
      scope,
    };
  }

  /**
   * The four steps of design 4.5 in one SERIALIZABLE transaction. Two concurrent refreshes of one
   * token both reach the rotating `UPDATE`; the second fails serialization and the adapter re-runs
   * this body, which then finds the token spent, with the first one's seal committed beside it,
   * and goes to the reuse rules. A body run that rolls back leaves nothing: its minted tokens were
   * never returned.
   */
  async refresh(req: McpRefreshRequest): Promise<McpRefreshResult> {
    const now = this.clock.now();
    const nowIso = iso(now);
    const graceMs = Math.max(0, Math.trunc(req.graceSeconds)) * 1000;
    return this.db.tx(async (t): Promise<McpRefreshResult> => {
      // Step 1: the token and its grant. Unknown, or unspent and expired: nothing changes.
      let row = await t.first<RefreshRow>(REFRESH_ROW, req.tokenHash);
      if (row === null) return { kind: 'invalid' };
      if (row.used_at_utc === null) {
        if (row.expires_at_utc <= nowIso) return { kind: 'invalid' };
        // Step 3: another client's live token is refused before any write.
        if (row.client_id !== req.clientId) return { kind: 'invalid' };
        // A dead grant or user gets nothing, and the token stays unspent.
        if (
          row.revoked_at_utc !== null ||
          row.grant_expires_at_utc <= nowIso ||
          row.disabled_at_utc !== null
        ) {
          return { kind: 'invalid' };
        }
        // Step 4: rotate, repeating the client check in the write itself.
        const spent = await t.first<{ grant_id: string }>(
          `UPDATE mcp_refresh_tokens t SET used_at_utc = ?
             FROM mcp_grants g
            WHERE t.token_hash = ? AND t.used_at_utc IS NULL AND t.expires_at_utc > ?
              AND g.id = t.grant_id AND g.client_id = ?
           RETURNING t.grant_id`,
          nowIso,
          req.tokenHash,
          nowIso,
          req.clientId,
        );
        if (spent !== null) {
          const issued = await this.insertPair(
            t,
            spent.grant_id,
            row.scope,
            Date.parse(row.grant_expires_at_utc),
            now,
            req.mint(),
          );
          if (graceMs > 0) {
            const sealed = req.seal(
              {
                access_token: issued.accessToken,
                refresh_token: issued.refreshToken,
                access_expires_at: issued.accessExpiresAtMs,
              },
              { tokenHash: req.tokenHash, grantId: spent.grant_id },
            );
            await t.run(
              'UPDATE mcp_refresh_tokens SET successor_sealed = ? WHERE token_hash = ?',
              sealed,
              req.tokenHash,
            );
          }
          return { kind: 'rotated', tokens: issued };
        }
        // Spent meanwhile: read it again and apply the reuse rules (step 2).
        row = await t.first<RefreshRow>(REFRESH_ROW, req.tokenHash);
        if (row === null || row.used_at_utc === null) return { kind: 'invalid' };
      }

      // Step 2: a spent token is a reuse, whatever client presents it.
      const inGrace =
        graceMs > 0 &&
        now - Date.parse(row.used_at_utc) <= graceMs &&
        row.client_id === req.clientId &&
        row.revoked_at_utc === null &&
        row.grant_expires_at_utc > nowIso &&
        row.disabled_at_utc === null &&
        row.successor_sealed !== null;
      if (inGrace && row.successor_sealed !== null) {
        const successor = req.open(row.successor_sealed, {
          tokenHash: req.tokenHash,
          grantId: row.grant_id,
        });
        if (successor !== null) {
          return {
            kind: 'grace',
            tokens: {
              grantId: row.grant_id,
              accessToken: successor.access_token,
              refreshToken: successor.refresh_token,
              accessExpiresAtMs: successor.access_expires_at,
              scope: row.scope,
            },
          };
        }
      }
      await revokeIn(t, row.grant_id, nowIso);
      return { kind: 'revoked', grantId: row.grant_id };
    });
  }

  async revokeGrant(grantId: string): Promise<boolean> {
    const nowIso = iso(this.clock.now());
    return this.db.tx((t) => revokeIn(t, grantId, nowIso));
  }

  async listConnectedApps(userId: string): Promise<McpConnectedApp[]> {
    const nowIso = iso(this.clock.now());
    const rows = await this.db.all<{
      grant_id: string;
      client_name: string;
      redirect_uris_json: string;
      created_at_utc: string;
      last_used_at_utc: string | null;
    }>(
      `SELECT g.id AS grant_id, c.client_name, c.redirect_uris_json, g.created_at_utc,
              g.last_used_at_utc
         FROM mcp_grants g JOIN mcp_clients c ON c.id = g.client_id
        WHERE g.user_id = ? AND g.revoked_at_utc IS NULL AND g.expires_at_utc > ?
          AND (EXISTS (SELECT 1 FROM mcp_access_tokens a
                        WHERE a.grant_id = g.id AND a.expires_at_utc > ?)
               OR EXISTS (SELECT 1 FROM mcp_refresh_tokens r
                           WHERE r.grant_id = g.id AND r.expires_at_utc > ?))
        ORDER BY g.created_at_utc DESC, g.id`,
      userId,
      nowIso,
      nowIso,
      nowIso,
    );
    return rows.map((r) => {
      const uris: unknown = JSON.parse(r.redirect_uris_json);
      return {
        grant_id: r.grant_id,
        client_name: r.client_name,
        redirect_uris: Array.isArray(uris)
          ? uris.filter((u): u is string => typeof u === 'string')
          : [],
        created_at_utc: r.created_at_utc,
        last_used_at_utc: r.last_used_at_utc,
      };
    });
  }

  async revokeUserGrant(userId: string, grantId: string): Promise<boolean> {
    const nowIso = iso(this.clock.now());
    return this.db.tx(async (t) => {
      const row = await t.first<{ id: string }>(
        `SELECT id FROM mcp_grants WHERE id = ? AND user_id = ? AND revoked_at_utc IS NULL
          FOR UPDATE`,
        grantId,
        userId,
      );
      if (row === null) return false;
      return revokeIn(t, grantId, nowIso);
    });
  }

  async revokeByToken(tokenHash: string, clientId: string): Promise<string | null> {
    const nowIso = iso(this.clock.now());
    return this.db.tx(async (t) => {
      const row = await t.first<{ grant_id: string }>(
        `SELECT x.grant_id FROM (
           SELECT grant_id FROM mcp_access_tokens WHERE token_hash = ?
           UNION ALL
           SELECT grant_id FROM mcp_refresh_tokens WHERE token_hash = ?
         ) x JOIN mcp_grants g ON g.id = x.grant_id
         WHERE g.client_id = ?
         LIMIT 1`,
        tokenHash,
        tokenHash,
        clientId,
      );
      if (row === null) return null;
      await revokeIn(t, row.grant_id, nowIso);
      return row.grant_id;
    });
  }

  async touchGrant(grantId: string): Promise<boolean> {
    const now = this.clock.now();
    const r = await this.db.run(
      `UPDATE mcp_grants SET last_used_at_utc = ?
        WHERE id = ? AND (last_used_at_utc IS NULL OR last_used_at_utc < ?)`,
      iso(now),
      grantId,
      iso(now - MCP_GRANT_TOUCH_MS),
    );
    return r.changes > 0;
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
