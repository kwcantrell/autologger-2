import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';

const envWith = (overrides: Record<string, string>): typeof env =>
  ({ ...env, ...overrides }) as unknown as typeof env;
const allow = envWith({ IP_ALLOWLIST: '10.0.0.0/24' });

describe('ipAllowlist middleware', () => {
  it('403s a client IP outside the allowlist', async () => {
    const res = await app.request(
      '/api/profile',
      { method: 'GET', headers: { 'CF-Connecting-IP': '8.8.8.8' } },
      allow,
    );
    expect(res.status).toBe(403);
  });

  it('allows a client IP inside the allowlist', async () => {
    const res = await app.request(
      '/api/profile',
      { method: 'GET', headers: { 'CF-Connecting-IP': '10.0.0.5' } },
      allow,
    );
    expect(res.status).toBe(200);
  });

  it('is disabled when IP_ALLOWLIST is empty', async () => {
    const res = await app.request(
      '/api/profile',
      { method: 'GET' },
      envWith({ IP_ALLOWLIST: '' }),
    );
    expect(res.status).toBe(200);
  });
});
