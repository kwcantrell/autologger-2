// src/app.ts — Hono app wiring: middleware chain + router mounts + static
// serving. Ported from src/autologger/web/app.py. The caller supplies
// upgradeWebSocket (from @hono/node-ws in main.ts; a 426 stub in HTTP tests).

import { ValidationError } from '@autologger/domain';
import { InvalidRangeError } from '@autologger/storage';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Hono } from 'hono';
import { COMPRESSIBLE_CONTENT_TYPE_REGEX, compress } from 'hono/compress';
import type { UpgradeWebSocket } from 'hono/ws';
import { ZodError } from 'zod';
import type { AppEnv, Bindings } from './appEnv';
import { ApiError } from './httpError';
import { authContext } from './middleware/auth';
import { ipAllowlistMiddleware } from './middleware/ipAllowlist';
import { adminRouter } from './routers/admin';
import { aiRouter } from './routers/ai';
import { aiV2Router } from './routers/aiV2';
import { audioRouter } from './routers/audio';
import { authRouter } from './routers/auth';
import { companionRouter } from './routers/companion';
import { eventsRouter } from './routers/events';
import { exportsRouter } from './routers/exports';
import { logImportRouter } from './routers/logImport';
import { profileRouter } from './routers/profile';
import { sessionsRouter } from './routers/sessions';
import { mountSessionWs } from './routers/sessionWs';
import { showsRouter } from './routers/shows';
import { teamsRouter } from './routers/teams';
import { transcribeRouter } from './routers/transcribe';

/** The Next.js frontend bridge (nextjs-frontend-migration, design D1) — the
 * minimal seam app.ts's catch-all consumes: given the raw Node req/res pair
 * for a request that matched no mounted route, `handle` answers it in full
 * (by the time the returned promise settles, the response has been fully
 * written). Implemented by `server/src/node/nextFrontend.ts`; kept
 * structural here (not imported from that module) so `wireApp`'s HTTP-test
 * callers can inject a stub with no dependency on the real Next wrapper. */
export interface FrontendBridge {
  handle(
    incoming: import('node:http').IncomingMessage,
    outgoing: import('node:http').ServerResponse,
  ): Promise<void>;
}

export function wireApp(
  app: Hono<AppEnv>,
  upgradeWebSocket: UpgradeWebSocket,
  opts: { frontend?: FrontendBridge; bindings?: Bindings } = {},
): Hono<AppEnv> {
  // Bindings injection must happen HERE, not in a serve() fetch wrapper:
  // @hono/node-ws routes WebSocket upgrades through app.request() directly,
  // bypassing any wrapper. Mutate c.env IN PLACE — do not reassign the
  // reference. @hono/node-ws's injectWebSocket() stashes a CONNECTION_SYMBOL_KEY
  // onto the very `env` object it passed into app.request(), then compares that
  // same object's property after the handler runs to decide whether to complete
  // the upgrade. Replacing c.env with a new spread object (the previous
  // `c.env = { ...b, ...c.env }`) breaks that identity check silently: the
  // symbol lands on the new object, injectWebSocket() keeps checking the old
  // one, sees a mismatch, and terminates the raw socket — the WS client sees a
  // bare error/close(1006) with no application-level trace. Preserve identity;
  // only backfill keys the adapter (incoming/outgoing) hasn't already set.
  // Callers must pass a per-request env; we mutate it.
  if (opts.bindings) {
    const b = opts.bindings as unknown as Record<string, unknown>;
    app.use('*', async (c, next) => {
      const target = c.env as unknown as Record<string, unknown>;
      for (const key of Object.keys(b)) {
        if (!(key in target)) target[key] = b[key];
      }
      await next();
    });
  }

  // Starlette applies middleware in reverse registration order; Hono runs them
  // in registration order. So register ipAllowlist first to keep it outermost.
  app.use('*', ipAllowlistMiddleware);
  app.use('*', authContext);

  // Response compression for the API surface only. Scoped to `/api/*` so the
  // Next frontend bridge (which compresses its own responses) and `/auth/*`
  // are untouched. The filter is the middleware's default compressible-type
  // regex plus `application/x-ndjson` (export.jsonl), which the default regex
  // omits. Surfaces that must NOT be compressed need no explicit exclusion:
  // - Audio downloads: `audio/*` content-types never match the filter, so the
  //   hand-set `content-length`/`content-range` headers (range scrubbing)
  //   survive untouched.
  // - SSE (ai/chat, aiV2): `streamSSE` sets both `Transfer-Encoding: chunked`
  //   (the middleware skips any response with an existing Transfer-Encoding)
  //   and `text/event-stream` (excluded by the default regex's negative
  //   lookahead) — doubly excluded.
  // - WS upgrades: no compressible response body, and compress() never touches
  //   `c.env`, so the @hono/node-ws env-identity handshake above is unaffected.
  app.use(
    '/api/*',
    compress({
      contentTypeFilter: (type) =>
        COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type) || /^application\/x-ndjson\b/i.test(type),
    }),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ detail: err.detail }, err.status as 400);
    if (err instanceof ValidationError) return c.json({ detail: err.message }, 400);
    if (err instanceof ZodError) return c.json({ detail: err.issues }, 422);
    if (err instanceof InvalidRangeError) {
      return c.json({ detail: 'Requested range not satisfiable.' }, 416);
    }
    if (err instanceof SyntaxError) return c.json({ detail: 'Invalid JSON body.' }, 400);
    console.error('unhandled error', err);
    return c.json({ detail: 'Internal Server Error' }, 500);
  });

  mountSessionWs(app, upgradeWebSocket);
  app.route('/', authRouter);
  app.route('/', profileRouter);
  app.route('/', showsRouter);
  app.route('/', teamsRouter);
  app.route('/', sessionsRouter);
  app.route('/', logImportRouter);
  app.route('/', eventsRouter);
  app.route('/', audioRouter);
  app.route('/', companionRouter);
  app.route('/', transcribeRouter);
  app.route('/', aiRouter);
  app.route('/', aiV2Router);
  app.route('/', exportsRouter);
  app.route('/', adminRouter);

  // Frontend bridge (nextjs-frontend-migration, design D1 "Custom-server
  // shape"; spec "Next.js frontend served through the Hono bridge"): every
  // GET request that matched no API/auth route above falls through to Next
  // (shell HTML, `/_next/static/*`, `public/`-served files, the not-found
  // document — see design D6's closed path-family list). Mounted GET-only —
  // Hono answers HEAD through the GET handler, same as today — so non-GET
  // unmatched requests keep 404ing from Hono exactly as `serveStatic` used
  // to leave them (spec "Non-GET unmatched requests keep the server's
  // 404"). Runs after ipAllowlist/authContext above, so page/asset requests
  // keep exactly the middleware coverage they have today.
  app.get('*', async (c) => {
    // Trailing-slash paths (except `/` itself) are never bridged — owner
    // ruling 2026-08-13 (apply-time amendment, task 2.3 measurement): Next
    // 15.5.23 normalizes trailing slashes for catch-all route matching
    // regardless of `skipTrailingSlashRedirect`, so this is enforced here,
    // in front of the framework, to keep the pinned `404` (spec "Trailing
    // slash stays 404").
    const path = c.req.path;
    if (path !== '/' && path.endsWith('/')) return c.notFound();

    // `/api/*` and `/auth/*` never reach the frontend bridge (spec "API
    // routes never reach the frontend bridge") — mounted routes under those
    // prefixes are matched above and never fall through to this catch-all,
    // but an UNMATCHED path under either prefix (e.g. a typo'd endpoint)
    // would otherwise still hit this `app.get('*')` and get answered by
    // Next's not-found document instead of Hono's own 404. Guard explicitly
    // so the closed API/auth surface never leaks a frontend-authored
    // response, matching pre-change `serveStatic` behavior.
    if (
      path === '/api' ||
      path === '/auth' ||
      path.startsWith('/api/') ||
      path.startsWith('/auth/')
    ) {
      return c.notFound();
    }

    // Absent frontend (HTTP-test callers, or a deliberately API-only boot)
    // → Hono's own 404, same as an asset miss (spec "API-only fallback
    // mode").
    if (!opts.frontend) return c.notFound();

    // Absent `outgoing` (the @hono/node-ws upgrade replay, and plain
    // `app.request()` tests, construct envs with no writable raw response —
    // design D1 "Bridge guards") → Hono's own 404 rather than invoking the
    // frontend (spec "Bridge without a writable response object"). Checked
    // BEFORE calling handle(), never after.
    const { incoming, outgoing } = c.env;
    if (!incoming || !outgoing) return c.notFound();

    try {
      await opts.frontend.handle(incoming, outgoing);
    } catch (err) {
      // The frontend already owns writing this response. If it started
      // (headers sent) before rejecting, composing a second response via
      // Hono's onError would corrupt the connection — log and return the
      // sentinel instead. Only rethrow when nothing has been written yet,
      // so onError's normal 500 path still applies (design D1 "Bridge
      // guards" (c)).
      if (outgoing.headersSent) {
        console.error('frontend bridge: handle() rejected after headers were sent', err);
        return RESPONSE_ALREADY_SENT;
      }
      throw err;
    }
    return RESPONSE_ALREADY_SENT;
  });

  return app;
}
