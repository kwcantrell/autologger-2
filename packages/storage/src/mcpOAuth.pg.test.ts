// The MCP OAuth store and sweeper on `catalog.mcp_*` (custom session dashboards J2; design
// docs/design/custom-session-dashboards.md sections 4.3, 4.7 and 4.9; mcp-authorization). Run
// against the catalog adapter as the app's least-privilege role on a cloned test database, with an
// injected clock. Rows are seeded on a test system handle; the store and sweeper bind their own
// reviewed reasons (`mcp-oauth`, `mcp-sweep`).
import type { CatalogDb } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_REFRESH_GRACE_DEFAULT_SECONDS,
  PostgresMcpOAuthStore,
  PostgresMcpOAuthSweeper,
} from './mcpOAuth';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { createTestDatabase } from './test/pgDb';

const SEC = 1000;
const HOUR = 3600 * SEC;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

async function env() {
  const testDb = await createTestDatabase();
  const root = new PostgresCatalogDb(testDb.app);
  open.push(root);
  const db: CatalogDb = root.bindSystem('test');
  await db.run(
    `INSERT INTO users (id, google_sub, email, created_at_utc) VALUES ('u1', 'u1-sub', 'u1@example.com', 'now')`,
  );
  let now = Date.parse('2026-11-13T12:00:00.000Z');
  const clock = { now: () => now };
  const set = (ms: number) => {
    now = ms;
  };
  const store = new PostgresMcpOAuthStore(root, clock);
  const sweeper = new PostgresMcpOAuthSweeper(root, clock);
  const T0 = now;

  const client = (id: string, createdAt: number, authorizedAt: number | null = null) =>
    db.run(
      `INSERT INTO mcp_clients (id, client_name, redirect_uris_json, registered_from, created_at_utc, last_authorized_at_utc)
       VALUES (?, 'Claude', '["https://claude.ai/api/mcp/auth_callback"]', '203.0.113.1', ?, ?)`,
      id,
      iso(createdAt),
      authorizedAt === null ? null : iso(authorizedAt),
    );
  const grant = (
    id: string,
    clientId: string,
    createdAt: number,
    opts: { expiresAt?: number; revokedAt?: number } = {},
  ) =>
    db.run(
      `INSERT INTO mcp_grants (id, user_id, client_id, scope, resource, created_at_utc, expires_at_utc, revoked_at_utc)
       VALUES (?, 'u1', ?, 'dashboards', 'https://example.com/mcp', ?, ?, ?)`,
      id,
      clientId,
      iso(createdAt),
      iso(opts.expiresAt ?? createdAt + 90 * DAY),
      opts.revokedAt === undefined ? null : iso(opts.revokedAt),
    );
  const refresh = (
    hash: string,
    grantId: string,
    opts: { expiresAt: number; usedAt?: number; sealed?: string },
  ) =>
    db.run(
      `INSERT INTO mcp_refresh_tokens (token_hash, grant_id, issued_at_utc, expires_at_utc, used_at_utc, successor_sealed)
       VALUES (?, ?, ?, ?, ?, ?)`,
      hash,
      grantId,
      iso(T0 - DAY),
      iso(opts.expiresAt),
      opts.usedAt === undefined ? null : iso(opts.usedAt),
      opts.sealed ?? null,
    );
  const access = (hash: string, grantId: string, expiresAt: number) =>
    db.run(
      'INSERT INTO mcp_access_tokens (token_hash, grant_id, expires_at_utc) VALUES (?, ?, ?)',
      hash,
      grantId,
      iso(expiresAt),
    );
  const ids = async (table: string, col = 'id') =>
    (await db.all<Record<string, string>>(`SELECT ${col} AS k FROM ${table} ORDER BY ${col}`)).map(
      (r) => r.k,
    );
  return { db, store, sweeper, set, T0, client, grant, refresh, access, ids };
}

describe('the MCP OAuth sweeper (design 4.9)', () => {
  it('deletes a client never used for a grant after 24 h and keeps one created less than 24 h ago', async () => {
    const e = await env();
    await e.client('alc_old', e.T0 - DAY - SEC);
    await e.client('alc_day', e.T0 - DAY);
    await e.client('alc_young', e.T0 - DAY + SEC);
    await e.client('alc_new', e.T0 - HOUR);
    const r = await e.sweeper.sweepOnce(MCP_REFRESH_GRACE_DEFAULT_SECONDS);
    expect(r.clients).toBe(1);
    expect(await e.ids('mcp_clients')).toEqual(['alc_day', 'alc_new', 'alc_young']);
    // Half a second later the exactly-24 h one has aged out, and the younger ones not yet.
    e.set(e.T0 + 500);
    await e.sweeper.sweepOnce(30);
    expect(await e.ids('mcp_clients')).toEqual(['alc_new', 'alc_young']);
  });

  it('keeps an old client that has a live grant, or that was authorized', async () => {
    const e = await env();
    await e.client('alc_granted', e.T0 - 10 * DAY, e.T0 - 10 * DAY);
    await e.grant('g1', 'alc_granted', e.T0 - 10 * DAY);
    await e.client('alc_authorized', e.T0 - 2 * DAY, e.T0 - 2 * DAY);
    await e.sweeper.sweepOnce(30);
    expect(await e.ids('mcp_clients')).toEqual(['alc_authorized', 'alc_granted']);
  });

  it('deletes a grant whose 90-day cap passed more than 30 days ago, with its tokens, and keeps one whose cap passed less than 30 days ago', async () => {
    const e = await env();
    await e.client('alc_c', e.T0 - 200 * DAY, e.T0 - 200 * DAY);
    // Cap passed 31 days ago, and 29 days ago.
    await e.grant('g_gone', 'alc_c', e.T0 - 121 * DAY);
    await e.grant('g_kept', 'alc_c', e.T0 - 119 * DAY);
    await e.refresh('r_gone', 'g_gone', { expiresAt: e.T0 + DAY });
    await e.access('a_gone', 'g_gone', e.T0 + HOUR);
    await e.refresh('r_kept', 'g_kept', { expiresAt: e.T0 + DAY });
    const r = await e.sweeper.sweepOnce(30);
    expect(r.grants).toBe(1);
    expect(await e.ids('mcp_grants')).toEqual(['g_kept']);
    expect(await e.ids('mcp_refresh_tokens', 'token_hash')).toEqual(['r_kept']);
    expect(await e.ids('mcp_access_tokens', 'token_hash')).toEqual([]);
    // The client still has a grant that ended within 30 days, so it stays.
    expect(await e.ids('mcp_clients')).toEqual(['alc_c']);
    // Two days later that grant's cap is 31 days past too; with it gone, so is the client.
    e.set(e.T0 + 2 * DAY);
    await e.sweeper.sweepOnce(30);
    expect(await e.ids('mcp_grants')).toEqual([]);
    expect(await e.ids('mcp_clients')).toEqual([]);
  });

  it('deletes a grant revoked more than 30 days ago and keeps one revoked less than 30 days ago', async () => {
    const e = await env();
    await e.client('alc_c', e.T0 - 60 * DAY, e.T0 - 60 * DAY);
    await e.grant('g_old', 'alc_c', e.T0 - 60 * DAY, { revokedAt: e.T0 - 31 * DAY });
    await e.grant('g_recent', 'alc_c', e.T0 - 60 * DAY, { revokedAt: e.T0 - 29 * DAY });
    await e.sweeper.sweepOnce(30);
    expect(await e.ids('mcp_grants')).toEqual(['g_recent']);
  });

  it('nulls successor_sealed on a refresh token used longer ago than the 30 s window and keeps it inside', async () => {
    const e = await env();
    await e.client('alc_c', e.T0 - DAY, e.T0 - DAY);
    await e.grant('g', 'alc_c', e.T0 - DAY);
    const exp = e.T0 + 10 * DAY;
    await e.refresh('r31', 'g', { expiresAt: exp, usedAt: e.T0 - 31 * SEC, sealed: 'seal-31' });
    await e.refresh('r30', 'g', { expiresAt: exp, usedAt: e.T0 - 30 * SEC, sealed: 'seal-30' });
    await e.refresh('r29', 'g', { expiresAt: exp, usedAt: e.T0 - 29 * SEC, sealed: 'seal-29' });
    await e.refresh('r_live', 'g', { expiresAt: exp, sealed: 'seal-unused' });
    const r = await e.sweeper.sweepOnce(MCP_REFRESH_GRACE_DEFAULT_SECONDS);
    expect(r.sealsCleared).toBe(1);
    const rows = await e.db.all<{ token_hash: string; successor_sealed: string | null }>(
      'SELECT token_hash, successor_sealed FROM mcp_refresh_tokens ORDER BY token_hash',
    );
    expect(rows.map((x) => ({ ...x }))).toEqual([
      { token_hash: 'r29', successor_sealed: 'seal-29' },
      { token_hash: 'r30', successor_sealed: 'seal-30' },
      { token_hash: 'r31', successor_sealed: null },
      { token_hash: 'r_live', successor_sealed: 'seal-unused' },
    ]);
    // The rows themselves stay (they are spent, not expired).
    e.set(e.T0 + 2 * SEC);
    await e.sweeper.sweepOnce(30);
    const after = await e.db.all<{ token_hash: string; successor_sealed: string | null }>(
      'SELECT token_hash, successor_sealed FROM mcp_refresh_tokens ORDER BY token_hash',
    );
    expect(after.map((x) => x.successor_sealed)).toEqual([null, null, null, 'seal-unused']);
  });

  it('uses the window it is given', async () => {
    const e = await env();
    await e.client('alc_c', e.T0 - DAY, e.T0 - DAY);
    await e.grant('g', 'alc_c', e.T0 - DAY);
    await e.refresh('r', 'g', { expiresAt: e.T0 + DAY, usedAt: e.T0 - 10 * SEC, sealed: 's' });
    await e.sweeper.sweepOnce(30);
    expect(
      (
        await e.db.first<{ s: string | null }>(
          'SELECT successor_sealed AS s FROM mcp_refresh_tokens',
        )
      )?.s,
    ).toBe('s');
    await e.sweeper.sweepOnce(5);
    expect(
      (
        await e.db.first<{ s: string | null }>(
          'SELECT successor_sealed AS s FROM mcp_refresh_tokens',
        )
      )?.s,
    ).toBeNull();
  });

  it('deletes expired access tokens, refresh tokens expired over a day ago, and rate windows over an hour old', async () => {
    const e = await env();
    await e.client('alc_c', e.T0 - DAY, e.T0 - DAY);
    await e.grant('g', 'alc_c', e.T0 - DAY);
    await e.access('a_expired', 'g', e.T0);
    await e.access('a_live', 'g', e.T0 + SEC);
    await e.refresh('r_long_expired', 'g', { expiresAt: e.T0 - DAY - SEC });
    await e.refresh('r_just_expired', 'g', { expiresAt: e.T0 - HOUR });
    await e.db.run(
      'INSERT INTO mcp_rate_windows (bucket, window_start_ms, count) VALUES (?, ?, 3), (?, ?, 4)',
      'register:old',
      e.T0 - HOUR - 1,
      'register:now',
      e.T0 - HOUR + 1,
    );
    const r = await e.sweeper.sweepOnce(30);
    expect(r).toEqual({
      accessTokens: 1,
      refreshTokens: 1,
      sealsCleared: 0,
      grants: 0,
      clients: 0,
      rateWindows: 1,
    });
    expect(await e.ids('mcp_access_tokens', 'token_hash')).toEqual(['a_live']);
    expect(await e.ids('mcp_refresh_tokens', 'token_hash')).toEqual(['r_just_expired']);
    expect(await e.ids('mcp_rate_windows', 'bucket')).toEqual(['register:now']);
  });

  it('bounds each delete per tick', async () => {
    const testDb = await createTestDatabase();
    const root = new PostgresCatalogDb(testDb.app);
    open.push(root);
    const db = root.bindSystem('test');
    const now = Date.parse('2026-11-13T12:00:00.000Z');
    await db.run(
      `INSERT INTO mcp_clients (id, client_name, redirect_uris_json, registered_from, created_at_utc)
       SELECT 'alc_' || g, 'x', '[]', 'x', ? FROM generate_series(1, 5) g`,
      iso(now - 2 * DAY),
    );
    const sweeper = new PostgresMcpOAuthSweeper(root, { now: () => now }, 2);
    expect((await sweeper.sweepOnce(30)).clients).toBe(2);
    expect((await sweeper.sweepOnce(30)).clients).toBe(2);
    expect((await sweeper.sweepOnce(30)).clients).toBe(1);
    expect((await sweeper.sweepOnce(30)).clients).toBe(0);
  });
});

describe('the MCP OAuth store (design 4.3)', () => {
  it('counts hits in a fixed window shared by every caller, and starts a new one after it', async () => {
    const e = await env();
    e.set(Date.parse('2026-11-13T12:00:00.000Z'));
    expect(await e.store.takeRateSlot('b', HOUR)).toEqual({ count: 1, retryAfterMs: HOUR });
    e.set(Date.parse('2026-11-13T12:59:00.000Z'));
    expect(await e.store.takeRateSlot('b', HOUR)).toEqual({ count: 2, retryAfterMs: 60 * SEC });
    expect(await e.store.takeRateSlot('other', HOUR)).toEqual({ count: 1, retryAfterMs: 60 * SEC });
    e.set(Date.parse('2026-11-13T13:00:00.000Z'));
    expect(await e.store.takeRateSlot('b', HOUR)).toEqual({ count: 1, retryAfterMs: HOUR });
  });

  it('counts concurrent hits exactly', async () => {
    const e = await env();
    const counts = await Promise.all(
      Array.from({ length: 12 }, () => e.store.takeRateSlot('c', HOUR)),
    );
    expect(counts.map((x) => x.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });

  it('registers a client with the clock time, and refuses at the cap', async () => {
    const e = await env();
    const make = (id: string) => ({
      id,
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      registered_from: '2001:db8:1:2::/64',
    });
    expect(await e.store.registerClient(make('alc_a'), 2)).toEqual({
      kind: 'created',
      created_at_utc: iso(e.T0),
    });
    expect((await e.store.registerClient(make('alc_b'), 2)).kind).toBe('created');
    expect(await e.store.registerClient(make('alc_c'), 2)).toEqual({ kind: 'cap-reached' });
    expect(await e.ids('mcp_clients')).toEqual(['alc_a', 'alc_b']);
    const row = await e.db.first<Record<string, unknown>>(
      "SELECT * FROM mcp_clients WHERE id = 'alc_a'",
    );
    expect(row).toEqual({
      id: 'alc_a',
      client_name: 'Claude',
      redirect_uris_json: '["https://claude.ai/api/mcp/auth_callback"]',
      registered_from: '2001:db8:1:2::/64',
      created_at_utc: iso(e.T0),
      last_authorized_at_utc: null,
    });
  });
});

describe('Connected apps on the store (design 4.8)', () => {
  async function seed() {
    const e = await env();
    await e.db.run(
      `INSERT INTO users (id, google_sub, email, created_at_utc) VALUES ('u2', 'u2-sub', 'u2@example.com', 'now')`,
    );
    await e.client('alc_c', e.T0 - 10 * DAY, e.T0 - 10 * DAY);
    return e;
  }

  it('lists only the user live grants that hold a token, newest first, without registered_from', async () => {
    const e = await seed();
    // Live with a refresh token; live with an access token only; a newer live one.
    await e.grant('g_old', 'alc_c', e.T0 - 5 * DAY);
    await e.refresh('r_old', 'g_old', { expiresAt: e.T0 + DAY });
    await e.grant('g_acc', 'alc_c', e.T0 - 4 * DAY);
    await e.access('a_acc', 'g_acc', e.T0 + HOUR);
    await e.grant('g_new', 'alc_c', e.T0 - DAY);
    await e.refresh('r_new', 'g_new', { expiresAt: e.T0 + DAY });
    // Not listed: no tokens, revoked, past the cap, only expired tokens, another user's.
    await e.grant('g_empty', 'alc_c', e.T0 - 3 * DAY);
    await e.grant('g_rev', 'alc_c', e.T0 - 3 * DAY, { revokedAt: e.T0 - DAY });
    await e.refresh('r_rev', 'g_rev', { expiresAt: e.T0 + DAY });
    await e.grant('g_cap', 'alc_c', e.T0 - 100 * DAY, { expiresAt: e.T0 - 10 * DAY });
    await e.refresh('r_cap', 'g_cap', { expiresAt: e.T0 + DAY });
    await e.grant('g_stale', 'alc_c', e.T0 - 60 * DAY);
    await e.refresh('r_stale', 'g_stale', { expiresAt: e.T0 - DAY });
    await e.db.run(
      `INSERT INTO mcp_grants (id, user_id, client_id, scope, resource, created_at_utc, expires_at_utc)
       VALUES ('g_other', 'u2', 'alc_c', 'dashboards', 'https://example.com/mcp', ?, ?)`,
      iso(e.T0 - DAY),
      iso(e.T0 + 80 * DAY),
    );
    await e.refresh('r_other', 'g_other', { expiresAt: e.T0 + DAY });

    const apps = await e.store.listConnectedApps('u1');
    expect(apps.map((a) => a.grant_id)).toEqual(['g_new', 'g_acc', 'g_old']);
    expect(apps[0]).toEqual({
      grant_id: 'g_new',
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      created_at_utc: iso(e.T0 - DAY),
      last_used_at_utc: null,
    });
    for (const a of apps) expect(Object.keys(a)).not.toContain('registered_from');
    expect((await e.store.listConnectedApps('u2')).map((a) => a.grant_id)).toEqual(['g_other']);
  });

  it('revokeUserGrant revokes the user own grant and deletes its tokens, and nothing else', async () => {
    const e = await seed();
    await e.grant('g1', 'alc_c', e.T0 - DAY);
    await e.refresh('r1', 'g1', { expiresAt: e.T0 + DAY });
    await e.access('a1', 'g1', e.T0 + HOUR);
    await e.grant('g2', 'alc_c', e.T0 - DAY);
    await e.access('a2', 'g2', e.T0 + HOUR);

    expect(await e.store.revokeUserGrant('u2', 'g1')).toBe(false);
    expect(await e.store.revokeUserGrant('u1', 'g_unknown')).toBe(false);
    expect(await e.ids('mcp_access_tokens', 'token_hash')).toEqual(['a1', 'a2']);

    expect(await e.store.revokeUserGrant('u1', 'g1')).toBe(true);
    expect(await e.ids('mcp_access_tokens', 'token_hash')).toEqual(['a2']);
    expect(await e.ids('mcp_refresh_tokens', 'token_hash')).toEqual([]);
    const g = await e.db.first<{ revoked_at_utc: string | null }>(
      "SELECT revoked_at_utc FROM mcp_grants WHERE id = 'g1'",
    );
    expect(g?.revoked_at_utc).toBe(iso(e.T0));
    // A second revoke is the same masked miss.
    expect(await e.store.revokeUserGrant('u1', 'g1')).toBe(false);
    expect((await e.store.listConnectedApps('u1')).map((a) => a.grant_id)).toEqual(['g2']);
  });
});
