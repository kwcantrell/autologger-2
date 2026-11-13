// src/node/nextFrontendDev.test.ts — the real Next dev server behind the real frontend bridge, on a
// real socket, the way main.ts wires it in the dev stack: `createNextFrontend({ dev: true })`, the
// bridge handler `wireApp` mounts (`frontendBridge`), and `serve()` with main.ts's fetch wrapper
// (`keepAlreadySentOnHead`). No bindings and no database, so it runs on the host under `npm test`.
//
// Two dev-only regressions from the Next 16 upgrade (job 014, proof round 3), neither visible in
// the production image:
// - F1: on Next 16 the root not-found page renders inside the `(index)` layout, so a not-found page
//   that brought its own `<html><body>` nested a second document in the layout's `<body>`. Next's
//   dev server logged 4 React errors per 404 ("In HTML, <html> cannot be a child of <body>…") and
//   the dev overlay showed a red "4 Issues" badge.
// - F2: `HEAD /` logged `ERR_HTTP_HEADERS_SENT`: under @hono/node-server 2.x the HEAD copy of the
//   bridge's RESPONSE_ALREADY_SENT sentinel was written a second time (see
//   `keepAlreadySentOnHead` in src/app.ts).
// Both checks fail on any error the server logs while it answers the request.

import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ServerType, serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { frontendBridge, keepAlreadySentOnHead } from '../app';
import type { AppEnv } from '../appEnv';
import { createNextFrontend, type NextFrontend } from './nextFrontend';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web');

/** The one message the dev server is allowed to log as an error. `reactMaxHeadersLength: 0`
 * (web/next.config.ts) keeps the `Link` header off `/` and 404s, and React's dev build warns about
 * the zero budget on every page render. Accepted with that setting (job 014, decision 1). */
const ACCEPTED = /React expected a positive non-zero `maxHeadersLength`/;

/** `next dev` rewrites this tracked file to point at `.next/dev/types`; `next build` (and the
 * committed copy) point at `.next/types`. Restored after the run so the test leaves the tree clean. */
const NEXT_ENV = join(WEB, 'next-env.d.ts');
const nextEnvBefore = readFileSync(NEXT_ENV, 'utf8');

let frontend: NextFrontend;
let server: ServerType;
let base: string;
let errorSpy: MockInstance;

/** Every error logged since `from`, minus the accepted warning, as text. */
function errorsSince(from: number): string[] {
  return errorSpy.mock.calls
    .slice(from)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.stack}` : String(a))).join(' '))
    .filter((line) => !ACCEPTED.test(line));
}

beforeAll(async () => {
  frontend = (await createNextFrontend({ dev: true, dir: WEB })) as NextFrontend;
  const app = new Hono<AppEnv>();
  app.get('*', frontendBridge(frontend));
  await new Promise<void>((resolve) => {
    server = serve(
      { fetch: keepAlreadySentOnHead(app.fetch), port: 0, hostname: '127.0.0.1' },
      (info: AddressInfo) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      },
    );
  });
  errorSpy = vi.spyOn(console, 'error');
  // Compile `/` once, outside the measured requests (the first dev request compiles on demand).
  await (await fetch(`${base}/`)).text();
}, 180_000);

afterAll(async () => {
  errorSpy?.mockRestore();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await frontend?.close();
  if (readFileSync(NEXT_ENV, 'utf8') !== nextEnvBefore) writeFileSync(NEXT_ENV, nextEnvBefore);
});

/** The RSC flight data a Next HTML response carries in its `self.__next_f.push([1, "..."])`
 * scripts, decoded and joined. In dev the server sends a `<html id="__next_error__">` shell for a
 * 404 and the browser renders the page from this payload, so the nested document only shows here,
 * not in the HTML. */
function flightData(html: string): string {
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let out = '';
  for (const m of html.matchAll(re)) out += JSON.parse(m[1] as string) as string;
  return out;
}

/** Lets anything the server logs after the response (a second write, a late render error) land. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe('dev server through the frontend bridge (job 014)', () => {
  it("HEAD / answers 200 with GET's headers and no body, and logs no error (F2)", async () => {
    const get = await fetch(`${base}/`);
    await get.text();
    const from = errorSpy.mock.calls.length;
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    expect(await head.text()).toBe('');
    await settle();
    expect(errorsSince(from)).toEqual([]);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
    expect(head.headers.get('cache-control')).toBe(get.headers.get('cache-control'));
    expect(head.headers.get('vary')).toBe(get.headers.get('vary'));
    expect(head.headers.get('x-hono-already-sent')).toBeNull();
  });

  it.each(['/does-not-exist', '/sessions/a/b', '/admin/users'])(
    'GET %s renders the not-found page inside one HTML document and logs no error (F1)',
    async (path) => {
      const from = errorSpy.mock.calls.length;
      const res = await fetch(`${base}${path}`);
      const html = await res.text();
      await settle();
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(html.match(/<html[\s>]/g)).toHaveLength(1);
      expect(html.match(/<body[\s>]/g)).toHaveLength(1);
      // The tree the browser renders: the `(index)` layout's one `<html>`/`<body>`, and the
      // not-found page inside it with none of its own (the nested pair React reported).
      const flight = flightData(html);
      // (Dev flight rows carry debug fields after each element's props, so match up to the props.)
      expect(flight).toContain('["$","h1",null,{"children":"404 — Not Found"}');
      expect(flight.match(/\["\$","html",/g)).toHaveLength(1);
      expect(flight.match(/\["\$","body",/g)).toHaveLength(1);
      expect(errorsSince(from)).toEqual([]);
    },
    120_000,
  );
});
