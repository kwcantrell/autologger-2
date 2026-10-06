import { useRef } from 'react';
import { createSeedStore, type SeedStore } from './seedStore';

// --- Which rows hold an `edit` (session-edit-conflicts D3, words and topics) ---
//
// The D3 follow rule moves a row's seed to the server row only while the row's controls do. For
// transcript words and topics the controls are a row-local `edit` snapshot, which the feed cannot
// see; a row therefore registers a HOLD for as long as its `edit` exists, and the feed's
// `followServer` treats a held row as frozen. Without it, focusing a row and leaving without
// typing would compare the old controls against a seed that had already followed another
// person's change, and send the old text as an edit (panel finding, "focus without typing").
//
// Counted, not a set: a hold is released by the effect cleanup of the row that took it, and a
// remount (virtualization, StrictMode, a Keep-theirs epoch) can briefly overlap two copies.

export interface RowHolds {
  /** Marks `id` held; returns the release (idempotent). */
  hold: (id: string) => () => void;
  has: (id: string) => boolean;
}

export function createRowHolds(): RowHolds {
  const counts = new Map<string, number>();
  return {
    hold: (id) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (counts.get(id) ?? 1) - 1;
        if (n <= 0) counts.delete(id);
        else counts.set(id, n);
      };
    },
    has: (id) => (counts.get(id) ?? 0) > 0,
  };
}

/** A feed's seeds and the holds that freeze them, handed to each row as one stable prop.
 *
 *  The store notifies per row: a row renders its untouched controls from its CURRENT seed
 *  (never a snapshot frozen into row state), so when the feed rebases a seed after a save,
 *  every mounted copy of that row, including one virtualization rebuilt mid-save, re-renders
 *  with the saved row's text. A control frozen at the old seed's text would otherwise be sent
 *  on its next blur against the newer base: a silent revert. */
export interface RowSeeds<TRow extends { version: number }> {
  store: SeedStore<TRow>;
  holds: RowHolds;
  /** Calls `onChange` whenever row `id`'s seed changes; returns the unsubscribe. */
  subscribe: (id: string, onChange: () => void) => () => void;
}

export function createRowSeeds<TRow extends { version: number }>(): RowSeeds<TRow> {
  const inner = createSeedStore<TRow>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (id: string) => {
    for (const l of [...(listeners.get(id) ?? [])]) l();
  };
  const store: SeedStore<TRow> = {
    get: inner.get,
    set: (id, seed) => {
      if (inner.get(id) === seed) return;
      inner.set(id, seed);
      notify(id);
    },
    delete: (id) => {
      if (inner.get(id) === undefined) return;
      inner.delete(id);
      notify(id);
    },
    clearAll: () => {
      inner.clearAll();
      for (const id of [...listeners.keys()]) notify(id);
    },
  };
  return {
    store,
    holds: createRowHolds(),
    subscribe: (id, onChange) => {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(onChange);
      return () => {
        const s = listeners.get(id);
        if (!s) return;
        s.delete(onChange);
        if (s.size === 0) listeners.delete(id);
      };
    },
  };
}

/** One per mounted owner, with an identity stable for its lifetime (rows are `memo`). */
export function useRowSeeds<TRow extends { version: number }>(): RowSeeds<TRow> {
  const ref = useRef<RowSeeds<TRow> | null>(null);
  if (ref.current === null) ref.current = createRowSeeds<TRow>();
  return ref.current;
}
