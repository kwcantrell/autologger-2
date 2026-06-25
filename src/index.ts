// AutoLogger Worker entry — Hono app + middleware chain + router mounts.
// Mirrors src/autologger/web/app.py: ipAllowlist (outermost) → auth context/gate,
// then the auth / profile / shows routers. SessionDO / real-time / audio /
// transcription are phases 3-7 (see docs/cloudflare/autologger-on-cloudflare.md).

import { Hono } from 'hono';
import { ZodError } from 'zod';
import { authContext } from './middleware/auth';
import { ipAllowlistMiddleware } from './middleware/ipAllowlist';
import { authRouter } from './routers/auth';
import { profileRouter } from './routers/profile';
import { showsRouter } from './routers/shows';
import { ValidationError } from './studio';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

// Starlette applies middleware in reverse registration order; Hono runs them in
// registration order. So register ipAllowlist first to keep it outermost.
app.use('*', ipAllowlistMiddleware);
app.use('*', authContext);

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ detail: err.message }, 400);
  if (err instanceof ZodError) return c.json({ detail: err.issues }, 422);
  if (err instanceof SyntaxError) return c.json({ detail: 'Invalid JSON body.' }, 400);
  console.error('unhandled error', err);
  return c.json({ detail: 'Internal Server Error' }, 500);
});

app.route('/', authRouter);
app.route('/', profileRouter);
app.route('/', showsRouter);

// Minimal root: the React frontend is served by Vite and points its API root here
// (phase 5/7 move Assets hosting onto the Worker). Health/info only for now.
app.get('/', (c) => c.json({ name: 'autologger', status: 'ok', phase: '1-2' }));

export default app;
