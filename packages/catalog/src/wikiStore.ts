// Show wiki store (OpenSpec change `show-wiki`, design D1-D4): pages, aliases and append-only
// revisions in `catalog.wiki_pages`, `catalog.wiki_aliases` and `catalog.wiki_revisions`.
//
// Runs under the caller's binding: every statement is filtered by the wiki policies, so a page in a
// show the user cannot access reads as missing (`null`, which the router answers with 404). Writes
// need a user binding, since every revision records its author.
//
// Each write is one catalog transaction (SERIALIZABLE; the adapter re-runs it on 40001), so the
// body only touches the catalog and the ids it needs are generated before it starts. The body:
// 1. reads the page(s) and decides not-found / merged / deleted / stale before any write;
// 2. refuses a `kind` change to or from `session`, a merge into itself or with a session page, and
//    a merge whose body or alias count would exceed the limits;
// 3. normalises the aliases (trim, dedupe on `catalog.search_norm`, drop one equal to the title);
// 4. pre-checks names with SELECTs: a live page (other than this one) whose title or alias matches
//    one of the new names (`WikiTitleTakenError`), or a live page of the same session
//    (`WikiSessionTakenError`). A unique violation would abort the transaction, so the holder could
//    not be looked up after one (`catalogDb.ts`: any error fails the whole transaction);
// 5. checks every `cite:`/`wiki:` link of each body it sets (the injected parser: the server passes
//    contract's `parseWikiLinks`, the parse the web
//    renders with): grammar, at most 500, sessions and pages of the page's show (hidden sessions
//    and deleted or merged pages are allowed);
// 6. writes with compare-and-set (`where id = ? and revision = ?`); if no row changed, a follow-up
//    read decides conflict, merged, deleted or not found.
// A stray unique violation (a race the serializable check did not catch) re-runs the whole
// transaction once, so its pre-check names the holder; a second one propagates.
// Create and edit are in-transaction steps (`createInTx`, `updateInTx`, taking an optional revision
// note), so the suggestion store (`wikiSuggestionStore.ts`, show-wiki-ai D2) accepts a suggestion
// with every rule of a manual save inside its own transaction.
//
// Revision notes (`wiki_revisions.note`), short and fixed:
//   `created`                   revision 1 of a page made by create
//   `edited`                    an edit
//   `restored r<n>`             an edit that restores revision n (`restoredFrom`)
//   `deleted` / `restored`      soft delete / undelete
//   `merged into <B id>`        the merged page A
//   `merged from <A id>`        the target page B
//   `split to <new id>`         the source page of a split
//   `split from <source id>`    revision 1 of the page a split created
//   `accepted suggestion <id>` [` (edited)`] / `created from suggestion <id>`: an accepted AI
//                               suggestion (wikiSuggestionStore.ts)
// Names are snapshotted from the writer's own `users` row: given and family name joined by a
// space, `""` when neither is set, never the email (design D1).

import { nowIso } from '@autologger/domain';
import type { CatalogDb } from '@autologger/ports';

/** One `cite:`/`wiki:` link as the injected parser reports it: the fields the store reads of
 * contract's `WikiLink` (design D4, "The store gets the parser by injection"). */
export interface WikiParsedLink {
  url: string;
  valid: boolean;
  sessionId?: string;
  pageId?: string;
}

/** What the injected parser returns; contract's `WikiLinksResult` is assignable to it. */
export interface WikiLinksParse {
  links: WikiParsedLink[];
  /** More than `WIKI_MAX_LINKS` links. */
  tooMany: boolean;
}

/** The link parser the store is given (`parseWikiLinks` from `@autologger/contract`). */
export type WikiLinksParser = (body: string) => WikiLinksParse;

/** Most `cite:`/`wiki:` links one body may hold (contract's `WIKI_MAX_LINKS`). */
export const WIKI_MAX_LINKS = 500;

export type WikiKind = 'person' | 'topic' | 'bit' | 'session';
export const WIKI_KINDS: readonly WikiKind[] = ['person', 'topic', 'bit', 'session'];

/** Limits of the show-wiki capability (the contract schema checks requests; the store re-checks
 * what it assembles itself, and the DB checks back both). */
export const WIKI_MAX_BODY = 100_000;
export const WIKI_MAX_ALIASES = 50;
/** Most pages one list returns (api-contract-freeze "Wiki page list and create endpoints"). */
export const WIKI_LIST_CAP = 2000;

/** The page object of api-contract-freeze "Wiki page object". */
export interface WikiPage {
  id: string;
  show_id: string;
  kind: WikiKind;
  title: string;
  body_md: string;
  aliases: string[];
  session_id: string | null;
  revision: number;
  merged_into: string | null;
  deleted: boolean;
  created_at_utc: string;
  created_by_name: string;
  updated_at_utc: string;
  updated_by_name: string;
}

export interface WikiPageListItem {
  id: string;
  kind: WikiKind;
  title: string;
  aliases: string[];
  session_id: string | null;
  revision: number;
  updated_at_utc: string;
  updated_by_name: string;
}

export interface WikiRevisionSummary {
  revision: number;
  title: string;
  kind: WikiKind;
  author_name: string;
  at_utc: string;
  note: string;
}

export interface WikiRevision extends WikiRevisionSummary {
  body_md: string;
  aliases: string[];
}

export interface WikiCreateInput {
  kind: WikiKind;
  title: string;
  bodyMd?: string;
  aliases?: string[];
  /** Required exactly when `kind` is `session`. */
  sessionId?: string | null;
}

export interface WikiUpdateInput {
  expectedRevision: number;
  title?: string;
  kind?: WikiKind;
  bodyMd?: string;
  /** Replaces the whole list. */
  aliases?: string[];
  /** A revision below the current one; only labels the new revision `restored r<n>`. */
  restoredFrom?: number;
}

export interface WikiSplitInput {
  expectedRevision: number;
  remainingBodyMd: string;
  newPage: { kind: WikiKind; title: string; bodyMd: string; aliases?: string[] };
}

export interface WikiListFilter {
  kind?: WikiKind;
  sessionId?: string;
  /** List deleted pages instead of live ones. Merged pages are never listed. */
  deleted?: boolean;
}

// -- errors (the router maps each to its 409 / 422 body) -------------------------------------------

/** `409 Version conflict.`: the expected revision is not current; `current` is the page now. */
export class WikiConflictError extends Error {
  override name = 'WikiConflictError';
  constructor(readonly current: WikiPage) {
    super('Version conflict.');
  }
}

/** `409 Page was merged.` */
export class WikiMergedError extends Error {
  override name = 'WikiMergedError';
  constructor(readonly mergedInto: string) {
    super('Page was merged.');
  }
}

/** `409 Page is deleted.` */
export class WikiDeletedError extends Error {
  override name = 'WikiDeletedError';
  constructor() {
    super('Page is deleted.');
  }
}

/** `409 Page is not deleted.` (restore of a live page). */
export class WikiNotDeletedError extends Error {
  override name = 'WikiNotDeletedError';
  constructor() {
    super('Page is not deleted.');
  }
}

/** `409 Title already used.` with the live page holding the name. */
export class WikiTitleTakenError extends Error {
  override name = 'WikiTitleTakenError';
  constructor(readonly pageId: string) {
    super('Title already used.');
  }
}

/** `409 Session already has a page.` with that page. */
export class WikiSessionTakenError extends Error {
  override name = 'WikiSessionTakenError';
  constructor(readonly pageId: string) {
    super('Session already has a page.');
  }
}

/** `422 {"detail": message}`: a rule the schema can't check. */
export class WikiInvalidError extends Error {
  override name = 'WikiInvalidError';
}

// -- rows -----------------------------------------------------------------------------------------

interface PageRow {
  id: string;
  show_id: string;
  kind: WikiKind;
  title: string;
  body_md: string;
  session_id: string | null;
  revision: number;
  merged_into: string | null;
  deleted_at_utc: string | null;
  created_at_utc: string;
  created_by_name: string;
  updated_at_utc: string;
  updated_by_name: string;
  aliases_json: unknown;
}

const PAGE_COLUMNS = `p.id, p.show_id, p.kind, p.title, p.body_md, p.session_id, p.revision,
  p.merged_into, p.deleted_at_utc, p.created_at_utc, p.created_by_name, p.updated_at_utc,
  p.updated_by_name, r.aliases_json`;

/** A page with the aliases of its newest revision: the saved order for a live page (whose alias
 * rows hold the same set), and what a merged or deleted page reports. */
const SELECT_PAGE = `select ${PAGE_COLUMNS}
  from wiki_pages p left join wiki_revisions r on r.page_id = p.id and r.revision = p.revision
  where p.id = ?`;

function jsonStrings(v: unknown): string[] {
  const raw = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(raw) ? raw.map(String) : [];
}

function pageOf(r: PageRow): WikiPage {
  return {
    id: r.id,
    show_id: r.show_id,
    kind: r.kind,
    title: r.title,
    body_md: r.body_md,
    aliases: jsonStrings(r.aliases_json),
    session_id: r.session_id ?? null,
    revision: Number(r.revision),
    merged_into: r.merged_into ?? null,
    deleted: r.deleted_at_utc !== null && r.deleted_at_utc !== undefined,
    created_at_utc: r.created_at_utc,
    created_by_name: r.created_by_name,
    updated_at_utc: r.updated_at_utc,
    updated_by_name: r.updated_by_name,
  };
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** U+0000-U+001F or U+007F: a title or alias is one line of plain text. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** A Markdown backslash before every ASCII punctuation character, so a title reads as plain text
 * inside the `## Merged from` heading (design D4). */
export function escapeMarkdownText(s: string): string {
  return s.replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`);
}

function isUniqueViolation(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 3; i++) {
    if ((x as { code?: unknown }).code === '23505') return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}

/** The signed-in writer of a wiki write: id, name snapshot and time. */
export interface WikiWriter {
  uid: string;
  name: string;
  at: string;
}

/** The wiki store's API surface (`catalog.wiki`). */
export type WikiStoreFacade = Pick<
  WikiStore,
  | 'listPages'
  | 'getPage'
  | 'listRevisions'
  | 'getRevision'
  | 'createPage'
  | 'updatePage'
  | 'deletePage'
  | 'restorePage'
  | 'mergePage'
  | 'splitPage'
>;

export class WikiStore implements WikiStoreFacade {
  /** Without `wikiLinks`, every write that sets a body fails closed (a plain `Error`, a 500), so
   * link validation is never skipped silently. */
  constructor(
    private readonly db: CatalogDb,
    private readonly wikiLinks?: WikiLinksParser,
  ) {}

  /** The configured parser, or the fail-closed error. */
  protected parser(): WikiLinksParser {
    if (!this.wikiLinks) throw new Error('wiki link parser not configured');
    return this.wikiLinks;
  }

  // -- reads ---------------------------------------------------------------------------------------

  async listPages(
    showId: string,
    filter: WikiListFilter = {},
  ): Promise<{ pages: WikiPageListItem[]; truncated: boolean }> {
    const rows = await this.db.all<PageRow>(
      `select ${PAGE_COLUMNS}
       from wiki_pages p left join wiki_revisions r on r.page_id = p.id and r.revision = p.revision
       where p.show_id = ? and p.merged_into is null
         and (case when ?::boolean then p.deleted_at_utc is not null else p.deleted_at_utc is null end)
         and (?::text is null or p.kind = ?::text)
         and (?::text is null or p.session_id = ?::text)
       order by catalog.search_norm(p.title), p.title, p.id
       limit ?`,
      showId,
      filter.deleted === true,
      filter.kind ?? null,
      filter.kind ?? null,
      filter.sessionId ?? null,
      filter.sessionId ?? null,
      WIKI_LIST_CAP + 1,
    );
    const pages = rows.slice(0, WIKI_LIST_CAP).map((r) => {
      const p = pageOf(r);
      return {
        id: p.id,
        kind: p.kind,
        title: p.title,
        aliases: p.aliases,
        session_id: p.session_id,
        revision: p.revision,
        updated_at_utc: p.updated_at_utc,
        updated_by_name: p.updated_by_name,
      };
    });
    return { pages, truncated: rows.length > WIKI_LIST_CAP };
  }

  /** The page, including merged and deleted pages; `null` when missing or not accessible. */
  async getPage(id: string): Promise<WikiPage | null> {
    return WikiStore.readIn(this.db, id);
  }

  /** Newest first, at most `limit` (1-100, default 50), below `before` when given; `nextBefore`
   * is the cursor for the next older page, `null` when none is left. `null` when the page is not
   * visible. */
  async listRevisions(
    id: string,
    opts: { limit?: number; before?: number | null },
  ): Promise<{ revisions: WikiRevisionSummary[]; nextBefore: number | null } | null> {
    const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 50)));
    return this.db.tx(async (t) => {
      if (!(await t.first('select 1 as ok from wiki_pages where id = ?', id))) return null;
      const rows = await t.all<WikiRevisionSummary>(
        `select revision, title, kind, author_name, at_utc, coalesce(note, '') as note
         from wiki_revisions where page_id = ? and (?::bigint is null or revision < ?::bigint)
         order by revision desc limit ?`,
        id,
        opts.before ?? null,
        opts.before ?? null,
        limit + 1,
      );
      const revisions = rows.slice(0, limit).map((r) => ({ ...r, revision: Number(r.revision) }));
      const more = rows.length > limit;
      return {
        revisions,
        nextBefore: more ? (revisions[revisions.length - 1]?.revision ?? null) : null,
      };
    });
  }

  /** One revision; `null` when the page is not visible or has no such revision. */
  async getRevision(id: string, revision: number): Promise<WikiRevision | null> {
    const r = await this.db.first<WikiRevisionSummary & { body_md: string; aliases_json: unknown }>(
      `select revision, title, kind, author_name, at_utc, coalesce(note, '') as note, body_md,
              aliases_json
       from wiki_revisions where page_id = ? and revision = ?`,
      id,
      revision,
    );
    if (!r) return null;
    return {
      revision: Number(r.revision),
      title: r.title,
      kind: r.kind,
      author_name: r.author_name,
      at_utc: r.at_utc,
      note: r.note,
      body_md: r.body_md,
      aliases: jsonStrings(r.aliases_json),
    };
  }

  // -- writes --------------------------------------------------------------------------------------

  async createPage(showId: string, input: WikiCreateInput): Promise<WikiPage> {
    this.parser();
    const id = crypto.randomUUID();
    return this.write((t) => this.createInTx(t, id, showId, input));
  }

  /** `null` when the page is missing or not accessible. An edit that changes nothing returns the
   * page unchanged and appends nothing. */
  async updatePage(id: string, input: WikiUpdateInput): Promise<WikiPage | null> {
    if (input.bodyMd !== undefined) this.parser();
    return this.write((t) => this.updateInTx(t, id, input));
  }

  /** The create pipeline as one step inside the caller's transaction `t` (show-wiki-ai D2). `id`
   * is generated before the transaction starts, so a retried transaction reuses it. `note` labels
   * revision 1 (default `created`). */
  protected async createInTx(
    t: CatalogDb,
    id: string,
    showId: string,
    input: WikiCreateInput,
    note = 'created',
  ): Promise<WikiPage> {
    const parse = this.parser();
    const kind = input.kind;
    if (!WIKI_KINDS.includes(kind)) throw new WikiInvalidError('Unknown page kind.');
    const sessionId = input.sessionId ?? null;
    if ((kind === 'session') !== (sessionId !== null)) {
      throw new WikiInvalidError(
        'A session page needs a session_id, and only a session page has one.',
      );
    }
    const title = input.title.trim();
    const body = input.bodyMd ?? '';
    const w = await WikiStore.writerOf(t);
    const aliases = await WikiStore.#normalise(t, title, input.aliases ?? []);
    WikiStore.checkLimits(title, body, aliases);
    if (kind === 'session') {
      if (aliases.length > 0) throw new WikiInvalidError('A session page has no aliases.');
      await WikiStore.#checkSession(t, showId, sessionId as string, id);
    } else {
      await WikiStore.#checkNames(t, showId, [title, ...aliases], [id]);
    }
    await WikiStore.checkLinksIn(parse, t, showId, body);
    await t.run(
      `insert into wiki_pages (id, show_id, kind, title, body_md, session_id, revision,
         merged_into, deleted_at_utc, created_by, created_by_name, created_at_utc, updated_by,
         updated_by_name, updated_at_utc)
       values (?, ?, ?, ?, ?, ?, 1, null, null, ?, ?, ?, ?, ?, ?)`,
      id,
      showId,
      kind,
      title,
      body,
      sessionId,
      w.uid,
      w.name,
      w.at,
      w.uid,
      w.name,
      w.at,
    );
    await WikiStore.#insertAliases(t, id, showId, aliases);
    await WikiStore.#insertRevision(t, w, id, 1, { title, kind, body_md: body, aliases }, note);
    return WikiStore.#mustRead(t, id);
  }

  /** The edit pipeline as one step inside the caller's transaction `t` (show-wiki-ai D2). `note`
   * labels the new revision; by default `edited`, or `restored r<n>` with `restoredFrom`. */
  protected async updateInTx(
    t: CatalogDb,
    id: string,
    input: WikiUpdateInput,
    note?: string,
  ): Promise<WikiPage | null> {
    const parse = input.bodyMd === undefined ? null : this.parser();
    const cur = await WikiStore.readIn(t, id);
    if (!cur) return null;
    WikiStore.#assertWritable(cur, input.expectedRevision);
    const kind = input.kind ?? cur.kind;
    if (!WIKI_KINDS.includes(kind)) throw new WikiInvalidError('Unknown page kind.');
    if (kind !== cur.kind && (kind === 'session' || cur.kind === 'session')) {
      throw new WikiInvalidError('A page kind cannot change to or from session.');
    }
    const restoredFrom = input.restoredFrom;
    if (
      restoredFrom !== undefined &&
      (!Number.isInteger(restoredFrom) || restoredFrom < 1 || restoredFrom >= cur.revision)
    ) {
      throw new WikiInvalidError('restored_from must name an earlier revision.');
    }
    const title = input.title === undefined ? cur.title : input.title.trim();
    const body = input.bodyMd ?? cur.body_md;
    const aliases =
      input.aliases === undefined && title === cur.title
        ? cur.aliases
        : await WikiStore.#normalise(t, title, input.aliases ?? cur.aliases);
    if (kind === 'session' && aliases.length > 0) {
      throw new WikiInvalidError('A session page has no aliases.');
    }
    WikiStore.checkLimits(title, body, aliases);
    if (
      title === cur.title &&
      kind === cur.kind &&
      body === cur.body_md &&
      sameList(aliases, cur.aliases)
    ) {
      return cur;
    }
    const w = await WikiStore.writerOf(t);
    if (kind !== 'session') await WikiStore.#checkNames(t, cur.show_id, [title, ...aliases], [id]);
    if (parse && body !== cur.body_md) await WikiStore.checkLinksIn(parse, t, cur.show_id, body);
    await WikiStore.#cas(
      t,
      id,
      cur.revision,
      'title = ?, kind = ?, body_md = ?',
      [title, kind, body],
      w,
    );
    if (!sameList(aliases, cur.aliases)) {
      await t.run('delete from wiki_aliases where page_id = ?', id);
      await WikiStore.#insertAliases(t, id, cur.show_id, aliases);
    }
    const label = note ?? (restoredFrom === undefined ? 'edited' : `restored r${restoredFrom}`);
    await WikiStore.#insertRevision(
      t,
      w,
      id,
      cur.revision + 1,
      { title, kind, body_md: body, aliases },
      label,
    );
    return WikiStore.#mustRead(t, id);
  }

  /** Soft delete; `null` when the page is missing or not accessible. */
  async deletePage(id: string, expectedRevision: number): Promise<WikiPage | null> {
    return this.write(async (t) => {
      const cur = await WikiStore.readIn(t, id);
      if (!cur) return null;
      WikiStore.#assertWritable(cur, expectedRevision);
      const w = await WikiStore.writerOf(t);
      await WikiStore.#cas(t, id, cur.revision, 'deleted_at_utc = ?', [w.at], w);
      await t.run('delete from wiki_aliases where page_id = ?', id);
      await WikiStore.#insertRevision(
        t,
        w,
        id,
        cur.revision + 1,
        WikiStore.#snapshot(cur),
        'deleted',
      );
      return WikiStore.#mustRead(t, id);
    });
  }

  /** Undelete; `null` when the page is missing or not accessible. */
  async restorePage(id: string, expectedRevision: number): Promise<WikiPage | null> {
    return this.write(async (t) => {
      const cur = await WikiStore.readIn(t, id);
      if (!cur) return null;
      if (cur.merged_into !== null) throw new WikiMergedError(cur.merged_into);
      if (!cur.deleted) throw new WikiNotDeletedError();
      if (cur.revision !== expectedRevision) throw new WikiConflictError(cur);
      const w = await WikiStore.writerOf(t);
      if (cur.kind === 'session') {
        await WikiStore.#checkSession(t, cur.show_id, cur.session_id as string, id);
      } else {
        await WikiStore.#checkNames(t, cur.show_id, [cur.title, ...cur.aliases], [id]);
      }
      await WikiStore.#cas(t, id, cur.revision, 'deleted_at_utc = null', [], w);
      if (cur.kind !== 'session') await WikiStore.#insertAliases(t, id, cur.show_id, cur.aliases);
      await WikiStore.#insertRevision(
        t,
        w,
        id,
        cur.revision + 1,
        WikiStore.#snapshot(cur),
        'restored',
      );
      return WikiStore.#mustRead(t, id);
    });
  }

  /** Merges page `id` (A) into `intoId` (B) and returns B. `null` when either page is missing, not
   * accessible, or B is in another show. */
  async mergePage(
    id: string,
    intoId: string,
    expectedRevision: number,
    intoExpectedRevision: number,
  ): Promise<WikiPage | null> {
    const parse = this.parser();
    if (id === intoId) throw new WikiInvalidError('A page cannot be merged into itself.');
    return this.write(async (t) => {
      const a = await WikiStore.readIn(t, id);
      const b = await WikiStore.readIn(t, intoId);
      if (!a || !b || a.show_id !== b.show_id) return null;
      for (const p of [a, b]) {
        if (p.merged_into !== null) throw new WikiMergedError(p.merged_into);
        if (p.deleted) throw new WikiDeletedError();
      }
      if (a.kind === 'session' || b.kind === 'session') {
        throw new WikiInvalidError('Session pages cannot be merged.');
      }
      if (a.revision !== expectedRevision) throw new WikiConflictError(a);
      if (b.revision !== intoExpectedRevision) throw new WikiConflictError(b);

      const heading = `## Merged from ${escapeMarkdownText(a.title)}`;
      const body = `${b.body_md === '' ? '' : `${b.body_md}\n\n`}${heading}\n\n${a.body_md}`;
      if (body.length > WIKI_MAX_BODY) {
        throw new WikiInvalidError(`The merged page would exceed ${WIKI_MAX_BODY} characters.`);
      }
      const aliases = await WikiStore.#normalise(t, b.title, [...b.aliases, a.title, ...a.aliases]);
      if (aliases.length > WIKI_MAX_ALIASES) {
        throw new WikiInvalidError(`The merged page would exceed ${WIKI_MAX_ALIASES} aliases.`);
      }
      const w = await WikiStore.writerOf(t);
      await WikiStore.#checkNames(t, b.show_id, [b.title, ...aliases], [a.id, b.id]);
      await WikiStore.checkLinksIn(parse, t, b.show_id, body);

      await WikiStore.#cas(t, a.id, a.revision, 'merged_into = ?', [b.id], w);
      await t.run('delete from wiki_aliases where page_id = ?', a.id);
      await WikiStore.#insertRevision(
        t,
        w,
        a.id,
        a.revision + 1,
        WikiStore.#snapshot(a),
        `merged into ${b.id}`,
      );
      await WikiStore.#cas(t, b.id, b.revision, 'body_md = ?', [body], w);
      await t.run('delete from wiki_aliases where page_id = ?', b.id);
      await WikiStore.#insertAliases(t, b.id, b.show_id, aliases);
      await WikiStore.#insertRevision(
        t,
        w,
        b.id,
        b.revision + 1,
        { title: b.title, kind: b.kind, body_md: body, aliases },
        `merged from ${a.id}`,
      );
      return WikiStore.#mustRead(t, b.id);
    });
  }

  /** Moves text out of page `id` into a new page; `null` when the page is missing or not
   * accessible. */
  async splitPage(
    id: string,
    input: WikiSplitInput,
  ): Promise<{ page: WikiPage; newPage: WikiPage } | null> {
    const parse = this.parser();
    const np = input.newPage;
    if (np.kind === 'session') throw new WikiInvalidError('A split cannot create a session page.');
    if (!WIKI_KINDS.includes(np.kind)) throw new WikiInvalidError('Unknown page kind.');
    const newId = crypto.randomUUID();
    const newTitle = np.title.trim();
    return this.write(async (t) => {
      const cur = await WikiStore.readIn(t, id);
      if (!cur) return null;
      WikiStore.#assertWritable(cur, input.expectedRevision);
      const aliases = await WikiStore.#normalise(t, newTitle, np.aliases ?? []);
      WikiStore.checkLimits(newTitle, np.bodyMd, aliases);
      WikiStore.checkLimits(cur.title, input.remainingBodyMd, []);
      const w = await WikiStore.writerOf(t);
      await WikiStore.#checkNames(t, cur.show_id, [newTitle, ...aliases], [newId]);
      await WikiStore.checkLinksIn(parse, t, cur.show_id, input.remainingBodyMd);
      await WikiStore.checkLinksIn(parse, t, cur.show_id, np.bodyMd);

      await WikiStore.#cas(t, id, cur.revision, 'body_md = ?', [input.remainingBodyMd], w);
      await WikiStore.#insertRevision(
        t,
        w,
        id,
        cur.revision + 1,
        { ...WikiStore.#snapshot(cur), body_md: input.remainingBodyMd },
        `split to ${newId}`,
      );
      await t.run(
        `insert into wiki_pages (id, show_id, kind, title, body_md, session_id, revision,
           merged_into, deleted_at_utc, created_by, created_by_name, created_at_utc, updated_by,
           updated_by_name, updated_at_utc)
         values (?, ?, ?, ?, ?, null, 1, null, null, ?, ?, ?, ?, ?, ?)`,
        newId,
        cur.show_id,
        np.kind,
        newTitle,
        np.bodyMd,
        w.uid,
        w.name,
        w.at,
        w.uid,
        w.name,
        w.at,
      );
      await WikiStore.#insertAliases(t, newId, cur.show_id, aliases);
      await WikiStore.#insertRevision(
        t,
        w,
        newId,
        1,
        { title: newTitle, kind: np.kind, body_md: np.bodyMd, aliases },
        `split from ${id}`,
      );
      return {
        page: await WikiStore.#mustRead(t, id),
        newPage: await WikiStore.#mustRead(t, newId),
      };
    });
  }

  // -- helpers -------------------------------------------------------------------------------------

  /** One catalog transaction; a unique violation re-runs it once (design D3). */
  protected async write<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.tx(fn);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return this.db.tx(fn);
    }
  }

  protected static async readIn(t: CatalogDb, id: string): Promise<WikiPage | null> {
    const r = await t.first<PageRow>(SELECT_PAGE, id);
    return r ? pageOf(r) : null;
  }

  static async #mustRead(t: CatalogDb, id: string): Promise<WikiPage> {
    const p = await WikiStore.readIn(t, id);
    if (!p) throw new Error(`wiki page ${id} vanished inside its own transaction`);
    return p;
  }

  /** Merged, deleted or stale: the 409 a write to `cur` gets. */
  static #assertWritable(cur: WikiPage, expectedRevision: number): void {
    if (cur.merged_into !== null) throw new WikiMergedError(cur.merged_into);
    if (cur.deleted) throw new WikiDeletedError();
    if (cur.revision !== expectedRevision) throw new WikiConflictError(cur);
  }

  /** Compare-and-set on the revision; when no row changed, a follow-up read decides the error. */
  static async #cas(
    t: CatalogDb,
    id: string,
    expected: number,
    set: string,
    binds: unknown[],
    w: WikiWriter,
  ): Promise<void> {
    const { changes } = await t.run(
      `update wiki_pages set ${set}, revision = revision + 1, updated_by = ?, updated_by_name = ?,
         updated_at_utc = ?
       where id = ? and revision = ?`,
      ...binds,
      w.uid,
      w.name,
      w.at,
      id,
      expected,
    );
    if (changes === 1) return;
    const now = await WikiStore.readIn(t, id);
    if (!now) throw new Error(`wiki page ${id} is no longer visible`);
    if (now.merged_into !== null) throw new WikiMergedError(now.merged_into);
    throw new WikiConflictError(now);
  }

  static #snapshot(p: WikiPage) {
    return { title: p.title, kind: p.kind, body_md: p.body_md, aliases: p.aliases };
  }

  /** The signed-in writer: id and name snapshot (given and family name, never the email). */
  protected static async writerOf(t: CatalogDb): Promise<WikiWriter> {
    const r = await t.first<{ uid: string | null; name: string | null }>(
      `select catalog.app_user_id() as uid,
              (select btrim(concat_ws(' ', nullif(btrim(u.given_name), ''), nullif(btrim(u.family_name), '')))
                 from users u where u.id = catalog.app_user_id()) as name`,
    );
    if (!r?.uid) throw new TypeError('wiki writes need a user binding');
    return { uid: r.uid, name: r.name ?? '', at: nowIso() };
  }

  /** The request limits of the show-wiki capability. The contract schema refuses these first; this
   * keeps the store from reaching a DB check (`23514`) with them. */
  protected static checkLimits(title: string, body: string, aliases: string[]): void {
    if (title.length < 1 || title.length > 200 || hasControl(title)) {
      throw new WikiInvalidError('A title is 1-200 characters of one line.');
    }
    if (body.length > WIKI_MAX_BODY || body.includes('\u0000')) {
      throw new WikiInvalidError(`A body is at most ${WIKI_MAX_BODY} characters, without NUL.`);
    }
    if (aliases.length > WIKI_MAX_ALIASES) {
      throw new WikiInvalidError(`A page has at most ${WIKI_MAX_ALIASES} aliases.`);
    }
    if (aliases.some((a) => a.length > 200 || hasControl(a))) {
      throw new WikiInvalidError('An alias is 1-200 characters of one line.');
    }
  }

  /** Trims, drops empties, dedupes on `catalog.search_norm` keeping the first spelling, and drops
   * an alias equal to `title`, in saved order. */
  static async #normalise(t: CatalogDb, title: string, aliases: string[]): Promise<string[]> {
    const trimmed = aliases.map((a) => String(a).trim()).filter((a) => a !== '');
    if (trimmed.length === 0) return [];
    const rows = await t.all<{ v: string; n: string }>(
      `select x.v, catalog.search_norm(x.v) as n
       from json_array_elements_text(?::text::json) with ordinality as x(v, o) order by x.o`,
      JSON.stringify([title, ...trimmed]),
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const [i, r] of rows.entries()) {
      if (seen.has(r.n)) continue;
      seen.add(r.n);
      if (i > 0) out.push(r.v);
    }
    return out;
  }

  /** A live non-session page of the show, other than `exclude`, holding one of `names` as its
   * title or an alias. */
  static async #checkNames(
    t: CatalogDb,
    showId: string,
    names: string[],
    exclude: string[],
  ): Promise<void> {
    const hit = await WikiStore.nameHolderIn(t, showId, names, exclude);
    if (hit !== null) throw new WikiTitleTakenError(hit);
  }

  /** The id of the live non-session page of the show, other than `exclude`, holding one of
   * `names` as its title or an alias; `null` when none does. */
  protected static async nameHolderIn(
    t: CatalogDb,
    showId: string,
    names: string[],
    exclude: string[],
  ): Promise<string | null> {
    const hit = await t.first<{ id: string }>(
      `with n as (select catalog.search_norm(v) as n from json_array_elements_text(?::text::json) v),
            x as (select v as id from json_array_elements_text(?::text::json) v)
       select p.id from wiki_pages p
       where p.show_id = ? and p.kind <> 'session' and p.merged_into is null
         and p.deleted_at_utc is null and p.id not in (select id from x)
         and catalog.search_norm(p.title) in (select n from n)
       union all
       select a.page_id from wiki_aliases a
       where a.show_id = ? and a.page_id not in (select id from x)
         and catalog.search_norm(a.alias) in (select n from n)
       limit 1`,
      JSON.stringify(names),
      JSON.stringify(exclude),
      showId,
      showId,
    );
    return hit ? hit.id : null;
  }

  /** The session is a session of the show, and no other live page is its session page. */
  static async #checkSession(
    t: CatalogDb,
    showId: string,
    sessionId: string,
    self: string,
  ): Promise<void> {
    const s = await t.first(
      'select 1 as ok from sessions where id = ? and show_id = ?',
      sessionId,
      showId,
    );
    if (!s) throw new WikiInvalidError('The session is not a session of this show.');
    const hit = await t.first<{ id: string }>(
      `select id from wiki_pages where show_id = ? and session_id = ? and id <> ?
         and merged_into is null and deleted_at_utc is null limit 1`,
      showId,
      sessionId,
      self,
    );
    if (hit) throw new WikiSessionTakenError(hit.id);
  }

  /** Every `cite:`/`wiki:` link of `body` is valid and points into the show (design D4). */
  protected static async checkLinksIn(
    parse: WikiLinksParser,
    t: CatalogDb,
    showId: string,
    body: string,
  ): Promise<void> {
    const { links, tooMany } = parse(body);
    if (tooMany) throw new WikiInvalidError(`A page may hold at most ${WIKI_MAX_LINKS} links.`);
    const bad = links.find((l) => !l.valid);
    if (bad) throw new WikiInvalidError(`Invalid link: ${bad.url}`);
    const sessionIds = [...new Set(links.flatMap((l) => (l.sessionId ? [l.sessionId] : [])))];
    const pageIds = [...new Set(links.flatMap((l) => (l.pageId ? [l.pageId] : [])))];
    const found = new Set<string>();
    if (sessionIds.length > 0) {
      const rows = await t.all<{ id: string }>(
        'select id from sessions where show_id = ? and id in (select json_array_elements_text(?::text::json))',
        showId,
        JSON.stringify(sessionIds),
      );
      for (const r of rows) found.add(`cite:${r.id}`);
    }
    if (pageIds.length > 0) {
      const rows = await t.all<{ id: string }>(
        'select id from wiki_pages where show_id = ? and id in (select json_array_elements_text(?::text::json))',
        showId,
        JSON.stringify(pageIds),
      );
      for (const r of rows) found.add(`wiki:${r.id}`);
    }
    const outside = links.find(
      (l) => !found.has(l.sessionId ? `cite:${l.sessionId}` : `wiki:${l.pageId}`),
    );
    if (outside) throw new WikiInvalidError(`Link outside this show: ${outside.url}`);
  }

  static async #insertAliases(
    t: CatalogDb,
    pageId: string,
    showId: string,
    aliases: string[],
  ): Promise<void> {
    if (aliases.length === 0) return;
    await t.run(
      `insert into wiki_aliases (page_id, show_id, alias)
       select ?, ?, v from json_array_elements_text(?::text::json) v`,
      pageId,
      showId,
      JSON.stringify(aliases),
    );
  }

  static async #insertRevision(
    t: CatalogDb,
    w: WikiWriter,
    pageId: string,
    revision: number,
    s: { title: string; kind: WikiKind; body_md: string; aliases: string[] },
    note: string,
  ): Promise<void> {
    await t.run(
      `insert into wiki_revisions (page_id, revision, title, kind, body_md, aliases_json,
         author_user_id, author_name, at_utc, note)
       values (?, ?, ?, ?, ?, ?::text::jsonb, ?, ?, ?, ?)`,
      pageId,
      revision,
      s.title,
      s.kind,
      s.body_md,
      JSON.stringify(s.aliases),
      w.uid,
      w.name,
      w.at,
      note,
    );
  }
}
