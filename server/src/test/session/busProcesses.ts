// Server processes on the Postgres frame bus, for route-level tests (session-frame-bus D8): each is
// `createBindings({ frameBus: 'postgres' })` over the current test database, with the bus started,
// served on a real listening server as `main.ts` serves it. `closeBusProcesses` ends them all.

import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { wireApp } from '../../app';
import type { AppEnv } from '../../appEnv';
import { createBindings } from '../../node/config';
import { testDatabase } from '../harness';

export const BUS_TEST_SECRET = 'x'.repeat(40);

export type BusProcess = ReturnType<typeof createBindings> & { port: number };

const made: Array<{ p: BusProcess; dir: string; srv: ServerType }> = [];

/** One server process on the test database: the Postgres bus started, then served. */
export async function busProcess(): Promise<BusProcess> {
  const db = testDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'autologger-bus-'));
  const m = createBindings(
    {
      DATA_DIR: dir,
      // As the harness's env (test/harness.ts), so its signed-in users and admin token work here.
      PUBLIC_BASE_URL: 'https://example.com',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com',
      SESSION_COOKIE: 'autologger_sid',
      SESSION_DAYS: '14',
      ADMIN_TOKEN: 'test-admin-token',
      PGHOST: db.host,
      PGPORT: String(db.port),
      PGUSER: db.user,
      PGPASSWORD: db.password,
      PGDATABASE: db.database,
      FRAME_BUS_SECRET: BUS_TEST_SECRET,
    },
    { frameBus: 'postgres' },
  );
  await m.startFrameBus();
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  wireApp(app, upgradeWebSocket, { bindings: m.bindings });
  let srv: ServerType | undefined;
  const port = await new Promise<number>((resolve) => {
    srv = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port),
    );
    injectWebSocket(srv);
  });
  const p = Object.assign(m, { port });
  made.push({ p, dir, srv: srv as ServerType });
  return p;
}

/** Ends every process `busProcess` made: its server (waited for at most 2 s), then its bindings. */
export async function closeBusProcesses(): Promise<void> {
  for (const { p, dir, srv } of made.splice(0)) {
    await Promise.race([new Promise((r) => srv.close(r)), new Promise((r) => setTimeout(r, 2000))]);
    await p.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
