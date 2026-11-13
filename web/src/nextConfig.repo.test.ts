/// <reference types="node" />
// Next 16 upgrade (job 014): pins the parts of `web/next.config.ts` and the workspace manifests
// that the upgrade had to change, so a later edit cannot silently undo them. The reasons for each
// setting are in the comments in `web/next.config.ts`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { defaultConfig } from 'next/dist/server/config-shared';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Loaded by path, not a static import: `next.config.ts` belongs to the `tsconfig.node.json`
// project reference, so a static import from `src/` fails `tsc` (TS6305).
const CONFIG_PATH = path.join(ROOT, 'web', 'next.config.ts');
const nextConfig = ((await import(/* @vite-ignore */ CONFIG_PATH)) as { default: NextConfig })
  .default;
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function atLeast16_2_11(version: string): boolean {
  const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10));
  return major === 16 && (minor > 2 || (minor === 2 && patch >= 11));
}

describe('next version', () => {
  it('web and server declare the same ^16 range, at or above 16.2.11', () => {
    const web = readJson('web/package.json').dependencies.next as string;
    const server = readJson('server/package.json').dependencies.next as string;
    expect(web).toBe(server);
    expect(web).toMatch(/^\^16\.\d+\.\d+$/);
    expect(atLeast16_2_11(web.slice(1))).toBe(true);
  });

  it('the lockfile resolves exactly one next, a 16.x at or above 16.2.11', () => {
    const lock = readJson('package-lock.json') as {
      packages: Record<string, { version?: string }>;
    };
    const entries = Object.entries(lock.packages).filter(([p]) =>
      /(^|\/)node_modules\/next$/.test(p),
    );
    expect(entries.map(([p]) => p)).toEqual(['node_modules/next']);
    expect(atLeast16_2_11(entries[0][1].version ?? '')).toBe(true);
  });
});

describe('web/next.config.ts under Next 16', () => {
  it('maps .webm imports to an emitted asset URL through Turbopack, with no webpack() hook left', () => {
    expect(nextConfig.turbopack?.rules?.['*.webm']).toEqual({ type: 'asset' });
    expect(nextConfig.webpack).toBeUndefined();
  });

  it('emits no React-generated Link response header (reactMaxHeadersLength 0)', () => {
    expect(nextConfig.reactMaxHeadersLength).toBe(0);
  });

  // Human decision 2026-11-13: keep Next 16's RSC request validation, and with it the `307` to
  // `?_rsc=<hash>` that an `RSC: 1` request without the matching query gets.
  it('leaves RSC request validation at Next 16 default, on', () => {
    expect(nextConfig.experimental?.validateRSCRequestHeaders).toBeUndefined();
    expect(defaultConfig.experimental?.validateRSCRequestHeaders).toBe(true);
  });

  it('keeps the settings the frozen routes and headers depend on', () => {
    expect(nextConfig).toMatchObject({
      output: 'standalone',
      reactStrictMode: false,
      allowedDevOrigins: ['127.0.0.1'],
      images: { unoptimized: true },
      poweredByHeader: false,
      skipTrailingSlashRedirect: true,
      pageExtensions: ['page.tsx', 'page.ts'],
    });
    expect(nextConfig.outputFileTracingRoot).toBe(ROOT);
  });
});
