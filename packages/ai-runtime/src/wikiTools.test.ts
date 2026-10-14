// The wiki turn's tools (show-wiki-ai task 4.3, design D3/D4; wiki-generation "The wiki turn and
// its tools", "Proposals are checked when they are made"). The three builders run through the
// real registration path (`registerSdkTurn(...).registerTools(sink)`) over a fake `WikiToolPort`,
// so the `TOOL_BUILDERS` entries and the per-turn state on the registration are under test too.

import type { SessionHubRegistryFacade } from '@autologger/session-core';
import { userCaller } from '@autologger/session-core';
import { describe, expect, it } from 'vitest';
import {
  AI_MCP_TOOL_NAMES,
  type AiMcpToolName,
  registerSdkTurn,
  type ToolSink,
  type ToolSinkResult,
} from './aiMcpServer';
import { TOOL_FAILED_TEXT } from './sdkTools';
import {
  createWikiTurnState,
  WIKI_LIST_MAX_CHARS,
  WIKI_LIST_MAX_LINES,
  WIKI_OTHER_SESSIONS_MAX,
  WIKI_READ_RESULT_MAX_CHARS,
  WIKI_RUN_MAX_TARGETS,
  type WikiSnapshotWord,
  type WikiToolPageDetail,
  type WikiToolPendingDetail,
  type WikiToolPort,
  type WikiTurnState,
  wikiRunProposals,
} from './wikiTools';

const SESSION = 'S1';
const SHOW = 'show-1';
const caller = userCaller('user-1');

/** `catalog.search_norm` stand-in: case, accents and ß folded. */
const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');

interface FakePortOptions {
  pages?: WikiToolPageDetail[];
  merged?: Record<string, string>;
  /** The show's pending suggestions, for pages (`pageId`) and new pages (`pageId: null`). The fake
   * holds only what the real port would answer: pending rows of the run's show. */
  pending?: WikiToolPendingDetail[];
  /** Words of the show's other sessions, by session id; any other id answers `null` (not a
   * session of the show). */
  sessions?: Record<string, WikiSnapshotWord[]>;
  sessionPage?: string | null;
  /** name (folded) → page id holding it. */
  names?: Record<string, string>;
  linkProblems?: (body: string) => string[];
  throwOn?: keyof WikiToolPort;
}

function fakePort(o: FakePortOptions = {}) {
  const calls: string[] = [];
  /** `sessionWords` and `pendingFor` arguments, in call order. */
  const args: string[] = [];
  const pages = o.pages ?? [];
  const pending = o.pending ?? [];
  const maybeThrow = (m: keyof WikiToolPort) => {
    calls.push(m);
    if (o.throwOn === m) throw new Error('SECRET-PORT-ERROR');
  };
  const port: WikiToolPort = {
    showId: SHOW,
    sessionId: SESSION,
    listPages: async () => {
      maybeThrow('listPages');
      return pages.map(({ bodyMd: _b, pendingSuggestionId, ...p }) => ({
        ...p,
        pending: pendingSuggestionId !== null,
      }));
    },
    listPendingNew: async () => {
      maybeThrow('listPendingNew');
      return pending
        .filter((s) => s.pageId === null)
        .map(({ suggestionId, kind, title }) => ({ suggestionId, kind, title }));
    },
    readPage: async (id) => {
      maybeThrow('readPage');
      if (o.merged?.[id]) return { mergedInto: o.merged[id] };
      return pages.find((p) => p.id === id) ?? null;
    },
    readPending: async (id) => {
      maybeThrow('readPending');
      return pending.find((s) => s.suggestionId === id) ?? null;
    },
    pendingFor: async (target) => {
      maybeThrow('pendingFor');
      if ('pageId' in target) {
        args.push(`pendingFor page:${target.pageId}`);
        return pending.find((s) => s.pageId === target.pageId) ?? null;
      }
      args.push(`pendingFor new:${target.normTitle}`);
      return pending.find((s) => s.pageId === null && fold(s.title) === target.normTitle) ?? null;
    },
    sessionWords: async (sessionId) => {
      maybeThrow('sessionWords');
      args.push(`sessionWords ${sessionId}`);
      return o.sessions?.[sessionId] ?? null;
    },
    sessionPageId: async () => {
      maybeThrow('sessionPageId');
      return o.sessionPage ?? null;
    },
    nameHolder: async (names) => {
      maybeThrow('nameHolder');
      for (const n of names) {
        const hit = o.names?.[fold(n)];
        if (hit) return hit;
      }
      return null;
    },
    checkLinks: async (body) => {
      maybeThrow('checkLinks');
      return o.linkProblems?.(body) ?? [];
    },
    normalize: async (texts) => {
      maybeThrow('normalize');
      return texts.map(fold);
    },
  };
  return { port, calls, args };
}

const word = (w: string, session_time: string, start_sec = 0): WikiSnapshotWord => ({
  word: w,
  session_time,
  speaker: '1',
  start_sec,
});

const WIKI_TOOLS: AiMcpToolName[] = ['list_wiki_pages', 'read_wiki_page', 'propose_page'];

type Handler = (args: Record<string, unknown>) => Promise<ToolSinkResult>;

/** The wiki tools of one turn, registered the way both routes register them. */
function wikiTools(port: WikiToolPort, words: WikiSnapshotWord[] = []) {
  const state: WikiTurnState = createWikiTurnState(port, words);
  const reg = registerSdkTurn({} as SessionHubRegistryFacade, SESSION, caller, {
    tools: ['get_transcript_words', ...WIKI_TOOLS],
    pagedWords: words,
    wiki: state,
  });
  const handlers = new Map<string, Handler>();
  const sink: ToolSink = {
    tool(name, _description, _shape, handler) {
      handlers.set(name, handler as Handler);
    },
  };
  reg.registerTools(sink);
  const call = async (name: AiMcpToolName, args: Record<string, unknown> = {}) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`no tool ${name}`);
    const res = await h(args);
    return { text: res.content.map((c) => c.text).join('\n'), isError: res.isError === true };
  };
  return { state, call, handlers };
}

const livePage = (over: Partial<WikiToolPageDetail> = {}): WikiToolPageDetail => ({
  id: 'p1',
  kind: 'person',
  title: 'Christina Ramos',
  aliases: ['CR'],
  revision: 3,
  bodyMd: 'Host.',
  pendingSuggestionId: null,
  ...over,
});

const pendingSuggestion = (over: Partial<WikiToolPendingDetail> = {}): WikiToolPendingDetail => ({
  suggestionId: 'sg1',
  pageId: 'p1',
  kind: 'person',
  title: 'Christina Ramos',
  aliases: ['CR', 'Chris'],
  bodyMd: 'Host. Earlier unreviewed addition.',
  ...over,
});

const newProposal = (over: Record<string, unknown> = {}) => ({
  kind: 'topic',
  title: 'Budget',
  aliases: [],
  body_md: 'The budget.',
  rationale: 'Discussed in S1.',
  ...over,
});

describe('registration', () => {
  it('the registry carries the three wiki tools', () => {
    for (const t of WIKI_TOOLS) expect(AI_MCP_TOOL_NAMES).toContain(t);
  });

  it('a turn without wiki state gets a tool error and no port call', async () => {
    const reg = registerSdkTurn({} as SessionHubRegistryFacade, SESSION, caller, {
      tools: WIKI_TOOLS,
    });
    const handlers = new Map<string, Handler>();
    reg.registerTools({
      tool(name, _d, _s, handler) {
        handlers.set(name, handler as Handler);
      },
    });
    for (const t of WIKI_TOOLS) {
      const res = await handlers.get(t)?.({});
      expect(res?.isError).toBe(true);
    }
  });
});

describe('list_wiki_pages', () => {
  it('lists live pages with id, kind, title, aliases, revision and the pending flag, then the pending new pages', async () => {
    const { port } = fakePort({
      pages: [
        livePage(),
        livePage({
          id: 'p2',
          kind: 'topic',
          title: 'Budget',
          aliases: [],
          revision: 1,
          pendingSuggestionId: 'sg1',
        }),
      ],
      pending: [
        pendingSuggestion({ pageId: 'p2', kind: 'topic', title: 'Budget', aliases: [] }),
        pendingSuggestion({
          suggestionId: 'sg9',
          pageId: null,
          kind: 'bit',
          title: 'The Duck',
          aliases: [],
          bodyMd: 'Quack.',
        }),
      ],
    });
    const { call } = wikiTools(port);
    const res = await call('list_wiki_pages');
    expect(res.isError).toBe(false);
    expect(res.text.split('\n')).toEqual([
      'p1 · person · "Christina Ramos" · aliases ["CR"] · r3',
      'p2 · topic · "Budget" · aliases [] · r1 · [pending]',
      'suggestion sg9 · new · bit · "The Duck"',
      '--- end of wiki pages ---',
    ]);
  });

  it('an empty wiki says so and ends with the end marker', async () => {
    const { call } = wikiTools(fakePort().port);
    const res = await call('list_wiki_pages');
    expect(res.text).toBe('(this show has no wiki pages yet)\n--- end of wiki pages ---');
  });

  it(`packs at most ${WIKI_LIST_MAX_LINES} entries per call, with a marker naming the next call`, async () => {
    const pages = Array.from({ length: 450 }, (_, i) =>
      livePage({ id: `p${i}`, title: `Page ${i}`, aliases: [] }),
    );
    const { call } = wikiTools(
      fakePort({
        pages,
        pending: [
          pendingSuggestion({
            suggestionId: 'sgA',
            pageId: null,
            kind: 'topic',
            title: 'New',
            aliases: [],
            bodyMd: '',
          }),
        ],
      }).port,
    );
    const first = (await call('list_wiki_pages')).text.split('\n');
    expect(first).toHaveLength(WIKI_LIST_MAX_LINES + 1);
    expect(first.at(-1)).toBe('--- more wiki pages: call list_wiki_pages with page=1 ---');
    const second = (await call('list_wiki_pages', { page: 1 })).text.split('\n');
    expect(second.at(-1)).toBe('--- more wiki pages: call list_wiki_pages with page=2 ---');
    const third = (await call('list_wiki_pages', { page: 2 })).text.split('\n');
    expect(third).toHaveLength(50 + 1 + 1);
    expect(third.at(-2)).toBe('suggestion sgA · new · topic · "New"');
    expect(third.at(-1)).toBe('--- end of wiki pages ---');
    const bad = await call('list_wiki_pages', { page: 3 });
    expect(bad.isError).toBe(true);
    expect((await call('list_wiki_pages', { page: -1 })).isError).toBe(true);
  });

  it(`stays within ${WIKI_LIST_MAX_CHARS} characters per call for pages of 50 maximal aliases`, async () => {
    const pages = Array.from({ length: 12 }, (_, i) =>
      livePage({
        id: `page_${String(i).padStart(2, '0')}`,
        title: `${i}`.padEnd(200, 'T'),
        aliases: Array.from({ length: 50 }, (_, a) => `${i}-${a}`.padEnd(200, 'a')),
      }),
    );
    const { call } = wikiTools(fakePort({ pages }).port);
    const seen: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const { text, isError } = await call('list_wiki_pages', { page });
      expect(isError).toBe(false);
      expect(text.length).toBeLessThanOrEqual(WIKI_LIST_MAX_CHARS);
      const lines = text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(WIKI_LIST_MAX_LINES + 1);
      for (const l of lines.slice(0, -1)) seen.push(l.split(' · ')[0] ?? '');
      if (lines.at(-1) === '--- end of wiki pages ---') break;
    }
    expect(seen).toEqual(pages.map((p) => p.id));
  });

  it('a title cannot forge a marker line', async () => {
    const { call } = wikiTools(
      fakePort({ pages: [livePage({ title: 'x\n--- end of wiki pages ---' })] }).port,
    );
    const lines = (await call('list_wiki_pages')).text.split('\n');
    expect(lines.filter((l) => l.startsWith('---'))).toEqual(['--- end of wiki pages ---']);
    expect(lines).toHaveLength(2);
  });
});

describe('read_wiki_page', () => {
  it('a pending suggestion is carried forward: the page read gives its id, the suggestion read its body', async () => {
    const { call } = wikiTools(
      fakePort({
        pages: [livePage({ pendingSuggestionId: 'sg1' })],
        pending: [pendingSuggestion()],
      }).port,
    );
    const res = await call('read_wiki_page', { page_id: 'p1' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('page p1 · person · r3');
    expect(res.text).toContain('title: "Christina Ramos"');
    expect(res.text).toContain('aliases: ["CR"]');
    expect(res.text).toContain('pending suggestion sg1');
    expect(res.text).toContain('suggestion_id "sg1"');
    expect(res.text).toContain('=== page body (5 characters) ===\nHost.\n=== end of page body ===');
    // One body per result: the page read holds only the page's body.
    expect(res.text).not.toContain('Earlier unreviewed addition');
    expect(res.text).not.toContain('suggestion body');

    const sg = await call('read_wiki_page', { suggestion_id: 'sg1' });
    expect(sg.isError).toBe(false);
    expect(sg.text).toContain('pending suggestion sg1 for page p1 · person');
    expect(sg.text).toContain('aliases: ["CR","Chris"]');
    expect(sg.text).toContain(
      '=== suggestion body (34 characters) ===\nHost. Earlier unreviewed addition.\n=== end of suggestion body ===',
    );
    expect(sg.text).not.toContain('=== page body');
  });

  it('a page with no pending suggestion names none', async () => {
    const { call } = wikiTools(fakePort({ pages: [livePage()] }).port);
    const res = await call('read_wiki_page', { page_id: 'p1' });
    expect(res.text).not.toContain('pending suggestion');
  });

  it('reads a pending new-page suggestion by suggestion_id', async () => {
    const { call } = wikiTools(
      fakePort({
        pending: [
          pendingSuggestion({
            suggestionId: 'sg9',
            pageId: null,
            kind: 'bit',
            title: 'The Duck',
            aliases: ['Duck'],
            bodyMd: 'Quack.',
          }),
        ],
      }).port,
    );
    const res = await call('read_wiki_page', { suggestion_id: 'sg9' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('pending new-page suggestion sg9 · bit');
    expect(res.text).toContain('title: "The Duck"');
    expect(res.text).toContain('aliases: ["Duck"]');
    expect(res.text).toContain('=== suggestion body (6 characters) ===\nQuack.');
  });

  it('"Suggestion not found." for another show\'s or a resolved suggestion (the port answers null)', async () => {
    const { port, calls } = fakePort({ pending: [pendingSuggestion()] });
    const { call } = wikiTools(port);
    for (const id of ['other-show-sg', 'resolved-sg']) {
      expect(await call('read_wiki_page', { suggestion_id: id })).toEqual({
        text: 'Suggestion not found.',
        isError: true,
      });
    }
    expect(calls.filter((c) => c === 'readPending')).toHaveLength(2);
  });

  it(`an adversarial header still keeps the whole result within ${WIKI_READ_RESULT_MAX_CHARS} characters, the cut marked`, async () => {
    const title = '"'.repeat(200);
    const aliases = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? '"' : '\\').repeat(200));
    const body = `${'b'.repeat(29_990)}TAIL`;
    const { call } = wikiTools(
      fakePort({
        pages: [livePage({ title, aliases, bodyMd: body, pendingSuggestionId: 'sg1' })],
        pending: [pendingSuggestion({ title, aliases, bodyMd: body })],
      }).port,
    );
    for (const args of [{ page_id: 'p1' }, { suggestion_id: 'sg1' }]) {
      const res = await call('read_wiki_page', args);
      expect(res.isError).toBe(false);
      expect(res.text.length).toBeLessThanOrEqual(WIKI_READ_RESULT_MAX_CHARS);
      // The header is whole: every escaped alias is there.
      expect(res.text).toContain(`aliases: ${JSON.stringify(aliases)}`);
      expect(res.text).toContain(`title: ${JSON.stringify(title)}`);
      expect(res.text).toMatch(/body \(cut: the first \d+ of 29994 characters/);
      expect(res.text).not.toContain('TAIL');
      expect(res.text.trimEnd().endsWith('body ===')).toBe(true);
    }
  });

  it('a short body under an ordinary header is not cut', async () => {
    const body = 'c'.repeat(30_000);
    const { call } = wikiTools(fakePort({ pages: [livePage({ bodyMd: body })] }).port);
    const res = await call('read_wiki_page', { page_id: 'p1' });
    expect(res.text).toContain('=== page body (30000 characters) ===');
    expect(res.text.length).toBeLessThanOrEqual(WIKI_READ_RESULT_MAX_CHARS);
  });

  it('"Page not found." for a missing, deleted or other-show page (the port answers null)', async () => {
    const { call } = wikiTools(fakePort().port);
    expect(await call('read_wiki_page', { page_id: 'other-show-page' })).toEqual({
      text: 'Page not found.',
      isError: true,
    });
  });

  it('a merged page says which page it was merged into, with no content', async () => {
    const { call } = wikiTools(fakePort({ merged: { p1: 'p7' } }).port);
    const res = await call('read_wiki_page', { page_id: 'p1' });
    expect(res.text).toBe('Page p1 was merged into page p7; read p7 instead.');
  });

  it('a body over 30,000 characters is cut and marked, and the page is marked too long to rewrite', async () => {
    const body = `${'a'.repeat(30_000)}TAIL`;
    const { call } = wikiTools(fakePort({ pages: [livePage({ bodyMd: body })] }).port);
    const res = await call('read_wiki_page', { page_id: 'p1' });
    expect(res.text).toContain(
      '=== page body (cut: the first 30000 of 30004 characters; this page is too long for you to rewrite) ===',
    );
    expect(res.text).toContain(`${'a'.repeat(30_000)}\n=== end of page body ===`);
    expect(res.text).not.toContain('TAIL');
  });

  it('both ids, or neither, are refused', async () => {
    const { call, state } = wikiTools(fakePort({ pages: [livePage()] }).port);
    for (const args of [{}, { page_id: 'p1', suggestion_id: 'sg1' }]) {
      expect(await call('read_wiki_page', args)).toEqual({
        text: 'Give exactly one of page_id or suggestion_id.',
        isError: true,
      });
    }
    expect(state.port).toBeDefined();
  });
});

describe('propose_page: shape and target (D4 steps 1–2)', () => {
  it('a valid new page is recorded', async () => {
    const { call, state } = wikiTools(fakePort().port);
    const res = await call('propose_page', newProposal());
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Recorded');
    expect(wikiRunProposals(state)).toEqual([
      {
        target: { type: 'new' },
        kind: 'topic',
        title: 'Budget',
        aliases: [],
        bodyMd: 'The budget.',
        rationale: 'Discussed in S1.',
      },
    ]);
  });

  it('shape problems are named, one line each, and nothing is recorded', async () => {
    const { call, state } = wikiTools(fakePort().port);
    const res = await call(
      'propose_page',
      newProposal({ title: 'a\nb', body_md: 'x'.repeat(30_001), rationale: '' }),
    );
    expect(res.isError).toBe(true);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('Proposal not recorded:');
    expect(lines.some((l) => l.startsWith('title:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('body_md:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('rationale:'))).toBe(true);
    expect(wikiRunProposals(state)).toEqual([]);
  });

  it('a new page needs a kind', async () => {
    const { call } = wikiTools(fakePort().port);
    const res = await call('propose_page', newProposal({ kind: undefined }));
    expect(res.text).toContain('kind is required for a new page');
  });

  it('a new page whose title or alias matches a live title or alias names that page', async () => {
    const { call, state } = wikiTools(fakePort({ names: { chris: 'p1' } }).port);
    const res = await call('propose_page', newProposal({ title: 'Someone', aliases: ['CHRIS'] }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('already used by page p1');
    expect(res.text).toContain('page_id "p1"');
    expect(wikiRunProposals(state)).toEqual([]);
  });

  it('a session page: only for the run session with no page, and with no aliases', async () => {
    const taken = wikiTools(fakePort({ sessionPage: 'p5' }).port);
    const r1 = await taken.call(
      'propose_page',
      newProposal({ kind: 'session', title: 'Session 1' }),
    );
    expect(r1.isError).toBe(true);
    expect(r1.text).toContain('This session already has a page (p5)');

    const free = wikiTools(fakePort({ sessionPage: null }).port);
    expect(
      (await free.call('propose_page', newProposal({ kind: 'session', title: 'Session 1' })))
        .isError,
    ).toBe(false);
    const r3 = await free.call(
      'propose_page',
      newProposal({ kind: 'session', title: 'Session 2', aliases: ['S'] }),
    );
    expect(r3.isError).toBe(true);
    expect(r3.text).toContain('aliases: a session page has none');
  });

  it('a page target: live, its kind, its base revision, and "No change."', async () => {
    const { call, state } = wikiTools(fakePort({ pages: [livePage()], merged: { p9: 'p1' } }).port);
    const same = { page_id: 'p1', title: 'Christina Ramos', aliases: ['CR'], body_md: 'Host.' };
    expect(await call('propose_page', { ...same, rationale: 'r' })).toEqual({
      text: 'No change.',
      isError: true,
    });
    expect(
      (await call('propose_page', { ...same, kind: 'topic', body_md: 'Host!', rationale: 'r' }))
        .text,
    ).toContain('kind: page p1 is a person page');
    expect(
      (await call('propose_page', { ...same, page_id: 'nope', rationale: 'r' })).text,
    ).toContain('Page not found.');
    expect((await call('propose_page', { ...same, page_id: 'p9', rationale: 'r' })).text).toContain(
      'merged into page p1',
    );
    const ok = await call('propose_page', {
      ...same,
      body_md: 'Host of the show.',
      rationale: 'r',
    });
    expect(ok.isError).toBe(false);
    expect(wikiRunProposals(state)).toEqual([
      {
        target: { type: 'page', pageId: 'p1', baseRevision: 3 },
        kind: 'person',
        title: 'Christina Ramos',
        aliases: ['CR'],
        bodyMd: 'Host of the show.',
        rationale: 'r',
      },
    ]);
  });

  it('a session page target takes no aliases', async () => {
    const { call } = wikiTools(
      fakePort({ pages: [livePage({ id: 'ps', kind: 'session', aliases: [] })] }).port,
    );
    const res = await call('propose_page', {
      page_id: 'ps',
      title: 'Christina Ramos',
      aliases: ['x'],
      body_md: 'new',
      rationale: 'r',
    });
    expect(res.text).toContain('aliases: a session page has none');
  });

  it('a target page over 30,000 characters cannot be rewritten', async () => {
    const { call } = wikiTools(
      fakePort({ pages: [livePage({ bodyMd: 'x'.repeat(30_001) })] }).port,
    );
    const res = await call('propose_page', {
      page_id: 'p1',
      title: 'Christina Ramos',
      aliases: [],
      body_md: 'short',
      rationale: 'r',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('too long');
  });

  it('link problems from the store check are returned, one line each', async () => {
    const { call, state } = wikiTools(
      fakePort({ linkProblems: () => ['A cited session is not in this show.'] }).port,
    );
    const res = await call('propose_page', newProposal({ body_md: 'see [x](cite:S9@1)' }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('A cited session is not in this show.');
    expect(wikiRunProposals(state)).toEqual([]);
  });
});

describe('propose_page: per-run targets', () => {
  it('a later proposal for a target replaces the earlier one', async () => {
    const { call, state } = wikiTools(fakePort({ pages: [livePage()] }).port);
    const base = { page_id: 'p1', title: 'Christina Ramos', aliases: ['CR'], rationale: 'r' };
    await call('propose_page', { ...base, body_md: 'one' });
    const second = await call('propose_page', { ...base, body_md: 'two' });
    expect(second.text).toContain('replaces');
    expect(wikiRunProposals(state).map((p) => p.bodyMd)).toEqual(['two']);
  });

  it('new pages are the same target when the titles differ only in case and accents', async () => {
    const { call, state } = wikiTools(fakePort().port);
    await call('propose_page', newProposal({ title: 'Café Noir' }));
    await call('propose_page', newProposal({ title: 'CAFE NOIR', body_md: 'second' }));
    expect(wikiRunProposals(state).map((p) => [p.title, p.bodyMd])).toEqual([
      ['CAFE NOIR', 'second'],
    ]);
  });

  it(`the ${WIKI_RUN_MAX_TARGETS + 1}st target is refused; replacing one still works`, async () => {
    const { call, state } = wikiTools(fakePort().port);
    for (let i = 0; i < WIKI_RUN_MAX_TARGETS; i += 1) {
      expect((await call('propose_page', newProposal({ title: `T${i}` }))).isError).toBe(false);
    }
    const over = await call('propose_page', newProposal({ title: 'One too many' }));
    expect(over.isError).toBe(true);
    expect(over.text).toContain(`${WIKI_RUN_MAX_TARGETS} targets`);
    expect(
      (await call('propose_page', newProposal({ title: 'T0', body_md: 'again' }))).isError,
    ).toBe(false);
    expect(wikiRunProposals(state)).toHaveLength(WIKI_RUN_MAX_TARGETS);
  });

  it('nothing is recorded once the turn is closed', async () => {
    const { call, state } = wikiTools(fakePort().port);
    state.closed = true;
    expect((await call('propose_page', newProposal())).isError).toBe(true);
    expect(wikiRunProposals(state)).toEqual([]);
  });
});

describe('propose_page: citations and the quote match (D4 steps 4–5)', () => {
  const WORDS: WikiSnapshotWord[] = [
    word('Café,', '00:01:01:00'),
    word('noir!', '00:01:01:12'),
    word('edge', '00:02:00:00'),
    word('word', '00:02:00:05'),
    word('r', '00:02:00:10'),
    word('drop', '00:10:00;15'),
    word('frame', '00:10:00;20'),
    word('fallback', '', 900.5),
    word("rock'n'roll", '00:20:00:00'),
    word('a', '00:30:00:00'),
    word('b', '00:30:00:01'),
    word('c', '00:30:00:02'),
  ];
  const propose = async (body: string, words = WORDS, port = fakePort().port) => {
    const t = wikiTools(port, words);
    const res = await t.call('propose_page', newProposal({ body_md: body }));
    return { ...res, proposals: wikiRunProposals(t.state) };
  };

  it('a misquote is sent back to the model, naming the citation', async () => {
    const res = await propose('He said [we never said that](cite:S1@120).');
    expect(res.isError).toBe(true);
    expect(res.text).toContain(
      'cite:S1@120 "we never said that": not found within 30 s of 00:02:00',
    );
    expect(res.proposals).toEqual([]);
  });

  it('a reference-style citation is checked by its text', async () => {
    const res = await propose('He said [we never said that][r].\n\n[r]: cite:S1@120');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('cite:S1@120 "we never said that": not found');
    // The label alone is in the window.
    expect((await propose('He said [r][].\n\n[r]: cite:S1@120')).isError).toBe(false);
  });

  it("accents, case and punctuation don't matter", async () => {
    expect((await propose('[cafe NOIR](cite:S1@75)')).isError).toBe(false);
    expect((await propose('[café — noir](cite:S1@61)')).isError).toBe(false);
  });

  it('the first word at exactly t−30 and t+30 passes, at t−31 and t+31 fails', async () => {
    // "edge" is at 120 s.
    expect((await propose('[edge word](cite:S1@150)')).isError).toBe(false);
    expect((await propose('[edge word](cite:S1@90)')).isError).toBe(false);
    expect((await propose('[edge word](cite:S1@151)')).isError).toBe(true);
    expect((await propose('[edge word](cite:S1@89)')).isError).toBe(true);
  });

  it('drop-frame timecodes, and start_sec for a word with an empty timecode', async () => {
    expect((await propose('[drop frame](cite:S1@600)')).isError).toBe(false);
    expect((await propose('[fallback](cite:S1@905)')).isError).toBe(false);
    expect((await propose('[fallback](cite:S1@940)')).isError).toBe(true);
  });

  it("a word holding two tokens (rock'n'roll)", async () => {
    expect((await propose('[Rock n Roll](cite:S1@1200)')).isError).toBe(false);
    expect((await propose("[rock 'n' roll](cite:S1@1200)")).isError).toBe(false);
  });

  it('a non-contiguous quote fails', async () => {
    expect((await propose('[a b c](cite:S1@1800)')).isError).toBe(false);
    expect((await propose('[a c](cite:S1@1800)')).isError).toBe(true);
  });

  it('an empty quote and one over 60 words fail', async () => {
    const empty = await propose('[!!!](cite:S1@1800)');
    expect(empty.text).toContain('cite:S1@1800 "!!!": the quote has no words');
    const long = await propose(
      `[${Array.from({ length: 61 }, () => 'a').join(' ')}](cite:S1@1800)`,
    );
    expect(long.text).toContain('the quote has 61 words; at most 60');
  });

  it('more than 200 checked citations is refused', async () => {
    const body = Array.from({ length: 201 }, () => '[a b](cite:S1@1800)').join(' ');
    const res = await propose(body);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('201 new citations; at most 200');
    const ok = Array.from({ length: 200 }, () => '[a b](cite:S1@1800)').join(' ');
    expect((await propose(ok)).isError).toBe(false);
  });

  it('a new citation of another session is refused', async () => {
    const res = await propose('[a b](cite:S2@1800)');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('cite:S2@1800 "a b": new citations must quote this session (S1)');
  });

  it("kept citations aren't re-checked, even a paraphrase or another session's", async () => {
    const page = livePage({
      bodyMd: 'He [paraphrased something](cite:S1@5) and [elsewhere](cite:S9@7).',
    });
    const { port, calls } = fakePort({ pages: [page] });
    const t = wikiTools(port, WORDS);
    const res = await t.call('propose_page', {
      page_id: 'p1',
      title: page.title,
      aliases: page.aliases,
      body_md: `${page.bodyMd}\n\nMore: [Paraphrased  SOMETHING][k].\n\n[k]: cite:S1@5`,
      rationale: 'r',
    });
    expect(res.isError).toBe(false);
    // Only citation texts were normalised; the transcript never was (nothing needed matching).
    expect(calls.filter((c) => c === 'normalize')).toHaveLength(1);
  });

  it('the transcript is normalised once per run', async () => {
    const { port, calls } = fakePort();
    const t = wikiTools(port, WORDS);
    await t.call('propose_page', newProposal({ title: 'A', body_md: '[a b](cite:S1@1800)' }));
    await t.call('propose_page', newProposal({ title: 'B', body_md: '[b c](cite:S1@1800)' }));
    // One call per proposal for its citation texts, plus one for the transcript.
    expect(calls.filter((c) => c === 'normalize')).toHaveLength(3);
  });

  it('every problem is collected before answering', async () => {
    const res = await propose(
      '[nope](cite:S1@1) [a b](cite:S2@1800)',
      WORDS,
      fakePort({
        linkProblems: () => ['Bad link.'],
      }).port,
    );
    const lines = res.text.split('\n');
    expect(lines).toContain('Bad link.');
    expect(lines.some((l) => l.startsWith('cite:S1@1 "nope"'))).toBe(true);
    expect(lines.some((l) => l.startsWith('cite:S2@1800'))).toBe(true);
  });
});

describe('propose_page: carried-forward citations of another session (D4 step 4)', () => {
  /** Session S0's words: "x y" at 100 s. */
  const S0_WORDS = [word('x', '00:01:40:00'), word('y', '00:01:40:05')];
  const pageWithPending = (pendingBody: string) =>
    fakePort({
      pages: [livePage({ pendingSuggestionId: 'sg1' })],
      pending: [pendingSuggestion({ bodyMd: pendingBody })],
      sessions: { S0: S0_WORDS },
    });
  const newWithPending = (pendingBody: string) =>
    fakePort({
      pending: [
        pendingSuggestion({
          suggestionId: 'sg9',
          pageId: null,
          kind: 'topic',
          title: 'Café Noir',
          aliases: [],
          bodyMd: pendingBody,
        }),
      ],
      sessions: { S0: S0_WORDS },
    });
  const toPage = (body: string) => ({
    page_id: 'p1',
    title: 'Christina Ramos',
    aliases: ['CR'],
    body_md: body,
    rationale: 'r',
  });
  const toNew = (body: string) => newProposal({ title: 'CAFE NOIR', body_md: body });

  it('a carried-forward citation passes, checked against the earlier session (page target)', async () => {
    const { port, args } = pageWithPending('Host. [x y](cite:S0@100)');
    const t = wikiTools(port);
    const res = await t.call('propose_page', toPage('Host. [x y](cite:S0@100)'));
    expect(res.isError).toBe(false);
    expect(args).toEqual(['pendingFor page:p1', 'sessionWords S0']);
  });

  it('a carried-forward misquote is refused, naming the citation (page target)', async () => {
    const { port } = pageWithPending('Host. [x z](cite:S0@100)');
    const t = wikiTools(port);
    const res = await t.call('propose_page', toPage('Host. [x z](cite:S0@100)'));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('cite:S0@100 "x z": not found within 30 s of 00:01:40');
    expect(wikiRunProposals(t.state)).toEqual([]);
  });

  it('a carried-forward citation outside the time window is refused', async () => {
    const { port } = pageWithPending('[x y](cite:S0@200)');
    const res = await wikiTools(port).call('propose_page', toPage('[x y](cite:S0@200)'));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('cite:S0@200 "x y": not found within 30 s of 00:03:20');
  });

  it('a carried-forward citation passes for a new-page target, found by its normalised title', async () => {
    const { port, args } = newWithPending('[x y](cite:S0@100)');
    const t = wikiTools(port);
    const res = await t.call('propose_page', toNew('More. [X, Y!](cite:S0@100)'));
    expect(res.isError).toBe(false);
    expect(args).toEqual(['pendingFor new:cafe noir', 'sessionWords S0']);
  });

  it('a carried-forward misquote is refused for a new-page target', async () => {
    const { port } = newWithPending('[x z](cite:S0@100)');
    const t = wikiTools(port);
    const res = await t.call('propose_page', toNew('[x z](cite:S0@100)'));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('cite:S0@100 "x z": not found within 30 s of 00:01:40');
    expect(wikiRunProposals(t.state)).toEqual([]);
  });

  it("a new citation of a session the target's pending suggestion doesn't cite is refused, with no read of its words", async () => {
    const { port, args } = fakePort({
      pages: [livePage({ pendingSuggestionId: 'sg1' })],
      pending: [pendingSuggestion({ bodyMd: '[x y](cite:S0@100)' })],
      sessions: { S0: S0_WORDS, S2: S0_WORDS },
    });
    const res = await wikiTools(port).call('propose_page', toPage('[x y](cite:S2@100)'));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('cite:S2@100 "x y": new citations must quote this session (S1)');
    expect(args).not.toContain('sessionWords S2');
  });

  it("a citation of another page's pending suggestion's session doesn't qualify", async () => {
    const { port, args } = fakePort({
      pages: [livePage(), livePage({ id: 'p2', title: 'Other', pendingSuggestionId: 'sg2' })],
      pending: [
        pendingSuggestion({ suggestionId: 'sg2', pageId: 'p2', bodyMd: '[x y](cite:S0@100)' }),
      ],
      sessions: { S0: S0_WORDS },
    });
    const res = await wikiTools(port).call('propose_page', toPage('[x y](cite:S0@100)'));
    expect(res.text).toContain('new citations must quote this session (S1)');
    expect(args).toEqual(['pendingFor page:p1']);
  });

  it("sessionWords of another show's session (null) is refused", async () => {
    const { port, args } = fakePort({
      pages: [livePage({ pendingSuggestionId: 'sg1' })],
      pending: [pendingSuggestion({ bodyMd: '[x y](cite:SX@100)' })],
      sessions: {},
    });
    const t = wikiTools(port);
    const res = await t.call('propose_page', toPage('[x y](cite:SX@100)'));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('cite:SX@100 "x y": new citations must quote this session (S1)');
    expect(args).toContain('sessionWords SX');
    expect(wikiRunProposals(t.state)).toEqual([]);
  });

  it(`at most ${WIKI_OTHER_SESSIONS_MAX} other sessions per run; the next is refused`, async () => {
    const ids = Array.from({ length: WIKI_OTHER_SESSIONS_MAX + 1 }, (_, i) => `O${i}`);
    const body = ids.map((id) => `[x y](cite:${id}@100)`).join(' ');
    const { port, args } = fakePort({
      pages: [livePage({ pendingSuggestionId: 'sg1' })],
      pending: [pendingSuggestion({ bodyMd: body })],
      sessions: Object.fromEntries(ids.map((id) => [id, S0_WORDS])),
    });
    const res = await wikiTools(port).call('propose_page', toPage(body));
    expect(res.isError).toBe(true);
    const problems = res.text.split('\n').slice(1);
    expect(problems).toEqual([
      `cite:O${WIKI_OTHER_SESSIONS_MAX}@100 "x y": at most ${WIKI_OTHER_SESSIONS_MAX} other sessions can be checked per run`,
    ]);
    expect(args.filter((a) => a.startsWith('sessionWords'))).toHaveLength(WIKI_OTHER_SESSIONS_MAX);
  });

  it("another session's words are read and normalised once per run", async () => {
    const { port, calls, args } = pageWithPending('[x y](cite:S0@100) [y](cite:S0@100)');
    const t = wikiTools(port);
    expect((await t.call('propose_page', toPage('[x y](cite:S0@100)'))).isError).toBe(false);
    expect((await t.call('propose_page', toPage('[y](cite:S0@100) again'))).isError).toBe(false);
    expect(args.filter((a) => a === 'sessionWords S0')).toHaveLength(1);
    // Per proposal one call for its citation texts, plus one for S0's words.
    expect(calls.filter((c) => c === 'normalize')).toHaveLength(3);
  });

  it('a pending suggestion is not trusted: its citations of the run session are checked too', async () => {
    const { port } = pageWithPending('[we never said that](cite:S1@120)');
    const res = await wikiTools(port).call(
      'propose_page',
      toPage('[we never said that](cite:S1@120)'),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain('cite:S1@120 "we never said that": not found');
  });

  it.each([
    'pendingFor',
    'sessionWords',
  ] as const)('a thrown %s returns "Tool failed."', async (m) => {
    const { port } = fakePort({
      pages: [livePage({ pendingSuggestionId: 'sg1' })],
      pending: [pendingSuggestion({ bodyMd: '[x y](cite:S0@100)' })],
      sessions: { S0: S0_WORDS },
      throwOn: m,
    });
    const res = await wikiTools(port).call('propose_page', toPage('[x y](cite:S0@100)'));
    expect(res).toEqual({ text: TOOL_FAILED_TEXT, isError: true });
  });
});

describe('a thrown port error returns "Tool failed."', () => {
  it.each([
    ['list_wiki_pages', 'listPages', {}],
    ['read_wiki_page', 'readPage', { page_id: 'p1' }],
    ['read_wiki_page', 'readPending', { suggestion_id: 'sg1' }],
    ['propose_page', 'checkLinks', newProposal()],
    ['propose_page', 'nameHolder', newProposal()],
    ['propose_page', 'normalize', newProposal()],
  ] as const)('%s when %s throws', async (tool, method, args) => {
    const { call } = wikiTools(fakePort({ throwOn: method }).port);
    const res = await call(tool, args);
    expect(res).toEqual({ text: TOOL_FAILED_TEXT, isError: true });
    expect(res.text).not.toContain('SECRET');
  });
});
