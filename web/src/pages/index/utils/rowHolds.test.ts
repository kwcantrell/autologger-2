import { describe, expect, it, vi } from 'vitest';
import { createRowHolds, createRowSeeds } from './rowHolds';
import { followServer } from './seedStore';

// session-edit-conflicts D3 (tasks 7.1-7.2): the holds that freeze a word or topic row's seed
// while the row has an edit, and the seed store's per-row change notifications that let every
// mounted copy of a row render its untouched controls from the current seed.

interface Row {
  id: string;
  version: number;
  text: string;
}
const row = (id: string, version: number, text = `${id}-v${version}`): Row => ({
  id,
  version,
  text,
});

describe('createRowHolds', () => {
  it('counts holds: a row stays held until every hold is released', () => {
    const holds = createRowHolds();
    expect(holds.has('a')).toBe(false);
    const r1 = holds.hold('a');
    const r2 = holds.hold('a');
    expect(holds.has('a')).toBe(true);
    r1();
    expect(holds.has('a')).toBe(true);
    r2();
    expect(holds.has('a')).toBe(false);
  });

  it('a release is idempotent and touches only its own row', () => {
    const holds = createRowHolds();
    const ra = holds.hold('a');
    const rb = holds.hold('b');
    const ra2 = holds.hold('a');
    ra();
    ra();
    expect(holds.has('a')).toBe(true);
    ra2();
    expect(holds.has('a')).toBe(false);
    expect(holds.has('b')).toBe(true);
    rb();
    expect(holds.has('b')).toBe(false);
  });
});

describe('createRowSeeds', () => {
  it('followServer moves an unheld row and leaves a held row at its seed', () => {
    const seeds = createRowSeeds<Row>();
    followServer(seeds.store, [row('a', 1), row('b', 1)], (r) => r.id, seeds.holds.has);
    const release = seeds.holds.hold('a');
    followServer(seeds.store, [row('a', 2), row('b', 2)], (r) => r.id, seeds.holds.has);
    expect(seeds.store.get('a')?.version).toBe(1);
    expect(seeds.store.get('b')?.version).toBe(2);
    release();
    followServer(seeds.store, [row('a', 3), row('b', 3)], (r) => r.id, seeds.holds.has);
    expect(seeds.store.get('a')?.version).toBe(3);
  });

  it('notifies a row’s subscribers when its seed changes, and only that row’s', () => {
    const seeds = createRowSeeds<Row>();
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = seeds.subscribe('a', onA);
    seeds.subscribe('b', onB);
    seeds.store.set('a', row('a', 1));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
    seeds.store.delete('a');
    expect(onA).toHaveBeenCalledTimes(2);
    offA();
    seeds.store.set('a', row('a', 2));
    expect(onA).toHaveBeenCalledTimes(2);
  });

  it('does not notify when a seed is set to the row it already holds', () => {
    const seeds = createRowSeeds<Row>();
    const r = row('a', 1);
    seeds.store.set('a', r);
    const onA = vi.fn();
    seeds.subscribe('a', onA);
    followServer(
      seeds.store,
      [r],
      (x) => x.id,
      () => false,
    );
    expect(onA).not.toHaveBeenCalled();
  });

  it('clearAll notifies every subscribed row', () => {
    const seeds = createRowSeeds<Row>();
    seeds.store.set('a', row('a', 1));
    const onA = vi.fn();
    const onB = vi.fn();
    seeds.subscribe('a', onA);
    seeds.subscribe('b', onB);
    seeds.store.clearAll();
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);
    expect(seeds.store.get('a')).toBeUndefined();
  });
});
