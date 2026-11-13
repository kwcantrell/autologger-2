// MCP OAuth token, PKCE, consent CSRF and grace-window seal crypto (custom dashboards J3; design
// sections 4.4 and 4.5; section 13.3 item 14 (c)).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  consentCsrf,
  consentCsrfValid,
  hashMcpSecret,
  MCP_REQUEST_ID,
  mintMcpTokens,
  newMcpCode,
  newMcpRequestId,
  openSuccessor,
  PKCE_VALUE,
  pkceS256Matches,
  sealSuccessor,
} from './mcpTokens';

const SECRET = 'k'.repeat(40);
const SPENT = 'alr_spentRefreshTokenValue0123456789abcdefghijk';
const SUCCESSOR = {
  access_token: 'alm_successorAccess0123456789abcdefghijklmnopqrstu',
  refresh_token: 'alr_successorRefresh0123456789abcdefghijklmnopqrst',
  access_expires_at: 1_800_000_000_000,
};
const ROW = { tokenHash: hashMcpSecret(SPENT), grantId: 'alg_grant1' };

describe('token formats', () => {
  it('mints alm_/alr_ tokens of 32 random bytes with their sha256 hex', () => {
    const t = mintMcpTokens();
    expect(t.accessToken).toMatch(/^alm_[A-Za-z0-9_-]{43}$/);
    expect(t.refreshToken).toMatch(/^alr_[A-Za-z0-9_-]{43}$/);
    expect(t.accessHash).toBe(createHash('sha256').update(t.accessToken).digest('hex'));
    expect(t.refreshHash).toBe(createHash('sha256').update(t.refreshToken).digest('hex'));
    expect(mintMcpTokens().accessToken).not.toBe(t.accessToken);
  });

  it('codes are 32 bytes and request ids 128 bits, in base64url', () => {
    expect(newMcpCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(MCP_REQUEST_ID.test(newMcpRequestId())).toBe(true);
  });
});

describe('PKCE S256', () => {
  it('matches BASE64URL(SHA256(verifier)) and nothing else', () => {
    // RFC 7636 appendix B.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(pkceS256Matches(verifier, challenge)).toBe(true);
    expect(pkceS256Matches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceS256Matches(verifier, verifier)).toBe(false);
    expect(PKCE_VALUE.test(verifier)).toBe(true);
    expect(PKCE_VALUE.test('a'.repeat(42))).toBe(false);
    expect(PKCE_VALUE.test('a'.repeat(129))).toBe(false);
    expect(PKCE_VALUE.test(`${'a'.repeat(42)}+`)).toBe(false);
  });
});

describe('consent CSRF', () => {
  it('is bound to the secret, the request and the session cookie', () => {
    const csrf = consentCsrf(SECRET, 'req1', 'cookie1');
    expect(consentCsrfValid(SECRET, 'req1', 'cookie1', csrf)).toBe(true);
    expect(consentCsrfValid(SECRET, 'req2', 'cookie1', csrf)).toBe(false);
    expect(consentCsrfValid(SECRET, 'req1', 'cookie2', csrf)).toBe(false);
    expect(consentCsrfValid(`${SECRET}x`, 'req1', 'cookie1', csrf)).toBe(false);
    expect(consentCsrfValid(SECRET, 'req1', 'cookie1', '')).toBe(false);
    expect(csrf).not.toContain('cookie1');
  });
});

describe('the sealed successor', () => {
  it('opens with the spent token, the secret and the same row', () => {
    const sealed = sealSuccessor(SPENT, SECRET, SUCCESSOR, ROW);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(openSuccessor(SPENT, SECRET, sealed, ROW)).toEqual(SUCCESSOR);
  });

  it('uses a fresh nonce per seal', () => {
    expect(sealSuccessor(SPENT, SECRET, SUCCESSOR, ROW)).not.toBe(
      sealSuccessor(SPENT, SECRET, SUCCESSOR, ROW),
    );
  });

  it('does not open for another row: token hash or grant id (the AAD)', () => {
    const sealed = sealSuccessor(SPENT, SECRET, SUCCESSOR, ROW);
    expect(openSuccessor(SPENT, SECRET, sealed, { ...ROW, tokenHash: 'f'.repeat(64) })).toBeNull();
    expect(openSuccessor(SPENT, SECRET, sealed, { ...ROW, grantId: 'alg_other' })).toBeNull();
  });

  it('does not open under a different MCP_SIGNING_SECRET (the HKDF salt)', () => {
    const sealed = sealSuccessor(SPENT, SECRET, SUCCESSOR, ROW);
    expect(openSuccessor(SPENT, `${SECRET}-rotated`, sealed, ROW)).toBeNull();
  });

  it('does not open with only the spent token, or with another token', () => {
    const sealed = sealSuccessor(SPENT, SECRET, SUCCESSOR, ROW);
    // A database dump plus the spent token, without the server's secret.
    expect(openSuccessor(SPENT, '', sealed, ROW)).toBeNull();
    expect(openSuccessor(`${SPENT}x`, SECRET, sealed, ROW)).toBeNull();
  });

  it('refuses a tampered or malformed seal', () => {
    const sealed = sealSuccessor(SPENT, SECRET, SUCCESSOR, ROW);
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith('A') ? 'B' : 'A'}${sealed.slice(-1)}`;
    expect(openSuccessor(SPENT, SECRET, flipped, ROW)).toBeNull();
    for (const bad of ['', 'v1.', 'v2.abcd', 'v1.!!!!', sealed.slice(3)]) {
      expect(openSuccessor(SPENT, SECRET, bad, ROW), bad).toBeNull();
    }
  });

  it('contains neither raw token in any common encoding', () => {
    const sealed = sealSuccessor(SPENT, SECRET, SUCCESSOR, ROW);
    for (const raw of [SUCCESSOR.access_token, SUCCESSOR.refresh_token, SPENT]) {
      expect(sealed).not.toContain(raw);
      expect(sealed).not.toContain(raw.slice(4));
      expect(sealed).not.toContain(Buffer.from(raw).toString('base64url'));
      expect(sealed).not.toContain(Buffer.from(raw).toString('base64'));
    }
  });
});
