// src/app.ts — Hono app wiring: middleware chain + router mounts + static
// serving. Ported from src/autologger/web/app.py. The caller supplies
// upgradeWebSocket (from @hono/node-ws in main.ts; a 426 stub in HTTP tests).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { ZodError } from 'zod';
import { authContext } from './middleware/auth';
import { ipAllowlistMiddleware } from './middleware/ipAllowlist';
import { InvalidRangeError } from './node/blobStore';
import { ApiError } from './routers/_helpers';
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
import { ValidationError } from './studio';
import type { AppEnv, Bindings } from './types';

export function wireApp(
  app: Hono<AppEnv>,
  upgradeWebSocket: UpgradeWebSocket,
  opts: { publicDir?: string; bindings?: Bindings } = {},
): Hono<AppEnv> {
  const publicDir = opts.publicDir ?? './public';

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

  // Static hosting: explicit page routes (the SPA client-side router owns
  // rendering under `/`, `/sessions/:id`, and `/teams`; this block only
  // decides which HTML shell to serve) + a catch-all for hashed /assets/*
  // and /static/*.
  // publicDir is the web/ workspace's Vite build output, passed by main.ts
  // (tests pass a fixture dir).
  async function serveHtml(c: Context<AppEnv>, assetPath: string) {
    let html: string;
    try {
      html = await readFile(join(publicDir, assetPath), 'utf-8');
    } catch {
      return c.notFound();
    }
    return c.html(html);
  }

  app.get('/', (c) => serveHtml(c, 'src/pages/index/index.html'));
  // Session deep-link route (api-contract-freeze delta, session-deep-links
  // change): `:id` matches exactly one path segment, so `/sessions` (no id)
  // and `/sessions/a/b` (nested segments) fall through to the static
  // catch-all below and keep 404ing. Serves the shell unconditionally on
  // session existence/authorization — no existence oracle at the HTML layer.
  app.get('/sessions/:id', (c) => serveHtml(c, 'src/pages/index/index.html'));
  // Teams management route (api-contract-freeze delta, teams-self-serve
  // change; design D6 — one of the three sanctioned lockstep mirrors of the
  // router-known route table): unconditional on auth, no cookies — the
  // login gate renders client-side, same as `/` and `/sessions/:id`.
  app.get('/teams', (c) => serveHtml(c, 'src/pages/index/index.html'));
  app.get('/admin/users', (c) => serveHtml(c, 'src/pages/admin-users/index.html'));
  app.get('*', serveStatic({ root: publicDir }));

  return app;
}
