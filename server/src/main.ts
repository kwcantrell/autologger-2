// src/main.ts — Node entry: env config → bindings → frontend → app → listen.

import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MediaSql } from '@autologger/ports/media';
import { DataDirLockedError, FrameBusSecretError } from '@autologger/storage';
import { mediaJobs } from '@autologger/storage/mediaJobs';
import { mediaUploads } from '@autologger/storage/mediaUploads';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { wireApp } from './app';
import type { AppEnv } from './appEnv';
import { ProviderKeysSecretError, verifyProviderKeysCheck } from './auth/providerKeyCrypto';
import { checkBootEnv } from './bootGuard';
import { maskBootstrapOwnerEmail, runFeatureEmails } from './env';
import { startMediaApply } from './mediaApply';
import { createBindings } from './node/config';
import { createNextFrontend } from './node/nextFrontend';
import {
  purgeExpiredAtBoot,
  reconcileMergesOnce,
  startLeaseSweeper,
  startMediaSweeper,
  startPeriodicPurge,
  trashOrphanBlobsOnce,
} from './startupPurge';
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
  created = createBindings(process.env, { frameBus: 'postgres', providerKeys: 'required' });
} catch (e) {
  // retire-host-dev D2: another server holds DATA_DIR — refuse cleanly (nothing was touched).
  if (
    e instanceof DataDirLockedError ||
    e instanceof FrameBusSecretError ||
    e instanceof ProviderKeysSecretError
  ) {
    console.error(`autologger: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
const { bindings, close, startFrameBus, ensureMediaDir } = created;
// owner-bootstrap D8: the masked bootstrap owner (domain and a short hash, never the local part),
// so the operator can check the configured value for a typo.
console.info(`bootstrap owner: ${maskBootstrapOwnerEmail(bindings.config.BOOTSTRAP_OWNER_EMAIL)}`);
// run-status-and-sweeper D9: the approved users for run features, as a count and masked forms
// (never the addresses), so the operator can check the list.
const runFeatureList = runFeatureEmails(bindings.config);
console.info(
  `run-feature users: ${runFeatureList.length} (${runFeatureList.map(maskBootstrapOwnerEmail).join(', ')})`,
);
// catalog-on-postgres D2: listen only once the catalog answers. Exit 1 otherwise, so the
// supervisor retries (the stack's migrations service may still be creating the schema).
try {
  await waitForCatalog(bindings.ports.catalog.bindSystem('boot-wait'));
  // byo-ai-providers D2: refuse a PROVIDER_KEYS_SECRET that doesn't match the stored keys.
  await verifyProviderKeysCheck(bindings.ports.providerCredentials, bindings.ports.providerKeys);
  // session-frame-bus D1: the bus's listener is up (its first LISTEN done) before listen(), so no
  // socket attaches before this process receives frames.
  await startFrameBus();
  // media-worker D4: `BLOB_DIR/media/` (mode 1777) exists before the worker's first job.
  await ensureMediaDir();
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
// media-worker D2, D6, D20: each tick also reconciles finished recordings into merge jobs and
// checks the notification queue.
const mediaBlobBytes = async (key: string): Promise<number> => {
  try {
    return (await stat(bindings.ports.audio.resolveKeyPath(key))).size;
  } catch {
    return 0;
  }
};
const reconcileDb = bindings.ports.catalog.bindSystem('media-reconcile') as unknown as MediaSql;
const leaseSweepTimer = startLeaseSweeper({
  leases: bindings.ports.leases,
  presence: bindings.ports.presence,
  sessions: bindings.ports.sessions,
  clock: bindings.ports.clock,
  reconcile: () =>
    reconcileMergesOnce({
      db: reconcileDb,
      jobs: mediaJobs,
      clock: bindings.ports.clock,
      blobBytes: mediaBlobBytes,
    }),
});
// media-worker D8, D12: trash, expired uploads, old jobs, orphan job directories, low-disk mode.
const mediaSweepDb = bindings.ports.catalog.bindSystem('media-sweep') as unknown as MediaSql;
// Blobs are written before their rows: once at boot, an hour-old blob no row names (a crash
// between the two) goes to the trash. Not awaited, so it never delays listen().
void trashOrphanBlobsOnce({
  db: mediaSweepDb,
  blobs: {
    list: (o) => bindings.ports.audio.list(o),
    resolveKeyPath: (k) => bindings.ports.audio.resolveKeyPath(k),
    trash: (k, now) => bindings.ports.mediaBlobs.trash(k, now),
  },
  clock: bindings.ports.clock,
});
const mediaSweepTimer = startMediaSweeper({
  db: mediaSweepDb,
  jobs: mediaJobs,
  uploads: mediaUploads,
  blobs: bindings.ports.mediaBlobs,
  clock: bindings.ports.clock,
});
// media-worker D3: this process applies the worker's results, every 10 s (the worker's
// `media_jobs_done` notification is a wake-up only; see README "Media jobs").
const mediaApply = startMediaApply({
  db: bindings.ports.catalog.bindSystem('media-apply') as unknown as MediaSql,
  jobs: mediaJobs,
  sessions: bindings.ports.sessions,
  blobs: bindings.ports.mediaBlobs,
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
    clearInterval(mediaSweepTimer);
    mediaApply.stop();
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
    // media-worker (B.9): a pass in flight finishes before the hubs and the database close, so it
    // never sees a closing registry (its job would otherwise stay `done` for the next start).
    const applyIdle = mediaApply.idle().catch((err) => {
      console.error('media apply pass failed during shutdown', err);
    });
    void Promise.all([serverClosed, frontendClosed, applyIdle])
      .then(() => close())
      .catch((err) => console.error('catalog close() rejected during shutdown', err))
      .finally(() => process.exit());
  });
}
