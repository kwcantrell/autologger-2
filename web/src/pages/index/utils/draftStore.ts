import { useRef } from 'react';

// --- Feed-owned edit drafts, shared by the two virtualized feeds ---
//
// Both feeds (EventLogSheet's log rows, TranscribeFeed's transcript rows) mount
// only the visible window of `<tr>`s, so a row's DOM — and, before this, the
// only copy of an in-progress edit — disappears the moment the row scrolls past
// the overscan. React fires no blur on unmount, so a blur-to-commit row loses
// the operator's typing silently: scrolling back shows the server value again,
// with no error and no toast.
//
// The answer both feeds now use is the same: the FEED owns the drafts, keyed by
// row id, and each row writes through on every keystroke and reads back when it
// remounts. This module is that primitive, extracted so the two feeds cannot
// drift apart on the one rule that is easy to get wrong — WHEN a draft stops
// being live (`clearMatching` below).
//
// Deliberately a mutable store behind stable callbacks rather than `useState`:
// nothing RENDERS from a draft except a freshly mounted row's initial value, so
// keystrokes must not re-render the feed and every mounted row with it.

// A per-row draft (`TDraft` below) is an all-optional record of raw control
// text: optional because only the controls the operator actually touched are
// recorded, and RAW because a draft has to be able to hold text that has no
// parsed form at all (a half-typed date). Each feed declares its own shape.

export interface DraftStore<TDraft extends object> {
  read: (id: string) => TDraft | undefined;
  /** Merges `patch` into whatever this row already has recorded. */
  write: (id: string, patch: TDraft) => void;
  /** Forgets this row's draft outright. */
  clear: (id: string) => void;
  /** Forgets only the `covered` fields whose recorded text is EXACTLY
   *  `reference`'s. A covered field that has DIVERGED from the reference is
   *  kept, and a field outside `covered` is kept untouched — the reference
   *  says nothing about it.
   *
   *  This is the one comparison the feeds share, and it is always made in DRAFT
   *  space — raw control text against raw control text. Comparing in value
   *  space (trimmed, parsed, normalized) reports "unchanged" for text the
   *  control is still displaying: a half-typed date has no parsed form at all
   *  and falls back to the original, and a trimmed message hides trailing
   *  whitespace. Clearing on such a match deletes text the row is showing,
   *  which the next remount then silently reverts.
   *
   *  `covered` is separate from `reference` — and required — because the two
   *  answer different questions, and a caller that let the reference answer
   *  both got it silently wrong. WHICH fields a clear speaks for is decided by
   *  what the save PERSISTED (or, for a server refresh, the whole row); WHAT to
   *  compare them against is the raw text, which for a partial save has to be
   *  read from somewhere wider than the patch. Passing the row's whole draft as
   *  the reference of a ONE-field save cleared every sibling field too: each
   *  one trivially equalled itself, so nothing looked diverged, and the next
   *  remount reverted text no save had ever persisted. Naming the covered set
   *  makes that claim visible and refutable at the call site.
   *
   *  Callers pass whichever reference makes "this covered field is spent" true
   *  for them: what a just-resolved save actually submitted, or the text the
   *  controls would render from the current server row. */
  clearMatching: (id: string, reference: TDraft, covered: ReadonlyArray<keyof TDraft>) => void;
  /** Forgets every row's draft (edit mode ended, or the session changed). */
  clearAll: () => void;
}

/** The `clearMatching` rule as a pure function, so both the store and any
 *  caller that needs the surviving fields without mutating can use it.
 *  Returns `undefined` when nothing survives. */
export function retainDivergentFields<TDraft extends object>(
  current: TDraft | undefined,
  reference: TDraft,
  covered: ReadonlyArray<keyof TDraft>,
): TDraft | undefined {
  if (!current) return undefined;
  // Spent: covered by this clear AND still exactly the reference text.
  const spent = new Set<keyof TDraft>();
  for (const field of covered) {
    const value = current[field];
    if (value !== undefined && value === reference[field]) spent.add(field);
  }
  // Everything else the draft carries survives — including fields this clear
  // never spoke for.
  let survivors: TDraft | undefined;
  for (const field of Object.keys(current) as Array<keyof TDraft>) {
    const value = current[field];
    if (value === undefined || spent.has(field)) continue;
    survivors ??= {} as TDraft;
    survivors[field] = value;
  }
  return survivors;
}

/** The subset of `fields` that `patch` actually carries — the `covered` list
 *  for a caller whose persisted field set IS the patch it sent. Filtering the
 *  declared field list (rather than `Object.keys`) keeps the result typed as
 *  `keyof TDraft` with no cast. */
export function presentFields<TDraft extends object>(
  patch: TDraft,
  fields: ReadonlyArray<keyof TDraft>,
): Array<keyof TDraft> {
  return fields.filter((field) => patch[field] !== undefined);
}

/** The store itself is field-list-free: WHICH fields a clear speaks for is a
 *  property of that clear, not of the store (see `clearMatching`). Feeds still
 *  declare an exhaustive field list at module scope next to their draft
 *  interface, with `satisfies ReadonlyArray<keyof TDraft>` so adding a field to
 *  the interface without listing it fails the compiler — it is what a
 *  whole-row clear passes as `covered`, and what `presentFields` filters. */
export function createDraftStore<TDraft extends object>(): DraftStore<TDraft> {
  const map = new Map<string, TDraft>();
  return {
    read: (id) => map.get(id),
    write: (id, patch) => {
      const prev = map.get(id);
      map.set(id, prev ? { ...prev, ...patch } : { ...patch });
    },
    clear: (id) => {
      map.delete(id);
    },
    clearMatching: (id, reference, covered) => {
      const survivors = retainDivergentFields(map.get(id), reference, covered);
      if (survivors) map.set(id, survivors);
      else map.delete(id);
    },
    clearAll: () => {
      map.clear();
    },
  };
}

/** One store per mounted feed, with an identity stable for that feed's whole
 *  lifetime — rows take it as a prop, and a fresh identity per render would
 *  defeat their `memo` (and, in EventLogSheet, churn the virtualizer options
 *  that read it). */
export function useDraftStore<TDraft extends object>(): DraftStore<TDraft> {
  const storeRef = useRef<DraftStore<TDraft> | null>(null);
  if (storeRef.current === null) storeRef.current = createDraftStore<TDraft>();
  return storeRef.current;
}
