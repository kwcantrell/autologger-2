// `POST /mcp` and the read tools (custom session dashboards J5; design sections 4.6, 5.1-5.4;
// mcp-session-data; api-contract-freeze "MCP endpoint route" and the Companion-token exception).
//
// Driven through the real app on a cloned catalog. Access tokens are written straight into the
// system-only tables (the J3 flow that mints them has its own suite), so each test controls the
// token's audience, expiry and grant cap. Wiki pages are written straight too, so a test can make
// pages the write path refuses (another show's citation, a link across shows).

import { randomBytes, randomUUID } from 'node:crypto';
import type { Clock } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../appEnv';
import { hashMcpSecret } from '../auth/mcpTokens';
import { READ_TOOL_NAMES } from '../dashboards/mcpReadTools';
import { PAGE_MAX_CHARS } from '../dashboards/query';
import { anonApp, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  seedAccessMatrix,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
  testDb,
} from '../test/helpers';
import { harnessHub } from '../test/session/sessionRows';

const SECRET = 's'.repeat(44);
const ON = { CUSTOM_DASHBOARDS_ENABLED: '1', MCP_SIGNING_SECRET: SECRET };
const ISSUER = 'https://example.com'; // the harness's PUBLIC_BASE_URL
const RESOURCE = `${ISSUER}/mcp`;
const CHALLENGE = `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="dashboards"`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const onEnv = (extra: Record<string, unknown> = {}, ports: Partial<Bindings['ports']> = {}) =>
  envWith({ ...ON, ...extra }, ports);

type Json = Record<string, unknown>;

/** A grant and access token for `userId`, written straight into the token tables. */
async function mintToken(
  userId: string,
  opts: { resource?: string; tokenExpiresMs?: number; grantExpiresMs?: number } = {},
) {
  const db = testDb();
  const now = Date.now();
  const clientId = `alc_${randomUUID()}`;
  const grantId = `alg_${randomUUID()}`;
  await db.run(
    `INSERT INTO mcp_clients (id, client_name, redirect_uris_json, registered_from, created_at_utc)
     VALUES (?, 'Claude', '["https://claude.ai/api/mcp/auth_callback"]', '192.0.2.1', ?)`,
    clientId,
    iso(now),
  );
  await db.run(
    `INSERT INTO mcp_grants (id, user_id, client_id, scope, resource, created_at_utc, expires_at_utc)
     VALUES (?, ?, ?, 'dashboards', ?, ?, ?)`,
    grantId,
    userId,
    clientId,
    opts.resource ?? RESOURCE,
    iso(now),
    iso(now + (opts.grantExpiresMs ?? 90 * DAY)),
  );
  const token = `alm_${randomBytes(32).toString('base64url')}`;
  await db.run(
    'INSERT INTO mcp_access_tokens (token_hash, grant_id, expires_at_utc) VALUES (?, ?, ?)',
    hashMcpSecret(token),
    grantId,
    iso(now + (opts.tokenExpiresMs ?? HOUR)),
  );
  return { token, grantId, clientId };
}

let rpcId = 0;
function post(e: Bindings, body: unknown, headers: Record<string, string> = {}) {
  return anonApp.request(
    '/mcp',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    e,
  );
}

/** One `tools/call`; returns the JSON-RPC result. */
async function call(e: Bindings, token: string, name: string, args: Json = {}) {
  rpcId += 1;
  const res = await post(
    e,
    { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } },
    { authorization: `Bearer ${token}` },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: Json; error?: Json };
  expect(body.error).toBeUndefined();
  return body.result as {
    content: { text: string }[];
    structuredContent?: Json;
    isError?: boolean;
  };
}

/** The structured result of a successful call. */
async function ok(e: Bindings, token: string, name: string, args: Json = {}) {
  const r = await call(e, token, name, args);
  expect(r.isError, r.content[0]?.text).toBeUndefined();
  return r.structuredContent as Json;
}

/** The error text of a refused call. */
async function refused(e: Bindings, token: string, name: string, args: Json = {}) {
  const r = await call(e, token, name, args);
  expect(r.isError).toBe(true);
  return r.content[0]?.text;
}

/** A studio with one show and session, and an admin with a token. */
async function world() {
  const studioId = await seedStudio();
  const showId = await seedShow({ studioId });
  const sessionId = await seedSession({ showId });
  const adminId = await seedUser({ studios: [studioId], role: 'admin' });
  const { token, grantId } = await mintToken(adminId);
  return { studioId, showId, sessionId, adminId, token, grantId };
}

const hubOf = (sessionId: string) => harnessHub(sessionId);

async function addEvent(sessionId: string, wall: string, frames: number, message = 'm') {
  await (await hubOf(sessionId)).addEvent({
    category: 'cam',
    message,
    metadataJson: '{}',
    markedAtUtc: null,
    ctx: { frameRate: 24, startOffsetFrames: 0 },
    explicitAnchor: { timecodeTotalFrames: frames, wallTimeUtc: wall },
  });
}

let pageCounter = 0;
/** A wiki page written straight into the table (the write path's link checks bypassed). */
async function insertPage(
  showId: string,
  opts: {
    id?: string;
    kind?: 'person' | 'topic' | 'bit' | 'session';
    title?: string;
    body?: string;
    sessionId?: string | null;
    merged?: string;
    deleted?: boolean;
  } = {},
) {
  pageCounter += 1;
  const id = opts.id ?? `pg-${pageCounter}-${randomUUID().slice(0, 6)}`;
  const now = iso(Date.now());
  await testDb().run(
    `INSERT INTO wiki_pages (id, show_id, kind, title, body_md, session_id, revision, merged_into,
       deleted_at_utc, created_by, created_by_name, created_at_utc, updated_by, updated_by_name,
       updated_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'u', 'U', ?, 'u', 'U', ?)`,
    id,
    showId,
    opts.kind ?? 'topic',
    opts.title ?? `Page ${pageCounter}`,
    opts.body ?? '',
    opts.sessionId ?? null,
    opts.merged ?? null,
    opts.deleted ? now : null,
    now,
    now,
  );
  return id;
}

/** Every item of a paged tool, walked with `limit`. */
async function walk(e: Bindings, token: string, tool: string, args: Json, limit: number) {
  const items: Json[] = [];
  const pages: Json[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const page = await ok(e, token, tool, { ...args, limit, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    items.push(...(page.items as Json[]));
    if (page.next_cursor === null) return { items, pages };
    cursor = String(page.next_cursor);
  }
  throw new Error('walk did not end');
}

// ── Criterion 1: auth ──────────────────────────────────────────────────────────────────────

describe('the /mcp bearer (design 4.6)', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  it('answers 401 with the exact challenge with no token, an empty one or a bad one', async () => {
    const e = onEnv();
    const cases: Record<string, string>[] = [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Bearer alm_not-a-token' },
      { authorization: 'Basic abc' },
    ];
    for (const headers of cases) {
      const res = await post(e, init, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
      expect(await res.json()).toEqual({ detail: 'Login required.' });
    }
  });

  it('refuses a wrong-audience token, an expired one and one past the grant cap', async () => {
    const e = onEnv();
    const userId = await seedUser();
    const cases = [
      await mintToken(userId, { resource: 'https://other.example/mcp' }),
      await mintToken(userId, { tokenExpiresMs: -1000 }),
      await mintToken(userId, { grantExpiresMs: -1000 }),
    ];
    for (const { token } of cases) {
      const res = await post(e, init, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    }
    const live = await mintToken(userId);
    expect((await post(e, init, { authorization: `Bearer ${live.token}` })).status).toBe(200);
  });

  it('refuses a token past the 90-day cap on an injected clock', async () => {
    const userId = await seedUser();
    const { token } = await mintToken(userId, { tokenExpiresMs: 100 * DAY });
    let now = Date.now();
    const clock: Clock = { now: () => now };
    const e = onEnv({}, { clock });
    expect((await post(e, init, { authorization: `Bearer ${token}` })).status).toBe(200);
    now += 90 * DAY + 1000;
    expect((await post(e, init, { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it('refuses a token whose grant was revoked (the storage revoke Connected apps performs)', async () => {
    const e = onEnv();
    const userId = await seedUser();
    const { token, grantId } = await mintToken(userId);
    expect((await post(e, init, { authorization: `Bearer ${token}` })).status).toBe(200);
    expect(await e.ports.mcpOAuth.revokeGrant(grantId)).toBe(true);
    const res = await post(e, init, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
  });

  it('refuses a token whose grant carries revoked_at_utc even with its tokens still in place', async () => {
    // The storage revoke deletes the tokens too; this pins the lookup's own revoked_at check.
    const e = onEnv();
    const userId = await seedUser();
    const { token, grantId } = await mintToken(userId);
    expect((await post(e, init, { authorization: `Bearer ${token}` })).status).toBe(200);
    await testDb().run(
      'UPDATE mcp_grants SET revoked_at_utc = ? WHERE id = ?',
      iso(Date.now()),
      grantId,
    );
    const left = await testDb().first<{ n: number }>(
      'SELECT count(*)::int AS n FROM mcp_access_tokens WHERE grant_id = ?',
      grantId,
    );
    expect(left?.n).toBe(1);
    const res = await post(e, init, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
  });

  it("refuses a disabled user's token", async () => {
    const e = onEnv();
    const userId = await seedUser();
    const { token } = await mintToken(userId);
    await catalogFor().auth.authSetUserDisabled(userId, true);
    expect((await post(e, init, { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it('ignores a session cookie on /mcp: the Bearer decides', async () => {
    const e = onEnv();
    const userId = await seedUser();
    const cookie = await loginCookie(userId);
    const res = await post(e, init, { cookie });
    expect(res.status).toBe(401);
  });

  it('stamps the grant last-used time', async () => {
    const e = onEnv();
    const userId = await seedUser();
    const { token, grantId } = await mintToken(userId);
    await post(e, init, { authorization: `Bearer ${token}` });
    await expect
      .poll(
        async () =>
          (
            await testDb().first<{ t: string | null }>(
              'SELECT last_used_at_utc AS t FROM mcp_grants WHERE id = ?',
              grantId,
            )
          )?.t,
      )
      .not.toBeNull();
  });

  it('still ignores a Bearer on /api/*, an MCP token included', async () => {
    const e = onEnv();
    const userId = await seedUser();
    const { token } = await mintToken(userId);
    for (const path of ['/api/sessions', '/api/companion-devices', '/api/profile']) {
      const bare = await anonApp.request(path, {}, e);
      const withToken = await anonApp.request(
        path,
        { headers: { authorization: `Bearer ${token}` } },
        e,
      );
      expect(withToken.status).toBe(bare.status);
      expect(await withToken.text()).toBe(await bare.text());
    }
    expect((await anonApp.request('/api/sessions', {}, e)).status).toBe(401);
  });
});

// ── Criterion 3: transport ─────────────────────────────────────────────────────────────────

describe('the /mcp transport (design 5.1)', () => {
  const list = { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} };

  it('answers GET, DELETE and the other methods 405 with Allow: POST', async () => {
    const e = onEnv();
    const userId = await seedUser();
    const { token } = await mintToken(userId);
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD']) {
      for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
        const res = await anonApp.request('/mcp', { method, headers }, e);
        expect(res.status, `${method}`).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
      }
    }
  });

  it('follows MCP_ALLOWED_ORIGINS on the Origin header', async () => {
    const e = onEnv({ MCP_ALLOWED_ORIGINS: 'https://desk.example.org, https://x.example:8443' });
    const { token } = await mintToken(await seedUser());
    const auth = { authorization: `Bearer ${token}` };
    expect((await post(e, list, auth)).status).toBe(200);
    expect((await post(e, list, { ...auth, origin: 'https://claude.ai' })).status).toBe(200);
    expect((await post(e, list, { ...auth, origin: 'https://desk.example.org' })).status).toBe(200);
    expect((await post(e, list, { ...auth, origin: 'https://x.example:8443' })).status).toBe(200);
    for (const origin of [
      'https://evil.example',
      'http://claude.ai',
      'https://claude.ai.evil.example',
      'https://x.example',
      'null',
    ]) {
      const res = await post(e, list, { ...auth, origin });
      expect(res.status, origin).toBe(403);
    }
    const plain = onEnv();
    expect((await post(plain, list, { ...auth, origin: 'https://desk.example.org' })).status).toBe(
      403,
    );
  });

  it('caps the body at 512 KiB', async () => {
    const e = onEnv();
    const { token } = await mintToken(await seedUser());
    const auth = { authorization: `Bearer ${token}` };
    const padded = (n: number) =>
      JSON.stringify({ ...list, params: { _meta: { pad: 'x'.repeat(n) } } });
    const base = padded(0).length;
    expect((await post(e, padded(512 * 1024 - base), auth)).status).toBe(200);
    expect((await post(e, padded(512 * 1024 - base + 1), auth)).status).toBe(413);
  });

  it('is stateless: no session id, and a tools/call needs no initialize on the same process', async () => {
    const e = onEnv();
    const { token } = await mintToken(await seedUser());
    const auth = { authorization: `Bearer ${token}` };
    const init = await post(
      e,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
      auth,
    );
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    const body = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('autologger');
    // A request with a made-up session id is served the same way: nothing is kept between them.
    const res = await post(e, list, { ...auth, 'mcp-session-id': 'whatever' });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const studios = await call(e, token, 'list_studios');
    expect(studios.isError).toBeUndefined();
  });
});

// ── Criterion 8: read-only tool list ───────────────────────────────────────────────────────

describe('the tool list (decision 11)', () => {
  it('is exactly the read tools, each marked read-only', async () => {
    const e = onEnv();
    const { token } = await mintToken(await seedUser());
    const res = await post(
      e,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { authorization: `Bearer ${token}` },
    );
    const body = (await res.json()) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    };
    expect(body.result.tools.map((t) => t.name)).toEqual([...READ_TOOL_NAMES]);
    expect(READ_TOOL_NAMES).toEqual([
      'list_studios',
      'list_shows',
      'list_sessions',
      'get_session',
      'list_events',
      'list_transcript_paragraphs',
      'list_transcript_words',
      'list_topics',
      'get_session_aggregates',
      'list_wiki_pages',
      'get_wiki_page',
    ]);
    for (const t of body.result.tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('calling every tool leaves the session and its rows unchanged', async () => {
    const e = onEnv();
    const w = await world();
    await addEvent(w.sessionId, '2026-01-01T00:00:01.000Z', 24);
    await (await hubOf(w.sessionId)).replaceTranscriptWords([
      { session_time: '00:00:01:00', speaker: 'A', word: 'hi', start_sec: 1, end_sec: 2 },
    ]);
    await insertPage(w.showId, { kind: 'session', sessionId: w.sessionId, title: 'S' });
    const snapshot = async () => ({
      revision: (
        await testDb().first<{ r: number }>(
          'SELECT revision::int AS r FROM sessions WHERE id = ?',
          w.sessionId,
        )
      )?.r,
      events: await testDb().all(
        'SELECT * FROM session_events WHERE session_id = ? ORDER BY id',
        w.sessionId,
      ),
      words: await testDb().all(
        'SELECT * FROM session_transcript_words WHERE session_id = ? ORDER BY id',
        w.sessionId,
      ),
      wiki: await testDb().all('SELECT * FROM wiki_pages WHERE show_id = ? ORDER BY id', w.showId),
    });
    const before = await snapshot();
    const s = { session_id: w.sessionId };
    await ok(e, w.token, 'list_studios');
    await ok(e, w.token, 'list_shows', { studio_id: w.studioId });
    await ok(e, w.token, 'list_sessions', { show_id: w.showId });
    await ok(e, w.token, 'get_session', s);
    await ok(e, w.token, 'list_events', s);
    await ok(e, w.token, 'list_transcript_paragraphs', s);
    await ok(e, w.token, 'list_transcript_words', s);
    await ok(e, w.token, 'list_topics', s);
    await ok(e, w.token, 'get_session_aggregates', s);
    const pages = await ok(e, w.token, 'list_wiki_pages', s);
    const first = (pages.items as Json[])[0] as Json;
    await ok(e, w.token, 'get_wiki_page', { ...s, page_id: first.page_id });
    expect(await snapshot()).toEqual(before);
  });
});

// ── Criterion 2: access ────────────────────────────────────────────────────────────────────

const SESSION_TOOLS = [
  'get_session',
  'list_events',
  'list_transcript_paragraphs',
  'list_transcript_words',
  'list_topics',
  'get_session_aggregates',
  'list_wiki_pages',
  'get_wiki_page',
] as const;

describe('access is the caller’s own, checked on every call (design 4.6, T4)', () => {
  it('a member with no grant gets Session not found from every read tool', async () => {
    const e = onEnv();
    const m = await seedAccessMatrix();
    const { token } = await mintToken(m.ungranted.id);
    const granted = await mintToken(m.granted.id);
    for (const tool of SESSION_TOOLS) {
      const args = {
        session_id: m.sessionId,
        ...(tool === 'get_wiki_page' ? { page_id: 'x' } : {}),
      };
      expect(await refused(e, token, tool, args), tool).toBe('Session not found');
      // An unknown session reads the same.
      expect(await refused(e, token, tool, { ...args, session_id: 'nope' }), tool).toBe(
        'Session not found',
      );
    }
    // The granted member reads it.
    expect(
      (await ok(e, granted.token, 'get_session', { session_id: m.sessionId })).session_id,
    ).toBe(m.sessionId);
    // A show they can't reach, and a studio they aren't in.
    expect(await refused(e, token, 'list_sessions', { show_id: m.showId })).toBe('Show not found.');
    const outsider = await mintToken(m.nonMember.id);
    expect(await refused(e, outsider.token, 'list_shows', { studio_id: m.studioId })).toBe(
      'Studio not found',
    );
    const shows = await ok(e, token, 'list_shows', { studio_id: m.studioId });
    expect(shows.items).toEqual([
      expect.objectContaining({ show_id: m.showId, can_access: false }),
    ]);
  });

  it('demoting or removing a user takes effect on their next call', async () => {
    const e = onEnv();
    const m = await seedAccessMatrix();
    const { token } = await mintToken(m.admin.id);
    const s = { session_id: m.sessionId };
    expect((await ok(e, token, 'list_events', s)).total).toBe(0);
    // Demoted to member with no grant: the next call is refused.
    await catalogFor().auth.authSetExistingMembershipRole(m.admin.id, m.studioId, 'member');
    expect(await refused(e, token, 'list_events', s)).toBe('Session not found');
    // Granted the show again: allowed; then removed from the studio: refused.
    await catalogFor().auth.authGrantShow(m.admin.id, m.showId, m.owner.id, iso(Date.now()));
    expect((await ok(e, token, 'list_events', s)).total).toBe(0);
    await catalogFor().auth.authRemoveMembership(m.admin.id, m.studioId);
    expect(await refused(e, token, 'list_events', s)).toBe('Session not found');
    expect(await refused(e, token, 'list_shows', { studio_id: m.studioId })).toBe(
      'Studio not found',
    );
  });
});

// ── Criterion 4: paging ────────────────────────────────────────────────────────────────────

describe('the paging contract (design 5.2)', () => {
  it('clamps limits to the tool maximum and below to 1', async () => {
    const e = onEnv();
    const w = await world();
    const sessionPage = await insertPage(w.showId, {
      kind: 'session',
      sessionId: w.sessionId,
      title: 'Session page',
    });
    for (let i = 0; i < 52; i++) {
      await insertPage(w.showId, { body: `[q](cite:${w.sessionId}@${i})` });
    }
    const s = { session_id: w.sessionId };
    const big = await ok(e, w.token, 'list_wiki_pages', { ...s, limit: 100_000 });
    expect((big.items as Json[]).length).toBe(50);
    expect(big.total).toBe(53);
    expect(big.next_cursor).not.toBeNull();
    const dflt = await ok(e, w.token, 'list_wiki_pages', s);
    expect((dflt.items as Json[]).length).toBe(20);
    const one = await ok(e, w.token, 'list_wiki_pages', { ...s, limit: 0 });
    expect((one.items as Json[]).map((i) => i.page_id)).toEqual([sessionPage]);
    const neg = await ok(e, w.token, 'list_wiki_pages', { ...s, limit: -5 });
    expect((neg.items as Json[]).length).toBe(1);
  });

  it('caps a page at 40,000 characters with truncated set, and the walk continues', async () => {
    const e = onEnv();
    const w = await world();
    for (let i = 0; i < 10; i++) {
      await addEvent(
        w.sessionId,
        iso(Date.parse('2026-01-01T00:00:00Z') + i * 1000),
        i * 24,
        `${i}`.repeat(8000),
      );
    }
    const s = { session_id: w.sessionId };
    const first = await ok(e, w.token, 'list_events', { ...s, limit: 10 });
    expect(first.truncated).toBe(true);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
    expect((first.items as Json[]).length).toBeLessThan(10);
    expect(first.next_cursor).not.toBeNull();
    const { items, pages } = await walk(e, w.token, 'list_events', s, 10);
    expect(items.map((i) => (i.message as string)[0])).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    for (const p of pages) expect(JSON.stringify(p).length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
  });

  it('refuses a cursor for another tool, another session or one that does not parse', async () => {
    const e = onEnv();
    const w = await world();
    const other = await seedSession({ showId: w.showId });
    await addEvent(w.sessionId, '2026-01-01T00:00:01.000Z', 24);
    await addEvent(w.sessionId, '2026-01-01T00:00:02.000Z', 48);
    const page = await ok(e, w.token, 'list_events', { session_id: w.sessionId, limit: 1 });
    const cursor = String(page.next_cursor);
    expect(await refused(e, w.token, 'list_topics', { session_id: w.sessionId, cursor })).toBe(
      'Invalid cursor.',
    );
    expect(await refused(e, w.token, 'list_events', { session_id: other, cursor })).toBe(
      'Invalid cursor.',
    );
    for (const bad of ['%%%', 'e30', Buffer.from('{"v":2}').toString('base64url')]) {
      expect(
        await refused(e, w.token, 'list_events', { session_id: w.sessionId, cursor: bad }),
      ).toBe('Invalid cursor.');
    }
    // The cursor carries no authority: another user's call with it is still authorized afresh.
    const stranger = await mintToken(await seedUser());
    expect(
      await refused(e, stranger.token, 'list_events', { session_id: w.sessionId, cursor }),
    ).toBe('Session not found');
  });

  it('notes a session that changed since the first page', async () => {
    const e = onEnv();
    const w = await world();
    await addEvent(w.sessionId, '2026-01-01T00:00:01.000Z', 24);
    await addEvent(w.sessionId, '2026-01-01T00:00:02.000Z', 48);
    const s = { session_id: w.sessionId };
    const first = await ok(e, w.token, 'list_events', { ...s, limit: 1 });
    expect(first.note).toBeUndefined();
    const unchanged = await ok(e, w.token, 'list_events', {
      ...s,
      limit: 1,
      cursor: first.next_cursor,
    });
    expect(unchanged.note).toBeUndefined();
    await addEvent(w.sessionId, '2026-01-01T00:00:03.000Z', 72);
    const second = await ok(e, w.token, 'list_events', {
      ...s,
      limit: 1,
      cursor: first.next_cursor,
    });
    expect(second.note).toBe('session changed since the first page');
    expect((second.items as Json[])[0]?.wall_time_utc).toBe('2026-01-01T00:00:02.000Z');
    // The note follows the walk.
    const third = await ok(e, w.token, 'list_events', {
      ...s,
      limit: 1,
      cursor: second.next_cursor,
    });
    expect(third.note).toBe('session changed since the first page');
  });
});

// ── Criterion 5: keyed reads ───────────────────────────────────────────────────────────────

describe('keyed session reads (design 5.2)', () => {
  it('walks every event exactly once in (wall_time_utc, id) order, a late-logged one included', async () => {
    const e = onEnv();
    const w = await world();
    // Logged in wall order, except the last: later wall time, earliest timecode.
    await addEvent(w.sessionId, '2026-01-01T00:00:01.000Z', 240, 'a');
    await addEvent(w.sessionId, '2026-01-01T00:00:02.000Z', 480, 'b');
    await addEvent(w.sessionId, '2026-01-01T00:00:02.000Z', 490, 'b2');
    await addEvent(w.sessionId, '2026-01-01T00:00:03.000Z', 720, 'c');
    await addEvent(w.sessionId, '2026-01-01T00:05:00.000Z', 24, 'late');
    const { items } = await walk(e, w.token, 'list_events', { session_id: w.sessionId }, 2);
    expect(items.length).toBe(5);
    expect(new Set(items.map((i) => i.event_id)).size).toBe(5);
    const keys = items.map((i) => `${i.wall_time_utc}|${i.event_id}`);
    expect(keys).toEqual([...keys].sort());
    expect(items.map((i) => i.message).at(-1)).toBe('late');
    // The hub's whole read agrees with the keyed walk.
    const whole = (await (await hubOf(w.sessionId)).listEvents({ limit: 100, offset: 0 })).events;
    expect(items.map((i) => i.event_id)).toEqual(whole.map((x) => x.event_id));
  });

  it('pages words, paragraphs and topics in (ordinal, id) order', async () => {
    const e = onEnv();
    const w = await world();
    const hub = await hubOf(w.sessionId);
    const words = Array.from({ length: 7 }, (_, i) => ({
      session_time: `00:00:0${i}:00`,
      speaker: 'A',
      word: `w${i}`,
      start_sec: i,
      end_sec: i + 0.5,
    }));
    await hub.replaceTranscriptWords(words, {
      paragraphs: Array.from({ length: 5 }, (_, i) => ({
        start_sec: i,
        end_sec: i + 1,
        speaker: 'A',
        text: `p${i}`,
      })),
      sentiment: [],
    });
    for (let i = 0; i < 4; i++) {
      await hub.insertTopic({
        session_time: `00:00:0${i}:00`,
        duration_sec: 1,
        topic_level: 1,
        summary: `t${i}`,
      });
    }
    const s = { session_id: w.sessionId };
    const ws = await walk(e, w.token, 'list_transcript_words', s, 3);
    expect(ws.items.map((i) => i.word)).toEqual(words.map((x) => x.word));
    const ps = await walk(e, w.token, 'list_transcript_paragraphs', s, 2);
    expect(ps.items.map((i) => i.text)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(ps.items.every((i) => i.session_time === null)).toBe(true);
    const ts = await walk(e, w.token, 'list_topics', s, 3);
    expect(ts.items.map((i) => i.summary)).toEqual(['t0', 't1', 't2', 't3']);
    const counts = (await ok(e, w.token, 'get_session', s)).counts;
    expect(counts).toEqual({ events: 0, words: 7, paragraphs: 5, topics: 4, wiki_pages: 0 });
  });

  it('reads at most limit rows per page from the database', async () => {
    const e = onEnv();
    const w = await world();
    const hub = await hubOf(w.sessionId);
    await hub.replaceTranscriptWords(
      Array.from({ length: 50 }, (_, i) => ({
        session_time: '',
        speaker: 'A',
        word: `w${i}`,
        start_sec: 0,
        end_sec: 0,
      })),
    );
    // The keyed read itself returns at most `limit` rows.
    const w9 = (await hub.listTranscriptWords()).find((x) => x.word === 'w9');
    const after = { ordinal: Number(w9?.ordinal), id: String(w9?.id) };
    const page = await hub.listTranscriptWordsAfter({ after, limit: 4 });
    expect(page.words.map((x) => x.word)).toEqual(['w10', 'w11', 'w12', 'w13']);
    expect(page.total).toBe(50);
    const viaTool = await ok(e, w.token, 'list_transcript_words', {
      session_id: w.sessionId,
      limit: 4,
    });
    expect((viaTool.items as Json[]).length).toBe(4);
  });
});

// ── Criterion 6: associated wiki pages ─────────────────────────────────────────────────────

describe('associated wiki pages (design 5.4)', () => {
  it('lists the three rules once each, one hop only, live pages of the show only', async () => {
    const e = onEnv();
    const w = await world();
    const other = await seedSession({ showId: w.showId });
    const otherShow = await seedShow({ studioId: w.studioId, name: 'Other' });
    const otherShowSession = await seedSession({ showId: otherShow });
    const S = w.sessionId;

    const linkedOnly = await insertPage(w.showId, {
      id: 'c-linked',
      title: 'Linked',
      body: '[far](wiki:d-twohop)',
    });
    const twoHop = await insertPage(w.showId, { id: 'd-twohop', title: 'Two hops' });
    const citesInline = await insertPage(w.showId, {
      id: 'b-inline',
      body: `see [q](cite:${S}@12)`,
    });
    const citesRef = await insertPage(w.showId, {
      id: 'b-ref',
      body: `see [q][r]\n\n[r]: cite:${S}@3`,
    });
    const citesAngle = await insertPage(w.showId, {
      id: 'b-angle',
      body: `see [q](<cite:${S}@4.5>)`,
    });
    const citesAndLinked = await insertPage(w.showId, { id: 'a-both', body: `[q](cite:${S}@1)` });
    await insertPage(w.showId, { id: 'e-code', body: `\`[q](cite:${S}@1)\`` });
    await insertPage(w.showId, { id: 'e-other', body: `[q](cite:${other}@1)` });
    await insertPage(w.showId, { id: 'e-deleted', body: `[q](cite:${S}@1)`, deleted: true });
    await insertPage(w.showId, { id: 'e-merged', body: `[q](cite:${S}@1)`, merged: twoHop });
    await insertPage(w.showId, { id: 'e-linked-deleted', deleted: true });
    await insertPage(otherShow, { id: 'e-othershow', body: `[q](cite:${S}@1)` });
    await insertPage(otherShow, { id: 'e-othershow-target' });
    await insertPage(otherShow, {
      id: 'e-othershow-sessionpage',
      kind: 'session',
      sessionId: otherShowSession,
      body: `[q](cite:${S}@1)`,
    });
    const sessionPage = await insertPage(w.showId, {
      id: 'z-session',
      kind: 'session',
      sessionId: S,
      body: `[a](wiki:${linkedOnly}) [b](wiki:${citesAndLinked}) [c](wiki:e-othershow-target) [d](wiki:e-linked-deleted) [e](wiki:e-merged) [self](wiki:z-session)`,
    });

    const { items } = await walk(e, w.token, 'list_wiki_pages', { session_id: S }, 2);
    expect(items.map((i) => [i.page_id, i.association])).toEqual([
      [sessionPage, 'session_page'],
      [citesAndLinked, 'cites_session'],
      [citesAngle, 'cites_session'],
      [citesInline, 'cites_session'],
      [citesRef, 'cites_session'],
      [linkedOnly, 'linked_from_session_page'],
    ]);
    expect((await ok(e, w.token, 'get_session', { session_id: S })).counts).toMatchObject({
      wiki_pages: 6,
    });
    // A page that isn't associated reads as missing, even in the same show.
    expect(await refused(e, w.token, 'get_wiki_page', { session_id: S, page_id: twoHop })).toBe(
      'Wiki page not found',
    );
    expect(
      await refused(e, w.token, 'get_wiki_page', { session_id: S, page_id: 'e-othershow' }),
    ).toBe('Wiki page not found');
  });

  it('keys the walk by (rule, page_id): a rename mid-walk neither skips nor repeats', async () => {
    const e = onEnv();
    const w = await world();
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'].map((x) => `${x}-${randomUUID().slice(0, 4)}`);
    for (const [i, id] of ids.entries()) {
      await insertPage(w.showId, { id, title: `T${5 - i}`, body: `[q](cite:${w.sessionId}@${i})` });
    }
    const s = { session_id: w.sessionId };
    const first = await ok(e, w.token, 'list_wiki_pages', { ...s, limit: 2 });
    // Rename the pages around the cursor so a title order would move them across it.
    await testDb().run(
      "UPDATE wiki_pages SET title = 'AAA', revision = revision + 1 WHERE id = ?",
      ids[4],
    );
    await testDb().run(
      "UPDATE wiki_pages SET title = 'ZZZ', revision = revision + 1 WHERE id = ?",
      ids[0],
    );
    const seen = (first.items as Json[]).map((i) => i.page_id);
    let cursor = first.next_cursor;
    let noted = false;
    while (cursor !== null) {
      const p = await ok(e, w.token, 'list_wiki_pages', { ...s, limit: 2, cursor });
      noted ||= p.note === 'session changed since the first page';
      seen.push(...(p.items as Json[]).map((i) => i.page_id));
      cursor = p.next_cursor;
    }
    expect(seen).toEqual(ids);
    expect(noted).toBe(true);
  });

  it('get_wiki_page slices a body by characters', async () => {
    const e = onEnv();
    const w = await world();
    const body = `[q](cite:${w.sessionId}@1) ${'"x"\n'.repeat(15_000)}`;
    const id = await insertPage(w.showId, { body });
    const s = { session_id: w.sessionId, page_id: id };
    let offset = 0;
    let text = '';
    for (;;) {
      const p = await ok(e, w.token, 'get_wiki_page', { ...s, offset, max_chars: 40_000 });
      expect(JSON.stringify(p).length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
      expect(p.body_chars).toBe(body.length);
      text += String(p.body_md);
      if (p.next_offset === null) break;
      offset = Number(p.next_offset);
    }
    expect(text).toBe(body);
    const dflt = await ok(e, w.token, 'get_wiki_page', s);
    expect(String(dflt.body_md).length).toBeLessThanOrEqual(20_000);
  });
});

// ── Criterion 7: the model tool window ─────────────────────────────────────────────────────

describe('the model tool window (design 5.1)', () => {
  async function fixedClockEnv(at: number) {
    const clock: Clock = { now: () => at };
    const { PostgresMcpOAuthStore } = await import('@autologger/storage');
    const store = new PostgresMcpOAuthStore(
      onEnv().ports.catalog as unknown as ConstructorParameters<typeof PostgresMcpOAuthStore>[0],
      clock,
    );
    return onEnv({}, { mcpOAuth: store });
  }

  it('answers the rate error past 120 calls a minute per user', async () => {
    const at = Date.parse('2026-11-13T12:00:20.000Z');
    const e = await fixedClockEnv(at);
    const userId = await seedUser();
    const { token } = await mintToken(userId);
    const other = await mintToken(await seedUser());
    await testDb().run(
      'INSERT INTO mcp_rate_windows (bucket, window_start_ms, count) VALUES (?, ?, 119)',
      `mcp-model-minute:${userId}`,
      at - (at % 60_000),
    );
    await ok(e, token, 'list_studios'); // the 120th
    expect(await refused(e, token, 'list_studios')).toBe('Rate limit exceeded; retry in 40 s.');
    // Another user's window is their own.
    await ok(e, other.token, 'list_studios');
    // tools/list is not a model tool call.
    const res = await post(
      e,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
  });

  it('answers the rate error past 2,000 calls an hour per user', async () => {
    const at = Date.parse('2026-11-13T12:30:00.000Z');
    const e = await fixedClockEnv(at);
    const userId = await seedUser();
    const { token } = await mintToken(userId);
    await testDb().run(
      'INSERT INTO mcp_rate_windows (bucket, window_start_ms, count) VALUES (?, ?, 1999)',
      `mcp-model-hour:${userId}`,
      at - (at % 3_600_000),
    );
    await ok(e, token, 'list_studios'); // the 2,000th
    expect(await refused(e, token, 'list_studios')).toBe('Rate limit exceeded; retry in 1800 s.');
  });
});

// ── Criterion 9: flag off ──────────────────────────────────────────────────────────────────

describe('with the flag off /mcp answers as an unmounted path (design 10.4)', () => {
  it('every method, with or without a Bearer, gets the unmounted answer', async () => {
    const off = envWith({ CUSTOM_DASHBOARDS_ENABLED: '' });
    const { token } = await mintToken(await seedUser());
    for (const method of ['GET', 'POST', 'DELETE', 'HEAD']) {
      for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
        const res = await anonApp.request('/mcp', { method, headers }, off);
        const control = await anonApp.request('/mcp-unmounted-control', { method, headers }, off);
        expect(res.status, method).toBe(control.status);
        expect(res.headers.get('www-authenticate')).toBeNull();
        expect(res.headers.get('allow')).toBeNull();
        expect(await res.text()).toBe(await control.text());
      }
    }
  });
});
