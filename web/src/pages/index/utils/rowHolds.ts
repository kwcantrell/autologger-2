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

/** A feed's seeds and the holds that freeze them, handed to each row as one stable prop. */
export interface RowSeeds<TRow extends { version: number }> {
  store: SeedStore<TRow>;
  holds: RowHolds;
}

/** One pair per mounted owner, with an identity stable for its lifetime (rows are `memo`). */
export function useRowSeeds<TRow extends { version: number }>(): RowSeeds<TRow> {
  const ref = useRef<RowSeeds<TRow> | null>(null);
  if (ref.current === null)
    ref.current = { store: createSeedStore<TRow>(), holds: createRowHolds() };
  return ref.current;
}
