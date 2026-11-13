/// <reference types="node" />
// Regression check for the Next 16 upgrade (job 014): the built stylesheet must contain the
// Tailwind utility classes the app uses.
//
// What broke: under Next 16 Turbopack evaluates `web/postcss.config.mjs` with an
// `import.meta.url` of `web/web/postcss.config.mjs`. The Tailwind `base` derived from it named a
// missing directory, the class-candidate scan found nothing, and the CSS shipped with no
// utilities (30,743 B instead of about 167 KB). The app rendered unstyled in the production image
// and in dev. Every test and header check stayed green, because none of them read the CSS.
// The fix declares the scan root in `src/shared/theme/tailwind.css` (`source('../../..')`).
//
// Only a real `next build` exercises the Turbopack PostCSS path, so this test runs one on the
// real `web/` and reads the CSS it emits. It starts the build with cwd `server/`, the cwd of the
// embedded dev server (`npm run dev -w server`), so the build sees the same environment as dev.
// The build replaces `web/.next`, which is gitignored build output.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER = path.join(WEB, '..', 'server');
const DIST = path.join(WEB, '.next');
const NEXT_BIN = createRequire(path.join(WEB, 'package.json')).resolve('next/dist/bin/next');

// Classes the sign-in shell (the index route's first screen) puts on its layout elements. Each is
// also asserted to still appear in that source file, so the list cannot go stale silently.
const SOURCE = path.join(WEB, 'src', 'pages', 'index', 'components', 'LoginPage.tsx');
const USED_CLASSES = [
  'flex',
  'items-center',
  'justify-center',
  'min-h-screen',
  'max-w-[25rem]',
  'text-center',
  'max-md:px-5',
];

/** The class as a CSS selector: `max-w-[25rem]` -> `.max-w-\[25rem\]`. */
function selector(cls: string): string {
  return `.${cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;
}

function cssFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return e.name.endsWith('.css') ? [p] : [];
  });
}

let css = '';

beforeAll(() => {
  // Start from nothing, so CSS left over from an earlier build cannot pass the test.
  fs.rmSync(DIST, { recursive: true, force: true });
  const build = spawnSync(process.execPath, [NEXT_BIN, 'build', WEB], {
    cwd: SERVER,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(`next build failed (${build.status}):\n${build.stdout}\n${build.stderr}`);
  }
  css = cssFiles(path.join(DIST, 'static'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}, 300_000);

describe('built CSS (next build, cwd server/)', () => {
  it('emits at least one stylesheet', () => {
    expect(css.length).toBeGreaterThan(0);
  });

  it('every listed class is still used by the sign-in shell', () => {
    const source = fs.readFileSync(SOURCE, 'utf8');
    for (const cls of USED_CLASSES) expect(source, cls).toContain(cls);
  });

  it.each(USED_CLASSES)('contains the Tailwind utility .%s', (cls) => {
    // The selector must end there: `.flex` must not be satisfied by `.flex-shrink-0`.
    const sel = selector(cls).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(css).toMatch(new RegExp(`${sel}(?![a-zA-Z0-9_\\\\-])`));
  });
});
