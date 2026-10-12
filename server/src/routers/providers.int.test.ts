// Provider credential routes (byo-ai-providers task 4.5, design D4, D5; api-contract-freeze
// "Provider credential routes", provider-credentials). Every request carries an explicit cookie (or
// none), through `anonApp`. Connection tests go to local fakes through a ProviderTester built with
// their hosts; the provider mode is set per request with `envWith({PROVIDER_DEV_MODE})`.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PROVIDER_TEST_DETAIL,
  providerCredentialSchema,
  providersResponseSchema,
  providerTestResponseSchema,
} from '@autologger/contract';
import { PostgresProviderCredentialStore } from '@autologger/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderTester } from '../auth/providerTester';
import { anonApp, envWith } from '../test/harness';
import { loginCookie, seedCompanionDevice, seedUser, testDb } from '../test/helpers';

const PATH = '/api/me/providers';
const LOGIN_REQUIRED = { detail: 'Login required.' };
const NOT_SET_UP = { detail: 'Provider not set up.' };
const TOO_MANY = { detail: 'Too many connection tests. Try again in a minute.' };
const NUL_REFUSED = { detail: 'Text must not contain NUL characters.' };
const OPENAI_KEY = 'sk-test-openai-0123456789';
const DG_KEY = 'dg_secret_abcd';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}
const servers: Server[] = [];
const logs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  logs.length = 0;
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
function captureLogs() {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(
      (...a: unknown[]) => void logs.push(a.map(String).join(' ')),
    );
  }
}

/** One fake host for every provider; `reply` decides each answer. */
async function fakeProviders(
  reply: (s: Seen) => { status: number; body?: string } = () => ({ status: 200 }),
) {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const one = { method: req.method ?? '', url: req.url ?? '', headers: req.headers };
      seen.push(one);
      const r = reply(one);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body ?? '{}');
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const tester = new ProviderTester({
    openai: origin,
    anthropic: origin,
    google: origin,
    deepgram: origin,
  });
  return { seen, origin, tester };
}

function envFor(
  opts: { dev?: boolean; tester?: ProviderTester; ports?: Record<string, unknown> } = {},
) {
  return envWith(
    { PROVIDER_DEV_MODE: opts.dev ?? false },
    { ...(opts.tester ? { providerTester: opts.tester } : {}), ...(opts.ports ?? {}) },
  );
}

interface Caller {
  id: string;
  cookie: string;
}
async function caller(email?: string): Promise<Caller> {
  const id = await seedUser(email ? { email } : {});
  return { id, cookie: await loginCookie(id) };
}

function req(
  who: Caller | null,
  method: string,
  path: string,
  body?: unknown,
  env = envFor(),
  headers: Record<string, string> = {},
) {
  return anonApp.request(
    `${PATH}${path}`,
    {
      method,
      headers: {
        ...(who ? { cookie: who.cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
  );
}

const stt = (over: Record<string, unknown> = {}) => ({
  provider: 'deepgram',
  model: 'nova-3',
  api_key: DG_KEY,
  ...over,
});
const openai = (over: Record<string, unknown> = {}) => ({
  provider: 'openai',
  model: 'gpt-5.5',
  api_key: OPENAI_KEY,
  ...over,
});
const compat = (baseUrl: string, over: Record<string, unknown> = {}) => ({
  provider: 'openai-compatible',
  base_url: baseUrl,
  model: 'm-1',
  api_key: OPENAI_KEY,
  ...over,
});

async function stored(userId: string, kind: string) {
  return testDb().first<Record<string, unknown>>(
    `SELECT provider, base_url, base_origin, model, key_last4, key_ciphertext
       FROM user_provider_credentials WHERE user_id = ? AND kind = ?`,
    userId,
    kind,
  );
}

describe('save, read, replace and delete (api-contract-freeze "Provider credential routes")', () => {
  it('saves a key once, shows only its last four, keeps it on a model-only save, and deletes', async () => {
    captureLogs();
    const me = await caller();
    const saved = await req(me, 'PUT', '/stt', stt());
    expect(saved.status).toBe(200);
    const cred = providerCredentialSchema.parse(await saved.json());
    expect(cred).toMatchObject({
      kind: 'stt',
      provider: 'deepgram',
      base_url: null,
      model: 'nova-3',
      key_last4: 'abcd',
    });

    const read = await req(me, 'GET', '');
    const text = await read.text();
    expect(text).not.toContain(DG_KEY);
    expect(providersResponseSchema.parse(JSON.parse(text))).toEqual({
      llm: null,
      stt: cred,
      run_features_allowed: true,
      // ai-sdk-agent-harness D9 category 5: GET adds claude_cli_allowed.
      claude_cli_allowed: false,
    });

    const before = await stored(me.id, 'stt');
    const kept = await req(me, 'PUT', '/stt', { provider: 'deepgram', model: 'nova-2' });
    expect(kept.status).toBe(200);
    const after = await stored(me.id, 'stt');
    expect(after?.model).toBe('nova-2');
    expect(
      Buffer.from(after?.key_ciphertext as Uint8Array).equals(
        Buffer.from(before?.key_ciphertext as Uint8Array),
      ),
    ).toBe(true);

    const del = await req(me, 'DELETE', '/stt');
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');
    expect(providersResponseSchema.parse(await (await req(me, 'GET', '')).json()).stt).toBeNull();
    expect((await req(me, 'DELETE', '/stt')).status).toBe(404);

    const audit = logs.filter((l) => l.startsWith('provider credential'));
    expect(audit).toEqual([
      `provider credential saved user=${me.id} kind=stt`,
      `provider credential saved user=${me.id} kind=stt`,
      `provider credential deleted user=${me.id} kind=stt`,
    ]);
    expect(logs.join('\n')).not.toContain(DG_KEY);
  });

  it('stores the key encrypted, never in a column', async () => {
    const me = await caller();
    await req(me, 'PUT', '/llm', openai());
    const row = await testDb().first<Record<string, unknown>>(
      'SELECT * FROM user_provider_credentials WHERE user_id = ?',
      me.id,
    );
    expect(JSON.stringify(row)).not.toContain(OPENAI_KEY);
    expect(Buffer.from(row?.key_ciphertext as Uint8Array).toString('utf8')).not.toContain(
      OPENAI_KEY,
    );
  });

  it('reports run_features_allowed false for a user who is not approved', async () => {
    const me = await caller('not-approved@example.com');
    expect(
      providersResponseSchema.parse(await (await req(me, 'GET', '')).json()).run_features_allowed,
    ).toBe(false);
  });
});

describe('the key and its destination (provider-credentials "A stored key is bound to its destination")', () => {
  it('the first save needs a key', async () => {
    const me = await caller();
    const r = await req(me, 'PUT', '/llm', openai({ api_key: undefined }));
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toContain('api_key');
    expect(await stored(me.id, 'llm')).toBeNull();
  });

  it('a new OpenAI-compatible host or a new provider without a key gets 422 and changes nothing', async () => {
    const me = await caller();
    expect((await req(me, 'PUT', '/llm', compat('https://api.example.com/v1'))).status).toBe(200);
    const before = await stored(me.id, 'llm');
    for (const body of [
      compat('https://other.example/v1', { api_key: undefined }),
      { provider: 'openai', model: 'gpt-5.5' },
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    ]) {
      const r = await req(me, 'PUT', '/llm', body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(JSON.stringify(await r.json())).toContain('api_key');
      expect(await stored(me.id, 'llm')).toEqual(before);
    }
    // The same origin written differently keeps the key.
    const same = await req(
      me,
      'PUT',
      '/llm',
      compat('https://API.Example.com:443/v2/', { api_key: undefined }),
    );
    expect(same.status).toBe(200);
    expect(await stored(me.id, 'llm')).toMatchObject({
      base_url: 'https://api.example.com/v2',
      base_origin: 'https://api.example.com',
      key_last4: before?.key_last4,
    });
  });

  it('a fixed-host provider with a base URL gets 422; a key with a control character or space gets 422', async () => {
    const me = await caller();
    for (const [kind, body] of [
      [
        'llm',
        {
          provider: 'anthropic',
          base_url: 'https://evil.example/v1',
          model: 'claude-x',
          api_key: OPENAI_KEY,
        },
      ],
      ['stt', stt({ api_key: 'dg_secret\nX-Evil: 1' })],
      ['stt', stt({ api_key: 'dg secret abcd' })],
      ['llm', compat('http://api.example.com/v1')],
      ['llm', compat('https://api.example.com:8443/v1')],
      ['llm', compat('https://api.example.com/v1?x=1')],
    ] as const) {
      expect((await req(me, 'PUT', `/${kind}`, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(await stored(me.id, 'llm')).toBeNull();
    expect(await stored(me.id, 'stt')).toBeNull();
  });

  it('NUL anywhere gets the NUL 400, and malformed JSON the existing 400', async () => {
    const me = await caller();
    const r = await req(me, 'PUT', '/stt', stt({ model: 'nova\u00003' }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual(NUL_REFUSED);
    expect((await req(me, 'PUT', '/stt', '{not json')).status).toBe(400);
    expect(await stored(me.id, 'stt')).toBeNull();
  });
});

describe('isolation and access', () => {
  it('users cannot see, delete or test each other’s credentials', async () => {
    const a = await caller();
    const b = await caller();
    await req(a, 'PUT', '/llm', openai());
    expect(providersResponseSchema.parse(await (await req(b, 'GET', '')).json()).llm).toBeNull();
    const del = await req(b, 'DELETE', '/llm');
    expect(del.status).toBe(404);
    expect(await del.json()).toEqual(NOT_SET_UP);
    const test = await req(b, 'POST', '/llm/test');
    expect(test.status).toBe(404);
    expect(await stored(a.id, 'llm')).not.toBeNull();
  });

  it('signed-out and Companion device callers get 401', async () => {
    const me = await caller();
    const device = await seedCompanionDevice(me.id);
    for (const headers of [{}, device.bearer]) {
      const r = await req(null, 'GET', '', undefined, envFor(), headers);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual(LOGIN_REQUIRED);
    }
  });

  it('an unknown kind is not found', async () => {
    const me = await caller();
    const r = await req(me, 'PUT', '/tts', stt());
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Not found.' });
  });
});

describe('the connection test (provider-credentials "The connection test reports without leaking")', () => {
  it('maps each provider’s answer to its fixed result, sending the key only in its header', async () => {
    captureLogs();
    const f = await fakeProviders((s) => {
      if (s.url.startsWith('/v1/models/missing'))
        return { status: 404, body: '{"error":"secret-upstream"}' };
      if (s.headers.authorization === 'Bearer bad-key-123456')
        return { status: 401, body: '{"error":"secret-upstream"}' };
      return { status: 200, body: '{"data":[{"id":"m-1"}]}' };
    });
    const env = envFor({ dev: true, tester: f.tester });
    const me = await caller();
    // A second user for the second half: five tests per window per user ("Request rules").
    const me2 = await caller();
    const testAs = async (who: Caller, kind: string) => {
      const r = await req(who, 'POST', `/${kind}/test`, undefined, env);
      expect(r.status).toBe(200);
      return providerTestResponseSchema.parse(await r.json());
    };
    const test = (kind: string) => testAs(me, kind);
    const test2 = (kind: string) => testAs(me2, kind);
    await req(me, 'PUT', '/llm', openai({ model: 'gpt-5.5' }), env);
    expect(await test('llm')).toEqual({ ok: true, detail: PROVIDER_TEST_DETAIL.connected });
    expect(f.seen.at(-1)?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);

    await req(me, 'PUT', '/llm', openai({ model: 'missing' }), env);
    expect(await test('llm')).toEqual({ ok: false, detail: PROVIDER_TEST_DETAIL.modelNotFound });

    await req(me, 'PUT', '/llm', openai({ api_key: 'bad-key-123456' }), env);
    expect(await test('llm')).toEqual({ ok: false, detail: PROVIDER_TEST_DETAIL.rejected });

    await req(
      me2,
      'PUT',
      '/llm',
      { provider: 'anthropic', model: 'claude-sonnet-4-5', api_key: OPENAI_KEY },
      env,
    );
    expect(await test2('llm')).toEqual({ ok: true, detail: PROVIDER_TEST_DETAIL.connected });
    expect(f.seen.at(-1)?.headers['x-api-key']).toBe(OPENAI_KEY);

    await req(me2, 'PUT', '/llm', compat(`${f.origin}/v1`), env);
    expect(await test2('llm')).toEqual({ ok: true, detail: PROVIDER_TEST_DETAIL.connected });
    expect(f.seen.at(-1)?.url).toBe('/v1/models');

    await req(me2, 'PUT', '/stt', stt(), env);
    expect(await test2('stt')).toEqual({ ok: true, detail: PROVIDER_TEST_DETAIL.connected });
    expect(f.seen.at(-1)?.headers.authorization).toBe(`Token ${DG_KEY}`);
    expect(f.seen.at(-1)?.url).toBe('/v1/listen?model=nova-3');

    expect(logs.join('\n')).not.toMatch(/secret-upstream|sk-test-openai|dg_secret|bad-key/);
  });

  it('a private OpenAI-compatible host in production mode reads as unreachable, without a request', async () => {
    const f = await fakeProviders();
    const me = await caller();
    const env = envFor({ dev: false, tester: f.tester });
    expect((await req(me, 'PUT', '/llm', compat('https://10.0.0.5/v1'), env)).status).toBe(200);
    const r = await req(me, 'POST', '/llm/test', undefined, env);
    expect(providerTestResponseSchema.parse(await r.json())).toEqual({
      ok: false,
      detail: PROVIDER_TEST_DETAIL.unreachable,
    });
    expect(f.seen).toHaveLength(0);
  });

  it('a credential that no longer decrypts asks for the key again, without a request', async () => {
    captureLogs();
    const f = await fakeProviders();
    const me = await caller();
    const env = envFor({ dev: true, tester: f.tester });
    await req(me, 'PUT', '/stt', stt(), env);
    await testDb().run(
      "UPDATE user_provider_credentials SET key_tag = '\\x00000000000000000000000000000000' WHERE user_id = ?",
      me.id,
    );
    const r = await req(me, 'POST', '/stt/test', undefined, env);
    expect(providerTestResponseSchema.parse(await r.json())).toEqual({
      ok: false,
      detail: PROVIDER_TEST_DETAIL.unreadable,
    });
    expect(f.seen).toHaveLength(0);
  });

  it('the sixth test in a window gets 429 without a request, across processes and after delete and re-save', async () => {
    const f = await fakeProviders();
    const me = await caller();
    const env = envFor({ dev: true, tester: f.tester });
    const other = envFor({
      dev: true,
      tester: f.tester,
      ports: {
        providerCredentials: new PostgresProviderCredentialStore(
          env.ports.catalog,
          env.ports.clock,
        ),
      },
    });
    await req(me, 'PUT', '/stt', stt(), env);
    for (let i = 0; i < 5; i++) {
      expect((await req(me, 'POST', '/stt/test', undefined, i % 2 ? env : other)).status).toBe(200);
    }
    const sixth = await req(me, 'POST', '/stt/test', undefined, other);
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual(TOO_MANY);
    await req(me, 'DELETE', '/stt', undefined, env);
    await req(me, 'PUT', '/stt', stt(), env);
    expect((await req(me, 'POST', '/stt/test', undefined, env)).status).toBe(429);
    expect(f.seen).toHaveLength(5);
  });

  it('testing without a credential is not found', async () => {
    const me = await caller();
    const r = await req(me, 'POST', '/llm/test');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual(NOT_SET_UP);
  });
});

// ai-sdk-agent-harness design D2 (api-contract-freeze "Provider credential routes", provider-credentials
// "A user holds at most one credential per kind"): the keyless `claude-cli` provider, allowlisted
// by CLAUDE_CLI_EMAILS while CLAUDE_CLI_PATH is set.
describe('the claude-cli provider (ai-sdk-agent-harness D2)', () => {
  const CLI_EMAIL = 'cli-dev@example.com';
  const CLI_FORBIDDEN = { detail: 'The Claude CLI is limited to approved operator accounts.' };
  const cliEnv = (
    over: { path?: string; emails?: string; tester?: ProviderTester; dev?: boolean } = {},
  ) =>
    envWith(
      {
        PROVIDER_DEV_MODE: over.dev ?? false,
        CLAUDE_CLI_PATH: over.path ?? '/fake/claude',
        CLAUDE_CLI_EMAILS: over.emails ?? ` ${CLI_EMAIL.toUpperCase()} ,other@example.com`,
      },
      over.tester ? { providerTester: over.tester } : {},
    );
  const allowedOf = async (who: Caller, env: ReturnType<typeof cliEnv>) =>
    providersResponseSchema.parse(await (await req(who, 'GET', '', undefined, env)).json())
      .claude_cli_allowed;

  it('an allowlisted caller saves it keyless, and GET reports claude_cli_allowed', async () => {
    captureLogs();
    const me = await caller(CLI_EMAIL);
    const env = cliEnv();
    expect(await allowedOf(me, env)).toBe(true);
    const r = await req(me, 'PUT', '/llm', { provider: 'claude-cli' }, env);
    expect(r.status).toBe(200);
    const cred = providerCredentialSchema.parse(await r.json());
    expect(cred).toMatchObject({
      kind: 'llm',
      provider: 'claude-cli',
      base_url: null,
      model: 'claude-cli',
      key_last4: null,
    });
    expect(await stored(me.id, 'llm')).toEqual({
      provider: 'claude-cli',
      base_url: null,
      base_origin: null,
      model: 'claude-cli',
      key_last4: null,
      key_ciphertext: null,
    });
    expect(
      providersResponseSchema.parse(await (await req(me, 'GET', '', undefined, env)).json()),
    ).toEqual({ llm: cred, stt: null, run_features_allowed: false, claude_cli_allowed: true });
    expect(logs.filter((l) => l.startsWith('provider credential'))).toEqual([
      `provider credential saved user=${me.id} kind=llm`,
    ]);
  });

  it('a caller who is not listed, the bootstrap owner, and anyone while CLAUDE_CLI_PATH is blank get 403 and nothing is stored', async () => {
    const notListed = await caller('not-listed@example.com');
    const owner = await caller('bootstrap-owner@example.com');
    const listed = await caller(CLI_EMAIL);
    // A prior credential is left unchanged by the refused save.
    expect((await req(notListed, 'PUT', '/llm', openai(), cliEnv())).status).toBe(200);
    const before = await stored(notListed.id, 'llm');
    for (const [who, env] of [
      [notListed, cliEnv()],
      [owner, cliEnv()],
      [listed, cliEnv({ path: '' })],
      [listed, cliEnv({ path: '   ' })],
    ] as const) {
      const r = await req(who, 'PUT', '/llm', { provider: 'claude-cli' }, env);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual(CLI_FORBIDDEN);
      expect(await allowedOf(who, env)).toBe(false);
    }
    expect(await stored(notListed.id, 'llm')).toEqual(before);
    expect(await stored(owner.id, 'llm')).toBeNull();
    expect(await stored(listed.id, 'llm')).toBeNull();
    // The default harness has no CLAUDE_CLI_EMAILS at all.
    expect(await allowedOf(listed, envFor())).toBe(false);
  });

  it('takes no key, base URL or model (422), and is not an stt provider', async () => {
    const me = await caller(CLI_EMAIL);
    for (const extra of [
      { model: 'opus' },
      { api_key: OPENAI_KEY },
      { base_url: 'https://api.example.com/v1' },
      { model: null },
    ]) {
      const r = await req(me, 'PUT', '/llm', { provider: 'claude-cli', ...extra }, cliEnv());
      expect(r.status, JSON.stringify(extra)).toBe(422);
    }
    expect((await req(me, 'PUT', '/stt', { provider: 'claude-cli' }, cliEnv())).status).toBe(422);
    expect(await stored(me.id, 'llm')).toBeNull();
    expect(await stored(me.id, 'stt')).toBeNull();
  });

  it('switching from claude-cli to a key provider without a key gets 422 and changes nothing; with a key it saves', async () => {
    const me = await caller(CLI_EMAIL);
    const env = cliEnv();
    expect((await req(me, 'PUT', '/llm', { provider: 'claude-cli' }, env)).status).toBe(200);
    const before = await stored(me.id, 'llm');
    for (const body of [
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { provider: 'openai', model: 'gpt-5.5' },
      compat('https://api.example.com/v1', { api_key: undefined }),
    ]) {
      const r = await req(me, 'PUT', '/llm', body, env);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(JSON.stringify(await r.json())).toContain('api_key');
      expect(await stored(me.id, 'llm')).toEqual(before);
    }
    const r = await req(
      me,
      'PUT',
      '/llm',
      { provider: 'anthropic', model: 'claude-sonnet-4-5', api_key: OPENAI_KEY },
      env,
    );
    expect(r.status).toBe(200);
    expect(providerCredentialSchema.parse(await r.json()).key_last4).toBe('6789');
  });

  it('the test answers Connected or unavailable with no outbound request, and counts toward the window', async () => {
    const f = await fakeProviders();
    const me = await caller(CLI_EMAIL);
    const env = cliEnv({ tester: f.tester });
    const removed = cliEnv({ tester: f.tester, emails: 'other@example.com' });
    const blank = cliEnv({ tester: f.tester, path: '' });
    expect((await req(me, 'PUT', '/llm', { provider: 'claude-cli' }, env)).status).toBe(200);
    const test = async (e: ReturnType<typeof cliEnv>) => {
      const r = await req(me, 'POST', '/llm/test', undefined, e);
      return { status: r.status, body: await r.json() };
    };
    expect(await test(env)).toEqual({
      status: 200,
      body: { ok: true, detail: PROVIDER_TEST_DETAIL.connected },
    });
    const unavailable = {
      status: 200,
      body: { ok: false, detail: "The Claude CLI isn't available to this account." },
    };
    expect(await test(removed)).toEqual(unavailable);
    expect(await test(blank)).toEqual(unavailable);
    expect(await test(env)).toEqual({
      status: 200,
      body: { ok: true, detail: PROVIDER_TEST_DETAIL.connected },
    });
    expect((await test(removed)).status).toBe(200);
    // The sixth test in the window is refused.
    expect(await test(env)).toEqual({ status: 429, body: TOO_MANY });
    expect(f.seen).toHaveLength(0);
  });
});
