// The session query service (custom session dashboards J5; design
// docs/design/custom-session-dashboards.md sections 3.1, 5.2, 5.3 and 5.4; mcp-session-data).
//
// It answers the model-visible read tools of `/mcp` (J5) and, later, the dashboard queries of the
// View and the web viewer (J8, J9). Every call re-authorizes from its own arguments: a session
// through `requireSession`, a show through `requireShowAccess`, a studio through the caller's
// membership. Nothing here trusts a cursor for authority.
//
// The paging contract (section 5.2):
// - `limit` defaults per tool and is clamped to the tool's maximum, never refused;
// - the cursor is base64url JSON `{v: 1, t: tool, s: scope id, k: position key, r: revision}`; a
//   cursor for another tool or scope, or one that doesn't parse, is `Invalid cursor.`;
// - the next page is a keyed read after the key, in the order the store itself sorts by, so each
//   page reads at most `limit` rows;
// - a page is capped at 40,000 characters of serialized structured content: it ends early with
//   `truncated: true`, and its cursor continues from the last item it includes;
// - when the revision the cursor carries differs from the current one, the page still continues
//   after the key and `note` says so.

import { createHash } from 'node:crypto';
import {
  computeEventCounts,
  computeEventDensity,
  computeFillerStats,
  computeSessionDuration,
  computeTalkTimeBySpeaker,
  computeTopicTimeline,
  computeUtteranceStats,
} from '@autologger/ai-runtime/aggregates';
import type { CatalogFacade, Row, WikiAssociationRow } from '@autologger/catalog';
import { citationsOf, parseWikiLinks } from '@autologger/contract';
import { enrichEventRpc } from '@autologger/domain';
import type { SessionHubFacade } from '@autologger/session-core';

/** The most characters of serialized structured content one result holds (section 5.2). */
export const PAGE_MAX_CHARS = 40_000;

/** The fixed tool error texts this service raises (section 5.1). */
export const SESSION_NOT_FOUND = 'Session not found';
export const STUDIO_NOT_FOUND = 'Studio not found';
export const SHOW_NOT_FOUND = 'Show not found.';
export const INVALID_CURSOR = 'Invalid cursor.';

/** The `note` of a page whose cursor saw an older revision (section 5.2). */
export const CHANGED_NOTE = 'session changed since the first page';
/** The `note` of a page that skipped one item larger than the page cap on its own. */
export const OVERSIZE_NOTE = 'an item over the 40,000-character page cap was skipped';

/** A refusal with one of the fixed texts; the MCP layer answers it as the tool error. */
export class QueryError extends Error {
  override name = 'QueryError';
}

/** Each list tool's default and maximum `limit` (section 5.3, section 13.3 item 9). */
export const TOOL_LIMITS = {
  list_shows: { def: 50, max: 200 },
  list_sessions: { def: 50, max: 200 },
  list_events: { def: 200, max: 500 },
  list_transcript_paragraphs: { def: 100, max: 300 },
  list_transcript_words: { def: 1000, max: 3000 },
  list_topics: { def: 200, max: 500 },
  list_wiki_pages: { def: 20, max: 50 },
} as const;

export type PagedTool = keyof typeof TOOL_LIMITS;

/** `get_wiki_page`'s `max_chars` default and maximum (section 5.3). */
export const WIKI_PAGE_CHARS = { def: 20_000, max: 40_000 } as const;
/** `list_studios` returns every membership, at most this many (section 5.3). */
export const LIST_STUDIOS_MAX = 100;

/** A missing limit is the default; one above the maximum is the maximum; below 1 is 1. */
export function clampLimit(
  limit: number | undefined,
  bounds: { def: number; max: number },
): number {
  if (limit === undefined) return bounds.def;
  return Math.min(bounds.max, Math.max(1, Math.trunc(limit)));
}

// ── cursors ──────────────────────────────────────────────────────────────────────────────────

interface CursorBody {
  v: 1;
  t: string;
  s: string;
  k: unknown;
  r: number;
}

export function encodeCursor(tool: string, scope: string, key: unknown, revision: number): string {
  const body: CursorBody = { v: 1, t: tool, s: scope, k: key, r: revision };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** The cursor's key and revision, or `Invalid cursor.` when it doesn't parse, isn't version 1, is
 * for another tool or scope, or its key isn't the tool's shape. */
export function decodeCursor<K>(
  raw: string,
  tool: string,
  scope: string,
  isKey: (k: unknown) => k is K,
): { key: K; revision: number } {
  let body: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('not base64url');
    body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new QueryError(INVALID_CURSOR);
  }
  const b = body as Partial<CursorBody> | null;
  if (
    b === null ||
    typeof b !== 'object' ||
    b.v !== 1 ||
    b.t !== tool ||
    b.s !== scope ||
    typeof b.r !== 'number' ||
    !Number.isFinite(b.r) ||
    !isKey(b.k)
  ) {
    throw new QueryError(INVALID_CURSOR);
  }
  return { key: b.k, revision: b.r };
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** `[wall_time_utc, id]` */
export type EventKey = [string, string];
const isEventKey = (k: unknown): k is EventKey =>
  Array.isArray(k) && k.length === 2 && isString(k[0]) && isString(k[1]);
/** `[ordinal, id]` */
export type OrdinalKey = [number, string];
const isOrdinalKey = (k: unknown): k is OrdinalKey =>
  Array.isArray(k) && k.length === 2 && isSafeInt(k[0]) && isString(k[1]);
/** `[rule, page_id]` */
export type WikiKey = [number, string];
const isWikiKey = (k: unknown): k is WikiKey =>
  Array.isArray(k) && k.length === 2 && (k[0] === 1 || k[0] === 2 || k[0] === 3) && isString(k[1]);
const isIdKey = (k: unknown): k is string => isString(k);

// ── pages ────────────────────────────────────────────────────────────────────────────────────

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
  truncated: boolean;
  note?: string;
}

/**
 * One page from `rows` (already the next rows after the cursor, at most `limit`): as many as fit
 * the 40,000-character cap, with the cursor after the last one included. A full read (`limit`
 * rows) gets a cursor even when nothing follows, so the walk may end on an empty page. One row
 * larger than the cap on its own is skipped, with a note, so a walk never stalls on it.
 */
export function buildPage<T, K>(
  rows: readonly T[],
  opts: {
    tool: string;
    scope: string;
    limit: number;
    total: number;
    /** The revision the next cursor carries: the first page's, through the whole walk. */
    revision: number;
    keyOf: (row: T) => K;
    notes?: string[];
  },
): Page<T> {
  const notes = [...(opts.notes ?? [])];
  const envelope = (cursor: string | null, truncated: boolean, extra: string[]) => {
    const all = [...notes, ...extra];
    return {
      items: [] as T[],
      next_cursor: cursor,
      total: opts.total,
      truncated,
      ...(all.length > 0 ? { note: all.join('; ') } : {}),
    };
  };
  const cursorAt = (row: T) => encodeCursor(opts.tool, opts.scope, opts.keyOf(row), opts.revision);

  const items: T[] = [];
  let itemChars = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as T;
    const rowChars = JSON.stringify(row).length + (items.length > 0 ? 1 : 0);
    // The worst case for this page: truncated (`false` is longer than `true`), with this row's
    // cursor and an oversize note if one might be added.
    const base = JSON.stringify(envelope(cursorAt(row), false, [OVERSIZE_NOTE])).length;
    if (base + itemChars + rowChars > PAGE_MAX_CHARS) {
      if (items.length === 0) {
        // This row alone is over the cap: skip it and continue after it.
        return { ...envelope(cursorAt(row), true, [OVERSIZE_NOTE]) };
      }
      const last = items[items.length - 1] as T;
      return { ...envelope(cursorAt(last), true, []), items };
    }
    items.push(row);
    itemChars += rowChars;
  }
  const full = rows.length >= opts.limit && rows.length > 0;
  const cursor = full ? cursorAt(rows[rows.length - 1] as T) : null;
  return { ...envelope(cursor, false, []), items };
}

/** The rows of an in-memory sorted list after `after` (or all), at most `limit`. */
function sliceAfter<T, K>(
  sorted: readonly T[],
  keyOf: (row: T) => K,
  after: K | null,
  compare: (a: K, b: K) => number,
  limit: number,
): T[] {
  const start = after === null ? 0 : sorted.findIndex((r) => compare(keyOf(r), after) > 0);
  return start < 0 ? [] : sorted.slice(start, start + limit);
}

/** Code-unit order, as the catalog's `collate "C"` columns sort ASCII ids. */
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ── the caller ───────────────────────────────────────────────────────────────────────────────

/** What one call needs: the caller's user and catalog, and the route helpers that authorize. */
export interface QueryCaller {
  userId: string;
  catalog: CatalogFacade;
  /** The session's index row when the caller reads it; throws `QueryError(SESSION_NOT_FOUND)`. */
  requireSession(sessionId: string): Promise<Row>;
  /** The show row when the caller can access it; throws `QueryError(SHOW_NOT_FOUND)`. */
  requireShowAccess(showId: string): Promise<Row>;
  /** The session's hub bound to the caller. */
  hub(sessionId: string): Promise<SessionHubFacade>;
}

interface PageArgs {
  cursor?: string;
  limit?: number;
}

/** The decoded cursor (or none), and the note when the revision moved since the first page. */
function resume<K>(
  args: PageArgs,
  tool: string,
  scope: string,
  isKey: (k: unknown) => k is K,
): { after: K | null; seen: number | null } {
  if (args.cursor === undefined) return { after: null, seen: null };
  const { key, revision } = decodeCursor(args.cursor, tool, scope, isKey);
  return { after: key, seen: revision };
}

function changedNotes(seen: number | null, current: number): string[] {
  return seen !== null && seen !== current ? [CHANGED_NOTE] : [];
}

// ── studios, shows and sessions ──────────────────────────────────────────────────────────────

export async function listStudios(q: QueryCaller) {
  const ids = await q.catalog.auth.authListStudioIdsForUser(q.userId);
  const names = q.catalog.studios.studioNamesDict();
  const items: { studio_id: string; name: string; role: string }[] = [];
  for (const id of ids.slice(0, LIST_STUDIOS_MAX)) {
    const role = await q.catalog.auth.authGetMembershipRole(q.userId, id);
    if (role === null) continue;
    items.push({ studio_id: id, name: names[id] ?? '', role });
  }
  return { items, total: items.length };
}

export async function listShows(q: QueryCaller, args: PageArgs & { studio_id: string }) {
  const tool = 'list_shows';
  const role = await q.catalog.auth.authGetMembershipRole(q.userId, args.studio_id);
  if (role === null) throw new QueryError(STUDIO_NOT_FOUND);
  const { after } = resume(args, tool, args.studio_id, isIdKey);
  const limit = clampLimit(args.limit, TOOL_LIMITS.list_shows);
  const accessible = await q.catalog.auth.authListAccessibleShowIds(q.userId);
  const rows = (await q.catalog.shows.listShowsForStudio(args.studio_id))
    .map((r) => ({
      show_id: String(r.id),
      name: String(r.name ?? ''),
      show_code: String(r.show_code ?? ''),
      can_access: accessible.has(String(r.id)),
    }))
    .sort((a, b) => cmpStr(a.show_id, b.show_id));
  const page = sliceAfter(rows, (r) => r.show_id, after, cmpStr, limit);
  return buildPage(page, {
    tool,
    scope: args.studio_id,
    limit,
    total: rows.length,
    revision: 0,
    keyOf: (r) => r.show_id,
  });
}

export async function listSessions(
  q: QueryCaller,
  args: PageArgs & { show_id: string; include_hidden?: boolean },
) {
  const tool = 'list_sessions';
  await q.requireShowAccess(args.show_id);
  const { after } = resume(args, tool, args.show_id, isIdKey);
  const limit = clampLimit(args.limit, TOOL_LIMITS.list_sessions);
  const rows = (
    await q.catalog.sessions.listSessionsForShow(args.show_id, {
      includeHidden: args.include_hidden === true,
    })
  )
    .map((r) => ({
      session_id: String(r.id),
      title: String(r.title ?? ''),
      date: sessionDate(r),
      archived: Number(r.archived ?? 0) !== 0,
      hidden: Number(r.ui_hidden ?? 0) !== 0,
    }))
    .sort((a, b) => cmpStr(a.session_id, b.session_id));
  const page = sliceAfter(rows, (r) => r.session_id, after, cmpStr, limit);
  return buildPage(page, {
    tool,
    scope: args.show_id,
    limit,
    total: rows.length,
    revision: 0,
    keyOf: (r) => r.session_id,
  });
}

/** The session's date: its episode date when set, else when it started. */
function sessionDate(r: Row): string {
  const episode = r.episode_date == null ? '' : String(r.episode_date);
  return episode || String(r.started_at_utc ?? '');
}

export async function getSession(q: QueryCaller, args: { session_id: string }) {
  const row = await q.requireSession(args.session_id);
  const showId = String(row.show_id);
  const studioId = (await q.catalog.sessions.getSessionStudioId(args.session_id)) ?? '';
  const counts = await (await q.hub(args.session_id)).contentCounts();
  const wiki = await associatedPages(q, args.session_id, showId);
  return {
    session_id: args.session_id,
    show_id: showId,
    studio_id: studioId,
    title: String(row.title ?? ''),
    date: sessionDate(row),
    fps: Number(row.frame_rate ?? 0),
    counts: {
      events: counts.events,
      words: counts.words,
      paragraphs: counts.paragraphs,
      topics: counts.topics,
      wiki_pages: wiki.length,
    },
    revision: counts.revision,
  };
}

// ── session content ──────────────────────────────────────────────────────────────────────────

export async function listEvents(q: QueryCaller, args: PageArgs & { session_id: string }) {
  const tool = 'list_events';
  await q.requireSession(args.session_id);
  const { after, seen } = resume(args, tool, args.session_id, isEventKey);
  const limit = clampLimit(args.limit, TOOL_LIMITS.list_events);
  const profile = await q.catalog.sessions.studioProfileForSession(args.session_id);
  const hub = await q.hub(args.session_id);
  const res = await hub.listEventsAfter({
    after: after === null ? null : { wall_time_utc: after[0], id: after[1] },
    limit,
  });
  const rows = res.events.map((e) => ({
    key: [e.wall_time_utc, e.event_id] as EventKey,
    item: enrichEventRpc(e, profile),
  }));
  return unwrap(
    buildPage(rows, {
      tool,
      scope: args.session_id,
      limit,
      total: res.total,
      revision: seen ?? res.revision,
      keyOf: (r) => r.key,
      notes: changedNotes(seen, res.revision),
    }),
  );
}

export async function listTranscriptWords(q: QueryCaller, args: PageArgs & { session_id: string }) {
  const tool = 'list_transcript_words';
  await q.requireSession(args.session_id);
  const { after, seen } = resume(args, tool, args.session_id, isOrdinalKey);
  const limit = clampLimit(args.limit, TOOL_LIMITS.list_transcript_words);
  const res = await (await q.hub(args.session_id)).listTranscriptWordsAfter({
    after: after === null ? null : { ordinal: after[0], id: after[1] },
    limit,
  });
  const rows = res.words.map((w) => ({
    key: [w.ordinal, w.id] as OrdinalKey,
    item: {
      ordinal: w.ordinal,
      session_time: w.session_time,
      speaker: w.speaker,
      word: w.word,
      start_sec: w.start_sec,
      end_sec: w.end_sec,
    },
  }));
  return unwrap(
    buildPage(rows, {
      tool,
      scope: args.session_id,
      limit,
      total: res.total,
      revision: seen ?? res.revision,
      keyOf: (r) => r.key,
      notes: changedNotes(seen, res.revision),
    }),
  );
}

export async function listTranscriptParagraphs(
  q: QueryCaller,
  args: PageArgs & { session_id: string },
) {
  const tool = 'list_transcript_paragraphs';
  await q.requireSession(args.session_id);
  const { after, seen } = resume(args, tool, args.session_id, isOrdinalKey);
  const limit = clampLimit(args.limit, TOOL_LIMITS.list_transcript_paragraphs);
  const res = await (await q.hub(args.session_id)).listTranscriptParagraphsAfter({
    after: after === null ? null : { ordinal: after[0], id: after[1] },
    limit,
  });
  const rows = res.paragraphs.map((p) => ({
    key: [p.ordinal, p.id] as OrdinalKey,
    item: {
      ordinal: p.ordinal,
      speaker: p.speaker,
      // Paragraphs store no session time of their own; `start_sec` places them.
      session_time: null,
      start_sec: p.start_sec,
      end_sec: p.end_sec,
      text: p.text,
    },
  }));
  return unwrap(
    buildPage(rows, {
      tool,
      scope: args.session_id,
      limit,
      total: res.total,
      revision: seen ?? res.revision,
      keyOf: (r) => r.key,
      notes: changedNotes(seen, res.revision),
    }),
  );
}

export async function listTopics(q: QueryCaller, args: PageArgs & { session_id: string }) {
  const tool = 'list_topics';
  await q.requireSession(args.session_id);
  const { after, seen } = resume(args, tool, args.session_id, isOrdinalKey);
  const limit = clampLimit(args.limit, TOOL_LIMITS.list_topics);
  const res = await (await q.hub(args.session_id)).listTopicsAfter({
    after: after === null ? null : { ordinal: after[0], id: after[1] },
    limit,
  });
  const rows = res.topics.map((t) => ({ key: [t.ordinal, t.id] as OrdinalKey, item: t }));
  return unwrap(
    buildPage(rows, {
      tool,
      scope: args.session_id,
      limit,
      total: res.total,
      revision: seen ?? res.revision,
      keyOf: (r) => r.key,
      notes: changedNotes(seen, res.revision),
    }),
  );
}

/** A page of `{key, item}` rows as a page of items. */
function unwrap<T>(page: Page<{ key: unknown; item: T }>): Page<T> {
  return { ...page, items: page.items.map((r) => r.item) };
}

// ── associated wiki pages (section 5.4) ──────────────────────────────────────────────────────

export type WikiAssociation = 'session_page' | 'cites_session' | 'linked_from_session_page';
const ASSOCIATION_OF_RULE: Record<1 | 2 | 3, WikiAssociation> = {
  1: 'session_page',
  2: 'cites_session',
  3: 'linked_from_session_page',
};

export interface AssociatedPage {
  rule: 1 | 2 | 3;
  page: WikiAssociationRow;
}

/**
 * The wiki pages associated with session `sessionId` of show `showId`, in `(rule, page_id)`
 * order, each once under its first rule:
 * 1. the session's own page;
 * 2. a page whose current body cites the session (`citationsOf`, the renderer's parser),
 *    pre-filtered in the database to bodies holding `cite:<session>@`;
 * 3. a page the session page links to with `wiki:` (one hop).
 * Only live, unmerged pages of the show, read under the caller's binding (wiki policies apply).
 */
export async function associatedPages(
  q: QueryCaller,
  sessionId: string,
  showId: string,
): Promise<AssociatedPage[]> {
  const candidates = await q.catalog.wiki.listAssociationCandidates(showId, sessionId);
  const out = new Map<string, AssociatedPage>();
  const sessionPage =
    candidates.find((p) => p.kind === 'session' && p.session_id === sessionId) ?? null;
  if (sessionPage !== null) out.set(sessionPage.id, { rule: 1, page: sessionPage });
  for (const p of candidates) {
    if (out.has(p.id)) continue;
    if (citationsOf(p.body_md).some((c) => c.sessionId === sessionId)) {
      out.set(p.id, { rule: 2, page: p });
    }
  }
  if (sessionPage !== null) {
    const ids = parseWikiLinks(sessionPage.body_md)
      .links.filter((l) => l.valid && l.kind === 'wiki' && l.pageId !== undefined)
      .map((l) => l.pageId as string)
      .filter((id) => !out.has(id));
    for (const p of await q.catalog.wiki.listLivePagesByIds(showId, ids)) {
      if (!out.has(p.id)) out.set(p.id, { rule: 3, page: p });
    }
  }
  return [...out.values()].sort((a, b) => a.rule - b.rule || cmpStr(a.page.id, b.page.id));
}

const compareWikiKey = (a: WikiKey, b: WikiKey) => a[0] - b[0] || cmpStr(a[1], b[1]);

/** A 48-bit fingerprint of the associated set (rule, id and revision of each page), the
 * `list_wiki_pages` cursor's revision: any edit, rename, addition or removal changes it. */
function associationFingerprint(pages: readonly AssociatedPage[]): number {
  const h = createHash('sha256');
  for (const a of pages) h.update(`${a.rule}\n${a.page.id}\n${a.page.revision}\n`);
  return Number.parseInt(h.digest('hex').slice(0, 12), 16);
}

export async function listWikiPages(q: QueryCaller, args: PageArgs & { session_id: string }) {
  const tool = 'list_wiki_pages';
  const row = await q.requireSession(args.session_id);
  const { after, seen } = resume(args, tool, args.session_id, isWikiKey);
  const limit = clampLimit(args.limit, TOOL_LIMITS.list_wiki_pages);
  const all = await associatedPages(q, args.session_id, String(row.show_id));
  const fingerprint = associationFingerprint(all);
  const keyOf = (a: AssociatedPage): WikiKey => [a.rule, a.page.id];
  const rows = sliceAfter(all, keyOf, after, compareWikiKey, limit).map((a) => ({
    key: keyOf(a),
    item: {
      page_id: a.page.id,
      kind: a.page.kind,
      title: a.page.title,
      aliases: a.page.aliases,
      revision: a.page.revision,
      association: ASSOCIATION_OF_RULE[a.rule],
      body_chars: a.page.body_md.length,
    },
  }));
  return unwrap(
    buildPage(rows, {
      tool,
      scope: args.session_id,
      limit,
      total: all.length,
      revision: seen ?? fingerprint,
      keyOf: (r) => r.key,
      notes: seen !== null && seen !== fingerprint ? [CHANGED_NOTE] : [],
    }),
  );
}

/** A slice end that doesn't split a surrogate pair. */
function safeEnd(body: string, end: number): number {
  if (end <= 0 || end >= body.length) return Math.max(0, Math.min(end, body.length));
  const prev = body.charCodeAt(end - 1);
  return prev >= 0xd800 && prev <= 0xdbff ? end - 1 : end;
}

export async function getWikiPage(
  q: QueryCaller,
  args: { session_id: string; page_id: string; offset?: number; max_chars?: number },
) {
  const row = await q.requireSession(args.session_id);
  const found = (await associatedPages(q, args.session_id, String(row.show_id))).find(
    (a) => a.page.id === args.page_id,
  );
  // A page that exists but isn't associated with this session reads as missing too.
  if (found === undefined) throw new QueryError('Wiki page not found');
  const body = found.page.body_md;
  const offset = Math.min(body.length, Math.max(0, Math.trunc(args.offset ?? 0)));
  const maxChars = Math.min(
    WIKI_PAGE_CHARS.max,
    Math.max(1, Math.trunc(args.max_chars ?? WIKI_PAGE_CHARS.def)),
  );
  const shape = (end: number) => ({
    page_id: found.page.id,
    kind: found.page.kind,
    title: found.page.title,
    revision: found.page.revision,
    body_md: body.slice(offset, end),
    offset,
    next_offset: end < body.length ? end : null,
    body_chars: body.length,
  });
  // Escaping can make the serialized slice longer than its characters, so shrink to the cap.
  let end = safeEnd(body, offset + maxChars);
  let result = shape(end);
  for (;;) {
    const over = JSON.stringify(result).length - PAGE_MAX_CHARS;
    if (over <= 0 || end <= offset) break;
    end = safeEnd(body, Math.max(offset, end - Math.max(over, 1)));
    result = shape(end);
  }
  return result;
}

// ── aggregates ───────────────────────────────────────────────────────────────────────────────

/** The `aggregates.ts` results for the session, each `{available, reason?}` as computed there
 * (ai-v2-dashboards "Data unavailability is a rendered state, never a zero"). Unpaged: it reads
 * the session's rows and returns only the small computed shapes. */
export async function getSessionAggregates(q: QueryCaller, args: { session_id: string }) {
  await q.requireSession(args.session_id);
  const hub = await q.hub(args.session_id);
  const words = await hub.listTranscriptWords();
  const { paragraphs } = await hub.listTranscriptEnrichment();
  const topics = await hub.listTopics();
  const events = await hub.exportEvents();
  const duration = computeSessionDuration(words);
  return {
    session_duration: duration,
    talk_time: computeTalkTimeBySpeaker(words),
    utterances: computeUtteranceStats(paragraphs),
    fillers: computeFillerStats(words),
    topic_timeline: computeTopicTimeline(topics),
    event_counts: computeEventCounts(events),
    event_density: computeEventDensity(events, duration.durationSec),
  };
}
