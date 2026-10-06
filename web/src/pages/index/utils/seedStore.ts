import { useRef } from 'react';

// --- Feed-owned seeds, the base of every versioned save (session-edit-conflicts D3) ---
//
// A row's SEED is the server row its controls were last filled from. A save
// sends `seed.version` as its base and decides what changed by comparing the
// controls against the seed — never against the cached row, whose version may
// already include another person's write the operator never saw. Every missed
// conflict the panel traced came from falling back to the cached row, so no
// surface has such a fallback: the seed is the only base.
//
// The FEED owns the seeds, keyed by row id, for the same reason it owns the
// drafts (draftStore.ts): virtualization unmounts rows that scroll past the
// overscan, and a remounted row must keep the base its draft was typed over.
// The feed clears it together with its drafts on a session change.
//
// Deliberately a mutable store behind stable callbacks rather than `useState`:
// nothing renders from a seed — it is read at save time and when a row
// remounts — so a write must not re-render the feed and every mounted row.

export interface SeedStore<TRow extends { version: number }> {
  get: (id: string) => TRow | undefined;
  /** Replaces this row's seed (a settled save's response row, Keep theirs'
   *  `current`, or the server row under the follow rule). */
  set: (id: string, seed: TRow) => void;
  /** Forgets this row's seed outright (the row is gone). */
  delete: (id: string) => void;
  /** Forgets every row's seed (the session changed). */
  clearAll: () => void;
}

export function createSeedStore<TRow extends { version: number }>(): SeedStore<TRow> {
  const map = new Map<string, TRow>();
  return {
    get: (id) => map.get(id),
    set: (id, seed) => {
      map.set(id, seed);
    },
    delete: (id) => {
      map.delete(id);
    },
    clearAll: () => {
      map.clear();
    },
  };
}

/** The D3 follow rule, applied by the feed whenever its list data changes:
 *  the seed follows the server row exactly while the row's controls do.
 *
 *  - A row that is not HELD takes the server row as its seed, in every mode
 *    (inline, batch or idle) — so batch and delete bases are the row the
 *    operator is looking at, and never cause false conflicts.
 *  - A HELD row (a draft, batch values, an `edit`, a save in flight or queued,
 *    or a focused inline row — the caller decides) keeps its seed: the
 *    operator's text was typed over that version, and moving the base under it
 *    would turn another person's write into a silent overwrite.
 *  - A held row with no seed yet still takes the server row, so every row the
 *    feed shows has a base; there is nothing older it could have been typed
 *    over. */
export function followServer<TRow extends { version: number }>(
  store: SeedStore<TRow>,
  rows: ReadonlyArray<TRow>,
  idOf: (row: TRow) => string,
  isHeld: (id: string) => boolean,
): void {
  for (const row of rows) {
    const id = idOf(row);
    if (isHeld(id) && store.get(id) !== undefined) continue;
    store.set(id, row);
  }
}

/** One store per mounted feed, with an identity stable for that feed's whole
 *  lifetime — rows take it as a prop, and a fresh identity per render would
 *  defeat their `memo`. */
export function useSeedStore<TRow extends { version: number }>(): SeedStore<TRow> {
  const storeRef = useRef<SeedStore<TRow> | null>(null);
  if (storeRef.current === null) storeRef.current = createSeedStore<TRow>();
  return storeRef.current;
}
