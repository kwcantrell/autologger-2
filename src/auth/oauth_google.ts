// Google OAuth — ported from src/autologger/web/oauth_google.py (httpx → fetch,
// google-auth ID-token verify → jose against Google's JWKS).

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

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
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    audience: clientId,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  });
  return payload;
}
