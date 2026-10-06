import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { createSeedStore, followServer, type SeedStore, useSeedStore } from './seedStore';

// --- The seed: the server row a row's controls were last filled from (D3) ---
//
// A save sends the seed's version and compares the controls against the seed,
// never the cached row. These cases pin the store itself and the one follow
// rule every feed applies when its list data changes. A `.tsx` (jsdom project)
// because the hook cases render a feed.

interface Row {
  id: string;
  text: string;
  version: number;
}

const row = (id: string, text: string, version: number): Row => ({ id, text, version });
const idOf = (r: Row) => r.id;

describe('createSeedStore', () => {
  it('gets what was set, forgets one row on delete, and every row on clearAll', () => {
    const store = createSeedStore<Row>();
    expect(store.get('a')).toBeUndefined();
    store.set('a', row('a', 'x', 1));
    store.set('b', row('b', 'y', 3));
    expect(store.get('a')).toEqual(row('a', 'x', 1));
    store.delete('a');
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')?.version).toBe(3);
    store.clearAll();
    expect(store.get('b')).toBeUndefined();
  });
});

describe('followServer', () => {
  it('moves an unheld row to the server row and leaves a held row on its seed', () => {
    const store = createSeedStore<Row>();
    store.set('held', row('held', 'mine', 1));
    store.set('free', row('free', 'old', 1));
    followServer(
      store,
      [row('held', 'theirs', 2), row('free', 'new', 2)],
      idOf,
      (id) => id === 'held',
    );
    expect(store.get('held')).toEqual(row('held', 'mine', 1));
    expect(store.get('free')).toEqual(row('free', 'new', 2));
  });

  it('seeds a held row that has no seed yet from the server row', () => {
    const store = createSeedStore<Row>();
    followServer(store, [row('a', 'first', 4)], idOf, () => true);
    expect(store.get('a')).toEqual(row('a', 'first', 4));
  });
});

describe('useSeedStore', () => {
  it('keeps an entry after the consumer that wrote it unmounts', () => {
    let store: SeedStore<Row> | null = null;
    function Consumer({ seeds }: { seeds: SeedStore<Row> }) {
      useEffect(() => {
        seeds.set('a', row('a', 'typed over', 7));
      }, [seeds]);
      return null;
    }
    let setShown: (v: boolean) => void = () => {};
    function Feed() {
      const seeds = useSeedStore<Row>();
      store = seeds;
      const [shown, set] = useState(true);
      setShown = set;
      return shown ? <Consumer seeds={seeds} /> : null;
    }
    render(<Feed />);
    act(() => setShown(false));
    expect(store).not.toBeNull();
    expect((store as unknown as SeedStore<Row>).get('a')?.version).toBe(7);
  });

  it('has a stable identity, and a write re-renders nothing', () => {
    const seen: Array<SeedStore<Row>> = [];
    let renders = 0;
    let bump: () => void = () => {};
    function Feed() {
      const seeds = useSeedStore<Row>();
      renders += 1;
      seen.push(seeds);
      const [, setN] = useState(0);
      bump = () => setN((n) => n + 1);
      return null;
    }
    render(<Feed />);
    const before = renders;
    act(() => {
      seen[0].set('a', row('a', 'x', 1));
      seen[0].delete('a');
      seen[0].clearAll();
    });
    expect(renders).toBe(before);
    act(() => bump());
    expect(new Set(seen).size).toBe(1);
    const { get, set, delete: del, clearAll } = seen[0];
    const last = seen[seen.length - 1];
    expect([last.get, last.set, last.delete, last.clearAll]).toEqual([get, set, del, clearAll]);
  });
});
