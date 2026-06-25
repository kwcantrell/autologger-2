// AutoLogger Worker entry — Hono app + middleware chain + router mounts.
// Mirrors src/autologger/web/app.py: ipAllowlist (outermost) → auth context/gate,
// then the auth / profile / shows routers. SessionDO / real-time / audio /
// transcription are phases 3-7 (see docs/cloudflare/autologger-on-cloudflare.md).

import { type Context, Hono } from 'hono';
import { ZodError } from 'zod';
import { authContext } from './middleware/auth';
import { ipAllowlistMiddleware } from './middleware/ipAllowlist';
import { ApiError } from './routers/_helpers';
import { adminRouter } from './routers/admin';
import { audioRouter } from './routers/audio';
import { authRouter } from './routers/auth';
import { companionRouter } from './routers/companion';
import { eventsRouter } from './routers/events';
import { exportsRouter } from './routers/exports';
import { profileRouter } from './routers/profile';
import { sessionsRouter } from './routers/sessions';
import { showsRouter } from './routers/shows';
import { transcribeRouter } from './routers/transcribe';
import { ValidationError } from './studio';
import type { AppEnv } from './types';

export { SessionDO } from './durable/SessionDO';

const app = new Hono<AppEnv>();

// Starlette applies middleware in reverse registration order; Hono runs them in
// registration order. So register ipAllowlist first to keep it outermost.
app.use('*', ipAllowlistMiddleware);
app.use('*', authContext);

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ detail: err.detail }, err.status as 400);
  if (err instanceof ValidationError) return c.json({ detail: err.message }, 400);
  if (err instanceof ZodError) return c.json({ detail: err.issues }, 422);
  if (err instanceof SyntaxError) return c.json({ detail: 'Invalid JSON body.' }, 400);
  console.error('unhandled error', err);
  return c.json({ detail: 'Internal Server Error' }, 500);
});

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

// SPA hosting (Workers Assets). The two pages are independent builds (no client-side
// router), so the Worker serves each HTML explicitly — substituting the API root the
// way the Python `_render_html` did — then falls through to ASSETS for hashed statics
// (`/assets/*`) and the logos (`/static/*`). These mounts come LAST so /api + /auth win.
async function serveHtml(c: Context<AppEnv>, assetPath: string) {
  const res = await c.env.ASSETS.fetch(new URL(assetPath, c.req.url));
  if (!res.ok) return c.notFound();
  const html = (await res.text()).replaceAll('__API_ROOT__', '/api');
  return c.html(html);
}

app.get('/', (c) => serveHtml(c, '/src/pages/index/index.html'));
app.get('/admin/users', (c) => serveHtml(c, '/src/pages/admin-users/index.html'));
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
