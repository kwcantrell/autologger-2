// The wiki turn's tools (OpenSpec change `show-wiki-ai`, design D3/D4; wiki-generation "The wiki
// turn and its tools", "Proposals are checked when they are made").
//
// - `list_wiki_pages {page?}`: the show's live pages, then its pending new-page suggestions, as
//   text lines, packed to at most 200 entries and 40 000 characters per call, ending with a
//   marker line;
// - `read_wiki_page {page_id? | suggestion_id?}`: one body per result: a live page (naming its
//   pending suggestion's id), or one pending suggestion of the show; every body is cut at 30 000
//   characters, and further so the whole result stays within 45 000, and the cut is marked;
// - `propose_page`: checks one whole page version (shape, target, links, citations, quotes) and
//   records it in the run's in-memory proposals, keyed by target. Citations not on the page now
//   are quote-checked against the run's session, or a session the target's pending suggestion
//   cites (re-panel 2026-10-14). It writes nothing: the wiki route stores the proposals only when
//   the run succeeds.
//
// The catalog comes in through `WikiToolPort`, which the server implements over the catalog bound
// to the caller, so every read is under the caller's row-level security; ai-runtime never imports
// the catalog. The show and session are the port's, never a tool parameter. The port, the word
// snapshot and the proposals live on the turn registration (`AiMcpTurnContext.wiki`), because the
// CLI's MCP servers are rebuilt per request.
//
// Errors the model should see come back as `isError` text; a thrown error (a port failure) is
// the fixed "Tool failed." on both routes, never the error's message.

import {
  citationsOf,
  WIKI_KINDS,
  WIKI_PROPOSAL_BODY_MAX,
  type WikiCitation,
  type WikiKind,
  wikiProposalSchema,
} from '@autologger/contract';
import { z } from 'zod';
import type { AiGenerationSnapshotWord, ToolSink, ToolSinkResult } from './aiMcpServer';

/** Most entries one `list_wiki_pages` call returns. */
export const WIKI_LIST_MAX_LINES = 200;
/** Most characters one `list_wiki_pages` result holds, marker line included (under the CLI's
 * 45 000-character tool-output bound, `GENERATION_PAGE_MAX_CHARS`). */
export const WIKI_LIST_MAX_CHARS = 40_000;
/** Bodies `read_wiki_page` returns are cut here; a longer page can't be an AI target. */
export const WIKI_READ_BODY_MAX = WIKI_PROPOSAL_BODY_MAX;
/** Most characters one `read_wiki_page` result holds, header included (the CLI's 45 000-character
 * tool-output bound, `GENERATION_PAGE_MAX_CHARS`). */
export const WIKI_READ_RESULT_MAX_CHARS = 45_000;
/** Most sessions other than the run's whose words one run may read for the quote check. */
export const WIKI_OTHER_SESSIONS_MAX = 10;
/** Most targets one run may propose. */
export const WIKI_RUN_MAX_TARGETS = 20;
/** A quote's first word must be within this many seconds of the cited time. */
export const WIKI_QUOTE_WINDOW_SEC = 30;
/** Most words a quote may have. */
export const WIKI_QUOTE_MAX_WORDS = 60;
/** Most new citations one proposal may have checked. */
export const WIKI_MAX_CHECKED_CITATIONS = 200;

/** The fixed text of a thrown tool body (as `sdkTools.ts`'s `TOOL_FAILED_TEXT`). */
const TOOL_FAILED = 'Tool failed.';
const PAGE_NOT_FOUND = 'Page not found.';
const NO_CHANGE = 'No change.';

// -- the port -------------------------------------------------------------------------------------

/** One live page of the show, for the list. */
export interface WikiToolPage {
  id: string;
  kind: WikiKind;
  title: string;
  aliases: string[];
  revision: number;
  /** The page has a pending suggestion. */
  pending: boolean;
}

/** One pending new-page suggestion of the show, for the list. */
export interface WikiToolPendingNew {
  suggestionId: string;
  kind: WikiKind;
  title: string;
}

/** One live page with its body, and the id of its pending suggestion when it has one. */
export interface WikiToolPageDetail {
  id: string;
  kind: WikiKind;
  title: string;
  aliases: string[];
  revision: number;
  bodyMd: string;
  pendingSuggestionId: string | null;
}

/** One pending suggestion of the show with its body: for a page (`pageId`) or a new page
 * (`pageId: null`). */
export interface WikiToolPendingDetail {
  suggestionId: string;
  pageId: string | null;
  kind: WikiKind;
  title: string;
  aliases: string[];
  bodyMd: string;
}

/** The catalog, as the wiki tools see it: bound to the caller and to the run's show and session. */
export interface WikiToolPort {
  readonly showId: string;
  readonly sessionId: string;
  /** The show's live pages in title order, each with its pending flag. */
  listPages(): Promise<WikiToolPage[]>;
  /** The show's pending new-page suggestions. */
  listPendingNew(): Promise<WikiToolPendingNew[]>;
  /** A live page of the show; `{mergedInto}` for a merged page; `null` for a missing or deleted
   * page, or a page of another show. */
  readPage(id: string): Promise<WikiToolPageDetail | { mergedInto: string } | null>;
  /** A pending suggestion of the run's show (for a page or a new page), or `null`: the port
   * filters on the show and `status = 'pending'` itself, since RLS alone would also return other
   * accessible shows' and resolved rows. */
  readPending(suggestionId: string): Promise<WikiToolPendingDetail | null>;
  /** The pending suggestion for a page of the show, or for a new page whose title normalises to
   * `normTitle`; `null` when there is none. */
  pendingFor(
    target: { pageId: string } | { normTitle: string },
  ): Promise<WikiToolPendingDetail | null>;
  /** A session's transcript words, read as the caller; `null` unless it is a session of the run's
   * show. */
  sessionWords(sessionId: string): Promise<WikiSnapshotWord[] | null>;
  /** The run session's live page, or `null`. */
  sessionPageId(): Promise<string | null>;
  /** The live page holding one of `names` as its title or an alias (as `catalog.search_norm`
   * folds them), or `null`. */
  nameHolder(names: string[]): Promise<string | null>;
  /** The manual-save link check: its problems, `[]` when the body is fine. */
  checkLinks(bodyMd: string): Promise<string[]>;
  /** Each text through `catalog.search_norm`, in order. */
  normalize(texts: string[]): Promise<string[]>;
}

// -- per-turn state -------------------------------------------------------------------------------

/** One transcript word of the run's snapshot: the rendering's three fields plus `start_sec`, the
 * quote match's fallback clock. */
export interface WikiSnapshotWord extends AiGenerationSnapshotWord {
  readonly start_sec: number;
}

/** One checked proposal, structurally the catalog's `WikiProposal` (`saveRun`'s input). */
export interface WikiRunProposal {
  target: { type: 'page'; pageId: string; baseRevision: number } | { type: 'new' };
  kind: WikiKind;
  title: string;
  aliases: string[];
  bodyMd: string;
  rationale: string;
}

interface TranscriptToken {
  readonly token: string;
  readonly time: number;
}

/** A memo slot: a wrapper object, so the checks below compare objects, not promises (promise
 * hygiene, async-session-hub D9). */
interface Memo<T> {
  promise: Promise<T>;
}

/** A wiki turn's state, carried on its registration. */
export interface WikiTurnState {
  readonly port: WikiToolPort;
  readonly words: readonly WikiSnapshotWord[];
  /** The run's proposals by target (`page:<id>` or `new:<normalised title>`), in proposal order. */
  readonly proposals: Map<string, WikiRunProposal>;
  /** The transcript's tokens, normalised once per run on first need. */
  tokens: Memo<readonly TranscriptToken[]> | null;
  /** Other sessions' tokens (`null`: not a session of the show), read and normalised once per
   * run on first need; at most `WIKI_OTHER_SESSIONS_MAX` entries. */
  readonly otherTokens: Map<string, Memo<readonly TranscriptToken[] | null>>;
  /** Set when the turn is over: a tool body still running records nothing. */
  closed: boolean;
}

export function createWikiTurnState(
  port: WikiToolPort,
  words: readonly WikiSnapshotWord[],
): WikiTurnState {
  return {
    port,
    words,
    proposals: new Map(),
    tokens: null,
    otherTokens: new Map(),
    closed: false,
  };
}

/** The run's proposals, in order. */
export function wikiRunProposals(state: WikiTurnState): WikiRunProposal[] {
  return [...state.proposals.values()];
}

// -- helpers --------------------------------------------------------------------------------------

function toolError(text: string): ToolSinkResult & { isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

function toolText(text: string): ToolSinkResult {
  return { content: [{ type: 'text', text }] };
}

/** Run a body; a thrown error becomes the fixed "Tool failed.". */
async function guarded(body: () => Promise<ToolSinkResult>): Promise<ToolSinkResult> {
  try {
    return await body();
  } catch {
    return toolError(TOOL_FAILED);
  }
}

/** Untrusted text on one rendered line: JSON-quoted (so it stays one line), with any run of 3+
 * hyphens shortened so it can never reproduce a marker line. */
function quoted(value: unknown): string {
  return JSON.stringify(value).replace(/-{3,}/g, '--');
}

/** Tokens of normalised text: each run of non-alphanumerics is a boundary. */
function tokensOf(normalised: string): string[] {
  return normalised.split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '');
}

const TIMECODE_RE = /^(\d+):([0-5]\d):([0-5]\d)(?:[:;.]\d+)?$/;

/** A word's time in seconds: its `session_time` as `HH×3600 + MM×60 + SS` (frames dropped), else
 * its `start_sec`. */
function wordTime(w: WikiSnapshotWord): number {
  const m = TIMECODE_RE.exec(w.session_time.trim());
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const s = Number(w.start_sec);
  return Number.isFinite(s) ? s : Number.NaN;
}

/** `HH:MM:SS` for whole seconds. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Words as tokens, normalised in one `port.normalize` call. */
async function tokenize(
  port: WikiToolPort,
  words: readonly WikiSnapshotWord[],
): Promise<readonly TranscriptToken[]> {
  if (words.length === 0) return [];
  const normalised = await port.normalize(words.map((w) => w.word));
  const out: TranscriptToken[] = [];
  words.forEach((w, i) => {
    const time = wordTime(w);
    for (const token of tokensOf(normalised[i] ?? '')) out.push({ token, time });
  });
  return out;
}

function transcriptTokens(state: WikiTurnState): Promise<readonly TranscriptToken[]> {
  if (state.tokens !== null) return state.tokens.promise;
  const wrapper: Memo<readonly TranscriptToken[]> = {
    promise: tokenize(state.port, state.words),
  };
  // A failed normalise is retried by the next call, not memoised.
  wrapper.promise = wrapper.promise.catch((err: unknown) => {
    if (state.tokens === wrapper) state.tokens = null;
    throw err;
  });
  state.tokens = wrapper;
  return wrapper.promise;
}

/** Another session's tokens, read and normalised once per run; `null` when it isn't a session of
 * the show. The caller checks the per-run limit before asking for a new session. */
function otherSessionTokens(
  state: WikiTurnState,
  sessionId: string,
): Promise<readonly TranscriptToken[] | null> {
  const memo = state.otherTokens.get(sessionId);
  if (memo !== undefined) return memo.promise;
  const wrapper: Memo<readonly TranscriptToken[] | null> = {
    promise: (async () => {
      const words = await state.port.sessionWords(sessionId);
      return words === null ? null : tokenize(state.port, words);
    })(),
  };
  // A failed read is retried by the next call, not memoised, and doesn't count to the limit.
  wrapper.promise = wrapper.promise.catch((err: unknown) => {
    if (state.otherTokens.get(sessionId) === wrapper) state.otherTokens.delete(sessionId);
    throw err;
  });
  state.otherTokens.set(sessionId, wrapper);
  return wrapper.promise;
}

/** Whether `quote` occurs as one contiguous token run whose first token is within the window. */
function quoteFound(tokens: readonly TranscriptToken[], quote: string[], at: number): boolean {
  const n = quote.length;
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const first = tokens[i];
    if (first === undefined || first.token !== quote[0]) continue;
    if (!(Math.abs(first.time - at) <= WIKI_QUOTE_WINDOW_SEC)) continue;
    let j = 1;
    while (j < n && tokens[i + j]?.token === quote[j]) j += 1;
    if (j === n) return true;
  }
  return false;
}

const citeName = (c: WikiCitation) => `cite:${c.sessionId}@${c.seconds}`;
const shown = (text: string) => JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}…` : text);

// -- list_wiki_pages ------------------------------------------------------------------------------

const LIST_END_MARKER = '--- end of wiki pages ---';
const listMoreMarker = (next: number) =>
  `--- more wiki pages: call list_wiki_pages with page=${next} ---`;

/** Pack entry lines into calls of at most 200 entries and 40 000 characters, marker included. */
function packList(lines: readonly string[]): string[][] {
  const reserve = listMoreMarker(9_999_999).length + 1;
  const cap = WIKI_LIST_MAX_CHARS - reserve;
  const calls: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const line of lines) {
    const cost = cur.length === 0 ? line.length : line.length + 1;
    if (cur.length > 0 && (cur.length >= WIKI_LIST_MAX_LINES || chars + cost > cap)) {
      calls.push(cur);
      cur = [];
      chars = 0;
    }
    chars += cur.length === 0 ? line.length : line.length + 1;
    cur.push(line);
  }
  if (cur.length > 0) calls.push(cur);
  return calls;
}

function buildListWikiPages(server: ToolSink, wiki: WikiTurnState): void {
  server.tool(
    'list_wiki_pages',
    "Lists this show's wiki: one line per live page (id · kind · title · aliases · revision, " +
      'and [pending] when it has a pending suggestion), then one line per pending new-page ' +
      'suggestion. Long lists span several calls: start at page=0 (the default) and, while the ' +
      'last line names a next page, call again with it.',
    {
      page: z.number().optional().describe('0-based page of the list (default 0).'),
    },
    async (args) =>
      guarded(async () => {
        const page = args.page ?? 0;
        if (!Number.isInteger(page) || page < 0) {
          return toolError(`Invalid page ${page}: expected a non-negative integer.`);
        }
        const [pages, pendingNew] = await Promise.all([
          wiki.port.listPages(),
          wiki.port.listPendingNew(),
        ]);
        const lines = [
          ...pages.map(
            (p) =>
              `${quotedId(p.id)} · ${p.kind} · ${quoted(p.title)} · aliases ${quoted(p.aliases)} · ` +
              `r${p.revision}${p.pending ? ' · [pending]' : ''}`,
          ),
          ...pendingNew.map(
            (s) => `suggestion ${quotedId(s.suggestionId)} · new · ${s.kind} · ${quoted(s.title)}`,
          ),
        ];
        if (lines.length === 0) {
          if (page !== 0) return toolError(`Page ${page} is out of range: the list has 1 page.`);
          return toolText(`(this show has no wiki pages yet)\n${LIST_END_MARKER}`);
        }
        const calls = packList(lines);
        const chunk = calls[page];
        if (chunk === undefined) {
          return toolError(
            `Page ${page} is out of range: the list has ${calls.length} page(s), 0-based.`,
          );
        }
        const marker = page < calls.length - 1 ? listMoreMarker(page + 1) : LIST_END_MARKER;
        return toolText(`${chunk.join('\n')}\n${marker}`);
      }),
  );
}

/** Ids are database ids, but they are rendered defensively anyway. */
function quotedId(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : quoted(id);
}

// -- read_wiki_page -------------------------------------------------------------------------------

/** Header lines are capped so the body always keeps room in the result. A real header (a title of
 * 200 characters and 50 aliases of 200, all of which may JSON-escape to double) fits these. */
const READ_TITLE_LINE_MAX = 1_500;
const READ_ALIASES_LINE_MAX = 21_000;

/** An untrusted header line, cut (and marked) past `max` characters. */
function capLine(line: string, max: number): string {
  const mark = ' …(cut)';
  return line.length <= max ? line : `${line.slice(0, max - mark.length)}${mark}`;
}

function bodyHead(name: 'page' | 'suggestion', shownChars: number, total: number): string {
  if (shownChars === total) return `=== ${name} body (${total} characters) ===`;
  return total > WIKI_READ_BODY_MAX
    ? `=== ${name} body (cut: the first ${shownChars} of ${total} characters; ` +
        'this page is too long for you to rewrite) ==='
    : `=== ${name} body (cut: the first ${shownChars} of ${total} characters, to fit one ` +
        'result; the rest is not shown, so do not rewrite this page from it) ===';
}

/** The header lines and then one body between fixed delimiters, the body cut at 30 000 characters
 * and further so the whole result is at most `WIKI_READ_RESULT_MAX_CHARS`. */
function renderRead(header: string[], name: 'page' | 'suggestion', body: string): string {
  const head = header.join('\n');
  const end = `=== end of ${name} body ===`;
  // The longest the body's own heading can be (a cut length has at most 5 digits).
  const headMax = Math.max(
    bodyHead(name, 99_999, WIKI_READ_BODY_MAX + 1).length,
    bodyHead(name, 99_999, WIKI_READ_BODY_MAX).length,
  );
  const room = WIKI_READ_RESULT_MAX_CHARS - head.length - headMax - end.length - 3;
  const shownChars = Math.max(0, Math.min(body.length, WIKI_READ_BODY_MAX, room));
  return `${head}\n${bodyHead(name, shownChars, body.length)}\n${body.slice(0, shownChars)}\n${end}`;
}

const titleLine = (title: string) => capLine(`title: ${quoted(title)}`, READ_TITLE_LINE_MAX);
const aliasesLine = (aliases: string[]) =>
  capLine(`aliases: ${quoted(aliases)}`, READ_ALIASES_LINE_MAX);

function buildReadWikiPage(server: ToolSink, wiki: WikiTurnState): void {
  server.tool(
    'read_wiki_page',
    'Reads one wiki page of this show by page_id, or one pending suggestion of this show by ' +
      'suggestion_id: a page read names its pending suggestion, if any, so you can read that ' +
      'suggestion next. Give exactly one of the two. Each result holds one body.',
    {
      page_id: z.string().optional().describe('A page id from list_wiki_pages.'),
      suggestion_id: z
        .string()
        .optional()
        .describe(
          'A pending suggestion id: from a page read, or a pending new page from list_wiki_pages.',
        ),
    },
    async (args) =>
      guarded(async () => {
        const hasPage = typeof args.page_id === 'string' && args.page_id !== '';
        const hasSuggestion = typeof args.suggestion_id === 'string' && args.suggestion_id !== '';
        if (hasPage === hasSuggestion) {
          return toolError('Give exactly one of page_id or suggestion_id.');
        }
        if (hasSuggestion) {
          const s = await wiki.port.readPending(args.suggestion_id as string);
          if (s === null) return toolError('Suggestion not found.');
          const first =
            s.pageId === null
              ? `pending new-page suggestion ${quotedId(s.suggestionId)} · ${s.kind} (unreviewed; ` +
                'to build on it, propose the same title without page_id, keeping its additions)'
              : `pending suggestion ${quotedId(s.suggestionId)} for page ${quotedId(s.pageId)} · ` +
                `${s.kind} (an earlier, unreviewed suggestion for this page: write your new ` +
                `version of page ${quotedId(s.pageId)} from it, keeping its additions)`;
          return toolText(
            renderRead([first, titleLine(s.title), aliasesLine(s.aliases)], 'suggestion', s.bodyMd),
          );
        }
        const id = args.page_id as string;
        const page = await wiki.port.readPage(id);
        if (page === null) return toolError(PAGE_NOT_FOUND);
        if ('mergedInto' in page) {
          return toolText(
            `Page ${quotedId(id)} was merged into page ${quotedId(page.mergedInto)}; ` +
              `read ${quotedId(page.mergedInto)} instead.`,
          );
        }
        const header = [
          `page ${quotedId(page.id)} · ${page.kind} · r${page.revision}`,
          titleLine(page.title),
          aliasesLine(page.aliases),
        ];
        if (page.pendingSuggestionId !== null) {
          header.push(
            `pending suggestion ${quotedId(page.pendingSuggestionId)}: this page has an earlier, ` +
              'unreviewed suggestion; read it with read_wiki_page suggestion_id ' +
              `${quoted(page.pendingSuggestionId)} and write your new version from it, keeping ` +
              'its additions',
          );
        }
        return toolText(renderRead(header, 'page', page.bodyMd));
      }),
  );
}

// -- propose_page ---------------------------------------------------------------------------------

/** Names and types only: the bounds live in `wikiProposalSchema`, applied in the handler so a
 * violation is a tool error the model can fix. */
const proposePageShape = {
  page_id: z
    .string()
    .optional()
    .describe('The page to rewrite, from list_wiki_pages; omit for a new page.'),
  kind: z.string().optional().describe('person, topic, bit or session; required for a new page.'),
  title: z.string().optional().describe('The page title (one line, at most 200 characters).'),
  aliases: z
    .array(z.string())
    .optional()
    .describe('Other names for the page (at most 50; none for a session page).'),
  body_md: z
    .string()
    .optional()
    .describe(`The WHOLE new page body in Markdown, at most ${WIKI_PROPOSAL_BODY_MAX} characters.`),
  rationale: z
    .string()
    .optional()
    .describe('Why this change, for the reviewer (1–500 characters).'),
};

function problemsText(problems: string[]): string {
  return ['Proposal not recorded:', ...problems].join('\n');
}

function buildProposePage(server: ToolSink, wiki: WikiTurnState): void {
  server.tool(
    'propose_page',
    'Proposes one whole page version for a person to review: a change to an existing page ' +
      '(page_id) or a new page (kind and title). Nothing is written to the wiki. Every new ' +
      "citation must quote this session exactly; a citation kept from the target's pending " +
      'suggestion may cite its earlier session and is checked against it. On a problem nothing is recorded and every ' +
      'problem is listed: fix them and call again. A later proposal for the same page replaces ' +
      'the earlier one.',
    proposePageShape,
    async (args) => guarded(() => propose(wiki, args)),
  );
}

async function propose(
  wiki: WikiTurnState,
  args: Record<string, unknown>,
): Promise<ToolSinkResult> {
  const { port } = wiki;
  // 1. Shape.
  const kindArg = args.kind;
  if (kindArg !== undefined && !(WIKI_KINDS as readonly unknown[]).includes(kindArg)) {
    return toolError(problemsText([`kind: must be one of ${WIKI_KINDS.join(', ')}`]));
  }
  const parsed = wikiProposalSchema.safeParse(args);
  if (!parsed.success) {
    return toolError(
      problemsText(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)),
    );
  }
  const p = parsed.data;
  const problems: string[] = [];

  // 2. Target.
  let target: WikiRunProposal['target'];
  let kind: WikiKind;
  let baseBody = '';
  if (p.page_id !== undefined) {
    const page = await port.readPage(p.page_id);
    if (page === null)
      return toolError(problemsText([`page_id ${quoted(p.page_id)}: ${PAGE_NOT_FOUND}`]));
    if ('mergedInto' in page) {
      return toolError(
        problemsText([
          `page_id ${quoted(p.page_id)}: the page was merged into page ` +
            `${quotedId(page.mergedInto)}; propose to that page instead.`,
        ]),
      );
    }
    if (page.bodyMd.length > WIKI_READ_BODY_MAX) {
      return toolError(
        problemsText([
          `page_id ${quoted(p.page_id)}: the page is too long (${page.bodyMd.length} characters) ` +
            `for you to rewrite; only pages of at most ${WIKI_READ_BODY_MAX} characters can be.`,
        ]),
      );
    }
    if (
      page.title === p.title &&
      page.bodyMd === p.body_md &&
      page.aliases.length === p.aliases.length &&
      page.aliases.every((a, i) => a === p.aliases[i])
    ) {
      return toolError(NO_CHANGE);
    }
    if (p.kind !== undefined && p.kind !== page.kind) {
      problems.push(
        `kind: page ${quotedId(page.id)} is a ${page.kind} page; omit kind or send "${page.kind}".`,
      );
    }
    if (page.kind === 'session' && p.aliases.length > 0) {
      problems.push('aliases: a session page has none');
    }
    target = { type: 'page', pageId: page.id, baseRevision: page.revision };
    kind = page.kind;
    baseBody = page.bodyMd;
  } else {
    if (p.kind === undefined) {
      return toolError(
        problemsText([`kind: kind is required for a new page (${WIKI_KINDS.join(', ')}).`]),
      );
    }
    const holder = await port.nameHolder([p.title, ...p.aliases]);
    if (holder !== null) {
      problems.push(
        `title: the title or an alias is already used by page ${quotedId(holder)}; to change ` +
          `that page, call propose_page with page_id ${quoted(holder)}.`,
      );
    }
    if (p.kind === 'session') {
      const own = await port.sessionPageId();
      if (own !== null) {
        problems.push(
          `kind: This session already has a page (${quotedId(own)}); propose a change to it ` +
            `with page_id ${quoted(own)}.`,
        );
      }
    }
    target = { type: 'new' };
    kind = p.kind;
  }

  // 3. Links: the store's own manual-save check.
  problems.push(...(await port.checkLinks(p.body_md)));

  // 4. Citations, and the key of a new page, normalised in one call.
  const cites = citationsOf(p.body_md);
  const baseCites = baseBody === '' ? [] : citationsOf(baseBody);
  const texts = [
    ...(target.type === 'new' ? [p.title] : []),
    ...cites.map((c) => c.text),
    ...baseCites.map((c) => c.text),
  ];
  const normalised = texts.length > 0 ? await port.normalize(texts) : [];
  const offset = target.type === 'new' ? 1 : 0;
  const key = target.type === 'new' ? `new:${normalised[0] ?? ''}` : `page:${target.pageId}`;
  const citeTokens = cites.map((_, i) => tokensOf(normalised[offset + i] ?? ''));
  const keyOf = (c: WikiCitation, tokens: string[]) =>
    `${c.sessionId}@${c.seconds}#${tokens.join(' ')}`;
  const kept = new Set(
    baseCites.map((c, i) => keyOf(c, tokensOf(normalised[offset + cites.length + i] ?? ''))),
  );
  const toCheck = cites
    .map((c, i) => ({ c, tokens: citeTokens[i] ?? [] }))
    .filter(({ c, tokens }) => !kept.has(keyOf(c, tokens)));

  // 5. Quotes. A citation of another session qualifies only when the target's pending suggestion
  // cites that session; it is checked against that session's words (design D4 step 4).
  if (toCheck.length > WIKI_MAX_CHECKED_CITATIONS) {
    problems.push(
      `body_md: ${toCheck.length} new citations; at most ${WIKI_MAX_CHECKED_CITATIONS} per proposal.`,
    );
  } else {
    let carried: Set<string> | null = null;
    if (toCheck.some(({ c }) => c.sessionId !== port.sessionId)) {
      const pending = await port.pendingFor(
        target.type === 'page' ? { pageId: target.pageId } : { normTitle: normalised[0] ?? '' },
      );
      carried = new Set(
        pending === null
          ? []
          : citationsOf(pending.bodyMd)
              .map((c) => c.sessionId)
              .filter((id) => id !== port.sessionId),
      );
    }
    const mustQuoteThis = `new citations must quote this session (${port.sessionId})`;
    for (const { c, tokens: quote } of toCheck) {
      const name = `${citeName(c)} ${shown(c.text)}`;
      const own = c.sessionId === port.sessionId;
      if (!own && !carried?.has(c.sessionId)) {
        problems.push(`${name}: ${mustQuoteThis}`);
      } else if (quote.length === 0) {
        problems.push(`${name}: the quote has no words`);
      } else if (quote.length > WIKI_QUOTE_MAX_WORDS) {
        problems.push(
          `${name}: the quote has ${quote.length} words; at most ${WIKI_QUOTE_MAX_WORDS}`,
        );
      } else if (
        !own &&
        !wiki.otherTokens.has(c.sessionId) &&
        wiki.otherTokens.size >= WIKI_OTHER_SESSIONS_MAX
      ) {
        problems.push(
          `${name}: at most ${WIKI_OTHER_SESSIONS_MAX} other sessions can be checked per run`,
        );
      } else {
        const tokens = own
          ? await transcriptTokens(wiki)
          : await otherSessionTokens(wiki, c.sessionId);
        if (tokens === null) {
          problems.push(`${name}: ${mustQuoteThis}`);
        } else if (!quoteFound(tokens, quote, c.seconds)) {
          problems.push(
            `${name}: not found within ${WIKI_QUOTE_WINDOW_SEC} s of ${clock(c.seconds)}`,
          );
        }
      }
    }
  }

  // Limits per run, and recording, with no await in between.
  const replaces = wiki.proposals.has(key);
  if (!replaces && wiki.proposals.size >= WIKI_RUN_MAX_TARGETS) {
    problems.push(
      `This run already has ${WIKI_RUN_MAX_TARGETS} targets; no new target can be added ` +
        '(a proposal for a target already proposed replaces it).',
    );
  }
  if (problems.length > 0) return toolError(problemsText(problems));
  if (wiki.closed) return toolError('Turn ended.');
  wiki.proposals.delete(key);
  wiki.proposals.set(key, {
    target,
    kind,
    title: p.title,
    aliases: p.aliases,
    bodyMd: p.body_md,
    rationale: p.rationale,
  });
  const what =
    target.type === 'page'
      ? `page ${quotedId(target.pageId)}`
      : `new ${kind} page ${quoted(p.title)}`;
  return toolText(
    `Recorded the proposal for ${what}${replaces ? ' (it replaces your earlier proposal for it)' : ''}. ` +
      `${wiki.proposals.size} of ${WIKI_RUN_MAX_TARGETS} targets used.`,
  );
}

// -- registration ---------------------------------------------------------------------------------

/** A wiki tool on a turn with no wiki state: a tool error, no port call. */
function unavailable(
  server: ToolSink,
  name: 'list_wiki_pages' | 'read_wiki_page' | 'propose_page',
) {
  server.tool(name, 'Not available on this turn.', {}, async () =>
    toolError('The wiki tools are only available on wiki turns.'),
  );
}

/** The three builders `aiMcpServer.ts`'s `TOOL_BUILDERS` registers. */
export const WIKI_TOOL_BUILDERS = {
  list_wiki_pages: (server: ToolSink, wiki: WikiTurnState | undefined): void =>
    wiki === undefined ? unavailable(server, 'list_wiki_pages') : buildListWikiPages(server, wiki),
  read_wiki_page: (server: ToolSink, wiki: WikiTurnState | undefined): void =>
    wiki === undefined ? unavailable(server, 'read_wiki_page') : buildReadWikiPage(server, wiki),
  propose_page: (server: ToolSink, wiki: WikiTurnState | undefined): void =>
    wiki === undefined ? unavailable(server, 'propose_page') : buildProposePage(server, wiki),
} as const;
