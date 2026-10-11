// The guarded model-request fetch (ai-sdk-agent-harness design D4; ai-topics-chat "Model requests
// on the AI SDK route are guarded"; provider-credentials "A stored key is bound to its
// destination"). The AI SDK provider factories call it as `(url, init)`. Against a local fake
// upstream: only the credential's destination and model-request path are reached; the DNS answer is
// checked and pinned per connection; redirects are returned unfollowed; the 120 s timeout covers
// only the wait for headers; the per-turn caps refuse without a connection (or end the response);
// per-request byte counts are exposed; the body streams; an abort closes the socket; nothing is
// logged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GUARDED_FETCH_CAPS,
  type GuardedFetchOptions,
  guardedFetch,
  isBlockedAddress,
  OutboundFailure,
  PROVIDER_HOSTS,
} from './providerOutbound';

const KEY = 'sk-guarded-SECRET-KEY-0123';
const BODY_MARK = 'PROMPT-BODY-MARKER';
const MB = 1024 * 1024;

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  bytes: number;
}

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

type Handler = (seen: Seen, res: ServerResponse, req: IncomingMessage) => void;
async function upstream(handler: Handler = (_s, res) => res.end('{"ok":true}')) {
  const seen: Seen[] = [];
  const closed: string[] = [];
  const s = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
    });
    req.on('end', () => {
      const one = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, bytes };
      seen.push(one);
      handler(one, res, req);
    });
    req.socket.on('close', () => closed.push(req.url ?? ''));
  });
  s.on('connection', (c) => sockets.push(c));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return { seen, closed, origin, port };
}

const hostsAt = (origin: string) => ({
  openai: origin,
  anthropic: origin,
  google: origin,
  deepgram: origin,
});

const post = (body = `{"m":"${BODY_MARK}"}`, extra: RequestInit = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body,
  ...extra,
});

async function refused(p: Promise<unknown>): Promise<OutboundFailure> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OutboundFailure);
  return err as OutboundFailure;
}

function fixed(origin: string, provider: string, model: string, over: Partial<GuardedFetchOptions> = {}) {
  return guardedFetch({
    provider,
    model,
    baseUrl: null,
    baseOrigin: null,
    production: false,
    hosts: hostsAt(origin),
    ...over,
  });
}

function compat(baseUrl: string, over: Partial<GuardedFetchOptions> = {}) {
  return guardedFetch({
    provider: 'openai-compatible',
    model: 'qwen3',
    baseUrl,
    baseOrigin: new URL(baseUrl).origin,
    production: false,
    ...over,
  });
}

describe('destination (D4 step 1)', () => {
  it('fixed-host providers reach only their host and model-request path', async () => {
    const u = await upstream();
    const ok = [
      ['anthropic', 'claude-sonnet-4-5', '/v1/messages'],
      ['openai', 'gpt-5.5', '/v1/responses'],
      ['google', 'gemini-2.5-pro', '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'],
      ['google', 'gemini-2.5-pro', '/v1beta/models/gemini-2.5-pro:streamGenerateContent'],
    ] as const;
    for (const [provider, model, path] of ok) {
      const g = fixed(u.origin, provider, model);
      const r = await g.fetch(`${u.origin}${path}`, post());
      expect(r.status, `${provider} ${path}`).toBe(200);
    }
    expect(u.seen.map((s) => s.url)).toEqual(ok.map(([, , p]) => p));

    const bad = [
      ['anthropic', 'claude-x', '/v1/complete'],
      ['anthropic', 'claude-x', '/v1/messages?beta=1'],
      ['anthropic', 'claude-x', '/v1/messages/'],
      ['openai', 'gpt-5.5', '/v1/chat/completions'],
      ['openai', 'gpt-5.5', '/v1/files'],
      ['google', 'gemini-2.5-pro', '/v1beta/models/other:streamGenerateContent?alt=sse'],
      ['google', 'gemini-2.5-pro', '/v1beta/models/gemini-2.5-pro:generateContent'],
      ['google', 'gemini-2.5-pro', '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=json'],
      ['google', 'gemini-2.5-pro', '/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=x'],
      ['anthropic', 'claude-x', '/v1/%2e%2e/messages'],
      ['anthropic', 'claude-x', '/v1/../v1/messages'],
      ['anthropic', 'claude-x', '/v1//messages'],
      ['anthropic', 'claude-x', '/v1%2Fmessages'],
      ['anthropic', 'claude-x', '/v1/./messages'],
    ] as const;
    for (const [provider, model, path] of bad) {
      const g = fixed(u.origin, provider, model);
      const e = await refused(g.fetch(`${u.origin}${path}`, post()));
      expect(e.kind, `${provider} ${path}`).toBe('refused');
    }
    // Another host, even the real one, when the table says otherwise.
    const g = fixed(u.origin, 'anthropic', 'claude-x');
    await refused(g.fetch(`${PROVIDER_HOSTS.anthropic}/v1/messages`, post()));
    await refused(g.fetch('http://127.0.0.2:1/v1/messages', post()));
    expect(u.seen).toHaveLength(ok.length);
  });

  it('a model id with / or .. cannot retarget the path, and no request is made for it', async () => {
    const u = await upstream();
    for (const model of ['../files', 'a/b', 'x..y', '..']) {
      const g = fixed(u.origin, 'google', model);
      const path = `/v1beta/models/${model}:streamGenerateContent?alt=sse`;
      const e = await refused(g.fetch(`${u.origin}${path}`, post()));
      expect(e.kind, model).toBe('refused');
      // Fixed-path providers refuse it too, so the id is never used anywhere.
      await refused(fixed(u.origin, 'anthropic', model).fetch(`${u.origin}/v1/messages`, post()));
    }
    expect(u.seen).toHaveLength(0);
  });

  it('openai-compatible reaches only <saved origin><base path>/chat/completions', async () => {
    const u = await upstream();
    const g = compat(`${u.origin}/v1`);
    expect((await g.fetch(`${u.origin}/v1/chat/completions`, post())).status).toBe(200);
    const root = compat(u.origin);
    expect((await root.fetch(`${u.origin}/chat/completions`, post())).status).toBe(200);
    for (const url of [
      `${u.origin}/v1/models`,
      `${u.origin}/v2/chat/completions`,
      `${u.origin}/chat/completions`,
      `${u.origin}/v1/chat/completions?x=1`,
      `${u.origin}/v1//chat/completions`,
      `${u.origin}/v1/x/../chat/completions`,
      `${u.origin}/v1/chat%2Fcompletions`,
      `http://127.0.0.2:${u.port}/v1/chat/completions`,
      `http://localhost:${u.port}/v1/chat/completions`,
    ]) {
      const e = await refused(g.fetch(url, post()));
      expect(e.kind, url).toBe('refused');
    }
    expect(u.seen.map((s) => s.url)).toEqual(['/v1/chat/completions', '/chat/completions']);
  });

  it('refuses a method other than POST, a Request object, and a userinfo URL', async () => {
    const u = await upstream();
    const g = compat(`${u.origin}/v1`);
    await refused(g.fetch(`${u.origin}/v1/chat/completions`, { method: 'GET' }));
    await refused(g.fetch(new Request(`${u.origin}/v1/chat/completions`, post()) as never));
    await refused(
      g.fetch(`http://user:pw@127.0.0.1:${u.port}/v1/chat/completions`, post()),
    );
    expect(u.seen).toHaveLength(0);
  });
});

describe('addresses (D4 step 2)', () => {
  it('in production mode a host resolving to 169.254.169.254 is refused, also after a public answer', async () => {
    const u = await upstream();
    const metadata = async () => [{ address: '169.254.169.254', family: 4 }];
    const g = compat('https://llm.example.com/v1', { production: true, lookup: metadata });
    const e = await refused(g.fetch('https://llm.example.com/v1/chat/completions', post()));
    expect(e.kind).toBe('unreachable');

    // A first answer that passes the check, then the metadata address on the next connection:
    // each connection resolves and checks again. The test policy treats the fake's loopback
    // address as public; 169.254.169.254 stays blocked by the real rule.
    let calls = 0;
    const flip = async () => {
      calls += 1;
      return [{ address: calls === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }];
    };
    const prod = compat(`http://llm.example.test:${u.port}/v1`, {
      production: true,
      lookup: flip,
      isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
    });
    const url = `http://llm.example.test:${u.port}/v1/chat/completions`;
    expect((await prod.fetch(url, post())).status).toBe(200);
    const e2 = await refused(prod.fetch(url, post()));
    expect(e2.kind).toBe('unreachable');
    expect(calls).toBe(2);
    expect(u.seen).toHaveLength(1);
  });

  it('in production mode a blocked IP literal or IPv4-mapped form is refused without a connection', async () => {
    const u = await upstream();
    for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', '[::1]']) {
      const base = `http://${host}:${u.port}/v1`;
      const g = compat(base, { production: true });
      const e = await refused(g.fetch(`${base}/chat/completions`, post()));
      expect(e.kind, host).toBe('unreachable');
    }
    expect(u.seen).toHaveLength(0);
  });

  it('the connection uses the checked address, with the original Host header', async () => {
    const u = await upstream();
    const g = compat(`http://llm.example.test:${u.port}/v1`, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const r = await g.fetch(`http://llm.example.test:${u.port}/v1/chat/completions`, post());
    expect(r.status).toBe(200);
    expect(u.seen[0]?.headers.host).toBe(`llm.example.test:${u.port}`);
    expect(u.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a 302 is returned unfollowed, though the caller set no redirect', async () => {
    const target = await upstream();
    const u = await upstream((_s, res) => {
      res.writeHead(302, { location: `${target.origin}/steal` });
      res.end();
    });
    const g = compat(`${u.origin}/v1`);
    const r = await g.fetch(`${u.origin}/v1/chat/completions`, post());
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${target.origin}/steal`);
    expect(target.seen).toHaveLength(0);
  });
});

describe('header timeout (D4 step 2)', () => {
  it('fires only before the headers arrive', async () => {
    const slowHeaders = await upstream((_s, res) => {
      setTimeout(() => res.end('late'), 600);
    });
    const g = compat(`${slowHeaders.origin}/v1`, { headerTimeoutMs: 150 });
    const t0 = Date.now();
    const e = await refused(g.fetch(`${slowHeaders.origin}/v1/chat/completions`, post()));
    expect(e.kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(550);

    const slowBody = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const tick = setInterval(() => {
        res.write(`data: ${n}\n\n`);
        n += 1;
        if (n === 6) {
          clearInterval(tick);
          res.end();
        }
      }, 100);
    });
    const g2 = compat(`${slowBody.origin}/v1`, { headerTimeoutMs: 150 });
    const r = await g2.fetch(`${slowBody.origin}/v1/chat/completions`, post());
    expect(await r.text()).toBe([0, 1, 2, 3, 4, 5].map((n) => `data: ${n}\n\n`).join(''));
  });

  it('defaults to 120 s', async () => {
    expect(GUARDED_FETCH_CAPS.headerTimeoutMs).toBe(120_000);
  });
});

describe('per-turn caps (D4 step 3)', () => {
  it('are 60 requests, 4 MB per body, 48 MB of bodies and 64 MB of responses', () => {
    expect(GUARDED_FETCH_CAPS).toMatchObject({
      requests: 60,
      requestBodyBytes: 4 * MB,
      requestBodyTotalBytes: 48 * MB,
      responseTotalBytes: 64 * MB,
    });
  });

  it('refuse the 61st request with no connection', async () => {
    const u = await upstream();
    const g = compat(`${u.origin}/v1`);
    for (let i = 0; i < 60; i++) {
      const r = await g.fetch(`${u.origin}/v1/chat/completions`, post('{}'));
      await r.text();
    }
    const e = await refused(g.fetch(`${u.origin}/v1/chat/completions`, post('{}')));
    expect(e.kind).toBe('cap');
    expect(g.breach()).toBe('requests');
    expect(u.seen).toHaveLength(60);
  });

  it('refuse a body over 4 MB, and bodies past 48 MB per turn, with no connection', async () => {
    const u = await upstream();
    const g = compat(`${u.origin}/v1`);
    const e = await refused(
      g.fetch(`${u.origin}/v1/chat/completions`, post('x'.repeat(4 * MB + 1))),
    );
    expect(e.kind).toBe('cap');
    expect(g.breach()).toBe('request-body');
    expect(u.seen).toHaveLength(0);

    const g2 = compat(`${u.origin}/v1`);
    const four = 'y'.repeat(4 * MB);
    for (let i = 0; i < 12; i++) {
      await (await g2.fetch(`${u.origin}/v1/chat/completions`, post(four))).text();
    }
    const e2 = await refused(g2.fetch(`${u.origin}/v1/chat/completions`, post('z')));
    expect(e2.kind).toBe('cap');
    expect(g2.breach()).toBe('request-total');
    expect(u.seen).toHaveLength(12);
  });

  it('abort the response stream past 64 MB of responses in the turn', async () => {
    const chunk = Buffer.alloc(MB, 0x61);
    const u = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const pump = () => {
        while (n < 70) {
          n += 1;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const g = compat(`${u.origin}/v1`);
    const r = await g.fetch(`${u.origin}/v1/chat/completions`, post());
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    let got = 0;
    const err = await (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        got += value.length;
      }
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundFailure);
    expect((err as OutboundFailure).kind).toBe('cap');
    expect(g.breach()).toBe('response-total');
    expect(got).toBeLessThanOrEqual(64 * MB);
    // The next request in the same turn is refused without a connection.
    await refused(g.fetch(`${u.origin}/v1/chat/completions`, post()));
    expect(u.seen).toHaveLength(1);
  });
});

describe('streaming, byte counts and abort (D4 step 4)', () => {
  it('reports per-request byte counts for the usage estimate', async () => {
    const u = await upstream((s, res) => res.end('r'.repeat(s.bytes * 2)));
    const g = compat(`${u.origin}/v1`);
    await (await g.fetch(`${u.origin}/v1/chat/completions`, post('a'.repeat(100)))).text();
    await (await g.fetch(`${u.origin}/v1/chat/completions`, post('b'.repeat(7)))).text();
    expect(g.byteLog()).toEqual([
      { requestBytes: 100, responseBytes: 200 },
      { requestBytes: 7, responseBytes: 14 },
    ]);
  });

  it('streams the body through unbuffered past 1 MB', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const u = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(Buffer.alloc(2 * MB, 0x62));
      void gate.then(() => res.end('tail'));
    });
    const g = compat(`${u.origin}/v1`);
    const r = await g.fetch(`${u.origin}/v1/chat/completions`, post());
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    let got = 0;
    while (got < 2 * MB) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      got += value?.length ?? 0;
    }
    // More than 1 MB arrived while the upstream is still holding the response open.
    expect(got).toBe(2 * MB);
    release();
    let tail = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += Buffer.from(value).toString('utf8');
    }
    expect(tail).toBe('tail');
  });

  it('an abort closes the upstream socket, before and after the headers', async () => {
    const u = await upstream((s, res) => {
      if (s.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: 1\n\n');
      }
    });
    const g = compat(`${u.origin}/v1`);
    const ac = new AbortController();
    const r = await g.fetch(`${u.origin}/v1/chat/completions`, post(undefined, { signal: ac.signal }));
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    ac.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await vi.waitFor(() => expect(u.closed).toHaveLength(1));

    const hang = await upstream(() => {});
    const g2 = compat(`${hang.origin}/v1`);
    const ac2 = new AbortController();
    const p = g2.fetch(`${hang.origin}/v1/chat/completions`, post(undefined, { signal: ac2.signal }));
    await vi.waitFor(() => expect(hang.seen).toHaveLength(1));
    ac2.abort();
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('AbortError');
    await vi.waitFor(() => expect(hang.closed).toHaveLength(1));

    // An already-aborted signal opens no connection.
    const g3 = compat(`${hang.origin}/v1`);
    await expect(
      g3.fetch(`${hang.origin}/v1/chat/completions`, post(undefined, { signal: AbortSignal.abort() })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(hang.seen).toHaveLength(1);
  });

  it('captured stdout and stderr hold no key, header or body', async () => {
    const out: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
    }
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      out.push(String(c));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      out.push(String(c));
      return true;
    });
    try {
      const u = await upstream((_s, res) => {
        res.writeHead(500, { 'x-upstream': 'UPSTREAM-HEADER' });
        res.end('UPSTREAM-BODY-SECRET');
      });
      const g = compat(`${u.origin}/v1`);
      const r = await g.fetch(`${u.origin}/v1/chat/completions`, post());
      expect(r.status).toBe(500);
      await r.text();
      await refused(g.fetch(`${u.origin}/v2/chat/completions`, post()));
      await refused(compat(`${u.origin}/v1`, { headerTimeoutMs: 1 }).fetch(`http://127.0.0.1:1/v1/chat/completions`, post()));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(out.join('\n')).not.toMatch(/SECRET|PROMPT-BODY|UPSTREAM-HEADER|authorization/i);
  });
});
