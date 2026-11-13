// Boot guard (retire-host-dev D1): the server boots only in a compose stack, with an absolute
// DATA_DIR and an absolute BLOB_DIR outside it (shared-blob-volume D1). Pure function; main.ts calls it first and bootGuardCli.ts runs it before tsx watch.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootWarnings, checkBootEnv, STACKS } from './bootGuard';

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
  // closed-signups D1: an invalid SIGNUPS refuses boot, naming SIGNUPS and its two values, never
  // the value; open, closed (any ASCII case, trimmed), blank and unset boot.
  it('refuses an invalid SIGNUPS, naming SIGNUPS, open and closed, and not the value', () => {
    for (const v of ['opne', 'yes', ' clsoed ']) {
      const msg = checkBootEnv({ ...ok, SIGNUPS: v });
      expect(msg, v).toMatch(/SIGNUPS/);
      expect(msg).toMatch(/open/);
      expect(msg).toMatch(/closed/);
      expect(msg).not.toContain(v.trim());
    }
  });
  it('boots with SIGNUPS open, closed, blank or unset, on every stack', () => {
    for (const s of ['dev', 'stage', 'prod']) {
      for (const v of [undefined, '', ' ', 'open', 'closed', ' Closed ', 'OPEN']) {
        expect(checkBootEnv({ ...ok, AUTOLOGGER_STACK: s, SIGNUPS: v }), `${s} ${v}`).toBeNull();
      }
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

// Custom session dashboards (ADR 0035, design §10.1): with the flag on, an unsafe setup is
// refused, naming the variable and never its value; with it off, nothing changes.
describe('checkBootEnv with CUSTOM_DASHBOARDS_ENABLED', () => {
  const secret = 'mcp-signing-secret-value-0123456789abcdef';
  const on = {
    ...ok,
    CUSTOM_DASHBOARDS_ENABLED: '1',
    DASHBOARD_RUNTIME_ORIGIN: 'https://runtime.dashboards.example',
    MCP_SIGNING_SECRET: secret,
    MCP_ALLOWED_ORIGINS: 'https://claude.example, https://desktop.example:8443',
  };
  /** A refusal that names `name`, and contains none of the given values. */
  const refusedNaming = (
    env: Record<string, string | undefined>,
    name: RegExp,
    values: Array<string | undefined>,
  ) => {
    const msg = checkBootEnv(env);
    expect(msg, JSON.stringify(env)).toMatch(name);
    for (const v of values) if (v?.trim()) expect(msg).not.toContain(v.trim());
    expect(msg).not.toContain(secret);
  };

  it('boots a valid flag-on setup, with the flag spelled any accepted way', () => {
    for (const v of ['1', 'true', 'yes', ' TRUE ', 'Yes']) {
      expect(checkBootEnv({ ...on, CUSTOM_DASHBOARDS_ENABLED: v }), v).toBeNull();
    }
    expect(checkBootEnv({ ...on, MCP_ALLOWED_ORIGINS: undefined })).toBeNull();
    expect(checkBootEnv({ ...on, MCP_ALLOWED_ORIGINS: '' })).toBeNull();
    expect(checkBootEnv({ ...on, PUBLIC_BASE_URL: 'https://autologger.example/' })).toBeNull();
    expect(checkBootEnv({ ...on, PUBLIC_BASE_URL: 'https://autologger.example:8443' })).toBeNull();
  });

  it('refuses a PUBLIC_BASE_URL that is not an https: origin, naming it and no value', () => {
    for (const v of [
      'http://autologger.example',
      'http://localhost:8787',
      'https://autologger.example/app',
      'https://autologger.example?x=1',
      'https://autologger.example#frag',
      'https://user@autologger.example',
      'not a url',
    ]) {
      refusedNaming({ ...on, PUBLIC_BASE_URL: v }, /PUBLIC_BASE_URL must be an https: origin/, [v]);
    }
  });

  it('refuses a missing or invalid DASHBOARD_RUNTIME_ORIGIN, naming it and no value', () => {
    for (const v of [
      undefined,
      '',
      '   ',
      'runtime.dashboards.example',
      'http://runtime.dashboards.example',
      'https://',
      'https://*.dashboards.example',
      'https://user@runtime.dashboards.example',
      'https://runtime.dashboards.example?x=1',
      'https://runtime.dashboards.example#x',
    ]) {
      refusedNaming(
        { ...on, DASHBOARD_RUNTIME_ORIGIN: v },
        /DASHBOARD_RUNTIME_ORIGIN must be set to an https: origin/,
        [v],
      );
    }
  });

  it('refuses a DASHBOARD_RUNTIME_ORIGIN with a path, naming it and no value', () => {
    for (const v of [
      'https://runtime.dashboards.example/',
      'https://runtime.dashboards.example/runtime/v1',
    ]) {
      refusedNaming(
        { ...on, DASHBOARD_RUNTIME_ORIGIN: v },
        /DASHBOARD_RUNTIME_ORIGIN must be set to an https: origin with no path/,
        [v],
      );
    }
  });

  it('refuses a DASHBOARD_RUNTIME_ORIGIN with an explicit port, :443 included, naming it', () => {
    for (const v of [
      'https://runtime.dashboards.example:8443',
      'https://runtime.dashboards.example:443',
      'https://[2001:db8::1]:8443',
    ]) {
      refusedNaming(
        { ...on, DASHBOARD_RUNTIME_ORIGIN: v },
        /DASHBOARD_RUNTIME_ORIGIN must be set to an https: origin with no path and no explicit port/,
        [v],
      );
    }
  });

  it('refuses a DASHBOARD_RUNTIME_ORIGIN on the same host as PUBLIC_BASE_URL, naming both', () => {
    for (const [app, runtime] of [
      ['https://autologger.example', 'https://autologger.example'],
      ['https://autologger.example:8443', 'https://AUTOLOGGER.example'],
      ['https://autologger.example/', 'https://autologger.example'],
    ] as const) {
      refusedNaming(
        { ...on, PUBLIC_BASE_URL: app, DASHBOARD_RUNTIME_ORIGIN: runtime },
        /DASHBOARD_RUNTIME_ORIGIN must have a host other than PUBLIC_BASE_URL/,
        [app, runtime, 'autologger.example'],
      );
    }
  });

  it('refuses a DASHBOARD_RUNTIME_ORIGIN host with a trailing dot or empty label, naming it', () => {
    for (const runtime of [
      'https://autologger.example.',
      'https://autologger.example..',
      'https://runtime..example',
      'https://.runtime.example',
    ]) {
      refusedNaming(
        { ...on, PUBLIC_BASE_URL: 'https://autologger.example', DASHBOARD_RUNTIME_ORIGIN: runtime },
        /DASHBOARD_RUNTIME_ORIGIN must be set to an https: origin .* no trailing dot or empty label/,
        [runtime, 'autologger.example', 'runtime.example'],
      );
    }
  });

  it('refuses a runtime host equal to PUBLIC_BASE_URL with a trailing dot, naming both', () => {
    for (const app of [
      'https://autologger.example.',
      'https://autologger.example..',
      'https://autologger.example.:8443/',
    ]) {
      refusedNaming(
        { ...on, PUBLIC_BASE_URL: app, DASHBOARD_RUNTIME_ORIGIN: 'https://autologger.example' },
        /DASHBOARD_RUNTIME_ORIGIN must have a host other than PUBLIC_BASE_URL/,
        [app, 'autologger.example'],
      );
    }
  });

  it('refuses a missing or short MCP_SIGNING_SECRET, naming it and no value', () => {
    for (const v of [undefined, '', 'short-secret-value', 'x'.repeat(31), ` ${'y'.repeat(31)} `]) {
      refusedNaming(
        { ...on, MCP_SIGNING_SECRET: v },
        /MCP_SIGNING_SECRET must be set to at least 32 characters/,
        [v],
      );
    }
    expect(checkBootEnv({ ...on, MCP_SIGNING_SECRET: 'z'.repeat(32) })).toBeNull();
  });

  it('refuses an MCP_ALLOWED_ORIGINS entry that is not an exact https: origin, naming it', () => {
    for (const bad of [
      '*',
      'https://*.allowed-bad.example',
      'http://allowed-bad.example',
      'https://allowed-bad.example/',
      'https://allowed-bad.example/path',
      'https://allowed-bad.example?q=1',
      'https://allowed-bad.example#f',
      'https://user:pw@allowed-bad.example',
      'allowed-bad.example',
      'https://',
    ]) {
      refusedNaming(
        { ...on, MCP_ALLOWED_ORIGINS: `https://claude.example, ${bad}` },
        /every MCP_ALLOWED_ORIGINS entry must be an exact https: origin/,
        [bad, 'allowed-bad', 'claude.example'],
      );
    }
  });

  it('accepts MCP_ALLOWED_ORIGINS entries with ports, padding and blank entries', () => {
    for (const v of [
      'https://claude.example',
      ' https://claude.example , https://desktop.example:8443 ',
      'https://claude.example,,',
      'HTTPS://Claude.Example',
      'https://[2001:db8::1]:8443',
    ]) {
      expect(checkBootEnv({ ...on, MCP_ALLOWED_ORIGINS: v }), v).toBeNull();
    }
  });

  it('refuses an MCP_REFRESH_GRACE_SECONDS that is not a whole number from 0 to 60, naming it', () => {
    for (const bad of ['61', '100', '-1', '+5', '5.5', '1e1', 'thirty', '3 0', '060']) {
      refusedNaming(
        { ...on, MCP_REFRESH_GRACE_SECONDS: bad },
        /MCP_REFRESH_GRACE_SECONDS must be unset, empty, or a whole number of seconds from 0 to 60/,
        [bad],
      );
    }
  });

  it('boots with MCP_REFRESH_GRACE_SECONDS unset, empty or from 0 to 60 (unset or empty is 30)', () => {
    for (const v of [undefined, '', '  ', '0', '1', '30', '60', ' 15 ']) {
      expect(checkBootEnv({ ...on, MCP_REFRESH_GRACE_SECONDS: v }), JSON.stringify(v)).toBeNull();
    }
  });

  it('with the flag off, boots exactly as before whatever the four settings hold', () => {
    const invalid = {
      PUBLIC_BASE_URL: 'http://localhost:8787',
      DASHBOARD_RUNTIME_ORIGIN: 'http://localhost:8787/path',
      MCP_SIGNING_SECRET: 'short',
      MCP_ALLOWED_ORIGINS: '*, http://x.example/path',
      MCP_REFRESH_GRACE_SECONDS: '999',
      IP_ALLOWLIST: '10.0.0.0/8',
    };
    for (const flag of [undefined, '', '0', 'false', 'no', 'off', 'on', 'enabled', '2', ' ']) {
      const env = { ...ok, ...invalid, CUSTOM_DASHBOARDS_ENABLED: flag };
      expect(checkBootEnv(env), JSON.stringify(flag)).toBeNull();
      expect(bootWarnings(env), JSON.stringify(flag)).toEqual([]);
      // The refusals that existed before still come first, unchanged.
      expect(checkBootEnv({ ...env, GOOGLE_CLIENT_ID: '' })).toBe(
        checkBootEnv({ ...ok, GOOGLE_CLIENT_ID: '' }),
      );
    }
    // Without the new settings at all, the same.
    expect(checkBootEnv({ ...ok, CUSTOM_DASHBOARDS_ENABLED: 'no' })).toBeNull();
  });
});

describe('bootWarnings (custom session dashboards, design §10.1 and §10.3)', () => {
  const on = {
    ...ok,
    CUSTOM_DASHBOARDS_ENABLED: 'true',
    DASHBOARD_RUNTIME_ORIGIN: 'https://runtime.dashboards-other.example',
    MCP_SIGNING_SECRET: 'mcp-signing-secret-value-0123456789abcdef',
  };
  const noValues = (warnings: string[], values: string[]) => {
    for (const w of warnings) for (const v of values) expect(w).not.toContain(v);
  };

  it('warns about nothing for a separate-site runtime and no IP_ALLOWLIST', () => {
    expect(checkBootEnv(on)).toBeNull();
    expect(bootWarnings(on)).toEqual([]);
    expect(bootWarnings({ ...on, IP_ALLOWLIST: '  ' })).toEqual([]);
  });

  it('warns when the runtime origin is on the same site as the app, naming variables only', () => {
    for (const runtime of [
      'https://runtime.autologger.example',
      'https://dash.autologger.example',
      'https://a.b.autologger.example',
    ]) {
      const env = { ...on, DASHBOARD_RUNTIME_ORIGIN: runtime };
      expect(checkBootEnv(env), runtime).toBeNull();
      const w = bootWarnings(env);
      expect(w, runtime).toHaveLength(1);
      expect(w[0]).toMatch(/DASHBOARD_RUNTIME_ORIGIN is on the same site as PUBLIC_BASE_URL/);
      expect(w[0]).toMatch(/separate registrable domain/);
      noValues(w, [runtime, 'autologger.example', 'runtime.', 'dash.']);
    }
  });

  it('warns when IP_ALLOWLIST is set, naming the documentation and not the range or the value', () => {
    const env = { ...on, IP_ALLOWLIST: '203.0.113.0/24' };
    const w = bootWarnings(env);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/IP_ALLOWLIST is set/);
    expect(w[0]).toMatch(/connector documentation/);
    noValues(w, ['203.0.113', '160.79.104.0/21']);
  });

  it('gives both warnings together', () => {
    const w = bootWarnings({
      ...on,
      DASHBOARD_RUNTIME_ORIGIN: 'https://runtime.autologger.example',
      IP_ALLOWLIST: '203.0.113.0/24',
    });
    expect(w).toHaveLength(2);
  });
});
