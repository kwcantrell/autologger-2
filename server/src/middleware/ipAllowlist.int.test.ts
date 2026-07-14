import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import type { Bindings } from '../types';

/** Simulate the @hono/node-server env: bindings + a fake socket peer. */
const envFrom = (remoteAddress: string, overrides: Record<string, string> = {}): Bindings =>
  ({
    ...env,
    config: { ...env.config, ...overrides },
    incoming: { socket: { remoteAddress } },
  }) as unknown as Bindings;

describe('ip allowlist on Node', () => {
  it('is disabled when IP_ALLOWLIST is empty', async () => {
    const res = await app.request('/api/profile', {}, envFrom('203.0.113.7'));
    expect(res.status).toBe(200);
  });

  it('allows a socket address inside the CIDR and blocks one outside', async () => {
    const allow = { IP_ALLOWLIST: '203.0.113.0/24' };
    expect((await app.request('/api/profile', {}, envFrom('203.0.113.7', allow))).status).toBe(200);
    expect((await app.request('/api/profile', {}, envFrom('198.51.100.1', allow))).status).toBe(403);
  });

  it('matches the v6-mapped loopback the Node socket reports', async () => {
    const allow = { IP_ALLOWLIST: '127.0.0.1' };
    expect((await app.request('/api/profile', {}, envFrom('::ffff:127.0.0.1', allow))).status).toBe(
      200,
    );
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY is on (anti-spoof)', async () => {
    const allow = { IP_ALLOWLIST: '203.0.113.0/24' };
    const spoof = await app.request(
      '/api/profile',
      { headers: { 'x-forwarded-for': '203.0.113.7' } },
      envFrom('198.51.100.1', allow),
    );
    expect(spoof.status).toBe(403);
    const trusted = await app.request(
      '/api/profile',
      { headers: { 'x-forwarded-for': '203.0.113.7' } },
      envFrom('198.51.100.1', { ...allow, TRUST_PROXY: '1' }),
    );
    expect(trusted.status).toBe(200);
  });

  it('blocks when no address is derivable (no socket, no trusted header)', async () => {
    const res = await app.request(
      '/api/profile',
      {},
      {
        ...env,
        config: { ...env.config, IP_ALLOWLIST: '203.0.113.0/24' },
      } as unknown as Bindings,
    );
    expect(res.status).toBe(403);
  });

  it('bad allowlist config → 500 via onError', async () => {
    const res = await app.request('/api/profile', {}, envFrom('1.2.3.4', { IP_ALLOWLIST: 'garbage!!' }));
    expect(res.status).toBe(500);
  });
});
