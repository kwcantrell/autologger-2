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
//
// The second suite pins the not-found page on the same build (one `next build` per run: two test
// files building into `web/.next` at once would race). On Next 16 the root not-found page picks
// up the app's global stylesheet; 15.5 rendered it unstyled. The human accepted that change
// (job 014, decision 3) and kept everything else: status `404`, response headers, and the page's
// own content and inline styles. The page renders no `<html>`/`<body>` of its own (proof round 3
// F1: nested in the layout's `<body>` it raised React errors in dev). The suite boots the
// standalone server the production image runs (`.next/standalone/web/server.js`) and asserts all
// of it, so a later change in either
// direction (the stylesheet dropped again, or the page's own markup changed) fails here.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

// ---- The not-found page on the production server ----------------------------------------------

/** Unknown paths of each kind: a nonsense path, a session path one segment too deep, and the
 * retired admin page. */
const UNKNOWN_PATHS = ['/does-not-exist', '/sessions/a/b', '/admin/users'];

/** The page's own content, exactly as `web/src/app/not-found.page.tsx` renders it, in the RSC
 * flight encoding: the inline style object of the wrapper, the heading and the paragraph. */
const NOT_FOUND_STYLE =
  '"style":{"display":"flex","minHeight":"100vh","alignItems":"center",' +
  '"justifyContent":"center","fontFamily":"sans-serif","textAlign":"center"}';
const NOT_FOUND_H1 = '["$","h1",null,{"children":"404 — Not Found"}]';
const NOT_FOUND_P = '["$","p",null,{"children":"This page doesn\'t exist."}]';

/** The RSC flight data a Next HTML response carries in its `self.__next_f.push([1, "..."])`
 * scripts, decoded and joined. */
function flightData(html: string): string {
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let out = '';
  for (const m of html.matchAll(re)) out += JSON.parse(m[1] as string) as string;
  return out;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

interface Fetched {
  status: number;
  headers: Headers;
  body: string;
}

let server: ChildProcess | undefined;
const responses = new Map<string, Fetched>();

beforeAll(async () => {
  const port = await freePort();
  server = spawn(process.execPath, [path.join(DIST, 'standalone', 'web', 'server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(`${base}/`);
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`standalone server did not start: ${err}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  for (const p of UNKNOWN_PATHS) {
    const res = await fetch(`${base}${p}`);
    responses.set(p, { status: res.status, headers: res.headers, body: await res.text() });
  }
}, 60_000);

afterAll(() => {
  server?.kill();
});

describe.each(UNKNOWN_PATHS)('not-found page for GET %s (standalone server)', (p) => {
  const get = (): Fetched => responses.get(p) as Fetched;

  it('responds 404 as HTML, with no Link header', () => {
    const res = get();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('link')).toBeNull();
  });

  it("renders the not-found page's own content and inline styles, unchanged", () => {
    const flight = flightData(get().body);
    expect(flight).toContain(NOT_FOUND_STYLE);
    expect(flight).toContain(NOT_FOUND_H1);
    expect(flight).toContain(NOT_FOUND_P);
  });

  it('renders inside the layout that loads the global stylesheet (job 014, decision 3)', () => {
    // Both 15.5 and 16 send the `(index)` layout's `<link rel="stylesheet">` in the flight data.
    // What changed is which not-found boundary renders the page. On 15.5 only the root boundary,
    // outside that layout, carried it; the layout's own boundary was `notFound: undefined`, so the
    // layout (and its stylesheet) never mounted. On 16 the layout's own boundary, the first one
    // after its stylesheet link, carries the page, so the page renders inside the layout and the
    // global stylesheet applies. Both readings are asserted here: that boundary must hold the
    // not-found page, and the linked file must be the app's global sheet (the one with the
    // Tailwind utilities the first suite checks).
    const flight = flightData(get().body);
    const link = /\["\$","link","\d+",\{"rel":"stylesheet","href":"([^"]+\.css)"/.exec(flight);
    expect(link, 'stylesheet link in the flight data').not.toBeNull();
    const href = (link as RegExpExecArray)[1] as string;
    const sheet = fs.readFileSync(path.join(DIST, href.replace(/^\/_next\//, '')), 'utf8');
    expect(sheet).toMatch(/\.min-h-screen(?![a-zA-Z0-9_\\-])/);

    const after = flight.slice((link as RegExpExecArray).index);
    const boundary = after.indexOf('"notFound":');
    expect(boundary, 'a not-found boundary after the stylesheet link').toBeGreaterThan(-1);
    const fallback = after.slice(boundary + '"notFound":'.length);
    // The page's own content, with no `<html>` of its own: the layout supplies the document
    // (a second `<html>` nested in the layout's `<body>` raised React errors in dev, proof round 3
    // F1).
    expect(fallback.startsWith('[["$","div",null,{"style":')).toBe(true);
    expect(fallback.indexOf(NOT_FOUND_H1)).toBeGreaterThan(-1);
    expect(fallback.indexOf(NOT_FOUND_STYLE)).toBeLessThan(fallback.indexOf('"forbidden":'));
  });

  it('is one HTML document: the layout has the only <html> and <body> (job 014, F1)', () => {
    const flight = flightData(get().body);
    expect(flight.match(/\["\$","html",/g)).toHaveLength(1);
    expect(flight.match(/\["\$","body",/g)).toHaveLength(1);
  });
});
