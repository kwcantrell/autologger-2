// Auth routes — ported from src/autologger/web/routers/auth.py.

import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  createLoginSession,
  newOauthState,
  normalizeOauthStateParam,
  putOauthState,
  revokeLoginSession,
  takeOauthState,
} from '../auth/identity';
import {
  cookieSecureForRequest,
  googleClientId,
  googleClientSecret,
  newUserAllTeamsEnabled,
  oauthConfigured,
  publicBaseUrl,
  sessionCookieName,
  sessionTtlDays,
} from '../env';
import { DEFAULT_STUDIO_ID, SETTING_ACTIVE_SHOW, SETTING_ACTIVE_STUDIO } from '../studio';
import type { AppEnv } from '../types';

export const authRouter = new Hono<AppEnv>();

// Log-sanitization for request/provider-derived values written to
// console.warn on callback failure branches (design D4). A response body is
// auto-escaped JSON, but a terminal log line is a new injection sink, so any
// value derived from the request or from Google's responses is sanitized
// before logging: strip C0 controls (U+0000-U+001F), U+007F (DEL), C1
// controls (U+0080-U+009F -- covers 8-bit CSI, which C0-only stripping
// misses), line/paragraph separators (U+2028/U+2029), and bidi overrides
// (U+202A-U+202E, U+2066-U+2069); cap at 256 characters. Forbidden code
// points are removed outright -- never re-encoded as a reversible escape
// (e.g. `\u`-style), which would just re-expand to live control bytes
// downstream.
const LOG_SANITIZE_MAX_LEN = 256;
const FORBIDDEN_LOG_CHARS =
  /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function sanitizeForLog(value: unknown): string {
  return String(value ?? '').replace(FORBIDDEN_LOG_CHARS, '').slice(0, LOG_SANITIZE_MAX_LEN);
}

authRouter.get('/auth/google/start', async (c) => {
  if (!oauthConfigured(c.env.config)) {
    return c.json(
      {
        detail:
          'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and ' +
          'PUBLIC_BASE_URL (e.g. http://127.0.0.1:8787).',
      },
      503,
    );
  }
  const state = newOauthState();
  await putOauthState(c.env.ports.kv, state);
  const uri = c.env.ports.identity.authorizationUrl({
    clientId: googleClientId(c.env.config),
    state,
    redirectUri: `${publicBaseUrl(c.env.config)}/auth/google/callback`,
  });
  return c.redirect(uri, 302);
});

// Callback failure classes redirect 302 -> /?login_error=<code> instead of
// the former JSON 400/503 bodies (specs/api-contract-freeze/spec.md). The
// former `detail` strings (including operator guidance such as the
// PUBLIC_BASE_URL mismatch hint) move to console.warn, with request/
// provider-derived values sanitized first (design D4). This is a boundary
// rule, not a blanket conversion: only these explicit branch returns and the
// two existing try/catches (token exchange, id_token verification) are
// reclassified — any other throw (KV, catalog, other infrastructure) keeps
// propagating to the app's ordinary 500 handler (see app.ts `onError`).
authRouter.get('/auth/google/callback', async (c) => {
  const error = c.req.query('error') ?? '';
  if (error) {
    console.warn('OAuth callback: provider returned an error', sanitizeForLog(error));
    return c.redirect('/?login_error=provider_error', 302);
  }
  if (!oauthConfigured(c.env.config)) {
    console.warn('OAuth callback: Google OAuth is not configured.');
    return c.redirect('/?login_error=oauth_not_configured', 302);
  }

  const code = (c.req.query('code') ?? '').trim();
  const state = normalizeOauthStateParam(c.req.query('state') ?? '');
  if (!code || !state) {
    const missing = [
      ['code', code],
      ['state', state],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n)
      .join(', ');
    console.warn(
      `OAuth callback: missing OAuth query parameters: ${sanitizeForLog(missing)}. Start ` +
        'sign-in from this app (/auth/google/start), complete Google’s screen, and let Google ' +
        'redirect back here — do not open /auth/google/callback manually.',
    );
    return c.redirect('/?login_error=missing_params', 302);
  }

  if (!(await takeOauthState(c.env.ports.kv, state))) {
    console.warn(
      'OAuth callback: invalid or expired OAuth state',
      sanitizeForLog(state),
      '— start again from Sign in with Google on this site, complete Google within 30 minutes, ' +
        'and avoid the browser Back button after Google. If this persists, confirm ' +
        'PUBLIC_BASE_URL matches the URL you use in the browser and in Google Cloud redirect URIs.',
    );
    return c.redirect('/?login_error=state_invalid', 302);
  }

  const redirectUri = `${publicBaseUrl(c.env.config)}/auth/google/callback`;
  let tokens: Record<string, unknown>;
  try {
    tokens = await c.env.ports.identity.exchangeCode({
      code,
      redirectUri,
      clientId: googleClientId(c.env.config),
      clientSecret: googleClientSecret(c.env.config),
    });
  } catch (e) {
    console.warn('OAuth callback: token exchange failed', sanitizeForLog((e as Error).message));
    return c.redirect('/?login_error=exchange_failed', 302);
  }

  const idTok = tokens.id_token;
  if (!idTok) {
    console.warn('OAuth callback: token response is missing id_token.');
    return c.redirect('/?login_error=token_invalid', 302);
  }
  let claims: Record<string, unknown>;
  try {
    claims = (await c.env.ports.identity.verifyIdToken(
      String(idTok),
      googleClientId(c.env.config),
    )) as Record<string, unknown>;
  } catch (e) {
    // A failed JWKS fetch also surfaces here as a verifyIdToken throw; this
    // log line is what tells the operator it was infrastructure, not the
    // token itself.
    console.warn('OAuth callback: id_token invalid', sanitizeForLog((e as Error).message));
    return c.redirect('/?login_error=token_invalid', 302);
  }

  const googleSub = String(claims.sub ?? '');
  if (!googleSub) {
    console.warn('OAuth callback: id_token is missing the subject claim.');
    return c.redirect('/?login_error=token_invalid', 302);
  }
  const email = String(claims.email ?? '').trim();
  const gn = String(claims.given_name ?? '').trim();
  const fn = String(claims.family_name ?? '').trim();
  const pic = String(claims.picture ?? '').trim();

  const catalog = c.get('catalog');
  const existing = catalog.auth.authGetUserByGoogleSub(googleSub);
  let uid: string;
  if (existing) {
    uid = String(existing.id);
    catalog.auth.authUpdateUserProfile(uid, {
      email,
      givenName: gn,
      familyName: fn,
      pictureUrl: pic,
    });
  } else {
    uid = catalog.auth.authCreateUserGoogle({
      googleSub,
      email: email || `${googleSub}@users.noreply.invalid`,
      givenName: gn,
      familyName: fn,
      pictureUrl: pic,
    });
    catalog.auth.authSeedPrefsFromGlobals(
      uid,
      (catalog.studios.getSetting(SETTING_ACTIVE_STUDIO)) || DEFAULT_STUDIO_ID,
      (catalog.studios.getSetting(SETTING_ACTIVE_SHOW)) || '',
    );
    if (newUserAllTeamsEnabled(c.env.config)) {
      catalog.auth.authAddMemberships(
        uid,
        catalog.studios.listStudiosBrief().map((s) => s.id),
      );
    }
  }

  const ttlDays = sessionTtlDays(c.env.config);
  const rawSess = await createLoginSession(c.env.ports.kv, uid, ttlDays);
  setCookie(c, sessionCookieName(c.env.config), rawSess, {
    httpOnly: true,
    maxAge: Math.floor(ttlDays * 86400),
    sameSite: 'Lax',
    secure: cookieSecureForRequest(c.env.config, c.req.raw),
    path: '/',
  });
  return c.redirect('/', 302);
});

async function logout(c: Context<AppEnv>): Promise<Response> {
  const cookie = getCookie(c, sessionCookieName(c.env.config));
  if (cookie) await revokeLoginSession(c.env.ports.kv, cookie);
  deleteCookie(c, sessionCookieName(c.env.config), { path: '/' });
  return c.redirect('/', 302);
}

authRouter.get('/auth/logout', logout);
authRouter.post('/auth/logout', logout);
