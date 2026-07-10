import { app, env } from './harness';
import { describe, expect, it } from 'vitest';

describe('harness smoke', () => {
  it('migrations applied: a migrated table is queryable', async () => {
    const r = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM studio_definitions',
    ).first<{ n: number }>();
    expect(typeof r?.n).toBe('number');
  });

  it('the Hono app responds through app.request with real bindings', async () => {
    const res = await app.request('/api/profile', { method: 'GET' }, env);
    expect([200, 401, 500]).toContain(res.status);
  });
});
