// Boot guard (retire-host-dev D1): the server boots only in a compose stack, with an absolute
// DATA_DIR and an absolute BLOB_DIR outside it (shared-blob-volume D1). Pure function; main.ts calls it first and bootGuardCli.ts runs it before tsx watch.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBootEnv, STACKS } from './bootGuard';

const ok = {
  AUTOLOGGER_STACK: 'dev',
  DATA_DIR: '/data',
  BLOB_DIR: '/blobs',
  PGHOST: 'db',
  PGPORT: '5432',
  PGUSER: 'autologger_app',
  PGPASSWORD: 'secret-value',
  PGDATABASE: 'postgres',
  GOOGLE_CLIENT_ID: 'client-id-value',
  GOOGLE_CLIENT_SECRET: 'client-secret-value',
  PUBLIC_BASE_URL: 'https://autologger.example',
  BOOTSTRAP_OWNER_EMAIL: 'owner-value@example.com',
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
  // shared-blob-volume D1: BLOB_DIR is required, absolute, and disjoint from DATA_DIR; checked
  // after DATA_DIR and before the PG settings.
  it('refuses a missing, empty or relative BLOB_DIR, naming BLOB_DIR and no value', () => {
    for (const v of [undefined, '', './blob-value', 'blob-value', '../blob-value']) {
      const msg = checkBootEnv({ ...ok, BLOB_DIR: v });
      expect(msg, String(v)).toMatch(/BLOB_DIR/);
      expect(msg).toMatch(/absolute/);
      if (v) expect(msg).not.toContain(v);
    }
  });
  it('refuses a BLOB_DIR that overlaps DATA_DIR, naming both and no value', () => {
    const cases: Array<[string, string]> = [
      ['/data', '/data'], // equal
      ['/data', '/data/'], // equal after path.resolve
      ['/data', '/data/x/..'], // equal after path.resolve
      ['/data', '/data/blobs'], // blob inside data
      ['/srv/data', '/srv'], // data inside blob
      ['/data', '/'], // '/' overlaps everything
    ];
    for (const [dataDir, blobDir] of cases) {
      const msg = checkBootEnv({ ...ok, DATA_DIR: dataDir, BLOB_DIR: blobDir });
      expect(msg, `${dataDir} ${blobDir}`).toMatch(/BLOB_DIR and DATA_DIR must be separate/);
      expect(msg).not.toContain('/data');
      expect(msg).not.toContain('/srv');
    }
  });
  it('accepts a BLOB_DIR that only shares a name prefix with DATA_DIR', () => {
    for (const blobDir of ['/data2', '/datablobs', '/srv/blobs']) {
      expect(checkBootEnv({ ...ok, DATA_DIR: '/data', BLOB_DIR: blobDir }), blobDir).toBeNull();
    }
  });
  it('checks BLOB_DIR after DATA_DIR and before the catalog settings', () => {
    expect(checkBootEnv({ ...ok, DATA_DIR: 'data', BLOB_DIR: undefined })).toMatch(/^DATA_DIR/);
    expect(checkBootEnv({ ...ok, BLOB_DIR: undefined, PGPASSWORD: undefined })).toMatch(
      /^BLOB_DIR/,
    );
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
    expect(checkBootEnv({ ...ok, BLOB_DIR: sentinel })).not.toContain(sentinel);
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
  // owner-bootstrap D8, D16: the bootstrap owner is required in every stack, and only as ASCII.
  it('refuses a missing, empty or whitespace-only BOOTSTRAP_OWNER_EMAIL, naming it and no value', () => {
    for (const v of [undefined, '', '   ', '\t\n']) {
      const msg = checkBootEnv({ ...ok, BOOTSTRAP_OWNER_EMAIL: v });
      expect(msg, JSON.stringify(v)).toMatch(/BOOTSTRAP_OWNER_EMAIL/);
      for (const val of ['client-id-value', 'client-secret-value', 'owner-value']) {
        expect(msg).not.toContain(val);
      }
    }
  });
  it('refuses a non-ASCII BOOTSTRAP_OWNER_EMAIL, naming it and not the value', () => {
    const kelvin = '\u212Aalen@gmail.com';
    const msg = checkBootEnv({ ...ok, BOOTSTRAP_OWNER_EMAIL: kelvin });
    expect(msg).toMatch(/BOOTSTRAP_OWNER_EMAIL/);
    expect(msg).toMatch(/ASCII/);
    expect(msg).not.toContain(kelvin);
    expect(msg).not.toContain('alen@gmail.com');
  });
  // run-status-and-sweeper D9: an approved-users entry is matched as exact ASCII too.
  it('refuses a non-ASCII RUN_FEATURE_EMAILS entry, naming it and not the value', () => {
    const kelvin = '\u212Aalen@gmail.com';
    const msg = checkBootEnv({ ...ok, RUN_FEATURE_EMAILS: `a@example.com, ${kelvin}` });
    expect(msg).toMatch(/RUN_FEATURE_EMAILS/);
    expect(msg).toMatch(/ASCII/);
    expect(msg).not.toContain(kelvin);
    expect(msg).not.toContain('alen@gmail.com');
    expect(msg).not.toContain('a@example.com');
  });
  it('allows an unset, blank or ASCII RUN_FEATURE_EMAILS', () => {
    for (const v of [undefined, '', ',', 'a@example.com, B@Example.com']) {
      expect(checkBootEnv({ ...ok, RUN_FEATURE_EMAILS: v }), JSON.stringify(v)).toBeNull();
    }
  });
  it('allows exactly the environments the compose wrapper sets (docker/scripts/compose-run.mjs ENVS)', () => {
    const src = readFileSync(join(__dirname, '../../docker/scripts/compose-run.mjs'), 'utf8');
    const envs = JSON.parse(
      (src.match(/const ENVS = (\[[^\]]*\]);/)?.[1] ?? '[]').replace(/'/g, '"'),
    );
    expect([...STACKS].sort()).toEqual([...envs].sort());
  });
});
