// main.ts on the Postgres frame bus (session-frame-bus D1, D2; ADR 0021 slice 9a): spawned the way
// a stack starts it, on this test's database. Without a valid FRAME_BUS_SECRET it refuses before it
// touches the data directory; with one, its listener is up before it listens, a signed notify sent
// after the boot reaches a browser socket, and SIGTERM ends both bus connections.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_BUS_APPLICATION_NAME, FRAME_BUS_CHANNEL, FrameBusSealer } from '@autologger/storage';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { connOptions } from '../../test/pg/testDb';
import { defaultUser, testDatabase } from './test/harness';
import { seededSession } from './test/helpers';

const SERVER = join(__dirname, '..');
const TSX = join(SERVER, '../node_modules/.bin/tsx');
const SECRET = 'b'.repeat(48);

let dir: string | null = null;
let child: ChildProcess | null = null;
afterEach(() => {
  // tsx runs main.ts in a child node process, so a refusal case that booted instead would leave
  // that grandchild running: kill the whole process group (spawned detached, so it leads one).
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // the group is already gone
    }
  }
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** The env a stack gives main.ts, on this test's database. */
function stackEnv(extra: Record<string, string>): Record<string, string> {
  dir = mkdtempSync(join(tmpdir(), 'autologger-boot-bus-'));
  const db = testDatabase();
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    AUTOLOGGER_STACK: 'dev',
    // API only and no Next dev server: production mode, whose frontend is the build if present.
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '0',
    DATA_DIR: join(dir, 'data'),
    PGHOST: db.host,
    PGPORT: String(db.port),
    PGUSER: db.user,
    PGPASSWORD: db.password,
    PGDATABASE: db.database,
    GOOGLE_CLIENT_ID: 'boot-bus-client-id',
    GOOGLE_CLIENT_SECRET: 'boot-bus-client-secret',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com',
    SESSION_COOKIE: 'autologger_sid',
    ...extra,
  };
}

/** Spawns main.ts; resolves with its exit status, or with the port once it is listening. */
function boot(env: Record<string, string>) {
  const out = { stdout: '', stderr: '' };
  const proc = spawn(TSX, [join(SERVER, 'src/main.ts')], {
    cwd: dir ?? undefined,
    env,
    detached: true,
  });
  child = proc;
  proc.stdout.on('data', (d) => {
    out.stdout += String(d);
  });
  proc.stderr.on('data', (d) => {
    out.stderr += String(d);
  });
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  const listening = new Promise<number>((resolve, reject) => {
    proc.stdout.on('data', () => {
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(out.stdout);
      if (m) resolve(Number(m[1]));
    });
    void exited.then((code) => reject(new Error(`main.ts exited ${code}: ${out.stderr}`)));
  });
  listening.catch(() => {});
  return { proc, out, exited, listening };
}

/** The frame bus connections main.ts holds on this test's database, with their last query. */
async function busConnections(): Promise<Array<{ query: string }>> {
  const admin = postgres({
    ...connOptions('postgres', testDatabase().database),
    max: 1,
    onnotice: () => {},
  });
  try {
    return await admin<Array<{ query: string }>>`
      select query from pg_stat_activity
      where datname = ${testDatabase().database} and application_name = ${FRAME_BUS_APPLICATION_NAME}`;
  } finally {
    await admin.end();
  }
}

describe('main.ts on the Postgres frame bus (session-frame-bus D1, D2)', () => {
  for (const [what, extra] of [
    ['without FRAME_BUS_SECRET', {}],
    ['with a FRAME_BUS_SECRET under 32 characters', { FRAME_BUS_SECRET: 'short-secret' }],
  ] as const) {
    it(`${what}: exits 1 naming it, before the data directory is created`, async () => {
      const env = stackEnv(extra);
      const r = boot(env);
      expect(await r.exited).toBe(1);
      expect(r.out.stderr).toMatch(/FRAME_BUS_SECRET must be set/);
      expect(r.out.stderr).not.toMatch(/short-secret/);
      expect(r.out.stdout).not.toMatch(/listening/);
      expect(readdirSync(dir as string)).toEqual([]);
    }, 40_000);
  }

  it('listens only after its listener is up, delivers a signed notify, and ends both bus connections on SIGTERM', async () => {
    const { sessionId } = await seededSession();
    const { cookie } = await defaultUser();
    const r = boot(stackEnv({ FRAME_BUS_SECRET: SECRET }));
    const port = await r.listening;
    // The listener was started (its first LISTEN done) before listen().
    expect((await busConnections()).some((c) => /^listen /i.test(c.query))).toBe(true);

    const messages: Array<Record<string, unknown>> = [];
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`, {
        headers: { cookie },
      } as unknown as string[]);
      w.addEventListener('open', () => resolve(w));
      w.addEventListener('error', (e) => reject(e));
    });
    ws.addEventListener('message', (e) => void messages.push(JSON.parse(String(e.data))));

    const payload = new FrameBusSealer(SECRET).seal({
      k: 'frame',
      s: sessionId,
      f: JSON.stringify({ type: 'command', command: 'play-toggle' }),
    });
    const app = postgres({ ...testDatabase(), max: 1, onnotice: () => {} });
    try {
      await app`select pg_notify(${FRAME_BUS_CHANNEL}, ${payload})`;
    } finally {
      await app.end();
    }
    const end = Date.now() + 5000;
    while (messages.length === 0 && Date.now() < end)
      await new Promise((res) => setTimeout(res, 20));
    expect(messages).toEqual([{ type: 'command', command: 'play-toggle' }]);

    r.proc.kill('SIGTERM');
    await r.exited;
    // Both the listener and the publisher connection are gone.
    const deadline = Date.now() + 5000;
    let left = await busConnections();
    while (left.length > 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
      left = await busConnections();
    }
    expect(left).toEqual([]);
  }, 60_000);
});
