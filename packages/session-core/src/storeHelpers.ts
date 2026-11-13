// Shared private helpers for the session domain stores (code-health-tail
// task 2.4, design D12): the partial-update patch builder and the
// insert-ordinal seed that topicStore and transcriptStore previously each
// hand-rolled. Internal to the store layer — nothing here is hub RPC surface.

import type { Row, SessionCore, SqlValue, VersionExpectation } from './sessionCore';

/** Whether an edit's expected version differs from the stored row's (session-row-versions D4). No
 * expectation is never stale (last writer wins). */
export function staleVersion(expect: VersionExpectation | undefined, row: Row): boolean {
  return expect !== undefined && Number(row.version) !== expect.version;
}

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

/** Next insert ordinal for `table` in the core's session: COALESCE(MAX(ordinal), -1) + 1 —
 * 0-seeded, so the first row gets ordinal 0 and deleting the MAX row frees its ordinal
 * for reuse (pinned in the store tests). The session row lock held by every write makes the
 * read-then-insert safe across processes (session-tables D5). `table` must be a literal table
 * name, never user input. (audioStore's 1-seeded ordinal is deliberately NOT
 * this helper.) */
export async function nextOrdinal(core: SessionCore, table: string): Promise<number> {
  const r = await core.first(
    `SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM ${table} WHERE session_id = ?`,
    core.sessionId,
  );
  return Number(r?.n ?? 0);
}

/** The tables a keyed `(ordinal, id)` page reads; a closed list, so the name is never input. */
export type OrdinalTable =
  | 'session_transcript_words'
  | 'session_transcript_paragraphs'
  | 'session_topics';

/** One keyed page of an `(ordinal, id)`-ordered session table: the rows after `after`, at most
 * `limit` of them, in the order the whole reads use (`ORDER BY ordinal, id`). */
export function keyedOrdinalPage(
  core: SessionCore,
  table: OrdinalTable,
  after: { ordinal: number; id: string } | null,
  limit: number,
): Promise<Row[]> {
  const n = Math.max(0, Math.trunc(limit));
  if (after === null) {
    return core.all(
      `SELECT * FROM ${table} WHERE session_id = ? ORDER BY ordinal, id LIMIT ?`,
      core.sessionId,
      n,
    );
  }
  return core.all(
    `SELECT * FROM ${table}
      WHERE session_id = ? AND (ordinal, id) > (?::bigint, ?::text)
      ORDER BY ordinal, id LIMIT ?`,
    core.sessionId,
    Math.trunc(after.ordinal),
    after.id,
    n,
  );
}

/** The session's row count in one of the `(ordinal, id)` tables. */
export async function countRows(core: SessionCore, table: OrdinalTable): Promise<number> {
  const r = await core.first(
    `SELECT COUNT(*) AS c FROM ${table} WHERE session_id = ?`,
    core.sessionId,
  );
  return Number(r?.c ?? 0);
}
