import { describe, expect, it, vi } from 'vitest';
import { FakeVisibilityDocument, FakeWakeLock } from '../../../test/fakes/wakeLock';
import { createWakeLockController } from './wakeLock';

// --- media-worker A.4: screen Wake Lock while recording (design D17) ---

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('createWakeLockController', () => {
  it('holds a screen lock while recording and releases it on stop', async () => {
    const wl = new FakeWakeLock();
    const doc = new FakeVisibilityDocument();
    const c = createWakeLockController({ wakeLock: wl, doc, log: vi.fn() });
    await c.acquire();
    expect(wl.held()).toHaveLength(1);
    expect(c.isHeld()).toBe(true);
    await c.release();
    expect(wl.held()).toHaveLength(0);
    expect(c.isHeld()).toBe(false);
  });

  it('re-requests the lock when the page becomes visible after the browser dropped it', async () => {
    const wl = new FakeWakeLock();
    const doc = new FakeVisibilityDocument();
    const c = createWakeLockController({ wakeLock: wl, doc, log: vi.fn() });
    await c.acquire();
    doc.setVisibility('hidden');
    await wl.systemRelease();
    expect(c.isHeld()).toBe(false);
    doc.setVisibility('visible');
    await settle();
    expect(wl.requests).toBe(2);
    expect(wl.held()).toHaveLength(1);
    await c.release();
  });

  it('does not re-request after stop', async () => {
    const wl = new FakeWakeLock();
    const doc = new FakeVisibilityDocument();
    const c = createWakeLockController({ wakeLock: wl, doc, log: vi.fn() });
    await c.acquire();
    await c.release();
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    await settle();
    expect(wl.requests).toBe(1);
  });

  it('a missing API is logged once, never thrown', async () => {
    const log = vi.fn();
    const doc = new FakeVisibilityDocument();
    const c = createWakeLockController({ wakeLock: null, doc, log });
    await expect(c.acquire()).resolves.toBeUndefined();
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    await settle();
    await c.release();
    await c.acquire();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/wake lock/i);
  });

  it('a refused request (NotAllowedError) is logged once and recording goes on', async () => {
    const wl = new FakeWakeLock();
    wl.deny = true;
    const log = vi.fn();
    const doc = new FakeVisibilityDocument();
    const c = createWakeLockController({ wakeLock: wl, doc, log });
    await expect(c.acquire()).resolves.toBeUndefined();
    doc.setVisibility('visible');
    await settle();
    expect(c.isHeld()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/NotAllowedError/);
  });

  it('a stop that lands while the request is pending releases the late lock', async () => {
    const wl = new FakeWakeLock();
    const doc = new FakeVisibilityDocument();
    const c = createWakeLockController({ wakeLock: wl, doc, log: vi.fn() });
    const pending = c.acquire();
    await c.release();
    await pending;
    expect(wl.held()).toHaveLength(0);
  });
});
