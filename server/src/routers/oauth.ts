// The MCP OAuth server's discovery and registration routes (ADR 0035 decision 5; design
// docs/design/custom-session-dashboards.md sections 4.2 and 4.3; mcp-authorization;
// api-contract-freeze "MCP OAuth discovery and registration routes").
//
// Every route here exists only while `CUSTOM_DASHBOARDS_ENABLED` is on. The flag is read per
// request, and with it off each handler hands the request on (`next()`), so it gets exactly the
// answer it gets with no route mounted: a GET falls through to the frontend bridge, and a POST to
// Hono's 404. No header is added with the flag off.
//
// The discovery and registration routes (J2) read no cookie or Bearer. The authorize, consent,
// token and revoke routes (J3, design 4.4, 4.5 and 4.8) follow below them; only the authorize and
// consent routes read the session cookie, and none reads a Bearer.

import type { McpIssuedTokens } from '@autologger/ports';
import type { Context, Handler } from 'hono';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../appEnv';
import { newOauthState, putMcpOauthState } from '../auth/identity';
import {
  MCP_GRANT_TYPES,
  MCP_MAX_CLIENTS,
  MCP_REGISTRATION_MAX_BODY_BYTES,
  MCP_REGISTRATION_WINDOW_MS,
  MCP_REGISTRATIONS_PER_WINDOW,
  newMcpClientId,
  parseClientMetadata,
  redirectUriMatches,
} from '../auth/mcpClientRegistration';
import {
  authorizationServerMetadata,
  MCP_SCOPE,
  mcpIssuer,
  mcpResource,
  protectedResourceMetadata,
} from '../auth/mcpOAuthMetadata';
import { consentPage, errorPage, MCP_PAGE_HEADERS, returnPage } from '../auth/mcpOAuthPages';
import {
  consentCsrf,
  consentCsrfValid,
  hashMcpSecret,
  MCP_REQUEST_ID,
  mintMcpTokens,
  newMcpCode,
  newMcpGrantId,
  newMcpRequestId,
  openSuccessor,
  PKCE_VALUE,
  pkceS256Matches,
  sealSuccessor,
} from '../auth/mcpTokens';
import {
  customDashboardsEnabled,
  googleClientId,
  MCP_REFRESH_GRACE_DEFAULT,
  mcpRefreshGraceSeconds,
  mcpSigningSecret,
  oauthConfigured,
  publicBaseUrl,
  sessionCookieName,
} from '../env';
import { effectiveClientIp, rateLimitSource } from '../middleware/ipAllowlist';

export const oauthRouter = new Hono<AppEnv>();

export const MCP_CLIENT_CAP_DETAIL = 'Too many registered clients; try again later.';
export const rateLimitedDetail = (seconds: number) => `Rate limit exceeded; retry in ${seconds} s.`;

/** A handler that runs only with the flag on; with it off the request goes on as if unmatched. */
function flagGated(handler: (c: Context<AppEnv>) => Promise<Response> | Response): Handler<AppEnv> {
  return async (c, next) => {
    if (!customDashboardsEnabled(c.env.config)) {
      await next();
      return;
    }
    return handler(c);
  };
}

/** `/oauth/*` answers are never cached and send no referrer (design 4.2). */
function oauthHeaders(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
}

const prm = flagGated((c) => c.json(protectedResourceMetadata(c.env.config)));
oauthRouter.get('/.well-known/oauth-protected-resource', prm);
oauthRouter.get('/.well-known/oauth-protected-resource/mcp', prm);
oauthRouter.get(
  '/.well-known/oauth-authorization-server',
  flagGated((c) => c.json(authorizationServerMetadata(c.env.config))),
);

/** The body's bytes, or undefined when there is none or it is over `max` bytes. */
async function readCappedBody(c: Context<AppEnv>, max: number): Promise<Buffer | undefined> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > max) return undefined;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The body as JSON, or undefined when it is over the size cap or not JSON. */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  const body = await readCappedBody(c, MCP_REGISTRATION_MAX_BODY_BYTES);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

oauthRouter.post(
  '/oauth/register',
  flagGated(async (c) => {
    oauthHeaders(c);
    const store = c.env.ports.mcpOAuth;
    // Every attempt counts, valid or not, so the window bounds the work an address can cause.
    const source = rateLimitSource(effectiveClientIp(c));
    const slot = await store.takeRateSlot(`register:${source}`, MCP_REGISTRATION_WINDOW_MS);
    if (slot.count > MCP_REGISTRATIONS_PER_WINDOW) {
      const seconds = Math.max(1, Math.ceil(slot.retryAfterMs / 1000));
      c.header('Retry-After', String(seconds));
      return c.json({ detail: rateLimitedDetail(seconds) }, 429);
    }
    const body = await readJsonBody(c);
    const parsed =
      body === undefined
        ? ({
            ok: false,
            error: 'invalid_client_metadata',
            description: 'The body must be a JSON object of at most 64 KiB.',
          } as const)
        : parseClientMetadata(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, error_description: parsed.description }, 400);
    }
    const id = newMcpClientId();
    const result = await store.registerClient(
      {
        id,
        client_name: parsed.value.client_name,
        redirect_uris: parsed.value.redirect_uris,
        registered_from: source,
      },
      MCP_MAX_CLIENTS,
    );
    if (result.kind === 'cap-reached') return c.json({ detail: MCP_CLIENT_CAP_DETAIL }, 429);
    console.info(`mcp oauth: client registered ${id}`);
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(Date.parse(result.created_at_utc) / 1000),
        client_name: parsed.value.client_name,
        redirect_uris: parsed.value.redirect_uris,
        grant_types: [...MCP_GRANT_TYPES],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(parsed.value.application_type === undefined
          ? {}
          : { application_type: parsed.value.application_type }),
      },
      201,
    );
  }),
);

// ── Authorization, consent, token and revocation (J3; design 4.4, 4.5, 4.8) ─────────────────

/** A pending authorize request lives this long in KV (`mcpauthz:<id>`). */
export const MCP_AUTHZ_TTL_SECONDS = 600;
/** An authorization code lives this long in KV (`mcpcode:<sha256(code)>`). */
export const MCP_CODE_TTL_SECONDS = 60;
/** An exchanged code's marker lives this long (`mcpcodeused:<sha256(code)>` → grant id). */
export const MCP_CODE_USED_TTL_SECONDS = 600;
/** The longest `state` accepted (design 4.4). */
export const MCP_STATE_MAX = 512;
/** Token endpoint windows (design 4.5; section 13.3 item 9). */
export const MCP_TOKEN_WINDOW_MS = 60_000;
export const MCP_TOKEN_PER_CLIENT = 30;
export const MCP_TOKEN_PER_ADDRESS = 60;
/** The largest form body the consent, token and revoke routes read. */
export const MCP_FORM_MAX_BYTES = 16 * 1024;
/** Longer `client_id` values name no client (ours are 26 characters) and aren't counted. */
const MCP_CLIENT_ID_MAX = 128;

const AUTHZ_PREFIX = 'mcpauthz:';
const CODE_PREFIX = 'mcpcode:';
const CODE_USED_PREFIX = 'mcpcodeused:';

/** A validated authorize request, as stored under `mcpauthz:<id>`. */
interface PendingAuthorization {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  state: string;
}

/** An issued code, as stored under `mcpcode:<sha256(code)>`. */
interface IssuedCode {
  grant_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
}

const parseJson = <T>(raw: string | null): T | null => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/** `uri` with the parameters appended to its query, the URI itself kept byte for byte. */
function withParams(uri: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return `${uri}${uri.includes('?') ? '&' : '?'}${q}`;
}

/** The headers of an HTML page: `/oauth/*`'s plus the CSP and frame headers (design 4.2). */
function pageHeaders(c: Context<AppEnv>): void {
  oauthHeaders(c);
  for (const [k, v] of Object.entries(MCP_PAGE_HEADERS)) c.header(k, v);
}

async function htmlError(c: Context<AppEnv>, title: string, message: string): Promise<Response> {
  pageHeaders(c);
  return c.html(await errorPage(title, message), 400);
}

const START_AGAIN = 'Start connecting again from the app (for example, Claude).';

/** Shows the consent page for a stored request to the signed-in user. */
async function showConsent(
  c: Context<AppEnv>,
  requestId: string,
  pending: PendingAuthorization,
): Promise<Response> {
  const user = c.get('user');
  const cookie = getCookie(c, sessionCookieName(c.env.config)) ?? '';
  const client = await c.env.ports.mcpOAuth.getClient(pending.client_id);
  if (user === null || cookie === '' || client === null) {
    return htmlError(c, 'This request has expired', START_AGAIN);
  }
  pageHeaders(c);
  return c.html(
    await consentPage({
      email: user.email,
      clientName: client.client_name,
      redirectHost: new URL(pending.redirect_uri).host,
      requestId,
      csrf: consentCsrf(mcpSigningSecret(c.env.config), requestId, cookie),
    }),
    200,
  );
}

oauthRouter.get(
  '/oauth/authorize',
  flagGated(async (c) => {
    const query = c.req.queries();
    const one = (k: string): string | undefined => {
      const v = query[k];
      return v !== undefined && v.length === 1 ? v[0] : undefined;
    };
    // Step 1: the client and redirect URI. Until both are validated nothing redirects.
    const clientId = one('client_id');
    const redirectUri = one('redirect_uri');
    const client =
      clientId !== undefined && clientId.length <= MCP_CLIENT_ID_MAX
        ? await c.env.ports.mcpOAuth.getClient(clientId)
        : null;
    if (client === null) {
      return htmlError(
        c,
        'Unknown app',
        `The app's client_id is missing or unknown. ${START_AGAIN}`,
      );
    }
    if (
      redirectUri === undefined ||
      !client.redirect_uris.some((r) => redirectUriMatches(r, redirectUri))
    ) {
      return htmlError(
        c,
        'Invalid redirect',
        `The app's redirect_uri is missing or not registered. ${START_AGAIN}`,
      );
    }

    // Step 2: everything else; a failure goes back to the validated redirect URI.
    oauthHeaders(c);
    const issuer = mcpIssuer(c.env.config);
    const state = one('state');
    const stateOk = state !== undefined && state.length >= 1 && state.length <= MCP_STATE_MAX;
    const fail = (error: string) =>
      c.redirect(
        withParams(redirectUri, { error, ...(stateOk ? { state } : {}), iss: issuer }),
        302,
      );
    if (Object.values(query).some((v) => v.length > 1)) return fail('invalid_request');
    if (one('response_type') !== 'code') return fail('invalid_request');
    const challenge = one('code_challenge');
    if (challenge === undefined || !PKCE_VALUE.test(challenge)) return fail('invalid_request');
    if (one('code_challenge_method') !== 'S256') return fail('invalid_request');
    if (one('resource') !== mcpResource(c.env.config)) return fail('invalid_target');
    const scope = one('scope');
    if (scope !== undefined && scope !== MCP_SCOPE) return fail('invalid_scope');
    if (!stateOk) return fail('invalid_request');

    // Step 3: store the validated request.
    const requestId = newMcpRequestId();
    const pending: PendingAuthorization = {
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      resource: mcpResource(c.env.config),
      scope: MCP_SCOPE,
      state: state as string,
    };
    await c.env.ports.kv.put(`${AUTHZ_PREFIX}${requestId}`, JSON.stringify(pending), {
      expirationTtl: MCP_AUTHZ_TTL_SECONDS,
    });

    // Step 4: signed in, so consent now.
    if (c.get('user') !== null) return showConsent(c, requestId, pending);

    // Step 5: through the existing Google sign-in, which resumes this request on success.
    if (!oauthConfigured(c.env.config)) {
      return htmlError(c, 'Sign-in is not available', 'Google sign-in is not configured.');
    }
    const oauthState = newOauthState();
    await putMcpOauthState(c.env.ports.kv, oauthState, requestId);
    return c.redirect(
      c.env.ports.identity.authorizationUrl({
        clientId: googleClientId(c.env.config),
        state: oauthState,
        redirectUri: `${publicBaseUrl(c.env.config)}/auth/google/callback`,
      }),
      302,
    );
  }),
);

oauthRouter.get(
  '/oauth/authorize/resume',
  flagGated(async (c) => {
    const requestId = c.req.query('request') ?? '';
    const pending = MCP_REQUEST_ID.test(requestId)
      ? parseJson<PendingAuthorization>(await c.env.ports.kv.get(`${AUTHZ_PREFIX}${requestId}`))
      : null;
    if (pending === null || c.get('user') === null) {
      return htmlError(c, 'This request has expired', START_AGAIN);
    }
    return showConsent(c, requestId, pending);
  }),
);

/** A form-urlencoded body as its parameters, or null (wrong type, too big, or a repeated name). */
async function readForm(c: Context<AppEnv>): Promise<Map<string, string> | null> {
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  const body = await readCappedBody(c, MCP_FORM_MAX_BYTES);
  if (body === undefined) return null;
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(body.toString('utf8'))) {
    if (out.has(k)) return null;
    out.set(k, v);
  }
  return out;
}

oauthRouter.post(
  '/oauth/authorize',
  flagGated(async (c) => {
    const form = await readForm(c);
    const user = c.get('user');
    const cookie = getCookie(c, sessionCookieName(c.env.config)) ?? '';
    if (form === null || user === null || cookie === '') {
      return htmlError(c, 'This request has expired', `Sign in, then ${START_AGAIN.toLowerCase()}`);
    }
    const requestId = form.get('request') ?? '';
    const decision = form.get('decision');
    const csrf = form.get('csrf') ?? '';
    // The CSRF check comes before the take, so a forged post can't spend someone's request.
    if (
      !MCP_REQUEST_ID.test(requestId) ||
      (decision !== 'approve' && decision !== 'deny') ||
      !consentCsrfValid(mcpSigningSecret(c.env.config), requestId, cookie, csrf)
    ) {
      return htmlError(c, 'This request is not valid', START_AGAIN);
    }
    const pending = parseJson<PendingAuthorization>(
      await c.env.ports.kv.take(`${AUTHZ_PREFIX}${requestId}`),
    );
    if (pending === null) return htmlError(c, 'This request has expired', START_AGAIN);

    const issuer = mcpIssuer(c.env.config);
    const host = new URL(pending.redirect_uri).host;
    let location: string;
    if (decision === 'deny') {
      location = withParams(pending.redirect_uri, {
        error: 'access_denied',
        state: pending.state,
        iss: issuer,
      });
    } else {
      const grantId = newMcpGrantId();
      const grant = await c.env.ports.mcpOAuth.createGrant({
        id: grantId,
        userId: user.id,
        clientId: pending.client_id,
        scope: pending.scope,
        resource: pending.resource,
      });
      if (grant === null) return htmlError(c, 'This request has expired', START_AGAIN);
      const code = newMcpCode();
      const issued: IssuedCode = {
        grant_id: grantId,
        client_id: pending.client_id,
        redirect_uri: pending.redirect_uri,
        code_challenge: pending.code_challenge,
        resource: pending.resource,
        scope: pending.scope,
      };
      await c.env.ports.kv.put(`${CODE_PREFIX}${hashMcpSecret(code)}`, JSON.stringify(issued), {
        expirationTtl: MCP_CODE_TTL_SECONDS,
      });
      console.info(`mcp oauth: consent approved, grant ${grantId} client ${pending.client_id}`);
      location = withParams(pending.redirect_uri, { code, state: pending.state, iss: issuer });
    }
    pageHeaders(c);
    return c.html(await returnPage(location, host), 200);
  }),
);

type TokenError =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target';

const tokenError = (c: Context<AppEnv>, error: TokenError) => c.json({ error }, 400);

function rateLimited(c: Context<AppEnv>, retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  c.header('Retry-After', String(seconds));
  return c.json({ detail: rateLimitedDetail(seconds) }, 429);
}

/** The `200` token answer; `expires_in` counts down to the access token's (possibly capped)
 * expiry, so it is below 3600 near the grant's cap. */
function tokenAnswer(c: Context<AppEnv>, t: McpIssuedTokens): Response {
  const left = Math.floor((t.accessExpiresAtMs - c.env.ports.clock.now()) / 1000);
  return c.json(
    {
      access_token: t.accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(1, left),
      refresh_token: t.refreshToken,
      scope: t.scope,
    },
    200,
  );
}

async function authorizationCodeGrant(
  c: Context<AppEnv>,
  form: Map<string, string>,
  clientId: string,
): Promise<Response> {
  const store = c.env.ports.mcpOAuth;
  const code = form.get('code');
  const redirectUri = form.get('redirect_uri');
  const verifier = form.get('code_verifier');
  if (!code || !redirectUri || verifier === undefined || !PKCE_VALUE.test(verifier)) {
    return tokenError(c, 'invalid_request');
  }
  if ((await store.getClient(clientId)) === null) return tokenError(c, 'invalid_client');

  const codeHash = hashMcpSecret(code);
  const issued = parseJson<IssuedCode>(await c.env.ports.kv.take(`${CODE_PREFIX}${codeHash}`));
  if (issued === null) {
    // Already exchanged: a replay, so the grant its first use produced is revoked (OAuth 2.1
    // section 4.1.3).
    const used = await c.env.ports.kv.get(`${CODE_USED_PREFIX}${codeHash}`);
    if (used !== null && (await store.revokeGrant(used))) {
      console.warn(`mcp oauth: code reuse, grant ${used} revoked`);
    }
    return tokenError(c, 'invalid_grant');
  }
  if (
    issued.client_id !== clientId ||
    issued.redirect_uri !== redirectUri ||
    form.get('resource') !== mcpResource(c.env.config) ||
    issued.resource !== mcpResource(c.env.config) ||
    !pkceS256Matches(verifier, issued.code_challenge)
  ) {
    return tokenError(c, 'invalid_grant');
  }
  await c.env.ports.kv.put(`${CODE_USED_PREFIX}${codeHash}`, issued.grant_id, {
    expirationTtl: MCP_CODE_USED_TTL_SECONDS,
  });
  const tokens = await store.issueTokens(issued.grant_id, clientId, mintMcpTokens());
  if (tokens === null) return tokenError(c, 'invalid_grant');
  console.info(`mcp oauth: code exchanged, grant ${issued.grant_id}`);
  return tokenAnswer(c, tokens);
}

async function refreshTokenGrant(
  c: Context<AppEnv>,
  form: Map<string, string>,
  clientId: string,
): Promise<Response> {
  const raw = form.get('refresh_token');
  if (!raw) return tokenError(c, 'invalid_request');
  const scope = form.get('scope');
  if (scope !== undefined && scope !== MCP_SCOPE) return tokenError(c, 'invalid_scope');
  const resource = form.get('resource');
  if (resource !== undefined && resource !== mcpResource(c.env.config)) {
    return tokenError(c, 'invalid_target');
  }
  const secret = mcpSigningSecret(c.env.config);
  const result = await c.env.ports.mcpOAuth.refresh({
    tokenHash: hashMcpSecret(raw),
    clientId,
    // The boot guard has refused an invalid value with the flag on.
    graceSeconds: mcpRefreshGraceSeconds(c.env.config) ?? MCP_REFRESH_GRACE_DEFAULT,
    mint: mintMcpTokens,
    seal: (successor, binding) => sealSuccessor(raw, secret, successor, binding),
    open: (sealed, binding) => openSuccessor(raw, secret, sealed, binding),
  });
  switch (result.kind) {
    case 'rotated':
      return tokenAnswer(c, result.tokens);
    case 'grace':
      console.info(`mcp oauth: refresh reuse within grace, grant ${result.tokens.grantId}`);
      return tokenAnswer(c, result.tokens);
    case 'revoked':
      console.warn(`mcp oauth: refresh reuse, grant ${result.grantId} revoked`);
      return tokenError(c, 'invalid_grant');
    default:
      return tokenError(c, 'invalid_grant');
  }
}

oauthRouter.post(
  '/oauth/token',
  flagGated(async (c) => {
    oauthHeaders(c);
    const store = c.env.ports.mcpOAuth;
    // Every request counts against its source address, valid or not (IPv6 by /64).
    const source = rateLimitSource(effectiveClientIp(c));
    const bySource = await store.takeRateSlot(`token-addr:${source}`, MCP_TOKEN_WINDOW_MS);
    if (bySource.count > MCP_TOKEN_PER_ADDRESS) return rateLimited(c, bySource.retryAfterMs);
    const form = await readForm(c);
    if (form === null) return tokenError(c, 'invalid_request');
    const clientId = form.get('client_id');
    if (!clientId || clientId.length > MCP_CLIENT_ID_MAX) return tokenError(c, 'invalid_request');
    const byClient = await store.takeRateSlot(`token-client:${clientId}`, MCP_TOKEN_WINDOW_MS);
    if (byClient.count > MCP_TOKEN_PER_CLIENT) return rateLimited(c, byClient.retryAfterMs);
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') return authorizationCodeGrant(c, form, clientId);
    if (grantType === 'refresh_token') return refreshTokenGrant(c, form, clientId);
    return tokenError(c, grantType ? 'unsupported_grant_type' : 'invalid_request');
  }),
);

oauthRouter.post(
  '/oauth/revoke',
  flagGated(async (c) => {
    oauthHeaders(c);
    const form = await readForm(c);
    const token = form?.get('token');
    if (form === null || !token) return c.json({ error: 'invalid_request' }, 400);
    // RFC 7009 section 2.2: 200 whether or not anything was revoked. Only a token of the
    // requesting client's own grant is revoked, with the whole grant (design 4.8).
    const clientId = form.get('client_id');
    if (clientId) {
      const grantId = await c.env.ports.mcpOAuth.revokeByToken(hashMcpSecret(token), clientId);
      if (grantId !== null) console.info(`mcp oauth: grant ${grantId} revoked by its client`);
    }
    return c.body(null, 200);
  }),
);
