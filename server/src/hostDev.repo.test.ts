// Host dev is retired (retire-host-dev D3): no package script loads an env file (server/.env is
// never read), and the dev script runs the boot guard before its file watcher.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const MANIFESTS = [
  'package.json',
  'server/package.json',
  'web/package.json',
  'companion/package.json',
  ...[
    'domain',
    'contract',
    'ports',
    'storage',
    'catalog',
    'session-core',
    'transcription',
    'media-import',
    'log-import',
    'ai-runtime',
  ].map((p) => `packages/${p}/package.json`),
];
const scripts = (f: string) =>
  Object.entries(
    (JSON.parse(readFileSync(join(ROOT, f), 'utf8')).scripts ?? {}) as Record<string, string>,
  );

describe('host dev is retired', () => {
  it('no package script passes an env file to node or tsx', () => {
    const offenders = MANIFESTS.flatMap((f) =>
      scripts(f)
        .filter(([, cmd]) => /--env-file/.test(cmd))
        .map(([n]) => `${f}:${n}`),
    );
    expect(offenders).toEqual([]);
  });
  it('the server dev script runs the boot guard before tsx watch', () => {
    const dev = Object.fromEntries(scripts('server/package.json')).dev ?? '';
    expect(dev).toMatch(/bootGuardCli\.ts\s*&&.*tsx watch/);
  });
});
