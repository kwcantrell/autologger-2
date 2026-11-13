// MCP OAuth authorization, consent, token and revocation (custom session dashboards J3; design
// docs/design/custom-session-dashboards.md sections 4.4, 4.5 and 4.8; ADR 0035 decisions 16 and
// 17; mcp-authorization; api-contract-freeze "MCP OAuth authorization, token and revocation
// routes").
//
// Driven through the real app on a cloned catalog. Times that matter (the 90-day cap, the 30-day
// refresh life, the grace window) come from an injected clock, shared by the route and an OAuth
// store built on it; KV keeps the system clock, and every code is exchanged at once.

import { createHash, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Clock } from '@autologger/ports';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv, Bindings } from '../appEnv';
import { MCP_PAGE_CSP, MCP_PAGE_STYLE } from '../auth/mcpOAuthPages';
import { consentCsrf, hashMcpSecret } from '../auth/mcpTokens';
import { anonApp, env, envWith } from '../test/harness';
import { loginCookie, seedUser, testDb } from '../test/helpers';

const SECRET = 's'.repeat(44);
const ON = { CUSTOM_DASHBOARDS_ENABLED: '1', TRUST_PROXY: '1', MCP_SIGNING_SECRET: SECRET };
const ISSUER = 'https://example.com'; // the harness's PUBLIC_BASE_URL
const RESOURCE = `${ISSUER}/mcp`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const SEC = 1000;
const HOUR = 3600 * SEC;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-13T12:00:00.000Z');

type Json = Record<string, unknown>;
const bodyOf = async (res: Response) => (await res.json()) as Json;

let ipCounter = 0;
/** A fresh IPv4 address per call, so tests don't share a rate window. */
const freshIp = () => {
  ipCounter += 1;
  return `192.0.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
};

/** An env on the flag, with a clock the test moves and an OAuth store on that clock. */
async function timed(extra: Record<string, unknown> = {}, start = T0) {
  let now = start;
  const clock: Clock = { now: () => now };
  const { PostgresMcpOAuthStore } = await import('@autologger/storage');
  const store = new PostgresMcpOAuthStore(
    env.ports.catalog as unknown as ConstructorParameters<typeof PostgresMcpOAuthStore>[0],
    clock,
  );
  return {
    env: envWith({ ...ON, ...extra }, { clock, mcpOAuth: store }),
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function registerClient(e: Bindings, redirectUris = [CALLBACK]): Promise<string> {
  const res = await anonApp.request(
    '/oauth/register',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ client_name: 'Claude <b>bold</b>', redirect_uris: redirectUris }),
    },
    e,
  );
  expect(res.status).toBe(201);
  return String((await bodyOf(res)).client_id);
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeUrl(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.append(k, v);
  return `/oauth/authorize?${q.toString()}`;
}

const goodParams = (clientId: string, challenge: string, state = 'st-123') => ({
  client_id: clientId,
  redirect_uri: CALLBACK,
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource: RESOURCE,
  scope: 'dashboards',
  state,
});

const unescapeHtml = (s: string) =>
  s
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** The consent form's hidden fields. */
function formFields(page: string): { request: string; csrf: string } {
  const request = /name="request" value="([^"]*)"/.exec(page)?.[1];
  const csrf = /name="csrf" value="([^"]*)"/.exec(page)?.[1];
  expect(request, 'consent page has a request field').toBeTruthy();
  expect(csrf, 'consent page has a csrf field').toBeTruthy();
  return { request: unescapeHtml(request as string), csrf: unescapeHtml(csrf as string) };
}

function postForm(e: Bindings, path: string, fields: Record<string, string>, headers = {}) {
  return anonApp.request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': freshIp(),
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    },
    e,
  );
}

/** The returning page's target, from its meta refresh; asserts the link names the same URL. */
function returnTarget(page: string): URL {
  const meta = /<meta http-equiv="refresh" content="0; url=([^"]*)">/.exec(page)?.[1];
  const link = /<a href="([^"]*)">Continue to /.exec(page)?.[1];
  expect(meta, 'returning page has a meta refresh').toBeTruthy();
  expect(link).toBe(meta);
  return new URL(unescapeHtml(meta as string));
}

interface Caller {
  userId: string;
  cookie: string;
}

async function signedIn(): Promise<Caller> {
  const userId = await seedUser({ email: 'connector-user@example.com' });
  return { userId, cookie: await loginCookie(userId) };
}

/** GET /oauth/authorize as the caller, then Approve or Deny; returns the redirect target. */
async function consentTo(
  e: Bindings,
  caller: Caller,
  clientId: string,
  challenge: string,
  decision: 'approve' | 'deny' = 'approve',
) {
  const res = await anonApp.request(
    authorizeUrl(goodParams(clientId, challenge)),
    { headers: { cookie: caller.cookie } },
    e,
  );
  expect(res.status).toBe(200);
  const fields = formFields(await res.text());
  const posted = await postForm(
    e,
    '/oauth/authorize',
    { ...fields, decision },
    { cookie: caller.cookie },
  );
  expect(posted.status).toBe(200);
  return returnTarget(await posted.text());
}

function exchange(e: Bindings, fields: Record<string, string>, ip = freshIp()) {
  return postForm(
    e,
    '/oauth/token',
    { grant_type: 'authorization_code', resource: RESOURCE, redirect_uri: CALLBACK, ...fields },
    { 'x-forwarded-for': ip },
  );
}

function refresh(e: Bindings, clientId: string, refreshToken: string, ip = freshIp()) {
  return postForm(
    e,
    '/oauth/token',
    { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
    { 'x-forwarded-for': ip },
  );
}

/** A connected grant: a client, consent, and the first token pair. */
async function connected(e: Bindings, caller?: Caller) {
  const who = caller ?? (await signedIn());
  const clientId = await registerClient(e);
  const { verifier, challenge } = pkce();
  const target = await consentTo(e, who, clientId, challenge);
  const code = target.searchParams.get('code') as string;
  const res = await exchange(e, { client_id: clientId, code, code_verifier: verifier });
  expect(res.status).toBe(200);
  const body = await bodyOf(res);
  const grant = await testDb().first<{ id: string }>(
    'SELECT id FROM mcp_grants WHERE client_id = ?',
    clientId,
  );
  return {
    caller: who,
    clientId,
    grantId: String(grant?.id),
    code,
    verifier,
    access: String(body.access_token),
    refresh: String(body.refresh_token),
    body,
  };
}

const accessRow = (token: string) =>
  testDb().first<{ grant_id: string; expires_at_utc: string }>(
    'SELECT grant_id, expires_at_utc FROM mcp_access_tokens WHERE token_hash = ?',
    hashMcpSecret(token),
  );
const refreshRow = (token: string) =>
  testDb().first<{
    grant_id: string;
    issued_at_utc: string;
    expires_at_utc: string;
    used_at_utc: string | null;
    successor_sealed: string | null;
  }>(
    'SELECT grant_id, issued_at_utc, expires_at_utc, used_at_utc, successor_sealed FROM mcp_refresh_tokens WHERE token_hash = ?',
    hashMcpSecret(token),
  );
const grantRow = (id: string) =>
  testDb().first<{ created_at_utc: string; expires_at_utc: string; revoked_at_utc: string | null }>(
    'SELECT created_at_utc, expires_at_utc, revoked_at_utc FROM mcp_grants WHERE id = ?',
    id,
  );
const tokenCounts = async (grantId: string) => {
  const a = await testDb().first<{ n: number }>(
    'SELECT count(*)::int AS n FROM mcp_access_tokens WHERE grant_id = ?',
    grantId,
  );
  const r = await testDb().first<{ n: number }>(
    'SELECT count(*)::int AS n FROM mcp_refresh_tokens WHERE grant_id = ?',
    grantId,
  );
  return { access: a?.n ?? -1, refresh: r?.n ?? -1 };
};
const iso = (ms: number) => new Date(ms).toISOString();
/** A URL without its query (this suite never reads `.pathname`: rawPath.repo.test.ts). */
const withoutQuery = (u: URL) => u.href.split('?')[0];

/** The grant is revoked and holds no token, so none of its tokens works any more. */
async function expectRevoked(grantId: string) {
  expect((await grantRow(grantId))?.revoked_at_utc).not.toBeNull();
  expect(await tokenCounts(grantId)).toEqual({ access: 0, refresh: 0 });
}

// ── Criterion 1: the code flow ──────────────────────────────────────────────────────────────

describe('the authorization code flow with PKCE S256 (design 4.4, 4.5)', () => {
  it('runs end to end: consent, code, state and iss, then the token answer', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env);
    const { verifier, challenge } = pkce();
    const target = await consentTo(t.env, caller, clientId, challenge);
    expect(withoutQuery(target)).toBe(CALLBACK);
    expect(target.searchParams.get('state')).toBe('st-123');
    expect(target.searchParams.get('iss')).toBe(ISSUER);
    const code = target.searchParams.get('code') as string;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const res = await exchange(t.env, { client_id: clientId, code, code_verifier: verifier });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const body = await bodyOf(res);
    expect(Object.keys(body).sort()).toEqual(
      ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type'].sort(),
    );
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe('dashboards');
    expect(body.access_token).toMatch(/^alm_[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).toMatch(/^alr_[A-Za-z0-9_-]{43}$/);

    // Only hashes are stored, bound to one grant of this user and client.
    const a = await accessRow(String(body.access_token));
    const r = await refreshRow(String(body.refresh_token));
    expect(a?.grant_id).toBeTruthy();
    expect(r?.grant_id).toBe(a?.grant_id);
    expect(a?.expires_at_utc).toBe(iso(T0 + HOUR));
    const g = await testDb().first<Json>(
      'SELECT user_id, client_id, scope, resource FROM mcp_grants WHERE id = ?',
      a?.grant_id,
    );
    expect(g).toEqual({
      user_id: caller.userId,
      client_id: clientId,
      scope: 'dashboards',
      resource: RESOURCE,
    });
    const c = await testDb().first<{ last_authorized_at_utc: string }>(
      'SELECT last_authorized_at_utc FROM mcp_clients WHERE id = ?',
      clientId,
    );
    expect(c?.last_authorized_at_utc).toBe(iso(T0));
  });

  it('a loopback redirect URI matches with any port and the request port is used', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env, ['http://127.0.0.1/callback']);
    const { verifier, challenge } = pkce();
    const res = await anonApp.request(
      authorizeUrl({
        ...goodParams(clientId, challenge),
        redirect_uri: 'http://127.0.0.1:51234/callback',
      }),
      { headers: { cookie: caller.cookie } },
      t.env,
    );
    expect(res.status).toBe(200);
    const posted = await postForm(
      t.env,
      '/oauth/authorize',
      { ...formFields(await res.text()), decision: 'approve' },
      { cookie: caller.cookie },
    );
    const target = returnTarget(await posted.text());
    expect(target.host).toBe('127.0.0.1:51234');
    const ex = await exchange(t.env, {
      client_id: clientId,
      code: target.searchParams.get('code') as string,
      code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1:51234/callback',
    });
    expect(ex.status).toBe(200);
  });

  describe('each exchange failure gets the error design 4.5 specifies', () => {
    async function freshCode() {
      const t = await timed();
      const caller = await signedIn();
      const clientId = await registerClient(t.env);
      const { verifier, challenge } = pkce();
      const target = await consentTo(t.env, caller, clientId, challenge);
      return { t, clientId, verifier, code: target.searchParams.get('code') as string };
    }

    it('a wrong verifier: invalid_grant, and the code is spent', async () => {
      const { t, clientId, verifier, code } = await freshCode();
      const wrong = pkce().verifier;
      const res = await exchange(t.env, { client_id: clientId, code, code_verifier: wrong });
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
      const again = await exchange(t.env, { client_id: clientId, code, code_verifier: verifier });
      expect(await bodyOf(again)).toEqual({ error: 'invalid_grant' });
    });

    it('a reused code: invalid_grant', async () => {
      const { t, clientId, verifier, code } = await freshCode();
      expect(
        (await exchange(t.env, { client_id: clientId, code, code_verifier: verifier })).status,
      ).toBe(200);
      const res = await exchange(t.env, { client_id: clientId, code, code_verifier: verifier });
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    });

    it('a mismatched redirect_uri: invalid_grant', async () => {
      const { t, clientId, verifier, code } = await freshCode();
      const res = await exchange(t.env, {
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: `${CALLBACK}/other`,
      });
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    });

    it('a wrong resource: invalid_grant', async () => {
      const { t, clientId, verifier, code } = await freshCode();
      const res = await exchange(t.env, {
        client_id: clientId,
        code,
        code_verifier: verifier,
        resource: 'https://other.example/mcp',
      });
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    });

    it("another client's client_id: invalid_grant", async () => {
      const { t, verifier, code } = await freshCode();
      const other = await registerClient(t.env);
      const res = await exchange(t.env, { client_id: other, code, code_verifier: verifier });
      expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    });

    it('missing parameters: invalid_request; an unknown client: invalid_client', async () => {
      const { t, clientId, verifier, code } = await freshCode();
      expect(await bodyOf(await exchange(t.env, { client_id: clientId, code }))).toEqual({
        error: 'invalid_request',
      });
      expect(await bodyOf(await exchange(t.env, { code, code_verifier: verifier }))).toEqual({
        error: 'invalid_request',
      });
      expect(
        await bodyOf(
          await exchange(t.env, { client_id: 'alc_nope', code, code_verifier: verifier }),
        ),
      ).toEqual({ error: 'invalid_client' });
      // None of those spent the code.
      const ok = await exchange(t.env, { client_id: clientId, code, code_verifier: verifier });
      expect(ok.status).toBe(200);
    });

    it('an unknown grant_type: unsupported_grant_type; a JSON body: invalid_request', async () => {
      const { t, clientId } = await freshCode();
      const res = await postForm(t.env, '/oauth/token', {
        grant_type: 'password',
        client_id: clientId,
      });
      expect(await bodyOf(res)).toEqual({ error: 'unsupported_grant_type' });
      const json = await anonApp.request(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
          body: JSON.stringify({ grant_type: 'authorization_code', client_id: clientId }),
        },
        t.env,
      );
      expect(json.status).toBe(400);
      expect(await bodyOf(json)).toEqual({ error: 'invalid_request' });
    });
  });

  it('a replayed code gets invalid_grant and revokes the grant its first use produced', async () => {
    const t = await timed();
    const c = await connected(t.env);
    expect(await tokenCounts(c.grantId)).toEqual({ access: 1, refresh: 1 });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replay = await exchange(t.env, {
      client_id: c.clientId,
      code: c.code,
      code_verifier: c.verifier,
    });
    expect(replay.status).toBe(400);
    expect(await bodyOf(replay)).toEqual({ error: 'invalid_grant' });
    expect(log).toHaveBeenCalledWith(`mcp oauth: code reuse, grant ${c.grantId} revoked`);
    log.mockRestore();
    // Its access and refresh tokens stop working.
    await expectRevoked(c.grantId);
    expect(await accessRow(c.access)).toBeNull();
    expect(await bodyOf(await refresh(t.env, c.clientId, c.refresh))).toEqual({
      error: 'invalid_grant',
    });
  });

  describe('GET /oauth/authorize errors (design 4.4)', () => {
    async function setup() {
      const t = await timed();
      const caller = await signedIn();
      const clientId = await registerClient(t.env);
      return { t, caller, clientId, challenge: pkce().challenge };
    }

    it('errors before the client and redirect_uri are validated never redirect', async () => {
      const { t, caller, clientId, challenge } = await setup();
      const base = goodParams(clientId, challenge);
      const cases: Record<string, string | undefined>[] = [
        { ...base, client_id: undefined },
        { ...base, client_id: 'alc_unknown' },
        { ...base, redirect_uri: undefined },
        { ...base, redirect_uri: 'https://evil.example/cb' },
        { ...base, redirect_uri: `${CALLBACK}x` },
        // Every later problem too, while the redirect URI is still unvalidated.
        { ...base, redirect_uri: 'https://evil.example/cb', response_type: 'token' },
        { ...base, client_id: 'alc_unknown', resource: 'https://other.example/mcp' },
      ];
      for (const params of cases) {
        for (const headers of [{}, { cookie: caller.cookie }]) {
          const res = await anonApp.request(authorizeUrl(params), { headers }, t.env);
          expect(res.status, JSON.stringify(params)).toBe(400);
          expect(res.headers.get('location')).toBeNull();
          expect(res.headers.get('content-type')).toContain('text/html');
          expect(res.headers.get('content-security-policy')).toBe(MCP_PAGE_CSP);
          const text = await res.text();
          expect(text).not.toContain('http-equiv="refresh"');
          expect(text).not.toContain('evil.example');
        }
      }
      // A repeated client_id or redirect_uri is not validated either.
      const dup = `${authorizeUrl(base)}&client_id=${clientId}`;
      const res = await anonApp.request(dup, {}, t.env);
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });

    it('after validation each problem redirects with its error, state and iss', async () => {
      const { t, clientId, challenge } = await setup();
      const base = goodParams(clientId, challenge);
      const cases: [Record<string, string | undefined>, string][] = [
        [{ ...base, response_type: 'token' }, 'invalid_request'],
        [{ ...base, response_type: undefined }, 'invalid_request'],
        [{ ...base, code_challenge: undefined }, 'invalid_request'],
        [{ ...base, code_challenge: 'short' }, 'invalid_request'],
        [{ ...base, code_challenge_method: 'plain' }, 'invalid_request'],
        [{ ...base, code_challenge_method: undefined }, 'invalid_request'],
        [{ ...base, resource: 'https://other.example/mcp' }, 'invalid_target'],
        [{ ...base, resource: undefined }, 'invalid_target'],
        [{ ...base, scope: 'dashboards admin' }, 'invalid_scope'],
      ];
      for (const [params, error] of cases) {
        const res = await anonApp.request(authorizeUrl(params), {}, t.env);
        expect(res.status, JSON.stringify(params)).toBe(302);
        const loc = new URL(res.headers.get('location') as string);
        expect(withoutQuery(loc)).toBe(CALLBACK);
        expect(loc.searchParams.get('error')).toBe(error);
        expect(loc.searchParams.get('state')).toBe('st-123');
        expect(loc.searchParams.get('iss')).toBe(ISSUER);
        expect(loc.searchParams.get('code')).toBeNull();
      }
      // A missing or over-long state is invalid_request, and is not echoed.
      for (const state of [undefined, 'x'.repeat(513)]) {
        const res = await anonApp.request(authorizeUrl({ ...base, state }), {}, t.env);
        const loc = new URL(res.headers.get('location') as string);
        expect(loc.searchParams.get('error')).toBe('invalid_request');
        expect(loc.searchParams.has('state')).toBe(false);
      }
      // A 512-character state is accepted.
      const ok = await anonApp.request(
        authorizeUrl({ ...base, state: 's'.repeat(512) }),
        {},
        t.env,
      );
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
    });

    it('with no session it sends the user to Google with an mcp: state', async () => {
      const { t, clientId, challenge } = await setup();
      const res = await anonApp.request(authorizeUrl(goodParams(clientId, challenge)), {}, t.env);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location') as string);
      expect(loc.origin).toBe('https://accounts.google.com');
      expect(loc.searchParams.get('redirect_uri')).toBe(`${ISSUER}/auth/google/callback`);
      const state = loc.searchParams.get('state') as string;
      const stored = await env.ports.kv.get(`csrf:${state}`);
      expect(stored).toMatch(/^mcp:[A-Za-z0-9_-]{22}$/);
      const id = (stored as string).slice(4);
      expect(await env.ports.kv.get(`mcpauthz:${id}`)).not.toBeNull();
    });
  });
});

// ── Criterion 2: consent ────────────────────────────────────────────────────────────────────

describe('the consent page and decision (design 4.2, 4.4)', () => {
  it('shows the email, the client name as text, the redirect host in bold, with the page headers', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env);
    const res = await anonApp.request(
      authorizeUrl(goodParams(clientId, pkce().challenge)),
      { headers: { cookie: caller.cookie } },
      t.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(
      `default-src 'none'; style-src 'sha256-${createHash('sha256').update(MCP_PAGE_STYLE).digest('base64')}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const page = await res.text();
    expect(page).toContain('connector-user@example.com');
    expect(page).toContain('Claude &lt;b&gt;bold&lt;/b&gt;');
    expect(page).not.toContain('<b>bold</b>');
    expect(page).toContain('<strong>claude.ai</strong>');
    expect(page).toContain(
      'read every session you can open, and create, edit and delete dashboards in studios where you are an owner or admin',
    );
    expect(page).toContain('<form method="post" action="/oauth/authorize">');
    // One inline style, exactly the hashed one, and nothing loaded.
    expect(page.match(/<style>/g)?.length).toBe(1);
    expect(page).toContain(`<style>${MCP_PAGE_STYLE}</style>`);
    expect(page).not.toMatch(/<script|<link|src=/);
  });

  it('asks on every authorization, even for a client already approved', async () => {
    const t = await timed();
    const caller = await signedIn();
    const c = await connected(t.env, caller);
    const res = await anonApp.request(
      authorizeUrl(goodParams(c.clientId, pkce().challenge)),
      { headers: { cookie: caller.cookie } },
      t.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('value="approve"');
  });

  it('checks the CSRF token: another session, another request or a forged value fails', async () => {
    const t = await timed();
    const caller = await signedIn();
    const other = await signedIn();
    const clientId = await registerClient(t.env);
    const open = async (who: Caller) => {
      const res = await anonApp.request(
        authorizeUrl(goodParams(clientId, pkce().challenge)),
        { headers: { cookie: who.cookie } },
        t.env,
      );
      return formFields(await res.text());
    };
    const mine = await open(caller);
    const second = await open(caller);
    const cases: [Record<string, string>, string][] = [
      [{ request: mine.request, csrf: 'forged', decision: 'approve' }, caller.cookie],
      [{ request: mine.request, csrf: '', decision: 'approve' }, caller.cookie],
      [{ request: mine.request, decision: 'approve' }, caller.cookie],
      // The form lifted into another session.
      [{ ...mine, decision: 'approve' }, other.cookie],
      // The token of one request used for another.
      [{ request: second.request, csrf: mine.csrf, decision: 'approve' }, caller.cookie],
      [{ ...mine, decision: 'maybe' }, caller.cookie],
    ];
    for (const [fields, cookie] of cases) {
      const res = await postForm(t.env, '/oauth/authorize', fields, { cookie });
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-security-policy')).toBe(MCP_PAGE_CSP);
      expect(await res.text()).not.toContain('http-equiv="refresh"');
    }
    // No session at all.
    const anon = await postForm(t.env, '/oauth/authorize', { ...mine, decision: 'approve' });
    expect(anon.status).toBe(400);
    // None of those spent the request or made a grant: the real form still approves once.
    expect(
      await testDb().first('SELECT id FROM mcp_grants WHERE client_id = ?', clientId),
    ).toBeNull();
    const ok = await postForm(
      t.env,
      '/oauth/authorize',
      { ...mine, decision: 'approve' },
      { cookie: caller.cookie },
    );
    expect(ok.status).toBe(200);
    const again = await postForm(
      t.env,
      '/oauth/authorize',
      { ...mine, decision: 'approve' },
      { cookie: caller.cookie },
    );
    expect(again.status).toBe(400);
  });

  it('the CSRF token is the HMAC of the request id and the session cookie hash', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env);
    const res = await anonApp.request(
      authorizeUrl(goodParams(clientId, pkce().challenge)),
      { headers: { cookie: caller.cookie } },
      t.env,
    );
    const f = formFields(await res.text());
    const raw = caller.cookie.split('=').slice(1).join('=');
    expect(f.csrf).toBe(consentCsrf(SECRET, f.request, raw));
  });

  it('Approve answers the 200 returning page, never a 302, with the page headers', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env);
    const res = await anonApp.request(
      authorizeUrl(goodParams(clientId, pkce().challenge)),
      { headers: { cookie: caller.cookie } },
      t.env,
    );
    const posted = await postForm(
      t.env,
      '/oauth/authorize',
      { ...formFields(await res.text()), decision: 'approve' },
      { cookie: caller.cookie },
    );
    expect(posted.status).toBe(200);
    expect(posted.headers.get('location')).toBeNull();
    expect(posted.headers.get('content-security-policy')).toBe(MCP_PAGE_CSP);
    expect(posted.headers.get('x-frame-options')).toBe('DENY');
    expect(posted.headers.get('referrer-policy')).toBe('no-referrer');
    expect(posted.headers.get('cache-control')).toBe('no-store');
    const page = await posted.text();
    expect(page).toContain(`<style>${MCP_PAGE_STYLE}</style>`);
    expect(page).toContain('Continue to claude.ai');
    const target = returnTarget(page);
    expect(withoutQuery(target)).toBe(CALLBACK);
    expect([...target.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state']);
  });

  it('Deny answers the returning page with error=access_denied, state and iss, and no grant', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env);
    const target = await consentTo(t.env, caller, clientId, pkce().challenge, 'deny');
    expect(withoutQuery(target)).toBe(CALLBACK);
    expect(Object.fromEntries(target.searchParams)).toEqual({
      error: 'access_denied',
      state: 'st-123',
      iss: ISSUER,
    });
    expect(
      await testDb().first('SELECT id FROM mcp_grants WHERE client_id = ?', clientId),
    ).toBeNull();
  });

  it('the redirect is the stored redirect_uri, never a form field, and keeps its own query', async () => {
    const t = await timed();
    const caller = await signedIn();
    const uri = 'https://client.example/cb?tenant=a&x=1';
    const clientId = await registerClient(t.env, [uri]);
    const res = await anonApp.request(
      authorizeUrl({ ...goodParams(clientId, pkce().challenge), redirect_uri: uri }),
      { headers: { cookie: caller.cookie } },
      t.env,
    );
    const posted = await postForm(
      t.env,
      '/oauth/authorize',
      {
        ...formFields(await res.text()),
        decision: 'approve',
        // Ignored: nothing in the form names where to go.
        redirect_uri: 'https://evil.example/cb',
      },
      { cookie: caller.cookie },
    );
    const page = await posted.text();
    expect(page).not.toContain('evil.example');
    const target = returnTarget(page);
    expect(target.origin).toBe('https://client.example');
    expect(target.searchParams.get('tenant')).toBe('a');
    expect(target.searchParams.get('x')).toBe('1');
    expect(target.searchParams.get('code')).toBeTruthy();
  });

  it('resume shows consent for a live request with a session, and a 400 page otherwise', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env);
    const start = await anonApp.request(
      authorizeUrl(goodParams(clientId, pkce().challenge)),
      {},
      t.env,
    );
    const state = new URL(start.headers.get('location') as string).searchParams.get('state');
    const id = String(await env.ports.kv.get(`csrf:${state}`)).slice(4);
    const ok = await anonApp.request(
      `/oauth/authorize/resume?request=${id}`,
      { headers: { cookie: caller.cookie } },
      t.env,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toBe(MCP_PAGE_CSP);
    expect(formFields(await ok.text()).request).toBe(id);
    for (const [path, headers] of [
      [`/oauth/authorize/resume?request=${id}`, {}],
      ['/oauth/authorize/resume?request=AAAAAAAAAAAAAAAAAAAAAA', { cookie: caller.cookie }],
      ['/oauth/authorize/resume', { cookie: caller.cookie }],
    ] as const) {
      const res = await anonApp.request(path, { headers }, t.env);
      expect(res.status, path).toBe(400);
      expect(await res.text()).toContain('Start connecting again');
    }
  });
});

// ── Criterion 4: refresh ────────────────────────────────────────────────────────────────────

describe('refresh (design 4.5)', () => {
  it('rotates: a new pair, the old token spent, and a seal on its row', async () => {
    const t = await timed();
    const c = await connected(t.env);
    t.advance(10 * SEC);
    const res = await refresh(t.env, c.clientId, c.refresh);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.access_token).not.toBe(c.access);
    expect(body.refresh_token).not.toBe(c.refresh);
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe('dashboards');
    const old = await refreshRow(c.refresh);
    expect(old?.used_at_utc).toBe(iso(T0 + 10 * SEC));
    expect(old?.successor_sealed).toMatch(/^v1\./);
    const fresh = await refreshRow(String(body.refresh_token));
    expect(fresh?.issued_at_utc).toBe(iso(T0 + 10 * SEC));
    expect(fresh?.used_at_utc).toBeNull();
    // The rotated pair works for the next rotation.
    t.advance(HOUR);
    expect((await refresh(t.env, c.clientId, String(body.refresh_token))).status).toBe(200);
  });

  it('a reuse outside the window revokes the grant and all its tokens', async () => {
    const t = await timed();
    const c = await connected(t.env);
    const next = await bodyOf(await refresh(t.env, c.clientId, c.refresh));
    t.advance(5 * 60 * SEC);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await refresh(t.env, c.clientId, c.refresh);
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    expect(log).toHaveBeenCalledWith(`mcp oauth: refresh reuse, grant ${c.grantId} revoked`);
    log.mockRestore();
    await expectRevoked(c.grantId);
    expect(await bodyOf(await refresh(t.env, c.clientId, String(next.refresh_token)))).toEqual({
      error: 'invalid_grant',
    });
  });

  it('refresh tokens expire 30 days after they are issued', async () => {
    const t = await timed();
    const c = await connected(t.env);
    expect((await refreshRow(c.refresh))?.expires_at_utc).toBe(iso(T0 + 30 * DAY));
    t.advance(30 * DAY);
    const res = await refresh(t.env, c.clientId, c.refresh);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    // Expired, not reused: nothing was revoked or spent.
    expect((await grantRow(c.grantId))?.revoked_at_utc).toBeNull();
    expect((await refreshRow(c.refresh))?.used_at_utc).toBeNull();

    // One second earlier it still rotates, and the new token's 30 days start at its own issue.
    const u = await timed();
    const d = await connected(u.env);
    u.advance(30 * DAY - SEC);
    const ok = await refresh(u.env, d.clientId, d.refresh);
    expect(ok.status).toBe(200);
    const next = await refreshRow(String((await bodyOf(ok)).refresh_token));
    expect(next?.expires_at_utc).toBe(iso(T0 + 60 * DAY - SEC));
  });

  it('a disabled user cannot refresh', async () => {
    const t = await timed();
    const c = await connected(t.env);
    await testDb().run(
      'UPDATE users SET disabled_at_utc = ? WHERE id = ?',
      iso(T0),
      c.caller.userId,
    );
    const res = await refresh(t.env, c.clientId, c.refresh);
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    expect((await refreshRow(c.refresh))?.used_at_utc).toBeNull();
    expect(await tokenCounts(c.grantId)).toEqual({ access: 1, refresh: 1 });
  });

  it('an unknown token and a missing refresh_token are refused, writing nothing', async () => {
    const t = await timed();
    const c = await connected(t.env);
    expect(await bodyOf(await refresh(t.env, c.clientId, 'alr_unknown'))).toEqual({
      error: 'invalid_grant',
    });
    const missing = await postForm(t.env, '/oauth/token', {
      grant_type: 'refresh_token',
      client_id: c.clientId,
    });
    expect(await bodyOf(missing)).toEqual({ error: 'invalid_request' });
    expect(await tokenCounts(c.grantId)).toEqual({ access: 1, refresh: 1 });
  });
});

// ── Criterion 5: the 90-day cap ─────────────────────────────────────────────────────────────

describe('the 90-day grant cap (ADR 0035 decision 16)', () => {
  it("a new grant's expires_at is 90 days after its creation", async () => {
    const t = await timed();
    const c = await connected(t.env);
    expect(await grantRow(c.grantId)).toEqual({
      created_at_utc: iso(T0),
      expires_at_utc: iso(T0 + 90 * DAY),
      revoked_at_utc: null,
    });
  });

  it('a refresh token issued 70 days into a grant expires at the cap, not 30 days later', async () => {
    const t = await timed();
    const c = await connected(t.env);
    let token = c.refresh;
    // Refresh every 20 days to stay inside each token's 30 days.
    for (const day of [20, 40, 60, 70]) {
      t.set(T0 + day * DAY);
      const res = await refresh(t.env, c.clientId, token);
      expect(res.status, `day ${day}`).toBe(200);
      token = String((await bodyOf(res)).refresh_token);
    }
    const row = await refreshRow(token);
    expect(row?.issued_at_utc).toBe(iso(T0 + 70 * DAY));
    expect(row?.expires_at_utc).toBe(iso(T0 + 90 * DAY));
  });

  it('an access token issued in the last hour before the cap expires at the cap', async () => {
    const t = await timed();
    const c = await connected(t.env);
    let token = c.refresh;
    for (const day of [25, 50, 75]) {
      t.set(T0 + day * DAY);
      token = String((await bodyOf(await refresh(t.env, c.clientId, token))).refresh_token);
    }
    t.set(T0 + 90 * DAY - 20 * 60 * SEC);
    const res = await refresh(t.env, c.clientId, token);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.expires_in).toBe(20 * 60);
    expect(Number(body.expires_in)).toBeLessThan(3600);
    expect((await accessRow(String(body.access_token)))?.expires_at_utc).toBe(iso(T0 + 90 * DAY));
    expect((await refreshRow(String(body.refresh_token)))?.expires_at_utc).toBe(iso(T0 + 90 * DAY));
  });

  it('refreshing every day still gets invalid_grant once the grant is 90 days old', async () => {
    const t = await timed();
    const c = await connected(t.env);
    let token = c.refresh;
    for (let day = 1; day < 90; day++) {
      t.set(T0 + day * DAY);
      const res = await refresh(t.env, c.clientId, token);
      expect(res.status, `day ${day}`).toBe(200);
      token = String((await bodyOf(res)).refresh_token);
    }
    t.set(T0 + 90 * DAY);
    const res = await refresh(t.env, c.clientId, token);
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    // The cap is enforced, not a revocation: the grant simply ended.
    expect((await grantRow(c.grantId))?.revoked_at_utc).toBeNull();
  });

  it('a code exchanged past the cap gets no tokens', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env);
    const { verifier, challenge } = pkce();
    const target = await consentTo(t.env, caller, clientId, challenge);
    t.set(T0 + 90 * DAY);
    const res = await exchange(t.env, {
      client_id: clientId,
      code: target.searchParams.get('code') as string,
      code_verifier: verifier,
    });
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
  });
});

// ── Criterion 6: the grace window ───────────────────────────────────────────────────────────

describe('the refresh grace window (ADR 0035 decision 17, design 4.5)', () => {
  /** A grant rotated once at T0 + 1 h: the spent token and the successor that rotation issued. */
  async function rotated(extra: Record<string, unknown> = {}) {
    const t = await timed(extra);
    const c = await connected(t.env);
    t.set(T0 + HOUR);
    const res = await refresh(t.env, c.clientId, c.refresh);
    expect(res.status).toBe(200);
    const successor = await bodyOf(res);
    const rows = await tokenCounts(c.grantId);
    return { t, c, successor, rows, rotatedAt: T0 + HOUR };
  }

  for (const after of [29, 30]) {
    it(`same-client reuse at ${after} s returns the successor already issued and writes no row`, async () => {
      const { t, c, successor, rows, rotatedAt } = await rotated();
      t.set(rotatedAt + after * SEC);
      const log = vi.spyOn(console, 'info').mockImplementation(() => {});
      const res = await refresh(t.env, c.clientId, c.refresh);
      expect(res.status).toBe(200);
      const body = await bodyOf(res);
      expect(body.access_token).toBe(successor.access_token);
      expect(body.refresh_token).toBe(successor.refresh_token);
      expect(body.expires_in).toBe(3600 - after);
      expect(log).toHaveBeenCalledWith(`mcp oauth: refresh reuse within grace, grant ${c.grantId}`);
      log.mockRestore();
      expect(await tokenCounts(c.grantId)).toEqual(rows);
      expect((await grantRow(c.grantId))?.revoked_at_utc).toBeNull();
    });
  }

  it('reuse at 31 s revokes the grant and all its tokens', async () => {
    const { t, c, successor, rotatedAt } = await rotated();
    t.set(rotatedAt + 31 * SEC);
    const res = await refresh(t.env, c.clientId, c.refresh);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    await expectRevoked(c.grantId);
    expect(await bodyOf(await refresh(t.env, c.clientId, String(successor.refresh_token)))).toEqual(
      {
        error: 'invalid_grant',
      },
    );
  });

  for (const after of [10, 31]) {
    it(`different-client reuse at ${after} s revokes`, async () => {
      const { t, c, successor, rotatedAt } = await rotated();
      const other = await registerClient(t.env);
      t.set(rotatedAt + after * SEC);
      const res = await refresh(t.env, other, c.refresh);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
      await expectRevoked(c.grantId);
      // The successor the rotation issued then fails too.
      expect(await accessRow(String(successor.access_token))).toBeNull();
      expect(
        await bodyOf(await refresh(t.env, c.clientId, String(successor.refresh_token))),
      ).toEqual({ error: 'invalid_grant' });
    });
  }

  it('a live token presented by another client gets invalid_grant, writes nothing, and the right client then refreshes it', async () => {
    const t = await timed();
    const c = await connected(t.env);
    const other = await registerClient(t.env);
    const before = await tokenCounts(c.grantId);
    const res = await refresh(t.env, other, c.refresh);
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    const row = await refreshRow(c.refresh);
    expect(row?.used_at_utc).toBeNull();
    expect(row?.successor_sealed).toBeNull();
    expect(await tokenCounts(c.grantId)).toEqual(before);
    expect((await grantRow(c.grantId))?.revoked_at_utc).toBeNull();
    expect((await refresh(t.env, c.clientId, c.refresh)).status).toBe(200);
  });

  it('two concurrent refreshes of one token return the same tokens', async () => {
    const t = await timed();
    const c = await connected(t.env);
    const [a, b] = await Promise.all([
      refresh(t.env, c.clientId, c.refresh),
      refresh(t.env, c.clientId, c.refresh),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ja, jb] = [await bodyOf(a), await bodyOf(b)];
    expect(ja.access_token).toBe(jb.access_token);
    expect(ja.refresh_token).toBe(jb.refresh_token);
    // One rotation only: the first pair plus one successor.
    expect(await tokenCounts(c.grantId)).toEqual({ access: 2, refresh: 2 });
    expect((await grantRow(c.grantId))?.revoked_at_utc).toBeNull();
  });

  for (const after of [0, 1]) {
    it(`with the window set to 0, rotation writes no seal and a reuse at +${after} s revokes`, async () => {
      const { t, c, rotatedAt } = await rotated({ MCP_REFRESH_GRACE_SECONDS: '0' });
      expect((await refreshRow(c.refresh))?.successor_sealed).toBeNull();
      t.set(rotatedAt + after * SEC);
      const res = await refresh(t.env, c.clientId, c.refresh);
      expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
      await expectRevoked(c.grantId);
    });
  }

  it('MCP_REFRESH_GRACE_SECONDS sets the window: at 5, a reuse at 5 s gets the successor and one at 6 s revokes', async () => {
    const a = await rotated({ MCP_REFRESH_GRACE_SECONDS: '5' });
    a.t.set(a.rotatedAt + 5 * SEC);
    expect((await refresh(a.t.env, a.c.clientId, a.c.refresh)).status).toBe(200);
    const b = await rotated({ MCP_REFRESH_GRACE_SECONDS: '5' });
    b.t.set(b.rotatedAt + 6 * SEC);
    expect(await bodyOf(await refresh(b.t.env, b.c.clientId, b.c.refresh))).toEqual({
      error: 'invalid_grant',
    });
    await expectRevoked(b.c.grantId);
  });

  it('a disabled user gets no successor', async () => {
    const { t, c, rotatedAt } = await rotated();
    await testDb().run(
      'UPDATE users SET disabled_at_utc = ? WHERE id = ?',
      iso(rotatedAt),
      c.caller.userId,
    );
    t.set(rotatedAt + 10 * SEC);
    const res = await refresh(t.env, c.clientId, c.refresh);
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    await expectRevoked(c.grantId);
  });

  it('a seal moved to another row does not open', async () => {
    const a = await rotated();
    // A second rotation in the same grant: its spent token's row gets the first row's seal.
    const second = await refresh(a.t.env, a.c.clientId, String(a.successor.refresh_token));
    expect(second.status).toBe(200);
    const sealA = (await refreshRow(a.c.refresh))?.successor_sealed;
    expect(sealA).toBeTruthy();
    await testDb().run(
      'UPDATE mcp_refresh_tokens SET successor_sealed = ? WHERE token_hash = ?',
      sealA,
      hashMcpSecret(String(a.successor.refresh_token)),
    );
    a.t.advance(5 * SEC);
    const res = await refresh(a.t.env, a.c.clientId, String(a.successor.refresh_token));
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    await expectRevoked(a.c.grantId);
  });

  it('successor_sealed contains neither raw token', async () => {
    const { c, successor } = await rotated();
    const sealed = String((await refreshRow(c.refresh))?.successor_sealed);
    for (const raw of [successor.access_token, successor.refresh_token, c.refresh, c.access]) {
      const s = String(raw);
      expect(sealed).not.toContain(s);
      expect(sealed).not.toContain(s.slice(4));
      expect(sealed).not.toContain(Buffer.from(s).toString('base64url'));
      expect(sealed).not.toContain(Buffer.from(s).toString('base64'));
      expect(sealed).not.toContain(hashMcpSecret(s));
    }
  });

  it('a seal does not open under a different MCP_SIGNING_SECRET', async () => {
    const { c, rotatedAt } = await rotated();
    const rotatedSecret = await timed({ MCP_SIGNING_SECRET: `${SECRET}-rotated` });
    rotatedSecret.set(rotatedAt + 10 * SEC);
    const res = await refresh(rotatedSecret.env, c.clientId, c.refresh);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_grant' });
    await expectRevoked(c.grantId);
  });
});

// ── Criterion 9: token endpoint rate limits ─────────────────────────────────────────────────

describe('token endpoint windows (design 4.5)', () => {
  const tokenCall = (e: Bindings, clientId: string, ip: string) =>
    postForm(
      e,
      '/oauth/token',
      { grant_type: 'refresh_token', client_id: clientId, refresh_token: 'alr_x' },
      { 'x-forwarded-for': ip },
    );

  it('the 31st request in a minute for one client gets 429 with Retry-After', async () => {
    const t = await timed({}, Date.parse('2026-11-13T12:00:10.000Z'));
    const clientId = await registerClient(t.env);
    for (let i = 0; i < 30; i++) {
      expect((await tokenCall(t.env, clientId, freshIp())).status).toBe(400);
    }
    const res = await tokenCall(t.env, clientId, freshIp());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('50');
    expect(await bodyOf(res)).toEqual({ detail: 'Rate limit exceeded; retry in 50 s.' });
    // Another client is not limited, and the next minute starts afresh.
    expect((await tokenCall(t.env, await registerClient(t.env), freshIp())).status).toBe(400);
    t.advance(50 * SEC);
    expect((await tokenCall(t.env, clientId, freshIp())).status).toBe(400);
  });

  it('the 61st request in a minute from one IPv4 address gets 429', async () => {
    const t = await timed();
    const ip = freshIp();
    for (let i = 0; i < 60; i++) {
      expect((await tokenCall(t.env, `alc_c${i}`, ip)).status).toBe(400);
    }
    expect((await tokenCall(t.env, 'alc_c61', ip)).status).toBe(429);
    expect((await tokenCall(t.env, 'alc_c62', freshIp())).status).toBe(400);
  });

  it('addresses in one IPv6 /64 share a window', async () => {
    const t = await timed();
    for (let i = 0; i < 30; i++) {
      expect((await tokenCall(t.env, `alc_a${i}`, '2001:db8:aa:bb::1')).status).toBe(400);
      expect((await tokenCall(t.env, `alc_b${i}`, `2001:db8:aa:bb:ffff::${i + 2}`)).status).toBe(
        400,
      );
    }
    expect((await tokenCall(t.env, 'alc_z', '2001:db8:aa:bb:1:2:3:4')).status).toBe(429);
    expect((await tokenCall(t.env, 'alc_z', '2001:db8:aa:bc::1')).status).toBe(400);
  });
});

// ── Criterion 10: revocation ────────────────────────────────────────────────────────────────

describe('POST /oauth/revoke (RFC 7009, design 4.8)', () => {
  const revoke = (e: Bindings, fields: Record<string, string>) =>
    postForm(e, '/oauth/revoke', fields);

  for (const which of ['refresh', 'access'] as const) {
    it(`revoking the ${which} token revokes the whole grant: 200 with no body`, async () => {
      const t = await timed();
      const c = await connected(t.env);
      const res = await revoke(t.env, {
        token: which === 'refresh' ? c.refresh : c.access,
        token_type_hint: `${which}_token`,
        client_id: c.clientId,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(res.headers.get('cache-control')).toBe('no-store');
      await expectRevoked(c.grantId);
      expect(await bodyOf(await refresh(t.env, c.clientId, c.refresh))).toEqual({
        error: 'invalid_grant',
      });
    });
  }

  it('answers 200 for an unknown token, and revokes nothing for another client', async () => {
    const t = await timed();
    const c = await connected(t.env);
    const other = await registerClient(t.env);
    const cases: Record<string, string>[] = [
      { token: 'alr_unknown', client_id: c.clientId },
      { token: c.refresh, client_id: other },
      { token: c.refresh },
    ];
    for (const fields of cases) {
      const res = await revoke(t.env, fields);
      expect(res.status, JSON.stringify(fields)).toBe(200);
    }
    expect((await grantRow(c.grantId))?.revoked_at_utc).toBeNull();
    expect(await tokenCounts(c.grantId)).toEqual({ access: 1, refresh: 1 });
  });

  it('a request without a token is invalid_request', async () => {
    const t = await timed();
    const res = await revoke(t.env, { client_id: 'alc_x' });
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: 'invalid_request' });
  });
});

// ── Criterion 11: flag off changes nothing ──────────────────────────────────────────────────

const upgradeStub = (() => async (c: { text(b: string, s: number): Response }) =>
  c.text('WebSocket unavailable in HTTP tests', 426)) as unknown as UpgradeWebSocket;

function fakeOutgoing(): ServerResponse {
  return { headersSent: false, writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
}

const J3_PATHS = ['/oauth/authorize', '/oauth/authorize/resume', '/oauth/token', '/oauth/revoke'];
const OFF_VALUES = [{}, { CUSTOM_DASHBOARDS_ENABLED: '0' }, { CUSTOM_DASHBOARDS_ENABLED: 'off' }];

async function snapshot(res: Response) {
  return { status: res.status, headers: [...res.headers.entries()].sort(), body: await res.text() };
}

describe('with the flag off every J3 path answers as an unmounted path does (design 10.4)', () => {
  const handle = vi.fn(async (_i: unknown, outgoing: ServerResponse) => {
    (outgoing as unknown as { headersSent: boolean }).headersSent = true;
  });
  const bridged = wireApp(new Hono<AppEnv>(), upgradeStub, { frontend: { handle } });
  afterEach(() => handle.mockClear());

  it.each(OFF_VALUES)('GET and HEAD reach the frontend bridge (flag %j)', async (flag) => {
    const caller = await signedIn();
    for (const path of J3_PATHS) {
      for (const method of ['GET', 'HEAD']) {
        for (const headers of [{}, { cookie: caller.cookie }]) {
          handle.mockClear();
          const e = {
            ...envWith(flag),
            incoming: {},
            outgoing: fakeOutgoing(),
          } as unknown as Bindings;
          const res = await bridged.request(`${path}?client_id=x`, { method, headers }, e);
          expect(handle, `${method} ${path}`).toHaveBeenCalledTimes(1);
          expect(res.headers.get('x-hono-already-sent')).toBe('true');
          expect(res.headers.get('content-security-policy')).toBeNull();
        }
      }
    }
  });

  it.each(OFF_VALUES)(
    'every method answers byte for byte what an unmounted path answers (flag %j)',
    async (flag) => {
      const caller = await signedIn();
      const e = envWith(flag);
      const control = await snapshot(
        await anonApp.request('/oauth/not-a-route', { method: 'POST' }, e),
      );
      for (const path of J3_PATHS) {
        for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
          const res = await anonApp.request(
            path,
            {
              method,
              headers: {
                cookie: caller.cookie,
                'content-type': 'application/x-www-form-urlencoded',
              },
              ...(method === 'GET' || method === 'HEAD'
                ? {}
                : { body: 'grant_type=refresh_token&client_id=alc_x&refresh_token=alr_x&token=x' }),
            },
            e,
          );
          const got = await snapshot(res);
          const want = method === 'HEAD' ? { ...control, body: '' } : control;
          expect(got, `${method} ${path}`).toEqual(want);
        }
      }
      const w = await testDb().first<{ n: number }>(
        'SELECT count(*)::int AS n FROM mcp_rate_windows',
      );
      expect(w?.n).toBe(0);
      const k = await testDb().first<{ n: number }>(
        "SELECT count(*)::int AS n FROM kv WHERE key LIKE 'mcp%'",
      );
      expect(k?.n).toBe(0);
    },
  );
});

// ── J4: Connected apps (design 4.8) ─────────────────────────────────────────────────────────

describe('GET and DELETE /api/oauth/connected-apps (design 4.8)', () => {
  const list = (e: Bindings, caller: Caller) =>
    anonApp.request('/api/oauth/connected-apps', { headers: { cookie: caller.cookie } }, e);
  const del = (e: Bindings, caller: Caller, id: string) =>
    anonApp.request(
      `/api/oauth/connected-apps/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { cookie: caller.cookie } },
      e,
    );

  it('lists only the signed-in user live grants in the specified shape, never registered_from', async () => {
    const t = await timed();
    const mine = await connected(t.env);
    const other = await connected(t.env, await signedIn2());
    const res = await list(t.env, mine.caller);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await bodyOf(res)) as { apps: Json[] };
    expect(body.apps).toEqual([
      {
        grant_id: mine.grantId,
        client_name: 'Claude <b>bold</b>',
        redirect_host: 'claude.ai',
        created_at: iso(T0),
        last_used_at: null,
      },
    ]);
    for (const a of body.apps) expect(Object.keys(a)).not.toContain('registered_from');
    expect(JSON.stringify(body)).not.toContain('registered_from');
    expect(JSON.stringify(body)).not.toContain(other.grantId);
    // The registering address is stored, but never selected by the list.
    const row = await testDb().first<{ registered_from: string }>(
      'SELECT registered_from FROM mcp_clients WHERE id = ?',
      mine.clientId,
    );
    expect(JSON.stringify(body)).not.toContain(String(row?.registered_from));
  });

  it('does not list a grant a failed code exchange left with no tokens', async () => {
    const t = await timed();
    const caller = await signedIn();
    const clientId = await registerClient(t.env);
    const { challenge } = pkce();
    const target = await consentTo(t.env, caller, clientId, challenge);
    const code = target.searchParams.get('code') as string;
    const bad = await exchange(t.env, {
      client_id: clientId,
      code,
      code_verifier: pkce().verifier,
    });
    expect(bad.status).toBe(400);
    const g = await testDb().first<{ id: string }>(
      'SELECT id FROM mcp_grants WHERE client_id = ?',
      clientId,
    );
    expect(g?.id).toBeTruthy();
    expect(await tokenCounts(String(g?.id))).toEqual({ access: 0, refresh: 0 });
    expect(await bodyOf(await list(t.env, caller))).toEqual({ apps: [] });
  });

  it('DELETE revokes the grant and its tokens: 204, refresh gets invalid_grant, lookup finds no token', async () => {
    const t = await timed();
    const c = await connected(t.env);
    expect(await accessRow(c.access)).not.toBeNull();
    const res = await del(t.env, c.caller, c.grantId);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    await expectRevoked(c.grantId);
    // The token lookup (the row `/mcp` will resolve a bearer through) no longer finds the token.
    expect(await accessRow(c.access)).toBeNull();
    expect(await refreshRow(c.refresh)).toBeNull();
    expect(await bodyOf(await refresh(t.env, c.clientId, c.refresh))).toEqual({
      error: 'invalid_grant',
    });
    expect(await bodyOf(await list(t.env, c.caller))).toEqual({ apps: [] });
  });

  it('another user grant id gets the same masked 404 as an unknown id, and stays live', async () => {
    const t = await timed();
    const mine = await connected(t.env);
    const intruder = await signedIn2();
    const foreign = await del(t.env, intruder, mine.grantId);
    const unknown = await del(t.env, intruder, 'alg_nope');
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await bodyOf(foreign)).toEqual(await bodyOf(unknown));
    expect((await grantRow(mine.grantId))?.revoked_at_utc).toBeNull();
    expect(await tokenCounts(mine.grantId)).toEqual({ access: 1, refresh: 1 });
    // Revoking an already revoked grant is the same masked 404.
    expect((await del(t.env, mine.caller, mine.grantId)).status).toBe(204);
    expect((await del(t.env, mine.caller, mine.grantId)).status).toBe(404);
  });

  it('needs a session cookie: 401 without one, and a Bearer never authenticates', async () => {
    const t = await timed();
    const c = await connected(t.env);
    for (const [method, path] of [
      ['GET', '/api/oauth/connected-apps'],
      ['DELETE', `/api/oauth/connected-apps/${c.grantId}`],
    ]) {
      const none = await anonApp.request(path, { method }, t.env);
      expect(none.status, `${method} ${path}`).toBe(401);
      const bearer = await anonApp.request(
        path,
        { method, headers: { authorization: `Bearer ${c.access}` } },
        t.env,
      );
      expect(bearer.status, `${method} ${path} bearer`).toBe(401);
    }
    expect((await grantRow(c.grantId))?.revoked_at_utc).toBeNull();
  });

  it.each(OFF_VALUES)(
    'with the flag off both routes answer as an unmounted path does (flag %j)',
    async (flag) => {
      const caller = await signedIn();
      const e = envWith(flag);
      const control = await snapshot(
        await anonApp.request('/api/oauth/not-a-route', { headers: { cookie: caller.cookie } }, e),
      );
      for (const [method, path] of [
        ['GET', '/api/oauth/connected-apps'],
        ['DELETE', '/api/oauth/connected-apps/alg_x'],
      ]) {
        const res = await anonApp.request(path, { method, headers: { cookie: caller.cookie } }, e);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await snapshot(res), `${method} ${path}`).toEqual(control);
      }
    },
  );
});

/** A second signed-in user, distinct from `signedIn()`'s. */
async function signedIn2(): Promise<Caller> {
  const userId = await seedUser({ email: 'second-user@example.com' });
  return { userId, cookie: await loginCookie(userId) };
}
