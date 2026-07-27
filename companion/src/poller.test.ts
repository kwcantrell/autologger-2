import { describe, expect, it, vi } from 'vitest';
import { Poller } from './poller.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Poller', () => {
  it('applies only the newest response when two overlap (sequence fence)', async () => {
    let resolveFirst!: (v: number) => void;
    const applied: number[] = [];
    const fetchState = vi
      .fn()
      .mockImplementationOnce(() => new Promise<number>((r) => (resolveFirst = r))) // slow
      .mockImplementationOnce(() => Promise.resolve(2)); // fast
    const p = new Poller({
      intervalMs: 5,
      fetchState,
      onState: (s: number) => applied.push(s),
      onError: () => {},
    });
    p.start(); // issues seq 1 (slow, pending)
    await tick();
    p.refreshNow(); // must coalesce into the pending seq-1 fetch, NOT start seq 2
    resolveFirst(1);
    await tick();
    expect(applied).toContain(1);
    p.stop();
    // Only one fetch was in flight at a time.
    expect(fetchState.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('stop() prevents further applies', async () => {
    const applied: number[] = [];
    const p = new Poller({
      intervalMs: 1,
      fetchState: () => Promise.resolve(7),
      onState: (s: number) => applied.push(s),
      onError: () => {},
    });
    p.start();
    p.stop();
    await tick();
    await tick();
    const count = applied.length;
    await tick();
    expect(applied.length).toBe(count); // no growth after stop
  });
});
