// src/main.ts — Node entry: env config → bindings → frontend → app → listen.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataDirLockedError, FrameBusSecretError } from '@autologger/storage';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { wireApp } from './app';
import type { AppEnv } from './appEnv';
import { checkBootEnv } from './bootGuard';
import { maskBootstrapOwnerEmail } from './env';
import { createBindings } from './node/config';
import { createNextFrontend } from './node/nextFrontend';
import { purgeExpiredAtBoot, startLeaseSweeper, startPeriodicPurge } from './startupPurge';
import { captureHonoUpgradeHandler, installUpgradeDispatcher } from './upgradeDispatch';
import { waitForCatalog } from './waitForCatalog';

// retire-host-dev D1: refuse before anything touches a data directory.
const refusal = checkBootEnv(process.env);
if (refusal) {
  console.error(`autologger: ${refusal}`);
  process.exit(1);
}

let created: ReturnType<typeof createBindings>;
try {
  // session-frame-bus D1: the production entry point is the only one on the Postgres frame bus, so
  // session frames reach every process sharing the database. It refuses without a valid
  // FRAME_BUS_SECRET (D2), before the data directory is touched.
  created = createBindings(process.env, { frameBus: 'postgres' });
} catch (e) {
  // retire-host-dev D2: another server holds DATA_DIR — refuse cleanly (nothing was touched).
  if (e instanceof DataDirLockedError || e instanceof FrameBusSecretError) {
    console.error(`autologger: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
const { bindings, close, startFrameBus } = created;
// owner-bootstrap D8: the masked bootstrap owner (domain and a short hash, never the local part),
// so the operator can check the configured value for a typo.
console.info(`bootstrap owner: ${maskBootstrapOwnerEmail(bindings.config.BOOTSTRAP_OWNER_EMAIL)}`);
// catalog-on-postgres D2: listen only once the catalog answers. Exit 1 otherwise, so the
// supervisor retries (the stack's migrations service may still be creating the schema).
try {
  await waitForCatalog(bindings.ports.catalog.bindSystem('boot-wait'));
  // session-frame-bus D1: the bus's listener is up (its first LISTEN done) before listen(), so no
  // socket attaches before this process receives frames.
  await startFrameBus();
} catch (e) {
  console.error(`autologger: ${(e as Error).message}`);
  await close().catch(() => {});
  process.exit(1);
}
// Startup KV hygiene (async-session-callers D2): awaited before listening, then repeated by the
// periodic purge (catalog-concurrency-hazards D10).
await purgeExpiredAtBoot(bindings.ports.kv);
const purgeTimer = startPeriodicPurge(bindings.ports.kv);
// run-status-and-sweeper D6: every process sweeps expired session leases; first tick in 60 s.
const leaseSweepTimer = startLeaseSweeper({
  leases: bindings.ports.leases,
  sessions: bindings.ports.sessions,
  clock: bindings.ports.clock,
});
const port = Number(process.env.PORT || '8787');
const hostname = bindings.config.HOST;

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
  console.warn('frontend not built (serving API only)');
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
    clearInterval(purgeTimer);
    clearInterval(leaseSweepTimer);
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
    // Neither input rejects: serverClosed only resolves, frontendClosed catches.
    // close() ends the frame bus's listener and publisher and the catalog connections
    // (catalog-on-postgres D2, session-frame-bus D1); the failsafe above still
    // bounds it, and a transaction it cuts short rolls back on the server.
    void Promise.all([serverClosed, frontendClosed])
      .then(() => close())
      .catch((err) => console.error('catalog close() rejected during shutdown', err))
      .finally(() => process.exit());
  });
}
