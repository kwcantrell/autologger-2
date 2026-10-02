// Auth routes — ported from src/autologger/web/routers/auth.py.

import { normalizeEmail } from '@autologger/domain';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../appEnv';
import { exchangeGoogleIdToken, IdentityUnavailableError } from '../auth/gotrue';
import {
  createLoginSession,
  newOauthState,
  normalizeOauthStateParam,
  putOauthState,
  revokeLoginSession,
  takeOauthState,
} from '../auth/identity';
import {
  bootstrapEmailMatch,
  bootstrapOwnerEmail,
  cookieSecureForRequest,
  googleClientId,
  googleClientSecret,
  oauthConfigured,
  publicBaseUrl,
  sessionCookieName,
  sessionTtlDays,
} from '../env';

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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point — this is the log-injection deny-list, not an accidental escape.
  /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function sanitizeForLog(value: unknown): string {
  return String(value ?? '')
    .replace(FORBIDDEN_LOG_CHARS, '')
    .slice(0, LOG_SANITIZE_MAX_LEN);
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
  // catalog-on-postgres D5: the catalog can't store NUL. The subject and email are identity keys
  // (a stripped email could match another address's invite), so NUL there refuses sign-in; the
  // display claims are stripped.
  if (googleSub.includes('\u0000') || email.includes('\u0000')) {
    console.warn('OAuth callback: id_token subject or email claim contains NUL.');
    return c.redirect('/?login_error=token_invalid', 302);
  }
  const noNul = (v: unknown) =>
    String(v ?? '')
      .replaceAll('\u0000', '')
      .trim();
  const gn = noNul(claims.given_name);
  const fn = noNul(claims.family_name);
  const pic = noNul(claims.picture);
  // JWTPayload carries an index signature, so unlisted claims (email_verified
  // is not one of jose's typed fields) flow through `claims` already -- no
  // change to verifyIdToken/oauth_google.ts is needed to surface it.
  const emailVerified = claims.email_verified === true;
  // gotrue-sign-in D3: only verified Google emails sign in, so Supabase Auth's email-based
  // account linking only ever sees verified addresses.
  if (!emailVerified || !email) {
    console.warn('OAuth callback: the Google account has no verified email.');
    return c.redirect('/?login_error=email_unverified', 302);
  }

  // gotrue-sign-in D1, D2: Supabase Auth verifies the same token again; its user id is the
  // account id. It runs before any catalog read, so a failure touches nothing.
  let authId: string;
  try {
    authId = (await exchangeGoogleIdToken(String(idTok), googleSub)).id;
  } catch (e) {
    if (!(e instanceof IdentityUnavailableError)) throw e;
    console.warn('OAuth callback: Supabase Auth exchange failed', e.reason);
    return c.redirect('/?login_error=identity_unavailable', 302);
  }
  const mismatch = (detail: string) => {
    console.warn(`OAuth callback: ${detail}; refusing sign-in (gotrue-sign-in D4)`);
    return c.redirect('/?login_error=identity_unavailable', 302);
  };

  const catalog = c.get('catalog');

  // Design D11: resolve the sub against ALL rows (not just enabled ones)
  // before the existing/new split. A disabled match must redirect here.
  let anyExisting = await catalog.auth.authGetUserByGoogleSubAny(googleSub);
  let uid = '';
  if (!anyExisting) {
    // The id may already hold this subject's account (a concurrent first sign-in just made it),
    // or another subject's: that is GoTrue linking two Google accounts, refused.
    const owner = await catalog.auth.authGetUserRowAny(authId);
    if (owner && String(owner.google_sub) !== googleSub) {
      return mismatch(`Supabase Auth id ${authId} already belongs to another Google account`);
    }
    anyExisting = owner;
  }
  if (!anyExisting) {
    // Design D2: the whole new-user branch -- creation, pref seeding, and
    // invite materialization + consumption -- runs inside one catalog
    // transaction, on stores bound to it (store transactions join it;
    // async-catalog-stores D3). The KV login-session write below stays outside.
    const created = await catalog.tx(async (cat) => {
      const newUid = await cat.auth.authCreateUserGoogle({
        id: authId,
        googleSub,
        email: email || `${googleSub}@users.noreply.invalid`,
        givenName: gn,
        familyName: fn,
        pictureUrl: pic,
      });
      // A concurrent first sign-in for this sub won (catalog-concurrency-hazards D5).
      if (newUid === null) return null;
      // No prefs seed (owner-bootstrap D10): a new user's prefs start empty, so their first team
      // (or onboarding) applies.
      // Materialize pending invites ONLY when the id_token asserts a
      // verified email (team-management delta, "Email invites") -- the
      // email claim becomes an authorization join key here, so an
      // unverified or absent claim must not match. `email` (the raw claim,
      // pre-fallback) is guarded non-empty so the synthesized
      // `<sub>@users.noreply.invalid` address can never be normalized into
      // a match.
      if (emailVerified && email) {
        const consumed = await cat.auth.authConsumeInvitesForEmail(normalizeEmail(email));
        for (const invite of consumed) {
          await cat.auth.authAddMembershipWithRole(newUid, String(invite.studio_id), 'member');
        }
      }
      return newUid;
    });
    if (created === null) {
      anyExisting = await catalog.auth.authGetUserByGoogleSubAny(googleSub);
      if (!anyExisting) return mismatch(`Supabase Auth id ${authId} was taken by another account`);
    } else uid = created;
  }
  if (anyExisting && String(anyExisting.id) !== authId) {
    return mismatch(`account ${String(anyExisting.id)} has Supabase Auth id ${authId}`);
  }
  if (anyExisting) {
    if (anyExisting.disabled_at_utc) {
      console.warn('OAuth callback: disabled account attempted sign-in', sanitizeForLog(googleSub));
      return c.redirect('/?login_error=account_disabled', 302);
    }
    uid = String(anyExisting.id);
    await catalog.auth.authUpdateUserProfile(uid, {
      email,
      givenName: gn,
      familyName: fn,
      pictureUrl: pic,
    });
  }

  // owner-bootstrap D7: the bootstrap owner claims every team with no owner, after either branch
  // (enabled, verified, identity matched) and before the session is issued. It fails open: a
  // failed claim is logged without the email and the next sign-in retries it.
  const match = bootstrapEmailMatch(email, bootstrapOwnerEmail(c.env.config));
  if (match === 'non-ascii') {
    console.warn('OAuth callback: bootstrap owner claim refused (non-ASCII email)');
  } else if (match) {
    try {
      const ids = await catalog.tx((cat) => cat.auth.authClaimOwnerlessStudios(uid));
      for (const id of ids) console.info(`OAuth callback: bootstrap owner claimed team ${id}`);
    } catch (e) {
      const code =
        (e as { code?: unknown } | null)?.code ?? (e instanceof Error ? e.name : 'error');
      console.warn(
        `OAuth callback: bootstrap owner claim failed (${sanitizeForLog(String(code))})`,
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
