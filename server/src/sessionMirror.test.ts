// catalog-database "Session live projection is mirrored in order" (catalog-concurrency-hazards D6).

import { describe, expect, it, vi } from 'vitest';
import { SessionMirror } from './sessionMirror';

type P = { event_count: number };

function setup() {
  const state = new Map<string, number>();
  const written: Array<[string, number]> = [];
  let block: Promise<void> | null = null;
  const blockFor = new Map<string, Promise<void>>();
  let fail: unknown = null;
  const reads: string[] = [];
  const warn = vi.fn();
  const mirror = new SessionMirror({
    snapshot: (sid) => {
      reads.push(sid);
      return { event_count: state.get(sid) ?? 0 } as unknown as never;
    },
    project: async (sid, p) => {
      if (block) await block;
      const own = blockFor.get(sid);
      if (own) await own;
      if (fail) throw fail;
      written.push([sid, (p as unknown as P).event_count]);
    },
    warn,
  });
  return {
    mirror,
    state,
    written,
    reads,
    warn,
    setBlock: (b: Promise<void> | null) => {
      block = b;
    },
    setFail: (e: unknown) => {
      fail = e;
    },
    blockFor,
  };
}

describe('SessionMirror', () => {
  it('a call made while a write runs gets a later write that reads the newer state', async () => {
    const t = setup();
    let open!: () => void;
    t.setBlock(new Promise<void>((r) => (open = r)));
    t.state.set('s1', 1);
    const first = t.mirror.mirror('s1');
    await Promise.resolve();
    t.state.set('s1', 2); // a second change commits while the first write is in flight
    const second = t.mirror.mirror('s1');
    t.setBlock(null);
    open();
    await Promise.all([first, second]);
    expect(t.written.at(-1)).toEqual(['s1', 2]);
  });

  it('a failed write warns and resolves', async () => {
    const t = setup();
    t.setFail(Object.assign(new Error('boom value-bearing'), { code: '57P01' }));
    await expect(t.mirror.mirror('s1')).resolves.toBeUndefined();
    expect(t.warn).toHaveBeenCalledTimes(1);
    expect(String(t.warn.mock.calls[0]?.[0])).toMatch(/s1.*57P01/);
    expect(String(t.warn.mock.calls[0]?.[0])).not.toMatch(/value-bearing/);
  });

  it('after a root timeout, the next write waits until the timed-out statement settles', async () => {
    const t = setup();
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    t.setFail(Object.assign(new Error('root timeout'), { name: 'CatalogRootTimeoutError', settled }));
    const first = t.mirror.mirror('s1');
    await Promise.resolve();
    t.setFail(null);
    t.state.set('s1', 5);
    const second = t.mirror.mirror('s1');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.written).toEqual([]); // still waiting on the timed-out statement
    settle();
    await Promise.all([first, second]);
    expect(t.written).toEqual([['s1', 5]]);
  });

  it('sessions don’t wait on each other', async () => {
    const t = setup();
    let open!: () => void;
    t.blockFor.set('slow', new Promise<void>((r) => (open = r)));
    const slow = t.mirror.mirror('slow');
    await t.mirror.mirror('fast');
    expect(t.written).toEqual([['fast', 0]]);
    open();
    await slow;
  });

  it('after close(), calls are no-ops and read no hub', async () => {
    const t = setup();
    await t.mirror.close();
    await t.mirror.mirror('s1');
    expect(t.reads).toEqual([]);
    expect(t.written).toEqual([]);
  });
});
