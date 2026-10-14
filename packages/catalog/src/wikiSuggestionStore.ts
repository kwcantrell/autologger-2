// AI wiki suggestions (OpenSpec change `show-wiki-ai`, design D2; show-wiki "AI suggestions",
// "Accepting a suggestion is a compare-and-set edit"), in `catalog.wiki_suggestions`, plus the read
// helpers the wiki tools use (design D3/D4).
//
// `WikiSuggestionStore` is the wiki store with the suggestion methods added, so they are exposed
// on the existing `catalog.wiki` facade and the catalog's store list doesn't change. It runs under
// the caller's binding like the wiki store: a suggestion of a show the user cannot access reads as
// missing (`null`, the router's masked 404).
//
// Each write is one SERIALIZABLE catalog transaction (the wiki store's `write`: a stray unique
// violation re-runs it once), with ids generated before it starts:
// - `saveRun` re-checks every proposal's shape and links, supersedes the older pending suggestion
//   of each target, and inserts the new rows as `pending` with the creator's name snapshot;
// - `acceptSuggestion` writes the page through the wiki store's own `updateInTx` / `createInTx`,
//   so it gets every rule of a manual save, then marks the suggestion `accepted`. Any wiki error
//   fails the transaction, so the suggestion stays `pending`;
// - `dismissSuggestion` marks a pending suggestion `dismissed`.
// Revision notes: `accepted suggestion <id>`, `accepted suggestion <id> (edited)` (an override
// differs from the suggestion's value), and `created from suggestion <id>` (revision 1 of a new
// page). Names are snapshots (`*_by_name`: given and family name, never the email).

import type { CatalogDb } from '@autologger/ports';
import {
  WIKI_KINDS,
  WikiInvalidError,
  type WikiKind,
  type WikiLinksParser,
  type WikiPage,
  WikiStore,
  type WikiStoreFacade,
} from './wikiStore';

export type WikiSuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'superseded';
export const WIKI_SUGGESTION_STATUSES: readonly WikiSuggestionStatus[] = [
  'pending',
  'accepted',
  'dismissed',
  'superseded',
];

/** Most suggestions one list returns (api-contract-freeze "Wiki suggestion list…"). */
export const WIKI_SUGGESTION_LIST_CAP = 500;
/** Longest body an AI proposal may hold (show-wiki-ai D4). */
export const WIKI_PROPOSAL_MAX_BODY = 30_000;
/** Longest rationale (catalog-database "Wiki suggestions table"). */
export const WIKI_MAX_RATIONALE = 500;

/** The suggestion object of api-contract-freeze "Wiki suggestion object". */
export interface WikiSuggestion {
  id: string;
  show_id: string;
  session_id: string;
  status: WikiSuggestionStatus;
  page_id: string | null;
  base_revision: number | null;
  kind: WikiKind;
  title: string;
  aliases: string[];
  rationale: string;
  page: { title: string; revision: number; state: 'live' | 'merged' | 'deleted' } | null;
  stale: boolean;
  created_at_utc: string;
  created_by_name: string;
  resolved_at_utc: string | null;
  resolved_by_name: string | null;
  resolved_revision: number | null;
}

/** The read endpoint's object: the suggestion plus its proposed body. */
export interface WikiSuggestionDetail extends WikiSuggestion {
  body_md: string;
}

/** What a proposal targets: an existing page and the revision it was written against, or a new
 * page (of the proposal's `kind` and `title`). */
export type WikiProposalTarget =
  | { type: 'page'; pageId: string; baseRevision: number }
  | { type: 'new' };

/** One checked proposal of a wiki-generation run, as `saveRun` stores it. */
export interface WikiProposal {
  target: WikiProposalTarget;
  kind: WikiKind;
  title: string;
  aliases: string[];
  bodyMd: string;
  rationale: string;
}

export interface WikiSuggestionListFilter {
  /** Default `pending`. */
  status?: WikiSuggestionStatus;
  pageId?: string;
}

/** "Edit, then accept" overrides; `expectedRevision` is required for an existing page. */
export interface WikiSuggestionAcceptInput {
  expectedRevision?: number;
  title?: string;
  bodyMd?: string;
  aliases?: string[];
}

export interface WikiSuggestionAcceptResult {
  page: WikiPage;
  suggestion: WikiSuggestion;
  /** A new page was created (the router's `201`). */
  created: boolean;
}

/** `409 Suggestion already resolved.` with the suggestion's status. */
export class WikiSuggestionResolvedError extends Error {
  override name = 'WikiSuggestionResolvedError';
  constructor(readonly status: WikiSuggestionStatus) {
    super('Suggestion already resolved.');
  }
}

// -- rows -----------------------------------------------------------------------------------------

interface SuggestionRow {
  id: string;
  show_id: string;
  session_id: string;
  status: WikiSuggestionStatus;
  page_id: string | null;
  base_revision: number | string | null;
  kind: WikiKind;
  title: string;
  aliases_json: unknown;
  rationale: string;
  created_at_utc: string;
  created_by_name: string;
  resolved_at_utc: string | null;
  resolved_by_name: string | null;
  resolved_revision: number | string | null;
  page_title: string | null;
  page_revision: number | string | null;
  page_merged_into: string | null;
  page_deleted_at_utc: string | null;
  body_md?: string;
}

const SUGGESTION_COLUMNS = `s.id, s.show_id, s.session_id, s.status, s.page_id, s.base_revision,
  s.kind, s.title, s.aliases_json, s.rationale, s.created_at_utc, s.created_by_name,
  s.resolved_at_utc, s.resolved_by_name, s.resolved_revision, p.title as page_title,
  p.revision as page_revision, p.merged_into as page_merged_into,
  p.deleted_at_utc as page_deleted_at_utc`;

const FROM_SUGGESTIONS = 'from wiki_suggestions s left join wiki_pages p on p.id = s.page_id';

const SELECT_DETAIL = `select ${SUGGESTION_COLUMNS}, s.body_md ${FROM_SUGGESTIONS}`;

function jsonStrings(v: unknown): string[] {
  const raw = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(raw) ? raw.map(String) : [];
}

const numOrNull = (v: number | string | null | undefined) =>
  v === null || v === undefined ? null : Number(v);

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function suggestionOf(r: SuggestionRow): WikiSuggestion {
  const baseRevision = numOrNull(r.base_revision);
  const pageRevision = numOrNull(r.page_revision);
  const page =
    r.page_id !== null && pageRevision !== null
      ? {
          title: r.page_title ?? '',
          revision: pageRevision,
          state: (r.page_merged_into != null
            ? 'merged'
            : r.page_deleted_at_utc != null
              ? 'deleted'
              : 'live') as 'live' | 'merged' | 'deleted',
        }
      : null;
  return {
    id: r.id,
    show_id: r.show_id,
    session_id: r.session_id,
    status: r.status,
    page_id: r.page_id ?? null,
    base_revision: baseRevision,
    kind: r.kind,
    title: r.title,
    aliases: jsonStrings(r.aliases_json),
    rationale: r.rationale,
    page,
    stale: page !== null && page.revision !== baseRevision,
    created_at_utc: r.created_at_utc,
    created_by_name: r.created_by_name,
    resolved_at_utc: r.resolved_at_utc ?? null,
    resolved_by_name: r.resolved_by_name ?? null,
    resolved_revision: numOrNull(r.resolved_revision),
  };
}

function detailOf(r: SuggestionRow): WikiSuggestionDetail {
  return { ...suggestionOf(r), body_md: r.body_md ?? '' };
}

function withoutBody(d: WikiSuggestionDetail): WikiSuggestion {
  const { body_md: _body, ...rest } = d;
  return rest;
}

/** The shape rules a stored proposal must meet: the page limits of a manual save, the AI body
 * cap and the rationale (design D4 step 1; this guards against a port bug, not the model). */
function checkProposalShape(p: WikiProposal): void {
  if (!WIKI_KINDS.includes(p.kind)) throw new WikiInvalidError('Unknown page kind.');
  if (p.target.type === 'page') {
    if (typeof p.target.pageId !== 'string' || p.target.pageId === '') {
      throw new WikiInvalidError('A page proposal needs a page id.');
    }
    if (!Number.isInteger(p.target.baseRevision) || p.target.baseRevision < 1) {
      throw new WikiInvalidError('A page proposal needs its base revision.');
    }
  } else if (p.target.type !== 'new') {
    throw new WikiInvalidError('Unknown proposal target.');
  }
  if (p.bodyMd.length > WIKI_PROPOSAL_MAX_BODY) {
    throw new WikiInvalidError(`A proposal body is at most ${WIKI_PROPOSAL_MAX_BODY} characters.`);
  }
  if (p.rationale.trim() === '' || p.rationale.length > WIKI_MAX_RATIONALE) {
    throw new WikiInvalidError(`A rationale is 1-${WIKI_MAX_RATIONALE} characters.`);
  }
  if (p.kind === 'session' && p.aliases.length > 0) {
    throw new WikiInvalidError('A session page has no aliases.');
  }
}

/** The suggestion methods and wiki-tool read helpers on `catalog.wiki` (design D2). */
export type WikiSuggestionStoreFacade = Pick<
  WikiSuggestionStore,
  | 'saveRun'
  | 'listSuggestions'
  | 'getSuggestion'
  | 'acceptSuggestion'
  | 'dismissSuggestion'
  | 'checkLinks'
  | 'normalize'
  | 'nameHolder'
  | 'pendingFor'
  | 'pendingNewPages'
  | 'sessionPageId'
>;

/** The whole `catalog.wiki` surface: pages and suggestions. */
export type WikiFacade = WikiStoreFacade & WikiSuggestionStoreFacade;

export class WikiSuggestionStore extends WikiStore implements WikiFacade {
  readonly #sdb: CatalogDb;

  /** Without `wikiLinks`, `saveRun`, an accept and `checkLinks` fail closed, as every wiki write
   * that sets a body does. */
  constructor(db: CatalogDb, wikiLinks?: WikiLinksParser) {
    super(db, wikiLinks);
    this.#sdb = db;
  }

  // -- suggestions ---------------------------------------------------------------------------------

  /** Stores one run's proposals as `pending` suggestions, in proposal order, superseding each
   * target's older pending suggestion, all in one transaction. Returns the stored suggestions. */
  async saveRun(
    showId: string,
    sessionId: string,
    runId: string,
    proposals: WikiProposal[],
  ): Promise<WikiSuggestion[]> {
    if (proposals.length === 0) return [];
    const parse = this.parser();
    const items = proposals.map((p) => {
      checkProposalShape(p);
      const title = p.title.trim();
      WikiStore.checkLimits(title, p.bodyMd, p.aliases);
      return { p, title, id: crypto.randomUUID() };
    });
    const pageIds = items.flatMap((x) => (x.p.target.type === 'page' ? [x.p.target.pageId] : []));
    if (new Set(pageIds).size !== pageIds.length) {
      throw new WikiInvalidError('Two proposals target the same page.');
    }
    return this.write(async (t) => {
      const w = await WikiStore.writerOf(t);
      const newTitles = items.flatMap((x) => (x.p.target.type === 'new' ? [x.title] : []));
      const norms = await WikiSuggestionStore.#normalizeIn(t, newTitles);
      if (new Set(norms).size !== norms.length) {
        throw new WikiInvalidError('Two proposals target the same new page.');
      }
      for (const { p } of items) await WikiStore.checkLinksIn(parse, t, showId, p.bodyMd);
      for (const { p, title } of items) {
        if (p.target.type === 'page') {
          await t.run(
            `update wiki_suggestions set status = 'superseded'
             where show_id = ? and status = 'pending' and page_id = ?`,
            showId,
            p.target.pageId,
          );
        } else {
          await t.run(
            `update wiki_suggestions set status = 'superseded'
             where show_id = ? and status = 'pending' and page_id is null
               and catalog.search_norm(title) = catalog.search_norm(?)`,
            showId,
            title,
          );
        }
      }
      for (const { p, title, id } of items) {
        const target = p.target.type === 'page' ? p.target : null;
        await t.run(
          `insert into wiki_suggestions (id, show_id, session_id, run_id, page_id, base_revision,
             kind, title, body_md, aliases_json, rationale, status, created_by, created_by_name,
             created_at_utc)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::text::jsonb, ?, 'pending', ?, ?, ?)`,
          id,
          showId,
          sessionId,
          runId,
          target?.pageId ?? null,
          target?.baseRevision ?? null,
          p.kind,
          title,
          p.bodyMd,
          JSON.stringify(p.aliases),
          p.rationale,
          w.uid,
          w.name,
          w.at,
        );
      }
      const rows = await t.all<SuggestionRow>(
        `select ${SUGGESTION_COLUMNS} ${FROM_SUGGESTIONS}
         where s.id in (select json_array_elements_text(?::text::json))`,
        JSON.stringify(items.map((x) => x.id)),
      );
      const byId = new Map(rows.map((r) => [r.id, suggestionOf(r)]));
      return items.map((x) => {
        const s = byId.get(x.id);
        if (!s) throw new Error(`wiki suggestion ${x.id} vanished inside its own transaction`);
        return s;
      });
    });
  }

  /** The show's suggestions of one status (default `pending`), optionally for one page, newest
   * first, at most 500. */
  async listSuggestions(
    showId: string,
    filter: WikiSuggestionListFilter = {},
  ): Promise<{ suggestions: WikiSuggestion[]; truncated: boolean }> {
    const status = filter.status ?? 'pending';
    if (!WIKI_SUGGESTION_STATUSES.includes(status)) {
      throw new WikiInvalidError('Unknown suggestion status.');
    }
    const rows = await this.#sdb.all<SuggestionRow>(
      `select ${SUGGESTION_COLUMNS} ${FROM_SUGGESTIONS}
       where s.show_id = ? and s.status = ? and (?::text is null or s.page_id = ?::text)
       order by s.created_at_utc desc, s.id desc
       limit ?`,
      showId,
      status,
      filter.pageId ?? null,
      filter.pageId ?? null,
      WIKI_SUGGESTION_LIST_CAP + 1,
    );
    return {
      suggestions: rows.slice(0, WIKI_SUGGESTION_LIST_CAP).map(suggestionOf),
      truncated: rows.length > WIKI_SUGGESTION_LIST_CAP,
    };
  }

  /** The suggestion with its body; `null` when missing or not accessible. */
  async getSuggestion(id: string): Promise<WikiSuggestionDetail | null> {
    return WikiSuggestionStore.#readDetail(this.#sdb, id);
  }

  /** Accepts a pending suggestion as a compare-and-set edit (or a create, for a new page) authored
   * by the caller. `null` when the suggestion is missing or not accessible. */
  async acceptSuggestion(
    id: string,
    input: WikiSuggestionAcceptInput,
  ): Promise<WikiSuggestionAcceptResult | null> {
    this.parser();
    const newId = crypto.randomUUID();
    return this.write(async (t) => {
      const s = await WikiSuggestionStore.#readDetail(t, id);
      if (!s) return null;
      if (s.status !== 'pending') throw new WikiSuggestionResolvedError(s.status);
      const title = input.title ?? s.title;
      const bodyMd = input.bodyMd ?? s.body_md;
      const aliases = input.aliases ?? s.aliases;
      let page: WikiPage;
      let created: boolean;
      if (s.page_id !== null) {
        if (input.expectedRevision === undefined) {
          throw new WikiInvalidError('expected_revision is required.');
        }
        const edited =
          title.trim() !== s.title || bodyMd !== s.body_md || !sameList(aliases, s.aliases);
        const note = `accepted suggestion ${id}${edited ? ' (edited)' : ''}`;
        const updated = await this.updateInTx(
          t,
          s.page_id,
          { expectedRevision: input.expectedRevision, title, bodyMd, aliases },
          note,
        );
        if (!updated) throw new Error(`wiki page ${s.page_id} is not visible`);
        page = updated;
        created = false;
      } else {
        page = await this.createInTx(
          t,
          newId,
          s.show_id,
          {
            kind: s.kind,
            title,
            bodyMd,
            aliases,
            sessionId: s.kind === 'session' ? s.session_id : null,
          },
          `created from suggestion ${id}`,
        );
        created = true;
      }
      await WikiSuggestionStore.#resolve(t, s, 'accepted', page.revision);
      const after = await WikiSuggestionStore.#readDetail(t, id);
      if (!after) throw new Error(`wiki suggestion ${id} vanished inside its own transaction`);
      return { page, suggestion: withoutBody(after), created };
    });
  }

  /** Dismisses a pending suggestion; `null` when missing or not accessible. */
  async dismissSuggestion(id: string): Promise<WikiSuggestion | null> {
    return this.write(async (t) => {
      const s = await WikiSuggestionStore.#readDetail(t, id);
      if (!s) return null;
      if (s.status !== 'pending') throw new WikiSuggestionResolvedError(s.status);
      await WikiSuggestionStore.#resolve(t, s, 'dismissed', null);
      const after = await WikiSuggestionStore.#readDetail(t, id);
      if (!after) throw new Error(`wiki suggestion ${id} vanished inside its own transaction`);
      return withoutBody(after);
    });
  }

  // -- read helpers for the wiki tools (design D2/D3) ----------------------------------------------

  /** The link problems of `bodyMd` for the show, exactly as a manual save finds them; `[]` when
   * every link is fine. */
  async checkLinks(showId: string, bodyMd: string): Promise<string[]> {
    try {
      await WikiStore.checkLinksIn(this.parser(), this.#sdb, showId, bodyMd);
      return [];
    } catch (e) {
      if (e instanceof WikiInvalidError) return [e.message];
      throw e;
    }
  }

  /** Each text through `catalog.search_norm`, in order: the fold of the unique indexes. */
  async normalize(texts: string[]): Promise<string[]> {
    return WikiSuggestionStore.#normalizeIn(this.#sdb, texts);
  }

  /** The live page of the show holding one of `names` as its title or an alias; `null` if none. */
  async nameHolder(showId: string, names: string[]): Promise<string | null> {
    if (names.length === 0) return null;
    return WikiStore.nameHolderIn(this.#sdb, showId, names, []);
  }

  /** The pending suggestion for a page, or for a new page whose title matches `normTitle` ignoring
   * case and accents; `null` when there is none. */
  async pendingFor(
    showId: string,
    target: { pageId: string } | { normTitle: string },
  ): Promise<WikiSuggestionDetail | null> {
    const r =
      'pageId' in target
        ? await this.#sdb.first<SuggestionRow>(
            `${SELECT_DETAIL} where s.show_id = ? and s.status = 'pending' and s.page_id = ?`,
            showId,
            target.pageId,
          )
        : await this.#sdb.first<SuggestionRow>(
            `${SELECT_DETAIL} where s.show_id = ? and s.status = 'pending' and s.page_id is null
               and catalog.search_norm(s.title) = catalog.search_norm(?)`,
            showId,
            target.normTitle,
          );
    return r ? detailOf(r) : null;
  }

  /** The show's pending new-page suggestions, newest first, at most 500. */
  async pendingNewPages(showId: string): Promise<WikiSuggestion[]> {
    const rows = await this.#sdb.all<SuggestionRow>(
      `select ${SUGGESTION_COLUMNS} ${FROM_SUGGESTIONS}
       where s.show_id = ? and s.status = 'pending' and s.page_id is null
       order by s.created_at_utc desc, s.id desc
       limit ?`,
      showId,
      WIKI_SUGGESTION_LIST_CAP,
    );
    return rows.map(suggestionOf);
  }

  /** The live session page of the show's session; `null` when it has none. */
  async sessionPageId(showId: string, sessionId: string): Promise<string | null> {
    const r = await this.#sdb.first<{ id: string }>(
      `select id from wiki_pages where show_id = ? and session_id = ?
         and merged_into is null and deleted_at_utc is null limit 1`,
      showId,
      sessionId,
    );
    return r ? r.id : null;
  }

  // -- helpers -------------------------------------------------------------------------------------

  static async #readDetail(t: CatalogDb, id: string): Promise<WikiSuggestionDetail | null> {
    const r = await t.first<SuggestionRow>(`${SELECT_DETAIL} where s.id = ?`, id);
    return r ? detailOf(r) : null;
  }

  static async #normalizeIn(t: CatalogDb, texts: string[]): Promise<string[]> {
    if (texts.length === 0) return [];
    const rows = await t.all<{ n: string }>(
      `select catalog.search_norm(x.v) as n
       from json_array_elements_text(?::text::json) with ordinality as x(v, o) order by x.o`,
      JSON.stringify(texts),
    );
    return rows.map((r) => r.n);
  }

  /** Pending → `accepted` (with the revision written) or `dismissed`, by the caller. */
  static async #resolve(
    t: CatalogDb,
    s: WikiSuggestion,
    status: 'accepted' | 'dismissed',
    revision: number | null,
  ): Promise<void> {
    const w = await WikiStore.writerOf(t);
    const { changes } = await t.run(
      `update wiki_suggestions set status = ?, resolved_by = ?, resolved_by_name = ?,
         resolved_at_utc = ?, resolved_revision = ?
       where id = ? and status = 'pending'`,
      status,
      w.uid,
      w.name,
      w.at,
      revision,
      s.id,
    );
    if (changes === 1) return;
    const now = await WikiSuggestionStore.#readDetail(t, s.id);
    throw new WikiSuggestionResolvedError(now?.status ?? s.status);
  }
}
