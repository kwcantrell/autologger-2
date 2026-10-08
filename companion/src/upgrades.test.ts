import type { CompanionStaticUpgradeProps } from '@companion-module/base';
import { describe, expect, it } from 'vitest';
import { UpgradeScripts } from './upgrades.js';

type Config = Record<string, unknown>;
type Secrets = { token?: string };

function run(config: Config | null, secrets: Secrets | null) {
  expect(UpgradeScripts).toHaveLength(1);
  const script = UpgradeScripts[0] as unknown as (
    ctx: { currentConfig: Config },
    props: CompanionStaticUpgradeProps<Config, Secrets>,
  ) => { updatedConfig: Config | null; updatedSecrets?: Secrets | null };
  return script({ currentConfig: config ?? {} }, { config, secrets, actions: [], feedbacks: [] });
}

describe('upgrade: token moves from config to secrets', () => {
  it('moves a non-empty config.token into updatedSecrets.token and drops it from config', () => {
    const r = run({ url: 'http://x:8787', token: 'old-api-token', pollMs: 500 }, {});
    expect(r.updatedSecrets).toEqual({ token: 'old-api-token' });
    expect(r.updatedConfig).toEqual({ url: 'http://x:8787', pollMs: 500 });
    expect(r.updatedConfig).not.toHaveProperty('token');
  });

  it('moves the token when secrets is null', () => {
    const r = run({ url: 'u', token: 'old', pollMs: 1000 }, null);
    expect(r.updatedSecrets).toEqual({ token: 'old' });
    expect(r.updatedConfig).toEqual({ url: 'u', pollMs: 1000 });
  });

  it('is a no-op when config.token is empty', () => {
    const r = run({ url: 'u', token: '', pollMs: 1000 }, {});
    expect(r.updatedConfig).toBeNull();
    expect(r.updatedSecrets ?? null).toBeNull();
  });

  it('is a no-op when config.token is absent', () => {
    const r = run({ url: 'u', pollMs: 1000 }, {});
    expect(r.updatedConfig).toBeNull();
    expect(r.updatedSecrets ?? null).toBeNull();
  });

  it('is a no-op when there is no config', () => {
    const r = run(null, null);
    expect(r.updatedConfig).toBeNull();
    expect(r.updatedSecrets ?? null).toBeNull();
  });

  it('is a no-op when secrets.token is already set', () => {
    const r = run({ url: 'u', token: 'old', pollMs: 1000 }, { token: 'ald_device' });
    expect(r.updatedConfig).toBeNull();
    expect(r.updatedSecrets ?? null).toBeNull();
  });
});
