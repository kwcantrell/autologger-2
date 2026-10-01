// Test Postgres for the `pg` vitest project (catalog-pg-schema design D6; ADR 0021 slice 4).
//
// Runs the image pinned in docker/supabase-db.yaml with the stack's `db` command, published only on
// 127.0.0.1, and applies supabase/migrations with the real docker/supabase/migrate.sh to the
// `postgres` database (which has the stack's Supabase neighbours) and to `autologger_template`,
// which tests clone per test (test/pg/testDb.ts). Passwords are random per run and reach docker only
// through the client's environment (`-e NAME`), never argv. A crashed run's container is reaped by
// a later run only once its owning process is gone; by hand:
//   docker rm -f $(docker ps -qf label=autologger-test-pg.pid)

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import type { TestPg } from './testDb';

export type DockerResult = { code: number; stdout: string; stderr: string };
export type DockerFn = (args: string[], env?: Record<string, string>) => Promise<DockerResult>;

export interface StartDeps {
  docker: DockerFn;
  pid: number;
  hostname: string;
  isAlive(pid: number): boolean;
  randomHex(bytes: number): string;
  image: string;
  repoRoot: string;
  /** One TCP query as `postgres` from the host; true when it succeeded. */
  probe(port: number, superPassword: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export const DOCKER_MISSING =
  'the catalog tests need a running docker daemon (they use the pinned supabase/postgres image)';
const LABEL = 'autologger-test-pg.pid';
const HOST_LABEL = 'autologger-test-pg.host';
const READY_TRIES = 120;

/** Removes test containers left on this host by runs whose process has exited. */
export async function reapStale(d: StartDeps): Promise<void> {
  const ps = await d.docker([
    'ps',
    '-a',
    '--filter',
    `label=${LABEL}`,
    '--format',
    `{{.ID}} {{.Label "${LABEL}"}} {{.Label "${HOST_LABEL}"}}`,
  ]);
  for (const line of ps.stdout.split('\n')) {
    const [id, pid, host] = line.trim().split(' ');
    if (!id || host !== d.hostname || !/^\d+$/.test(pid ?? '')) continue;
    if (!d.isAlive(Number(pid))) await d.docker(['rm', '-f', id]);
  }
}

export async function startTestPostgres(d: StartDeps): Promise<TestPg> {
  if ((await d.docker(['info', '--format', '{{.ServerVersion}}'])).code !== 0) {
    throw new Error(DOCKER_MISSING);
  }
  await reapStale(d);
  const superPassword = d.randomHex(16);
  const appPassword = d.randomHex(16);
  const secrets = { POSTGRES_PASSWORD: superPassword, APP_DB_PASSWORD: appPassword };
  const pull = await d.docker(['pull', '--quiet', d.image]);
  if (pull.code !== 0) throw new Error(`docker pull ${d.image} failed: ${pull.stderr.trim()}`);
  const run = await d.docker(
    [
      'run',
      '-d',
      '--rm',
      '--label',
      `${LABEL}=${d.pid}`,
      '--label',
      `${HOST_LABEL}=${d.hostname}`,
      '-p',
      '127.0.0.1::5432',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'APP_DB_PASSWORD',
      '-v',
      `${join(d.repoRoot, 'supabase/migrations')}:/migrations:ro`,
      '-v',
      `${join(d.repoRoot, 'docker/supabase/migrate.sh')}:/migrate.sh:ro`,
      d.image,
      // The stack's `db` command (docker/supabase-db.yaml), plus room for parallel test pools.
      'postgres',
      '-c',
      'config_file=/etc/postgresql/postgresql.conf',
      '-c',
      'log_min_messages=fatal',
      '-c',
      'max_connections=300',
    ],
    secrets,
  );
  const container = run.stdout.trim();
  if (run.code !== 0 || !container) throw new Error(`docker run failed: ${run.stderr.trim()}`);
  try {
    const portOut = await d.docker(['port', container, '5432/tcp']);
    const m = /^127\.0\.0\.1:(\d+)$/m.exec(portOut.stdout);
    if (!m) throw new Error(`unexpected published address: ${portOut.stdout.trim()}`);
    const port = Number(m[1]);
    // The image restarts once after initdb, and the socket answers before that (design A17):
    // require two TCP successes one second apart.
    let ok = 0;
    for (let i = 0; i < READY_TRIES && ok < 2; i++) {
      ok = (await d.probe(port, superPassword)) ? ok + 1 : 0;
      await d.sleep(1000);
    }
    if (ok < 2) throw new Error('test Postgres did not become ready');
    const exec = async (args: string[], env?: Record<string, string>) => {
      const r = await d.docker(['exec', '-u', 'postgres', ...args], env);
      if (r.code !== 0) throw new Error(`docker exec ${args.join(' ')} failed: ${r.stderr.trim()}`);
      return r;
    };
    await exec([
      container,
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'create database autologger_template',
    ]);
    for (const db of ['postgres', 'autologger_template']) {
      await exec(
        ['-e', `PGDATABASE=${db}`, '-e', 'APP_DB_PASSWORD', container, 'sh', '/migrate.sh'],
        secrets,
      );
    }
    return { host: '127.0.0.1', port, superPassword, appPassword, container };
  } catch (e) {
    await d.docker(['rm', '-f', container]);
    throw e;
  }
}

function dockerCli(args: string[], env?: Record<string, string>): Promise<DockerResult> {
  return new Promise((done) => {
    const child = spawn('docker', args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.on('data', (b) => {
      stderr += b;
    });
    child.on('error', (e) => done({ code: 127, stdout, stderr: String(e) }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

function pinnedImage(repoRoot: string): string {
  const yaml = readFileSync(join(repoRoot, 'docker/supabase-db.yaml'), 'utf8');
  const m = /^x-image: &image (\S+)$/m.exec(yaml);
  if (!m?.[1]) throw new Error('no pinned image (x-image) in docker/supabase-db.yaml');
  return m[1];
}

async function probe(port: number, password: string): Promise<boolean> {
  const sql = postgres({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password,
    database: 'postgres',
    max: 1,
    connect_timeout: 2,
    onnotice: () => {},
  });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const pg = await startTestPostgres({
    docker: dockerCli,
    pid: process.pid,
    hostname: hostname(),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    randomHex: (n) => randomBytes(n).toString('hex'),
    image: pinnedImage(repoRoot),
    repoRoot,
    probe,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  project.provide('pg', pg);
  return async () => {
    await dockerCli(['rm', '-f', pg.container]);
  };
}
