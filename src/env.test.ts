import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import {
  adminMeta,
  adminTokenConfigured,
  cookieSecureForRequest,
  newUserAllTeamsEnabled,
  oauthConfigured,
  publicBaseUrl,
  requireLoginEnabled,
  sessionCookieName,
  sessionTtlDays,
} from './env';

const E = (o: Record<string, string | undefined>): Env => o as unknown as Env;

describe('env flag parsing', () => {
  it('requireLoginEnabled defaults true; false only for 0/false/no', () => {
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: '1' }))).toBe(true);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: 'TRUE' }))).toBe(true);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: '0' }))).toBe(false);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: 'false' }))).toBe(false);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: 'no' }))).toBe(false);
    expect(requireLoginEnabled(E({}))).toBe(true);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: '' }))).toBe(true);
  });

  it('newUserAllTeamsEnabled defaults off and is false for 0/false/no', () => {
    expect(newUserAllTeamsEnabled(E({}))).toBe(false);
    expect(newUserAllTeamsEnabled(E({ NEW_USER_ALL_TEAMS: 'no' }))).toBe(false);
    expect(newUserAllTeamsEnabled(E({ NEW_USER_ALL_TEAMS: '1' }))).toBe(true);
  });

  it('sessionCookieName falls back to default', () => {
    expect(sessionCookieName(E({}))).toBe('autologger_sid');
    expect(sessionCookieName(E({ SESSION_COOKIE: 'x' }))).toBe('x');
  });

  it('cookieSecureForRequest honors explicit flag, else derives from scheme', () => {
    expect(cookieSecureForRequest(E({ COOKIE_SECURE: 'yes' }), new Request('http://x'))).toBe(
      true,
    );
    expect(cookieSecureForRequest(E({ COOKIE_SECURE: 'no' }), new Request('https://x'))).toBe(
      false,
    );
    expect(cookieSecureForRequest(E({}), new Request('https://x'))).toBe(true);
    expect(cookieSecureForRequest(E({}), new Request('http://x'))).toBe(false);
  });

  it('cookieSecureForRequest trusts X-Forwarded-Proto only under TRUST_PROXY', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-proto': 'https' } });
    expect(cookieSecureForRequest(E({ TRUST_PROXY: '1' }), req)).toBe(true);
    expect(cookieSecureForRequest(E({}), req)).toBe(false);
  });

  it('sessionTtlDays — current behavior: finite passes through (incl. non-positive)', () => {
    expect(sessionTtlDays(E({}))).toBe(14);
    expect(sessionTtlDays(E({ SESSION_DAYS: '30' }))).toBe(30);
    expect(sessionTtlDays(E({ SESSION_DAYS: '0' }))).toBe(0); // quirk: not clamped
    expect(sessionTtlDays(E({ SESSION_DAYS: 'abc' }))).toBe(14);
  });

  it('oauthConfigured requires id + secret + base url', () => {
    expect(oauthConfigured(E({}))).toBe(false);
    expect(
      oauthConfigured(
        E({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', PUBLIC_BASE_URL: 'http://x' }),
      ),
    ).toBe(true);
  });

  it('publicBaseUrl strips trailing slashes; adminMeta reflects token presence', () => {
    expect(publicBaseUrl(E({ PUBLIC_BASE_URL: 'http://x/' }))).toBe('http://x');
    expect(adminTokenConfigured(E({ ADMIN_TOKEN: 't' }))).toBe(true);
    expect(adminMeta(E({ ADMIN_TOKEN: 't' }))).toEqual({
      restart_supported: false,
      restart_needs_token: true,
    });
  });
});
