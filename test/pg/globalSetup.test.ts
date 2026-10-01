// Unit tests for the test-Postgres global setup (catalog-pg-schema design D6), with docker stubbed.
import { describe, expect, it } from 'vitest';
import {
  DOCKER_MISSING,
  type DockerFn,
  reapStale,
  type StartDeps,
  startTestPostgres,
} from './globalSetup';

type Call = { args: string[]; env?: Record<string, string> };

function stubDocker(over: (args: string[]) => { code: number; stdout?: string } | undefined) {
  const calls: Call[] = [];
  const docker: DockerFn = async (args, env) => {
    calls.push({ args, env });
    const r = over(args);
    return { code: r?.code ?? 0, stdout: r?.stdout ?? '', stderr: '' };
  };
  return { docker, calls };
}

function deps(docker: DockerFn): StartDeps {
  let n = 0;
  return {
    docker,
    pid: 4242,
    hostname: 'h1',
    isAlive: () => true,
    randomHex: () => `${'ab'.repeat(16)}${n++}`,
    image: 'supabase/postgres:test@sha256:00',
    repoRoot: '/repo',
    probe: async () => true,
    sleep: async () => {},
  };
}

describe('startTestPostgres', () => {
  it('rejects with the daemon message when docker info fails', async () => {
    const { docker } = stubDocker((a) => (a[0] === 'info' ? { code: 1 } : undefined));
    await expect(startTestPostgres(deps(docker))).rejects.toThrow(DOCKER_MISSING);
  });

  it('keeps passwords off argv and publishes only on 127.0.0.1', async () => {
    const { docker, calls } = stubDocker((a) => {
      if (a[0] === 'run') return { code: 0, stdout: 'cid123\n' };
      if (a[0] === 'port') return { code: 0, stdout: '127.0.0.1:40001\n' };
      if (a[0] === 'ps') return { code: 0, stdout: '' };
      return undefined;
    });
    const pg = await startTestPostgres(deps(docker));
    expect(pg.port).toBe(40001);
    expect(pg.superPassword).not.toBe(pg.appPassword);
    for (const c of calls) {
      for (const a of c.args) {
        expect(a).not.toContain(pg.superPassword);
        expect(a).not.toContain(pg.appPassword);
      }
    }
    const run = calls.find((c) => c.args[0] === 'run');
    expect(run).toBeDefined();
    const ports = run?.args.flatMap((a, i, all) => (a === '-p' ? [all[i + 1]] : [])) ?? [];
    expect(ports).toEqual(['127.0.0.1::5432']);
    expect(run?.env?.POSTGRES_PASSWORD).toBe(pg.superPassword);
    expect(run?.env?.APP_DB_PASSWORD).toBe(pg.appPassword);
    // migrate.sh runs on both databases, with the app password passed by name only.
    const migrates = calls.filter((c) => c.args[0] === 'exec' && c.args.includes('/migrate.sh'));
    expect(migrates.map((c) => c.args.find((a) => a.startsWith('PGDATABASE=')))).toEqual([
      'PGDATABASE=postgres',
      'PGDATABASE=autologger_template',
    ]);
    for (const m of migrates) expect(m.args).toContain('APP_DB_PASSWORD');
  });
});

describe('reapStale', () => {
  it('removes only containers on this host whose labelled pid is dead', async () => {
    const { docker, calls } = stubDocker((a) =>
      a[0] === 'ps' ? { code: 0, stdout: 'c1 111 h1\nc2 222 h1\nc3 333 h2\n' } : undefined,
    );
    await reapStale({ ...deps(docker), isAlive: (pid) => pid === 222 });
    expect(calls.filter((c) => c.args[0] === 'rm').map((c) => c.args)).toEqual([
      ['rm', '-f', 'c1'],
    ]);
  });
});
