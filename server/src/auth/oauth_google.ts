// Google OAuth — ported from src/autologger/web/oauth_google.py (httpx → fetch,
// google-auth ID-token verify → jose against Google's JWKS). Exposed as the
// IdentityVerifier port: the JWKS cache is instance state (no module-level
// singleton) and its TTL reads the injected Clock.

import type { Clock, IdentityVerifier as IdentityVerifierPort } from '@autologger/ports';
import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 10 * 60_000;

export function googleAuthorizationUrl(opts: {
  clientId: string;
  state: string;
  redirectUri: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: opts.state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

export class GoogleIdentityVerifier implements IdentityVerifierPort {
  /** JWKS cache — instance state, TTL from the injected Clock. */
  private jwksCache: { keys: ReturnType<typeof createLocalJWKSet>; fetchedAt: number } | null =
    null;

  // No default: every call site (the composition root, tests) passes a Clock
  // explicitly. A default here would need `systemClock`, which lives in
  // `server/src/node/` — importing it would give `auth/` an edge back into
  // `node/`, recreating the very `auth ⇄ node` cycle this change breaks
  // (package-split-foundation design D3).
  constructor(private clock: Clock) {}

  /** Fetch-and-cache Google's JWKS via global fetch — NOT jose's remote-JWKS
   * path, whose node:https transport broke both test mocking and the
   * single-outbound-seam property (see CLAUDE.md invariant). */
  private async googleJwks(): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.jwksCache && this.clock.now() - this.jwksCache.fetchedAt < JWKS_TTL_MS) {
      return this.jwksCache.keys;
    }
    const res = await fetch(GOOGLE_JWKS_URL);
    if (!res.ok) throw new Error(`Google JWKS fetch failed: ${res.status}`);
    const jwks = (await res.json()) as JSONWebKeySet;
    this.jwksCache = { keys: createLocalJWKSet(jwks), fetchedAt: this.clock.now() };
    return this.jwksCache.keys;
  }

  authorizationUrl(opts: { clientId: string; state: string; redirectUri: string }): string {
    return googleAuthorizationUrl(opts);
  }

  async exchangeCode(opts: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Token exchange failed: ${r.status} ${text}`);
    }
    return (await r.json()) as Record<string, unknown>;
  }

  async verifyIdToken(idToken: string, clientId: string): Promise<JWTPayload> {
    const options = {
      audience: clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    };
    let result: Awaited<ReturnType<typeof jwtVerify>>;
    try {
      result = await jwtVerify(idToken, await this.googleJwks(), options);
    } catch (e) {
      if (e instanceof errors.JWKSNoMatchingKey) {
        this.jwksCache = null; // kid rotation: refetch once (mirrors createRemoteJWKSet semantics)
        result = await jwtVerify(idToken, await this.googleJwks(), options);
      } else {
        throw e;
      }
    }
    const { payload } = result;
    return payload;
  }
}
