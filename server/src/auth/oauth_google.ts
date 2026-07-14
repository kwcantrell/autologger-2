// Google OAuth — ported from src/autologger/web/oauth_google.py (httpx → fetch,
// google-auth ID-token verify → jose against Google's JWKS).

import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 10 * 60_000;

let jwksCache: { keys: ReturnType<typeof createLocalJWKSet>; fetchedAt: number } | null = null;

/** Fetch-and-cache Google's JWKS via global fetch — NOT jose's remote-JWKS
 * path, whose node:https transport broke both test mocking and the
 * single-outbound-seam property (see CLAUDE.md invariant). */
async function googleJwks(): Promise<ReturnType<typeof createLocalJWKSet>> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`Google JWKS fetch failed: ${res.status}`);
  const jwks = (await res.json()) as JSONWebKeySet;
  jwksCache = { keys: createLocalJWKSet(jwks), fetchedAt: Date.now() };
  return jwksCache.keys;
}

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

/** Exchange the authorization code for tokens (includes id_token). Throws on HTTP error. */
export async function exchangeAuthorizationCode(opts: {
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

/** Verify signature + audience + issuer; returns claims. Throws on failure. */
export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<JWTPayload> {
  const options = {
    audience: clientId,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  };
  let result;
  try {
    result = await jwtVerify(idToken, await googleJwks(), options);
  } catch (e) {
    if (e instanceof errors.JWKSNoMatchingKey) {
      jwksCache = null; // kid rotation: refetch once (mirrors createRemoteJWKSet semantics)
      result = await jwtVerify(idToken, await googleJwks(), options);
    } else {
      throw e;
    }
  }
  const { payload } = result;
  return payload;
}
