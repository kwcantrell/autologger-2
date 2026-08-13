// nextFrontend.test.ts — factory-level tests for the boot-ordering contract
// (design D1 "Boot ordering"; spec "API-only fallback mode and boot
// ordering", scenarios "Missing build keeps the API alive" / "Corrupt build
// fails the boot"). Never BOOTS real Next (no `prepare()` call anywhere in
// this file): `isApiOnly` is tested as a pure filesystem decision, and
// `createNextFrontend`'s corrupt-build path is tested against an injected
// fake factory whose `prepare()` rejects — the module under test only
// reaches for the real `next` package when `nextFactory` is omitted, which
// no `createNextFrontend` call here does. The one exception is the shape
// guard at the bottom, which `require()`s the real `next` package the exact
// same way `loadRealNextFactory()` does — to check what its CJS export
// SHAPE is, not to invoke it — added in task 3.3 after that real path
// (unreachable from any test above, by design) turned out to be broken.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNextFrontend, isApiOnly, type NextFactory } from './nextFrontend';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'autologger-nextfrontend-'));
  return dir;
}

describe('isApiOnly — pure decision function', () => {
  it('dev mode is never API-only, even with no build directory', () => {
    expect(isApiOnly({ dev: true, dir: freshDir() })).toBe(false);
  });

  it('prod with no <dir>/.next present is API-only', () => {
    expect(isApiOnly({ dev: false, dir: freshDir() })).toBe(true);
  });

  it('prod with <dir>/.next present is NOT API-only', () => {
    const d = freshDir();
    mkdirSync(join(d, '.next'));
    expect(isApiOnly({ dev: false, dir: d })).toBe(false);
  });
});

describe('createNextFrontend — missing-build fallback (prod, no web/.next)', () => {
  it('resolves null and never invokes the injected next factory', async () => {
    const factory = vi.fn();
    const result = await createNextFrontend({
      dev: false,
      dir: freshDir(),
      nextFactory: factory as unknown as NextFactory,
    });
    expect(result).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('createNextFrontend — corrupt-build reject path (prod, web/.next present, prepare() rejects)', () => {
  it('rethrows the prepare() rejection rather than degrading to API-only', async () => {
    const d = freshDir();
    mkdirSync(join(d, '.next'));
    const boom = new Error('corrupt build manifest');
    const fakeApp = {
      prepare: vi.fn().mockRejectedValue(boom),
      getRequestHandler: vi.fn(),
      getUpgradeHandler: vi.fn(),
      close: vi.fn(),
    };
    const factory = vi.fn().mockReturnValue(fakeApp);
    await expect(
      createNextFrontend({ dev: false, dir: d, nextFactory: factory as unknown as NextFactory }),
    ).rejects.toThrow('corrupt build manifest');
    // `httpServer` is always passed (drive-by fix, task 3.4) — see
    // nextFrontend.ts's `noOpUpgradeServer` doc comment for why: without it,
    // Next's own `getRequestHandler()` wrapper self-attaches a SECOND
    // 'upgrade' listener onto the real server on its first invocation,
    // which mishandles `/api/*` WebSocket upgrades.
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ dev: false, dir: d, httpServer: expect.anything() }),
    );
    expect(fakeApp.getRequestHandler).not.toHaveBeenCalled();
  });
});

describe('createNextFrontend — happy path wiring (fake factory, prepare() resolves)', () => {
  it('returns a frontend whose handle/upgradeHandler/close delegate to the app instance', async () => {
    const d = freshDir();
    mkdirSync(join(d, '.next'));
    const requestHandler = vi.fn().mockResolvedValue(undefined);
    const upgradeHandler = vi.fn().mockResolvedValue(undefined);
    const fakeApp = {
      prepare: vi.fn().mockResolvedValue(undefined),
      getRequestHandler: vi.fn().mockReturnValue(requestHandler),
      getUpgradeHandler: vi.fn().mockReturnValue(upgradeHandler),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const factory = vi.fn().mockReturnValue(fakeApp);
    const frontend = await createNextFrontend({
      dev: true,
      dir: d,
      nextFactory: factory as unknown as NextFactory,
    });
    expect(frontend).not.toBeNull();
    const incoming = { fake: 'incoming' } as never;
    const outgoing = { fake: 'outgoing' } as never;
    await frontend?.handle(incoming, outgoing);
    expect(requestHandler).toHaveBeenCalledWith(incoming, outgoing);

    const socket = { fake: 'socket' } as never;
    const head = Buffer.from('');
    await frontend?.upgradeHandler(incoming, socket, head);
    expect(upgradeHandler).toHaveBeenCalledWith(incoming, socket, head);

    await frontend?.close();
    expect(fakeApp.close).toHaveBeenCalled();
  });
});

describe('httpServer stub — neutralizes NextCustomServer self-attach (drive-by fix, task 3.4)', () => {
  it('passes an inert httpServer stub to the factory so Next cannot self-attach an upgrade listener to the real server', async () => {
    // Regression coverage for the bug documented on `noOpUpgradeServer` in
    // nextFrontend.ts: real `next`'s `getRequestHandler()` wrapper calls
    // `this.options.httpServer.on('upgrade', ...)` (falling back to
    // `req.socket.server` — the REAL server — only when `httpServer` is
    // absent) the first time any request is served. Without this stub,
    // that self-attached listener races `upgradeDispatch.ts`'s own
    // dispatcher on every subsequent WS upgrade — including `/api/*`
    // session sockets — because Next's catch-all route matches ANY
    // unmatched path and ends the socket. Asserting the stub's shape here
    // (present, has a callable `.on()`, and calling it is a genuine no-op)
    // is the closest unit-level proxy for "Next cannot reach our real
    // server" without booting real Next.
    const d = freshDir();
    mkdirSync(join(d, '.next'));
    const fakeApp = {
      prepare: vi.fn().mockResolvedValue(undefined),
      getRequestHandler: vi.fn().mockReturnValue(vi.fn()),
      getUpgradeHandler: vi.fn().mockReturnValue(vi.fn()),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const factory = vi.fn().mockReturnValue(fakeApp);
    await createNextFrontend({ dev: true, dir: d, nextFactory: factory as unknown as NextFactory });

    expect(factory).toHaveBeenCalledTimes(1);
    const passedOpts = factory.mock.calls[0][0] as { httpServer?: { on?: unknown } };
    expect(passedOpts.httpServer).toBeDefined();
    expect(typeof passedOpts.httpServer?.on).toBe('function');
    // Calling `.on()` the way NextCustomServer#setupWebSocketHandler does
    // must be a genuine no-op — no throw, no observable side effect.
    expect(() =>
      (passedOpts.httpServer as { on(e: string, l: () => void): void }).on('upgrade', () => {}),
    ).not.toThrow();
  });
});

describe('real `next` package CJS export shape (regression guard, task 3.3)', () => {
  it('require("next") resolves to the factory function directly, not a {default} wrapper', () => {
    // Mirrors `loadRealNextFactory()`'s own resolution exactly (same
    // `createRequire(import.meta.url)` + `require('next')` call) so this
    // test breaks the moment that function's assumption about `next`'s
    // export shape stops holding — which is exactly what happened here: a
    // prior version of `loadRealNextFactory()` assumed `{ default: factory
    // }` (citing the `.d.ts`'s `export default` syntax, which describes an
    // ESM/esModuleInterop CONSUMER's view, not the CJS runtime's actual
    // `module.exports` value) and broke every real Next boot with
    // `TypeError: factory is not a function`. Does not call the factory or
    // touch the filesystem — a pure shape check, not a boot.
    const nodeRequire = createRequire(import.meta.url);
    const mod = nodeRequire('next');
    expect(typeof mod).toBe('function');
  });
});
