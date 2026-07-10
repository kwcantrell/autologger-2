// src/app.ts — Hono app wiring: middleware chain + router mounts + static
// serving. Mirrors src/autologger/web/app.py. The caller supplies
// upgradeWebSocket (from @hono/node-ws in main.ts; a 426 stub in HTTP tests).

import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { authContext } from './middleware/auth';
import { ipAllowlistMiddleware } from './middleware/ipAllowlist';
import { InvalidRangeError } from './node/blobStore';
import { ApiError } from './routers/_helpers';
import { adminRouter } from './routers/admin';
import { audioRouter } from './routers/audio';
import { authRouter } from './routers/auth';
import { companionRouter } from './routers/companion';
import { eventsRouter } from './routers/events';
import { exportsRouter } from './routers/exports';
import { profileRouter } from './routers/profile';
import { mountSessionWs } from './routers/sessionWs';
import { sessionsRouter } from './routers/sessions';
import { showsRouter } from './routers/shows';
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
  // bypassing any wrapper. Spread keeps the adapter-provided incoming/outgoing.
  if (opts.bindings) {
    const b = opts.bindings;
    app.use('*', async (c, next) => {
      c.env = { ...b, ...c.env };
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
  app.route('/', sessionsRouter);
  app.route('/', eventsRouter);
  app.route('/', audioRouter);
  app.route('/', companionRouter);
  app.route('/', transcribeRouter);
  app.route('/', exportsRouter);
  app.route('/', adminRouter);

  // Static hosting. __API_ROOT__ substitution is PHASE-1 TRANSITIONAL (spec:
  // scope #6) — sub-project 2 replaces it with a Vite build-time define.
  async function serveHtml(c: Context<AppEnv>, assetPath: string) {
    let html: string;
    try {
      html = await readFile(join(publicDir, assetPath), 'utf-8');
    } catch {
      return c.notFound();
    }
    return c.html(html.replaceAll('__API_ROOT__', '/api'));
  }

  app.get('/', (c) => serveHtml(c, 'src/pages/index/index.html'));
  app.get('/admin/users', (c) => serveHtml(c, 'src/pages/admin-users/index.html'));
  app.get('*', serveStatic({ root: publicDir }));

  return app;
}
