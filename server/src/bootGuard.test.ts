// Boot guard (retire-host-dev D1): the server boots only in a compose stack, with an absolute
// DATA_DIR. Pure function; main.ts calls it first and bootGuardCli.ts runs it before tsx watch.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBootEnv, STACKS } from './bootGuard';

const ok = { AUTOLOGGER_STACK: 'dev', DATA_DIR: '/data' };

describe('checkBootEnv', () => {
  it('accepts every stack with an absolute DATA_DIR', () => {
    for (const s of ['dev', 'stage', 'prod']) expect(checkBootEnv({ ...ok, AUTOLOGGER_STACK: s })).toBeNull();
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
  it('never puts an environment value into the message', () => {
    const sentinel = 'sentinel-value-should-not-appear';
    expect(checkBootEnv({ AUTOLOGGER_STACK: sentinel, DATA_DIR: '/data' })).not.toContain(sentinel);
    expect(checkBootEnv({ AUTOLOGGER_STACK: 'dev', DATA_DIR: sentinel })).not.toContain(sentinel);
  });
  it('allows exactly the environments the compose wrapper sets (docker/scripts/compose-run.mjs ENVS)', () => {
    const src = readFileSync(join(__dirname, '../../docker/scripts/compose-run.mjs'), 'utf8');
    const envs = JSON.parse((src.match(/const ENVS = (\[[^\]]*\]);/)?.[1] ?? '[]').replace(/'/g, '"'));
    expect([...STACKS].sort()).toEqual([...envs].sort());
  });
});
