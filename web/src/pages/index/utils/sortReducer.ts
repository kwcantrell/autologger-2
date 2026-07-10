/** Shared column-sort state for the feed tables (Event / Transcribe / Topics). */
export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

/** Header-click reducer: clicking the active column toggles direction, a new column starts desc. */
export function clickSortReducer<K extends string>(state: SortState<K>, key: K): SortState<K> {
  if (state.key === key) return { key, dir: state.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'desc' };
}
