// Outbound requests to user-chosen provider hosts (byo-ai-providers design D5; provider-credentials
// "LLM base URLs are restricted in production mode", "The connection test reports without
// leaking"). In production mode every address in the blocked ranges is refused, in IPv4, IPv6,
// IPv4-mapped and NAT64 forms; the connection goes to the vetted address; redirects are never
// followed; the whole request, name resolution included, is bounded by the caller's signal; and a
// failure is a fixed classification, never the underlying error or its message.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBlockedAddress,
  normalizeBaseUrl,
  normalizeOrigin,
  OutboundFailure,
  providerRequest,
} from './providerOutbound';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

const lookupTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('isBlockedAddress (design D5)', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::10.0.0.1',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('normalizeOrigin and normalizeBaseUrl', () => {
  it('lowercases the host, drops the default port and a trailing slash', () => {
    expect(normalizeOrigin('https://API.Example.com:443/v1/')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://API.Example.com:443/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeOrigin('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com');
  });
});

describe('providerRequest (design D5)', () => {
  it('in production mode refuses a blocked address without connecting, as unreachable', async () => {
    let hits = 0;
    const port = await serve((_q, res) => {
      hits++;
      res.end('{}');
    });
    for (const addresses of [['127.0.0.1'], ['8.8.8.8', '10.0.0.1'], ['::ffff:127.0.0.1']]) {
      const err = await providerRequest({
        url: `http://models.example:${port}/v1/models`,
        headers: {},
        production: true,
        signal: AbortSignal.timeout(5_000),
        lookup: lookupTo(...addresses),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OutboundFailure);
      expect((err as OutboundFailure).kind).toBe('unreachable');
    }
    expect(hits).toBe(0);
  });

  it('connects to the vetted address while keeping the original Host header', async () => {
    let host = '';
    const port = await serve((q, res) => {
      host = String(q.headers.host);
      res.end('{"data":[]}');
    });
    const r = await providerRequest({
      url: `http://models.example:${port}/v1/models`,
      headers: { authorization: 'Bearer k' },
      production: false,
      signal: AbortSignal.timeout(5_000),
      lookup: lookupTo('127.0.0.1'),
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"data":[]}');
    expect(host).toBe(`models.example:${port}`);
  });

  it('does not follow a redirect', async () => {
    let followed = false;
    const target = await serve((_q, res) => {
      followed = true;
      res.end('{}');
    });
    const port = await serve((_q, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target}/` });
      res.end();
    });
    const r = await providerRequest({
      url: `http://127.0.0.1:${port}/v1/models`,
      headers: {},
      production: false,
      signal: AbortSignal.timeout(5_000),
    });
    expect(r.status).toBe(302);
    expect(followed).toBe(false);
  });

  it('a slow name lookup counts toward the timeout', async () => {
    const started = Date.now();
    const err = await providerRequest({
      url: 'http://slow.example/v1/models',
      headers: {},
      production: false,
      signal: AbortSignal.timeout(200),
      lookup: () => new Promise(() => {}),
    }).catch((e: unknown) => e);
    expect((err as OutboundFailure).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a slow answer is a timeout', async () => {
    const port = await serve(() => {
      // never answers
    });
    const err = await providerRequest({
      url: `http://127.0.0.1:${port}/v1/models`,
      headers: {},
      production: false,
      signal: AbortSignal.timeout(200),
    }).catch((e: unknown) => e);
    expect((err as OutboundFailure).kind).toBe('timeout');
  });

  it('a refused connection is unreachable', async () => {
    const port = await serve(() => {});
    await new Promise((r) => servers.pop()?.close(r));
    const err = await providerRequest({
      url: `http://127.0.0.1:${port}/v1/models`,
      headers: {},
      production: false,
      signal: AbortSignal.timeout(2_000),
    }).catch((e: unknown) => e);
    expect((err as OutboundFailure).kind).toBe('unreachable');
  });

  it('an error that would carry the key is classified, and neither it nor its message is logged or kept', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(
        (...a: unknown[]) => void logs.push(a.map(String).join(' ')),
      );
    }
    const port = await serve((_q, res) => res.end('{}'));
    const key = 'sk_secret_value_1234';
    const err = await providerRequest({
      url: `http://127.0.0.1:${port}/v1/models`,
      headers: { authorization: `Bearer ${key}\nX-Injected: 1` },
      production: false,
      signal: AbortSignal.timeout(2_000),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundFailure);
    expect((err as OutboundFailure).kind).toBe('unreachable');
    expect(String((err as Error).message)).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    expect(logs.join('\n')).not.toContain(key);
  });

  it('caps the body it reads at 1 MB', async () => {
    const port = await serve((_q, res) => {
      res.end('x'.repeat(2 * 1024 * 1024));
    });
    const r = await providerRequest({
      url: `http://127.0.0.1:${port}/v1/models`,
      headers: {},
      production: false,
      signal: AbortSignal.timeout(5_000),
    });
    expect(r.body.length).toBeLessThanOrEqual(1024 * 1024);
  });
});
