// Boot guard (retire-host-dev D1): the server boots only in a compose stack, with an absolute
// DATA_DIR. Pure function; main.ts calls it first and bootGuardCli.ts runs it before tsx watch.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBootEnv, STACKS } from './bootGuard';

const ok = {
  AUTOLOGGER_STACK: 'dev',
  DATA_DIR: '/data',
  PGHOST: 'db',
  PGPORT: '5432',
  PGUSER: 'autologger_app',
  PGPASSWORD: 'secret-value',
  PGDATABASE: 'postgres',
  GOOGLE_CLIENT_ID: 'client-id-value',
  GOOGLE_CLIENT_SECRET: 'client-secret-value',
  PUBLIC_BASE_URL: 'https://autologger.example',
};

describe('checkBootEnv', () => {
  it('accepts every stack with an absolute DATA_DIR', () => {
    for (const s of ['dev', 'stage', 'prod'])
      expect(checkBootEnv({ ...ok, AUTOLOGGER_STACK: s })).toBeNull();
  });
  it('refuses a missing, empty or unknown stack sentinel, naming make dev-up', () => {
    for (const v of [undefined, '', 'x', 'DEV', 'check']) {
      const msg = checkBootEnv({ ...ok, AUTOLOGGER_STACK: v });
      expect(msg, String(v)).toMatch(/AUTOLOGGER_STACK/);
      expect(msg).toMatch(/make dev-up/);
    }
  });
  it('refuses a missing, empty or relative DATA_DIR, naming DATA_DIR', () => {
    for (const v of [undefined, '', './data', 'data', '../x']) {
      expect(checkBootEnv({ ...ok, DATA_DIR: v }), String(v)).toMatch(/DATA_DIR/);
    }
  });
  it('refuses each missing or empty catalog connection setting, naming it (catalog-on-postgres D2)', () => {
    for (const k of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
      for (const v of [undefined, '']) {
        const msg = checkBootEnv({ ...ok, [k]: v });
        expect(msg, `${k}=${String(v)}`).toMatch(new RegExp(k));
        expect(msg).not.toContain('secret-value');
      }
    }
  });
  it('never puts an environment value into the message', () => {
    const sentinel = 'sentinel-value-should-not-appear';
    expect(checkBootEnv({ ...ok, AUTOLOGGER_STACK: sentinel })).not.toContain(sentinel);
    expect(checkBootEnv({ ...ok, DATA_DIR: sentinel })).not.toContain(sentinel);
  });
  // require-login D1: login is always required, so a server no one can sign in to never boots.
  it('accepts a full env (null)', () => {
    expect(checkBootEnv(ok)).toBeNull();
  });
  it('refuses REQUIRE_LOGIN present with any value, empty included, naming it', () => {
    for (const v of ['0', '1', '']) {
      const msg = checkBootEnv({ ...ok, REQUIRE_LOGIN: v });
      expect(msg, JSON.stringify(v)).toMatch(/REQUIRE_LOGIN/);
    }
  });
  it('refuses a missing, blank or whitespace-only sign-in setting, naming it', () => {
    for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PUBLIC_BASE_URL']) {
      for (const v of [undefined, '', '   ', '\t\n']) {
        const msg = checkBootEnv({ ...ok, [k]: v });
        expect(msg, `${k}=${JSON.stringify(v)}`).toMatch(new RegExp(k));
      }
    }
  });
  it('never puts a sign-in value into the message', () => {
    for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PUBLIC_BASE_URL']) {
      const msg = checkBootEnv({ ...ok, [k]: '' }) ?? '';
      for (const v of ['client-id-value', 'client-secret-value', 'https://autologger.example']) {
        expect(msg).not.toContain(v);
      }
    }
    const msg = checkBootEnv({ ...ok, REQUIRE_LOGIN: 'sentinel-value-should-not-appear' }) ?? '';
    expect(msg).not.toContain('sentinel-value-should-not-appear');
    expect(msg).not.toContain('client-secret-value');
  });
  it('allows exactly the environments the compose wrapper sets (docker/scripts/compose-run.mjs ENVS)', () => {
    const src = readFileSync(join(__dirname, '../../docker/scripts/compose-run.mjs'), 'utf8');
    const envs = JSON.parse(
      (src.match(/const ENVS = (\[[^\]]*\]);/)?.[1] ?? '[]').replace(/'/g, '"'),
    );
    expect([...STACKS].sort()).toEqual([...envs].sort());
  });
});
