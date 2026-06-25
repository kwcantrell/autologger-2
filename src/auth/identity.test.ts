import { describe, expect, it } from 'vitest';
import {
  apiRequestRequiresLogin,
  newOauthState,
  normalizeOauthStateParam,
  requestHasValidAdminToken,
  requestHasValidApiToken,
  timingSafeEqual,
} from './identity';

const req = (auth?: string): Request =>
  new Request('http://x/', auth ? { headers: { Authorization: auth } } : undefined);

describe('identity pure helpers', () => {
  it('timingSafeEqual matches equal strings, rejects different length/content', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });

  it('admin/api token checks require a matching Bearer and a configured token', () => {
    expect(requestHasValidAdminToken(req('Bearer secret'), 'secret')).toBe(true);
    expect(requestHasValidAdminToken(req('Bearer nope'), 'secret')).toBe(false);
    expect(requestHasValidAdminToken(req(), 'secret')).toBe(false);
    expect(requestHasValidAdminToken(req('Bearer secret'), '')).toBe(false);
    expect(requestHasValidApiToken(req('Bearer k'), 'k')).toBe(true);
  });

  it('apiRequestRequiresLogin gates /api/* except GET /api/profile and /api/admin/*', () => {
    expect(apiRequestRequiresLogin('/api/sessions', 'GET')).toBe(true);
    expect(apiRequestRequiresLogin('/api/profile', 'GET')).toBe(false);
    expect(apiRequestRequiresLogin('/api/profile', 'POST')).toBe(true);
    expect(apiRequestRequiresLogin('/api/admin/users', 'GET')).toBe(false);
    expect(apiRequestRequiresLogin('/', 'GET')).toBe(false);
  });

  it('normalizeOauthStateParam trims + percent-decodes, tolerates bad input', () => {
    expect(normalizeOauthStateParam('  a%20b ')).toBe('a b');
    expect(normalizeOauthStateParam('%')).toBe('%');
    expect(normalizeOauthStateParam('')).toBe('');
  });

  it('newOauthState returns a non-empty url-safe token', () => {
    const s = newOauthState();
    expect(s.length).toBeGreaterThan(20);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
