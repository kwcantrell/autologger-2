// The connection test (byo-ai-providers design D5; provider-credentials "The connection test
// reports without leaking"): one request per test, per provider, against local fakes standing in
// for each provider's host. Results are the fixed strings; upstream bodies never reach a result or
// a log. Production wiring always uses the frozen constant hosts.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_TEST_DETAIL } from '@autologger/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBindings } from '../node/config';
import { PROVIDER_HOSTS, ProviderTester } from './providerTester';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A fake provider host: records each request and answers with `reply`. */
async function fake(reply: (seen: Seen) => { status: number; body?: string }) {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const one = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      seen.push(one);
      const r = reply(one);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body ?? '{}');
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { seen, origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

const KEY = 'test-key-0123456789';
const SECRET_BODY = 'upstream-secret-detail';

async function testerFor(reply: Parameters<typeof fake>[0]) {
  const f = await fake(reply);
  const tester = new ProviderTester({
    openai: f.origin,
    anthropic: f.origin,
    google: f.origin,
    deepgram: f.origin,
  });
  return { ...f, tester };
}

const llm = (provider: string, model = 'm-1', baseUrl: string | null = null) => ({
  kind: 'llm' as const,
  provider,
  baseUrl,
  model,
  key: KEY,
  production: false,
});

describe('ProviderTester requests (design D5)', () => {
  it('openai: GET /v1/models/{model} with a Bearer key; 2xx connected', async () => {
    const t = await testerFor(() => ({ status: 200, body: '{"id":"gpt-5.5"}' }));
    expect(await t.tester.test(llm('openai', 'gpt-5.5'))).toEqual({
      ok: true,
      detail: PROVIDER_TEST_DETAIL.connected,
    });
    expect(t.seen[0]?.method).toBe('GET');
    expect(t.seen[0]?.url).toBe('/v1/models/gpt-5.5');
    expect(t.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('anthropic: GET /v1/models/{model} with x-api-key and anthropic-version, the model percent-encoded', async () => {
    const t = await testerFor(() => ({ status: 200 }));
    expect((await t.tester.test(llm('anthropic', 'claude sonnet/4'))).ok).toBe(true);
    expect(t.seen[0]?.url).toBe('/v1/models/claude%20sonnet%2F4');
    expect(t.seen[0]?.headers['x-api-key']).toBe(KEY);
    expect(t.seen[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(t.seen[0]?.headers.authorization).toBeUndefined();
  });

  it('google: GET /v1beta/models/{model} with x-goog-api-key', async () => {
    const t = await testerFor(() => ({ status: 200 }));
    expect((await t.tester.test(llm('google', 'gemini-flash-latest'))).ok).toBe(true);
    expect(t.seen[0]?.url).toBe('/v1beta/models/gemini-flash-latest');
    expect(t.seen[0]?.headers['x-goog-api-key']).toBe(KEY);
  });

  it('openai-compatible: GET {base_url}/models; listed, missing and unlisted models', async () => {
    const t = await testerFor(() => ({ status: 200, body: '{"data":[{"id":"a"},{"id":"m-1"}]}' }));
    expect(await t.tester.test(llm('openai-compatible', 'm-1', `${t.origin}/v1`))).toEqual({
      ok: true,
      detail: PROVIDER_TEST_DETAIL.connected,
    });
    expect(t.seen[0]?.url).toBe('/v1/models');
    expect(t.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(await t.tester.test(llm('openai-compatible', 'zz', `${t.origin}/v1`))).toEqual({
      ok: false,
      detail: PROVIDER_TEST_DETAIL.modelNotFound,
    });
    const u = await testerFor(() => ({ status: 200, body: '{"object":"list"}' }));
    expect((await u.tester.test(llm('openai-compatible', 'zz', `${u.origin}/v1`))).ok).toBe(true);
  });

  it('deepgram: POST /v1/listen?model= with a Token key and a short silent WAV', async () => {
    const t = await testerFor(() => ({ status: 200 }));
    const r = await t.tester.test({
      kind: 'stt',
      provider: 'deepgram',
      baseUrl: null,
      model: 'nova-3',
      key: KEY,
      production: false,
    });
    expect(r.ok).toBe(true);
    const s = t.seen[0];
    expect(s?.method).toBe('POST');
    expect(s?.url).toBe('/v1/listen?model=nova-3');
    expect(s?.headers.authorization).toBe(`Token ${KEY}`);
    expect(s?.headers['content-type']).toBe('audio/wav');
    expect(s?.body.subarray(0, 4).toString()).toBe('RIFF');
    expect(s?.body.subarray(8, 12).toString()).toBe('WAVE');
    // 0.25 s of 16 kHz mono 16-bit silence: 8000 data bytes after the 44-byte header.
    expect(s?.body.length).toBe(44 + 8000);
    expect(s?.body.subarray(44).every((b) => b === 0)).toBe(true);
  });
});

describe('ProviderTester results (design D5)', () => {
  it.each([
    ['openai', 401, PROVIDER_TEST_DETAIL.rejected],
    ['anthropic', 403, PROVIDER_TEST_DETAIL.rejected],
    ['openai', 404, PROVIDER_TEST_DETAIL.modelNotFound],
    ['anthropic', 404, PROVIDER_TEST_DETAIL.modelNotFound],
    ['google', 404, PROVIDER_TEST_DETAIL.modelNotFound],
    ['openai', 500, PROVIDER_TEST_DETAIL.unexpected(500)],
    ['google', 302, PROVIDER_TEST_DETAIL.unexpected(302)],
  ])('%s answering %i reads as its fixed result', async (provider, status, detail) => {
    const t = await testerFor(() => ({ status, body: `{"error":"${SECRET_BODY}"}` }));
    const r = await t.tester.test(llm(provider));
    expect(r).toEqual({ ok: false, detail });
  });

  it("google's 400 API_KEY_INVALID reads as rejected; another 400 as unexpected; neither body is kept", async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(
        (...a: unknown[]) => void logs.push(a.map(String).join(' ')),
      );
    }
    const invalid = JSON.stringify({
      error: {
        code: 400,
        message: SECRET_BODY,
        status: 'INVALID_ARGUMENT',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ],
      },
    });
    const t = await testerFor(() => ({ status: 400, body: invalid }));
    const r = await t.tester.test(llm('google'));
    expect(r).toEqual({ ok: false, detail: PROVIDER_TEST_DETAIL.rejected });
    const u = await testerFor(() => ({
      status: 400,
      body: `{"error":{"message":"${SECRET_BODY}"}}`,
    }));
    expect(await u.tester.test(llm('google'))).toEqual({
      ok: false,
      detail: PROVIDER_TEST_DETAIL.unexpected(400),
    });
    expect(JSON.stringify([r, logs])).not.toContain(SECRET_BODY);
  });

  it('a dead host is unreachable and a silent one times out', async () => {
    const t = await testerFor(() => ({ status: 200 }));
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    expect(await t.tester.test(llm('openai'))).toEqual({
      ok: false,
      detail: PROVIDER_TEST_DETAIL.unreachable,
    });
    const silent = createServer(() => {});
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const slow = new ProviderTester(
      { openai: origin, anthropic: origin, google: origin, deepgram: origin },
      { timeoutMs: 200 },
    );
    expect(await slow.test(llm('openai'))).toEqual({
      ok: false,
      detail: PROVIDER_TEST_DETAIL.timeout,
    });
  });

  it('an openai-compatible host refused in production mode reads as unreachable, without a request', async () => {
    const t = await testerFor(() => ({ status: 200 }));
    const r = await t.tester.test({
      ...llm('openai-compatible', 'm-1', 'https://10.0.0.5/v1'),
      production: true,
    });
    expect(r).toEqual({ ok: false, detail: PROVIDER_TEST_DETAIL.unreachable });
    expect(t.seen).toHaveLength(0);
  });
});

describe('ProviderTester wiring (provider-credentials "Fixed hosts can\'t be overridden in production")', () => {
  it('the constant hosts are the real ones and frozen', () => {
    expect(PROVIDER_HOSTS).toEqual({
      openai: 'https://api.openai.com',
      anthropic: 'https://api.anthropic.com',
      google: 'https://generativelanguage.googleapis.com',
      deepgram: 'https://api.deepgram.com',
    });
    expect(Object.isFrozen(PROVIDER_HOSTS)).toBe(true);
    expect(Object.isFrozen(new ProviderTester().hosts)).toBe(true);
  });

  it('createBindings wires the constant hosts whatever the environment holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autologger-tester-'));
    const base: Record<string, string> = {
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'https://example.com',
      BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com',
      PGHOST: '127.0.0.1',
      PGPORT: '1',
      PGUSER: 'autologger_app',
      PGPASSWORD: 'unused',
      PGDATABASE: 'postgres',
      AI_PROVIDER: 'claude_cli',
    };
    // Every key createBindings reads that the base doesn't set answers an attacker host.
    const hostile = new Proxy(base, {
      get: (t, k) => (k in t ? t[k as string] : 'http://127.0.0.1:1'),
    }) as Record<string, string>;
    const { bindings, close } = createBindings(hostile);
    try {
      expect(bindings.ports.providerTester.hosts).toEqual(PROVIDER_HOSTS);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
