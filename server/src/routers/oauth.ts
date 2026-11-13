// The MCP OAuth server's discovery and registration routes (ADR 0035 decision 5; design
// docs/design/custom-session-dashboards.md sections 4.2 and 4.3; mcp-authorization;
// api-contract-freeze "MCP OAuth discovery and registration routes").
//
// Every route here exists only while `CUSTOM_DASHBOARDS_ENABLED` is on. The flag is read per
// request, and with it off each handler hands the request on (`next()`), so it gets exactly the
// answer it gets with no route mounted: a GET falls through to the frontend bridge, and a POST to
// Hono's 404. No header is added with the flag off.
//
// None of these routes reads a cookie or a Bearer, and none writes anything but the registered
// client and the rate window. The authorize, token and revoke endpoints are J3's.

import type { Context, Handler } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import {
  MCP_GRANT_TYPES,
  MCP_MAX_CLIENTS,
  MCP_REGISTRATION_MAX_BODY_BYTES,
  MCP_REGISTRATION_WINDOW_MS,
  MCP_REGISTRATIONS_PER_WINDOW,
  newMcpClientId,
  parseClientMetadata,
} from '../auth/mcpClientRegistration';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  rateLimitSource,
} from '../auth/mcpOAuthMetadata';
import { customDashboardsEnabled } from '../env';
import { effectiveClientIp } from '../middleware/ipAllowlist';

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

/** The body as JSON, or undefined when it is over the size cap or not JSON. */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MCP_REGISTRATION_MAX_BODY_BYTES) return undefined;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MCP_REGISTRATION_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
