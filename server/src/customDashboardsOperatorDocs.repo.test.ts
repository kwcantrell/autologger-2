// Every custom dashboards setting the server reads (design §10.1) is declared where an operator
// can set it: the app container's env allowlist (otherwise compose-run never passes it), the
// README env table, server/.env.example and docs/openbao-secrets.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

// The feature's own settings (PUBLIC_BASE_URL and IP_ALLOWLIST predate it and are documented
// elsewhere).
const KEYS = [
  'CUSTOM_DASHBOARDS_ENABLED',
  'DASHBOARD_RUNTIME_ORIGIN',
  'MCP_SIGNING_SECRET',
  'MCP_ALLOWED_ORIGINS',
  'MCP_REFRESH_GRACE_SECONDS',
];

describe('custom dashboards settings are declared for operators', () => {
  it.each(KEYS)('%s is in the allowlist, README, .env.example and openbao doc', (key) => {
    expect(read('docker/secrets-env.yaml')).toMatch(new RegExp(`^\\s+${key}:\\s*$`, 'm'));
    expect(read('README.md')).toMatch(new RegExp(`^\\| \`${key}\` \\|`, 'm'));
    expect(read('server/.env.example')).toMatch(new RegExp(`^# ${key}=`, 'm'));
    expect(read('docs/openbao-secrets.md')).toContain(`\`${key}\``);
  });
});
