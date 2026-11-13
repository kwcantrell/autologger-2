// `POST /mcp`: the public MCP endpoint (custom session dashboards J5; design sections 3.3 and 5.1;
// mcp-session-data; api-contract-freeze "MCP endpoint route").
//
// It exists only while `CUSTOM_DASHBOARDS_ENABLED` is on; with it off every method hands the
// request on (`next()`), so it gets exactly the answer an unmounted path gets. With it on:
// - `authContext` has already resolved the Bearer access token of a `POST` (or answered `401`);
// - any other method gets `405` with `Allow: POST`;
// - a request whose `Origin` is present and isn't `https://claude.ai` or one of
//   `MCP_ALLOWED_ORIGINS` gets `403`;
// - a body over 512 KiB gets `413` from the transport, before it is parsed;
// - the SDK's web-standard Streamable HTTP transport runs stateless (no `Mcp-Session-Id`), with a
//   fresh McpServer per request, answering JSON, so any process serves any request.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { buildReadToolServer, modelWindowFor } from '../dashboards/mcpReadTools';
import {
  type QueryCaller,
  QueryError,
  SESSION_NOT_FOUND,
  SHOW_NOT_FOUND,
} from '../dashboards/query';
import { customDashboardsEnabled, mcpAllowedOrigins } from '../env';
import { ApiError } from '../httpError';
import { getSessionHub, requireSession, requireShowAccess, requireUser } from './_helpers';

export const mcpRouter = new Hono<AppEnv>();

/** The `/mcp` body cap (design 5.1, section 13.3 item 8). */
export const MCP_MAX_BODY_BYTES = 512 * 1024;
/** The origin always accepted on `/mcp` (design 5.1). */
export const CLAUDE_ORIGIN = 'https://claude.ai';

/** Rethrows the masked route refusal as the fixed tool text. */
async function masked<T>(p: Promise<T>, text: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw new QueryError(text);
    throw err;
  }
}

mcpRouter.all('/mcp', async (c, next) => {
  if (!customDashboardsEnabled(c.env.config)) {
    await next();
    return;
  }
  if (c.req.method.toUpperCase() !== 'POST') {
    c.header('Allow', 'POST');
    return c.json({ detail: 'Method Not Allowed' }, 405);
  }
  const origin = c.req.header('origin');
  if (origin !== undefined) {
    const allowed = [CLAUDE_ORIGIN, ...(mcpAllowedOrigins(c.env.config) ?? [])];
    if (!allowed.includes(origin)) return c.json({ detail: 'Origin not allowed.' }, 403);
  }

  const user = requireUser(c);
  const q: QueryCaller = {
    userId: user.id,
    catalog: c.get('catalog'),
    requireSession: (sessionId) =>
      masked(requireSession(c, sessionId, { includeHidden: true }), SESSION_NOT_FOUND),
    requireShowAccess: (showId) => masked(requireShowAccess(c, showId), SHOW_NOT_FOUND),
    hub: (sessionId) => getSessionHub(c, sessionId),
  };
  const server = buildReadToolServer(
    q,
    modelWindowFor((bucket, ms) => c.env.ports.mcpOAuth.takeRateSlot(bucket, ms), user.id),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
});
