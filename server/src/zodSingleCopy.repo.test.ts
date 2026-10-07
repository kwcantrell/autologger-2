import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// --- One zod 4 in the tree, and the Agent SDK's peers met (migrate-zod-4 D3) ---
// (package-architecture "Runtime dependencies checked by nominal identity are never duplicated",
// scenarios "One zod in the tree" and "The Agent SDK's peers are met".)
//
// A second resolved zod mints a second `ZodError` class: app.ts's `instanceof ZodError` then misses
// and a 422 becomes a 500 (the bump-mcp-sdk-advisory incident), and the Agent SDK's `tool()` gets
// schemas from a zod it doesn't share. `npm install <pkg> -w <workspace>` would write zod under a
// workspace's `dependencies`, where it could install a private copy. So, over `package-lock.json`:
//   - exactly one `node_modules/**/zod` entry, at a 4.x version;
//   - `node_modules/@anthropic-ai/sdk` present (the Agent SDK's type-only peer, `>=0.93`);
//   - no workspace package other than `server` lists zod under `dependencies`.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface LockEntry {
  version?: string;
  dependencies?: Record<string, string>;
  link?: boolean;
}

const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, LockEntry>;
};

describe('one zod 4 in the lockfile (migrate-zod-4 D3)', () => {
  it('has exactly one node_modules zod entry, and it is 4.x', () => {
    const zods = Object.entries(lock.packages).filter(
      ([key]) => key === 'node_modules/zod' || key.endsWith('/node_modules/zod'),
    );
    expect(zods.map(([key, e]) => `${key}@${e.version}`)).toHaveLength(1);
    expect(zods[0]?.[1].version).toMatch(/^4\./);
  });

  it('has the Agent SDK peer @anthropic-ai/sdk installed', () => {
    expect(lock.packages['node_modules/@anthropic-ai/sdk']?.version).toBeDefined();
  });

  it('lists zod under dependencies only for server', () => {
    const workspaces = Object.entries(lock.packages).filter(
      ([key, e]) => key !== '' && !key.includes('node_modules/') && e.link !== true,
    );
    expect(workspaces.length).toBeGreaterThan(5);
    const withZod = workspaces
      .filter(([, e]) => e.dependencies?.zod !== undefined)
      .map(([key]) => key);
    expect(withZod).toEqual(['server']);
  });
});
