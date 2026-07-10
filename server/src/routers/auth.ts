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
  exchangeAuthorizationCode,
  googleAuthorizationUrl,
  verifyGoogleIdToken,
} from '../auth/oauth_google';
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

authRouter.get('/auth/google/start', async (c) => {
  if (!oauthConfigured(c.env)) {
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
  await putOauthState(c.env.AUTH, state);
  const uri = googleAuthorizationUrl({
    clientId: googleClientId(c.env),
    state,
    redirectUri: `${publicBaseUrl(c.env)}/auth/google/callback`,
  });
  return c.redirect(uri, 302);
});

authRouter.get('/auth/google/callback', async (c) => {
  const error = c.req.query('error') ?? '';
  if (error) return c.json({ detail: error }, 400);
  if (!oauthConfigured(c.env)) return c.json({ detail: 'Google OAuth is not configured.' }, 503);

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
    return c.json(
      {
        detail:
          `Missing OAuth query parameters: ${missing}. Start sign-in from this app ` +
          '(/auth/google/start), complete Google’s screen, and let Google redirect back here — ' +
          'do not open /auth/google/callback manually.',
      },
      400,
    );
  }

  if (!(await takeOauthState(c.env.AUTH, state))) {
    return c.json(
      {
        detail:
          'Invalid or expired OAuth state. Start again from Sign in with Google on this site, ' +
          'complete Google within 30 minutes, and avoid the browser Back button after Google. If ' +
          'this persists, confirm PUBLIC_BASE_URL matches the URL you use in the browser and in ' +
          'Google Cloud redirect URIs.',
      },
      400,
    );
  }

  const redirectUri = `${publicBaseUrl(c.env)}/auth/google/callback`;
  let tokens: Record<string, unknown>;
  try {
    tokens = await exchangeAuthorizationCode({
      code,
      redirectUri,
      clientId: googleClientId(c.env),
      clientSecret: googleClientSecret(c.env),
    });
  } catch (e) {
    return c.json({ detail: `Token exchange failed: ${(e as Error).message}` }, 400);
  }

  const idTok = tokens.id_token;
  if (!idTok) return c.json({ detail: 'Missing id_token.' }, 400);
  let claims: Record<string, unknown>;
  try {
    claims = (await verifyGoogleIdToken(String(idTok), googleClientId(c.env))) as Record<
      string,
      unknown
    >;
  } catch (e) {
    return c.json({ detail: `Invalid id_token: ${(e as Error).message}` }, 400);
  }

  const googleSub = String(claims.sub ?? '');
  if (!googleSub) return c.json({ detail: 'Missing subject.' }, 400);
  const email = String(claims.email ?? '').trim();
  const gn = String(claims.given_name ?? '').trim();
  const fn = String(claims.family_name ?? '').trim();
  const pic = String(claims.picture ?? '').trim();

  const catalog = c.get('catalog');
  const existing = await catalog.authGetUserByGoogleSub(googleSub);
  let uid: string;
  if (existing) {
    uid = String(existing.id);
    await catalog.authUpdateUserProfile(uid, {
      email,
      givenName: gn,
      familyName: fn,
      pictureUrl: pic,
    });
  } else {
    uid = await catalog.authCreateUserGoogle({
      googleSub,
      email: email || `${googleSub}@users.noreply.invalid`,
      givenName: gn,
      familyName: fn,
      pictureUrl: pic,
    });
    await catalog.authSeedPrefsFromGlobals(
      uid,
      (await catalog.getSetting(SETTING_ACTIVE_STUDIO)) || DEFAULT_STUDIO_ID,
      (await catalog.getSetting(SETTING_ACTIVE_SHOW)) || '',
    );
    if (newUserAllTeamsEnabled(c.env)) {
      await catalog.authAddMemberships(
        uid,
        catalog.listStudiosBrief().map((s) => s.id),
      );
    }
  }

  const ttlDays = sessionTtlDays(c.env);
  const rawSess = await createLoginSession(c.env.AUTH, uid, ttlDays);
  setCookie(c, sessionCookieName(c.env), rawSess, {
    httpOnly: true,
    maxAge: Math.floor(ttlDays * 86400),
    sameSite: 'Lax',
    secure: cookieSecureForRequest(c.env, c.req.raw),
    path: '/',
  });
  return c.redirect('/', 302);
});

async function logout(c: Context<AppEnv>): Promise<Response> {
  const cookie = getCookie(c, sessionCookieName(c.env));
  if (cookie) await revokeLoginSession(c.env.AUTH, cookie);
  deleteCookie(c, sessionCookieName(c.env), { path: '/' });
  return c.redirect('/', 302);
}

authRouter.get('/auth/logout', logout);
authRouter.post('/auth/logout', logout);
