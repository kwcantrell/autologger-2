// src/main.ts — Node entry: env config → bindings → frontend → app → listen.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { wireApp } from './app';
import type { AppEnv } from './appEnv';
import { loopbackHostname, requireLoginEnabled } from './env';
import { createBindings } from './node/config';
import { createNextFrontend } from './node/nextFrontend';
import { captureHonoUpgradeHandler, installUpgradeDispatcher } from './upgradeDispatch';

const { bindings, close } = createBindings(process.env);
const port = Number(process.env.PORT || '8787');
const hostname = process.env.HOST || '0.0.0.0';

// Env-loading order is a deliberate invariant (nextjs-frontend-migration,
// design D1 "Env-loading order"): createBindings() above already snapshotted
// server config from process.env BEFORE this point — next() below is what
// auto-loads web/.env* into process.env during prepare(). Server secrets
// must never be sourced from a web-side dotfile; this ordering is what
// guarantees that.
//
// `dev` mirrors the boot-ordering/dev-bind decisions this migration made
// (design D1 "Boot ordering", D10 "Dev workflow"): `NODE_ENV !== 'production'`
// runs Next in dev mode (HMR, on-demand compilation, never API-only); the web
// app directory is resolved from this file's location (server/src/ → repo
// root/web) so cwd never matters, matching the old webDist resolution this
// replaces.
const dev = process.env.NODE_ENV !== 'production';
const webDir = join(dirname(fileURLToPath(import.meta.url)), '../../web');

// Boot ordering (design D1 "Boot ordering", spec "API-only fallback mode and
// boot ordering"): the server begins accepting connections only after this
// resolves. `createNextFrontend` itself decides API-only (no `web/.next`
// present in prod ⇒ resolves `null`, `next` never invoked); a `prepare()`
// REJECTION with a build directory present is NOT caught here — it
// propagates and crashes the boot loudly, which is correct: a corrupt build
// is a broken deploy, not a missing frontend, and must never silently
// degrade to API-only.
const frontend = await createNextFrontend({ dev, dir: webDir });
if (!dev && !frontend) {
  console.warn('frontend not built — run `npm run build` (serving API only)');
}

// Gate decision E1: login defaults ON. If the operator explicitly opened the
// API (REQUIRE_LOGIN=0) on a non-loopback bind with no allowlist, say so loudly.
// Same predicate the per-feature open-network refusals read (env.ts).
const loopback = loopbackHostname(bindings.config);
if (
  !loopback &&
  !requireLoginEnabled(bindings.config) &&
  !(bindings.config.IP_ALLOWLIST || '').trim()
) {
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
wireApp(app, upgradeWebSocket, { bindings, frontend: frontend ?? undefined });
bindings.ports.sessions.startSweeper();

// Capture Hono's own `server.on('upgrade', ...)` listener via a stub object
// BEFORE the real server exists, so it is never installed on the real server
// directly — main.ts installs exactly one real `upgrade` listener: the path
// dispatcher below (design D1 "Upgrade dispatch"; server/src/upgradeDispatch.ts
// has the full rationale + verification of this capture technique against
// the installed @hono/node-ws).
const honoUpgradeHandler = captureHonoUpgradeHandler(injectWebSocket);

const server = serve({ fetch: app.fetch, port, hostname }, (info) =>
  console.log(`AutoLogger (Node) listening on http://${hostname}:${info.port}`),
);
installUpgradeDispatcher({
  server,
  honoUpgrade: honoUpgradeHandler,
  frontend,
  dev,
  config: bindings.config,
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // server.close() alone never completes while a WebSocket is open (upgraded
    // sockets aren't idle keep-alives) — the normal state of this app. Destroy
    // them too, and guarantee exit even if something else holds the loop.
    const failsafe = setTimeout(() => process.exit(1), 5000);
    failsafe.unref();
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    (server as import('node:http').Server).closeAllConnections?.();
    // Shutdown (design D1 "Shutdown"): frontend.close() joins the
    // SIGINT/SIGTERM path without being serialized before server.close() —
    // both are initiated here together (server.close()/closeAllConnections()
    // above, frontend.close() here) and awaited together below, rather than
    // chained one after the other; a frontend.close() rejection is logged
    // and does not block shutdown (the 5s failsafe is the final backstop
    // either way).
    const frontendClosed = Promise.resolve(frontend?.close()).catch((err) => {
      console.error('frontend close() rejected during shutdown', err);
    });
    Promise.all([serverClosed, frontendClosed]).then(() => {
      close();
      process.exit(0);
    });
  });
}
