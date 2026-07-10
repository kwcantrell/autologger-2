// src/main.ts — Node entry: env config → bindings → app → listen.

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireApp } from './app';
import { requireLoginEnabled } from './env';
import { createBindings } from './node/config';
import type { AppEnv } from './types';

const { bindings, close } = createBindings(process.env);
const port = Number(process.env.PORT || '8787');
const hostname = process.env.HOST || '0.0.0.0';

// web/dist resolved from this file's location (server/src/ → repo root/web/dist)
// so cwd never matters. API-only operation is legitimate; just say why / 404s.
const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (!existsSync(webDist)) {
  console.warn('frontend not built — run `npm run build` (serving API only)');
}

// Gate decision E1: login defaults ON. If the operator explicitly opened the
// API (REQUIRE_LOGIN=0) on a non-loopback bind with no allowlist, say so loudly.
const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
if (!loopback && !requireLoginEnabled(bindings) && !(bindings.IP_ALLOWLIST || '').trim()) {
  console.warn(
    '\n' +
      '!!! WARNING: AutoLogger is binding to a NON-LOOPBACK interface with\n' +
      '!!! REQUIRE_LOGIN=0 and no IP_ALLOWLIST. Every /api route is open to\n' +
      '!!! the network. Set REQUIRE_LOGIN=1, an IP_ALLOWLIST, or HOST=127.0.0.1.\n',
  );
}

const app = new Hono<AppEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
// Bindings ride in via wireApp's injection middleware — NOT a fetch wrapper —
// because @hono/node-ws upgrades bypass serve()'s fetch entirely.
wireApp(app, upgradeWebSocket, { bindings, publicDir: webDist });
bindings.SESSION_DO.startSweeper();

const server = serve(
  { fetch: app.fetch, port, hostname },
  (info) => console.log(`AutoLogger (Node) listening on http://${hostname}:${info.port}`),
);
injectWebSocket(server);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // server.close() alone never completes while a WebSocket is open (upgraded
    // sockets aren't idle keep-alives) — the normal state of this app. Destroy
    // them too, and guarantee exit even if something else holds the loop.
    const failsafe = setTimeout(() => process.exit(1), 5000);
    failsafe.unref();
    server.close(() => {
      close();
      process.exit(0);
    });
    (server as import('node:http').Server).closeAllConnections?.();
  });
}
