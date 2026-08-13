// nextFrontend.test.ts — factory-level tests for the boot-ordering contract
// (design D1 "Boot ordering"; spec "API-only fallback mode and boot
// ordering", scenarios "Missing build keeps the API alive" / "Corrupt build
// fails the boot"). Never boots real Next: `isApiOnly` is tested as a pure
// filesystem decision, and `createNextFrontend`'s corrupt-build path is
// tested against an injected fake factory whose `prepare()` rejects. Real
// Next is never imported by this file's assertions — the module under test
// only reaches for the real `next` package when `nextFactory` is omitted,
// which no test here does.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
    expect(factory).toHaveBeenCalledWith({ dev: false, dir: d });
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
