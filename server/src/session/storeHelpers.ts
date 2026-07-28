// Shared private helpers for the session domain stores (code-health-tail
// task 2.4, design D12): the partial-update patch builder and the
// insert-ordinal seed that topicStore and transcriptStore previously each
// hand-rolled. Internal to the store layer — nothing here is hub RPC surface.

import type { SessionCore, SqlValue } from './sessionCore';

/** Build the UPDATE SET fragments + bind values for a partial patch, in the
 * caller-given key order; keys whose patch value is `undefined` are skipped
 * (an explicit value, including '' or 0, is applied). Callers pass a literal
 * key list — the keys become SQL column names verbatim, never user input. */
export function buildPatch<K extends string>(
  patch: Partial<Record<K, SqlValue>>,
  keys: readonly K[],
): { cols: string[]; vals: SqlValue[] } {
  const cols: string[] = [];
  const vals: SqlValue[] = [];
  for (const key of keys) {
    const v = patch[key];
    if (v !== undefined) {
      cols.push(`${key} = ?`);
      vals.push(v);
    }
  }
  return { cols, vals };
}

/** Next insert ordinal for `table`: COALESCE(MAX(ordinal), -1) + 1 — 0-seeded,
 * so the first row gets ordinal 0 and deleting the MAX row frees its ordinal
 * for reuse (pinned in the store tests). `table` must be a literal table
 * name, never user input. (audioStore's 1-seeded ordinal is deliberately NOT
 * this helper.) */
export function nextOrdinal(core: SessionCore, table: string): number {
  return Number(core.first(`SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM ${table}`)?.n ?? 0);
}
