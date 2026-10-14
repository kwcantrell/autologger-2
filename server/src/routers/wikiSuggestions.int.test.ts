// Wiki suggestion routes and the wiki update (show-wiki-ai task 5.1; api-contract-freeze "Wiki
// suggestion object", "Wiki update endpoint", "Wiki suggestion list, read, accept and dismiss
// endpoints"; wiki-generation).
//
// Every request runs as a member of the show-access matrix (`seedAccessMatrix`). The granted
// member also reaches a second show B of the same team (the cross-show cases). `wiki/generate`
// runs on the AI SDK route against the local fake provider (`fakeLlm.ts`), and on the CLI route
// against `fake-claude-wiki-success.mjs`, which calls the wiki tools over the real MCP listener.
// Success bodies are parsed with the contract's strict schemas, so an extra or missing key fails.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_RUNTIME_FIXTURES_DIR } from '@autologger/ai-runtime';
import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import { stableSessionCwd } from '@autologger/ai-runtime/aiChatRunner';
import { __resetAiMcpListenerForTests } from '@autologger/ai-runtime/aiMcpServer';
import { type WikiProposal, type WikiSuggestion, WikiSuggestionStore } from '@autologger/catalog';
import {
  WIKI_DETAIL,
  WIKI_SUGGESTION_DETAIL,
  wikiGenerateResponseSchema,
  wikiMergedConflictSchema,
  wikiPageIdConflictSchema,
  wikiPageSchema,
  wikiSuggestionAcceptResponseSchema,
  wikiSuggestionDetailSchema,
  wikiSuggestionListSchema,
  wikiSuggestionResolvedConflictSchema,
  wikiSuggestionSchema,
  wikiVersionConflictSchema,
} from '@autologger/contract';
import { userCaller } from '@autologger/session-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../appEnv';
import { answer, callTools, type FakeLlm, type FakeScript, startFakeLlm } from '../test/fakeLlm';
import { anonApp, app, defaultUser, env, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  NOT_APPROVED_EMAIL,
  seedAccessMatrix,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
  type TestCaller,
  testDb,
} from '../test/helpers';
import { CLI_TEST_EMAILS, chooseClaudeCli, saveSdkCredential } from '../test/llmRoutes';
import { holdAsAnotherProcess, runLeaseRows } from '../test/runLeases';
import { harnessHub } from '../test/session/sessionRows';
import { createWikiToolPort } from './_wikiToolPort';

type Json = Record<string, unknown>;

interface Sent {
  status: number;
  json: Json;
  res: Response;
}

const D = WIKI_SUGGESTION_DETAIL;
const FAILED = { detail: D.failed };
const CLI_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/fake-claude-wiki-success.mjs', import.meta.url),
);

async function send(
  who: TestCaller | null,
  method: string,
  path: string,
  body?: unknown,
  on: Bindings = env,
): Promise<Sent> {
  const headers: Record<string, string> = {};
  if (who !== null) headers.cookie = who.cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  const res = await (who === null ? anonApp : app).request(path, init, on);
  // No suggestion or wiki-update route sets a cookie: checked on every response.
  expect(res.headers.get('set-cookie')).toBeNull();
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json, res };
}

/** The show-access matrix plus show B of the same team, which the granted member also reaches,
 * with a session of its own, and show C of another team that no matrix member reaches. */
async function world() {
  const m = await seedAccessMatrix();
  const showB = await seedShow({ studioId: m.studioId, name: 'Other Show', code: 'OS' });
  const sessionB = await seedSession({ showId: showB });
  await catalogFor().auth.authGrantShow(m.granted.id, showB, m.owner.id, new Date().toISOString());
  const studioC = await seedStudio();
  const showC = await seedShow({ studioId: studioC, name: 'Foreign Show', code: 'FS' });
  const sessionC = await seedSession({ showId: showC });
  const me = m.granted;
  const wiki = () => catalogFor().forUser(me.id).wiki;
  const page = async (body: Json, showId = m.showId) => {
    const r = await send(me, 'POST', `/api/shows/${showId}/wiki/pages`, body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return wikiPageSchema.parse(r.json);
  };
  /** Stores proposals as one run of the granted member, as `wiki/generate` does. */
  const seed = (proposals: WikiProposal[], showId = m.showId, sessionId = m.sessionId) =>
    wiki().saveRun(showId, sessionId, crypto.randomUUID(), proposals);
  return { ...m, me, showB, sessionB, showC, sessionC, wiki, page, seed };
}
type World = Awaited<ReturnType<typeof world>>;

const newPage = (title: string, extra: Partial<WikiProposal> = {}): WikiProposal => ({
  target: { type: 'new' },
  kind: 'person',
  title,
  aliases: [],
  bodyMd: `${title} body.\n`,
  rationale: `About ${title}.`,
  ...extra,
});
const pageEdit = (pageId: string, baseRevision: number, title: string, bodyMd: string) =>
  ({
    target: { type: 'page', pageId, baseRevision },
    kind: 'person',
    title,
    aliases: [],
    bodyMd,
    rationale: 'An edit.',
  }) satisfies WikiProposal;

/** "Alice joined the band in Paris", every word at 00:01:00 (60 s). */
async function seedWords(sessionId: string, at = '00:01:00:00'): Promise<void> {
  const hub = await harnessHub(sessionId);
  for (const word of ['Alice', 'joined', 'the', 'band', 'in', 'Paris']) {
    await hub.insertTranscriptWord({ session_time: at, speaker: 'Host', word });
  }
}

/** A transcript spanning two generation pages (as transcribe.int.test.ts). */
async function seedTwoPageWords(sessionId: string): Promise<void> {
  const hub = await harnessHub(sessionId);
  for (let i = 0; i < 30; i += 1) {
    await hub.insertTranscriptWord({
      session_time: '00:00:01:00',
      speaker: 'Host',
      word: `w${i}${'a'.repeat(2_000)}`,
    });
  }
}

/** Every suggestion of the show, any status. */
async function allSuggestions(showId: string): Promise<WikiSuggestion[]> {
  const wiki = catalogFor().wiki;
  const out: WikiSuggestion[] = [];
  for (const status of ['pending', 'accepted', 'dismissed', 'superseded'] as const) {
    out.push(...(await wiki.listSuggestions(showId, { status })).suggestions);
  }
  return out;
}

// -- wiki/generate --------------------------------------------------------------------------------

describe('POST /api/sessions/:sessionId/wiki/generate', () => {
  const fakes: FakeLlm[] = [];
  const cwds: string[] = [];
  beforeEach(async () => {
    aiChatTurns.reset();
    await __resetAiMcpListenerForTests();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    aiChatTurns.reset();
    await __resetAiMcpListenerForTests();
    await Promise.all(fakes.splice(0).map((f) => f.close()));
    for (const id of cwds.splice(0)) rmSync(stableSessionCwd(id), { recursive: true, force: true });
  });
  async function fakeProvider(script: FakeScript): Promise<FakeLlm> {
    const f = await startFakeLlm(script);
    fakes.push(f);
    return f;
  }
  /** `CLAUDE_CLI_PATH` set and the callers listed: only the saved choice decides the route. */
  const aiEnv = (
    o: Record<string, unknown> = {},
    cli = join(AI_RUNTIME_FIXTURES_DIR, 'fake-claude.mjs'),
  ) =>
    envWith({ CLAUDE_CLI_PATH: cli, CLAUDE_CLI_EMAILS: CLI_TEST_EMAILS, HOST: '127.0.0.1', ...o });
  const generate = (who: TestCaller | null, s: string, on: Bindings = aiEnv()) => {
    cwds.push(s);
    return send(who, 'POST', `/api/sessions/${s}/wiki/generate`, undefined, on);
  };
  /** Everything request `n` (from 1) sent, as text: the tool results the model saw. */
  const sentIn = (llm: FakeLlm, n: number) => JSON.stringify(llm.requests[n - 1]?.messages ?? []);

  const propose = (args: Json) => ({ name: 'propose_page', args });
  const alice = (s: string, quote = 'Alice joined the band') =>
    propose({
      kind: 'person',
      title: 'Alice',
      aliases: [],
      body_md: `Alice plays bass. [${quote}](cite:${s}@60)\n`,
      rationale: 'Alice is introduced in this session.',
    });
  const plain = (title: string) =>
    propose({
      kind: 'topic',
      title,
      aliases: [],
      body_md: `${title} came up.\n`,
      rationale: `${title} is discussed.`,
    });
  const transcript = { name: 'get_transcript_words', args: { page: 0 } };

  /** A world whose session has words and whose granted member has an AI SDK route on `llm`. */
  async function sdkWorld(llm: FakeLlm): Promise<World> {
    const w = await world();
    await seedWords(w.sessionId);
    await saveSdkCredential(llm.baseURL, { cookie: w.me.cookie });
    return w;
  }

  describe('the order of checks', () => {
    it('401 when not logged in, with no model request', async () => {
      const llm = await fakeProvider(() => answer('done'));
      const w = await sdkWorld(llm);
      const r = await generate(null, w.sessionId);
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ detail: 'Login required.' });
      expect(llm.requests).toHaveLength(0);
    });

    it('the masked 404 for a missing session, a session with no show, an ungranted member and an outsider; first, even with no AI route', async () => {
      const llm = await fakeProvider(() => answer('done'));
      const w = await sdkWorld(llm);
      const noShow = await seedSession({ showId: w.showId });
      await testDb().run('update sessions set show_id = null where id = ?', noShow);
      for (const [who, s] of [
        [w.me, 'no-such-session'],
        [w.me, noShow],
        [w.ungranted, w.sessionId],
        [w.nonMember, w.sessionId],
        // No AI route and no access: still the 404.
        [w.ungranted, w.sessionC],
      ] as Array<[TestCaller, string]>) {
        const r = await generate(who, s);
        expect(r.status, s).toBe(404);
        expect(r.json).toEqual({ detail: 'Session not found' });
      }
      expect(llm.requests).toHaveLength(0);
      expect(await allSuggestions(w.showId)).toEqual([]);
    });

    it('503 with no AI route (CLAUDE_CLI_PATH alone is not one), before the 403, with no slot or lease', async () => {
      const w = await world();
      await seedWords(w.sessionId);
      const r = await generate(w.me, w.sessionId);
      expect(r.status).toBe(503);
      expect(r.json).toEqual({ detail: D.noLanguageModel });
      // A user who is not approved and has no route gets the 503, not the 403.
      const notApproved = await seedUser({ email: NOT_APPROVED_EMAIL, studios: [w.studioId] });
      await catalogFor().auth.authGrantShow(
        notApproved,
        w.showId,
        w.owner.id,
        new Date().toISOString(),
      );
      const na = { id: notApproved, cookie: await loginCookie(notApproved) };
      const r2 = await generate(na, w.sessionId);
      expect(r2.status).toBe(503);
      expect(aiChatTurns.isSessionInFlight(w.sessionId)).toBe(false);
      expect(await runLeaseRows(w.sessionId)).toEqual([]);
    });

    it('403 for a user who is not approved, before the no-transcript 400', async () => {
      const llm = await fakeProvider(() => answer('done'));
      const w = await world();
      const notApproved = await seedUser({ email: NOT_APPROVED_EMAIL, studios: [w.studioId] });
      await catalogFor().auth.authGrantShow(
        notApproved,
        w.showId,
        w.owner.id,
        new Date().toISOString(),
      );
      const na = { id: notApproved, cookie: await loginCookie(notApproved) };
      await saveSdkCredential(llm.baseURL, { cookie: na.cookie });
      const r = await generate(na, w.sessionId);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({
        detail: 'This feature is limited to approved users on this server.',
      });
      expect(llm.requests).toHaveLength(0);
    });

    it('400 for a session with no transcript words, before the busy 409, with no model request', async () => {
      const llm = await fakeProvider(() => answer('done'));
      const w = await world();
      await saveSdkCredential(llm.baseURL, { cookie: w.me.cookie });
      const held = aiChatTurns.tryAcquire(w.sessionId);
      expect(held.ok).toBe(true);
      try {
        const r = await generate(w.me, w.sessionId);
        expect(r.status).toBe(400);
        expect(r.json).toEqual({ detail: D.noTranscript });
      } finally {
        if (held.ok) held.release();
      }
      expect(llm.requests).toHaveLength(0);
    });

    it('409 with the wiki busy detail against a held slot, and against another process’s lease; nothing stored', async () => {
      const llm = await fakeProvider(() => answer('done'));
      const w = await sdkWorld(llm);
      const held = aiChatTurns.tryAcquire(w.sessionId);
      expect(held.ok).toBe(true);
      try {
        const r = await generate(w.me, w.sessionId);
        expect(r.status).toBe(409);
        expect(r.json).toEqual({ detail: D.busy });
      } finally {
        if (held.ok) held.release();
      }
      // The lease helper reads the hub as the default user: make it an admin of the team.
      await catalogFor().auth.authAddMembershipWithRole(
        (await defaultUser()).id,
        w.studioId,
        'admin',
      );
      const other = await holdAsAnotherProcess(w.sessionId, 'ai-turn');
      const r2 = await generate(w.me, w.sessionId);
      expect(r2.status).toBe(409);
      expect(r2.json).toEqual({ detail: D.busy });
      expect(aiChatTurns.isSessionInFlight(w.sessionId)).toBe(false);
      expect(await runLeaseRows(w.sessionId)).toEqual([
        { kind: 'ai-turn', holder_client_id: other },
      ]);
      expect(llm.requests).toHaveLength(0);
      expect(await allSuggestions(w.showId)).toEqual([]);
    });
  });

  it('Update wiki returns the stored suggestions on the AI SDK route', async () => {
    let s = '';
    const llm = await fakeProvider((n) =>
      n === 1
        ? callTools(1, [transcript, { name: 'list_wiki_pages', args: {} }])
        : n === 2
          ? callTools(2, [alice(s)])
          : answer('done'),
    );
    const w = await sdkWorld(llm);
    s = w.sessionId;
    const r = await generate(w.me, s);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const body = wikiGenerateResponseSchema.parse(r.json);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]).toMatchObject({
      show_id: w.showId,
      session_id: s,
      status: 'pending',
      page_id: null,
      base_revision: null,
      kind: 'person',
      title: 'Alice',
      aliases: [],
      page: null,
      stale: false,
      created_by_name: 'Test User',
      resolved_at_utc: null,
      resolved_by_name: null,
      resolved_revision: null,
    });
    // Exactly the four wiki tools are offered.
    const tools = ((llm.requests[0]?.tools ?? []) as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(tools.sort()).toEqual(
      ['get_transcript_words', 'list_wiki_pages', 'propose_page', 'read_wiki_page'].sort(),
    );
    expect(sentIn(llm, 3)).toContain('Recorded the proposal');
    expect((await allSuggestions(w.showId)).map((x) => x.id)).toEqual([body.suggestions[0]?.id]);
    expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
    expect(await runLeaseRows(s)).toEqual([]);
  });

  it('Update wiki returns the stored suggestions on the CLI route, with the four tools allowed', {
    timeout: 30_000,
  }, async () => {
    const w = await world();
    await seedWords(w.sessionId);
    await chooseClaudeCli(w.me.id);
    const r = await generate(w.me, w.sessionId, aiEnv({}, CLI_FIXTURE));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const body = wikiGenerateResponseSchema.parse(r.json);
    expect(body.suggestions.map((x) => [x.status, x.page_id, x.kind, x.title])).toEqual([
      ['pending', null, 'person', 'Alice'],
    ]);
    const cwd = stableSessionCwd(w.sessionId);
    const argv = JSON.parse(readFileSync(join(cwd, '.fixture-argv.json'), 'utf8')) as string[];
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(
      [
        'mcp__autologger__get_transcript_words',
        'mcp__autologger__list_wiki_pages',
        'mcp__autologger__read_wiki_page',
        'mcp__autologger__propose_page',
      ].join(','),
    );
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('5');
    const results = JSON.parse(
      readFileSync(join(cwd, '.fixture-tool-results.json'), 'utf8'),
    ) as string[];
    expect(results[1]).toContain('Recorded the proposal');
    expect(aiChatTurns.isSessionInFlight(w.sessionId)).toBe(false);
  });

  it('WIKI_GENERATE_MAX_BUDGET_USD reaches the CLI', { timeout: 30_000 }, async () => {
    const w = await world();
    await seedWords(w.sessionId);
    await chooseClaudeCli(w.me.id);
    const r = await generate(
      w.me,
      w.sessionId,
      aiEnv({ WIKI_GENERATE_MAX_BUDGET_USD: '1.25' }, CLI_FIXTURE),
    );
    expect(r.status).toBe(200);
    const argv = JSON.parse(
      readFileSync(join(stableSessionCwd(w.sessionId), '.fixture-argv.json'), 'utf8'),
    ) as string[];
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('1.25');
  });

  it('a run with no proposals is a success with an empty list', async () => {
    const llm = await fakeProvider((n) => (n === 1 ? callTools(1, [transcript]) : answer('none')));
    const w = await sdkWorld(llm);
    const r = await generate(w.me, w.sessionId);
    expect(r.status).toBe(200);
    expect(wikiGenerateResponseSchema.parse(r.json)).toEqual({ suggestions: [] });
  });

  it('A provider failure after proposals stores nothing', async () => {
    let s = '';
    const llm = await fakeProvider((n) =>
      n === 1
        ? callTools(1, [transcript])
        : n === 2
          ? callTools(2, [alice(s), plain('Touring')])
          : { status: 401, body: '{"error":"PROVIDER-MARKER"}' },
    );
    const w = await sdkWorld(llm);
    s = w.sessionId;
    const r = await generate(w.me, s);
    expect(r.status).toBe(502);
    expect(r.json).toEqual(FAILED);
    expect(sentIn(llm, 3).match(/Recorded the proposal/g)).toHaveLength(2);
    expect(await allSuggestions(w.showId)).toEqual([]);
    expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
  });

  it('a step-capped run fails; WIKI_GENERATE_MAX_STEPS applies', async () => {
    const llm = await fakeProvider((n) =>
      n === 1 ? callTools(1, [transcript, plain('Capped')]) : callTools(n, [transcript]),
    );
    const w = await sdkWorld(llm);
    const r = await generate(w.me, w.sessionId, aiEnv({ WIKI_GENERATE_MAX_STEPS: '3' }));
    expect(r.status).toBe(502);
    expect(llm.requests).toHaveLength(3);
    expect(await allSuggestions(w.showId)).toEqual([]);
  });

  it('a run over its token budget fails; WIKI_GENERATE_MAX_TOKENS applies', async () => {
    // 15 tokens a step; a budget of 40 stops after the third step.
    const llm = await fakeProvider((n) =>
      n === 1 ? callTools(1, [transcript, plain('Budget')]) : callTools(n, [transcript]),
    );
    const w = await sdkWorld(llm);
    const r = await generate(w.me, w.sessionId, aiEnv({ WIKI_GENERATE_MAX_TOKENS: '40' }));
    expect(r.status).toBe(502);
    expect(llm.requests).toHaveLength(3);
    expect(await allSuggestions(w.showId)).toEqual([]);
  });

  it('An unread transcript page fails the run', async () => {
    const llm = await fakeProvider((n) =>
      n === 1 ? callTools(1, [transcript, plain('Half read')]) : answer('done'),
    );
    const w = await world();
    await seedTwoPageWords(w.sessionId);
    await saveSdkCredential(llm.baseURL, { cookie: w.me.cookie });
    const r = await generate(w.me, w.sessionId);
    expect(r.status).toBe(502);
    expect(r.json).toEqual(FAILED);
    expect(sentIn(llm, 2)).toContain('Recorded the proposal');
    expect(await allSuggestions(w.showId)).toEqual([]);
  });

  it('A failed store stores nothing: a saveRun whose transaction fails part-way leaves no suggestion', async () => {
    const realSaveRun = WikiSuggestionStore.prototype.saveRun;
    const spy = vi
      .spyOn(WikiSuggestionStore.prototype, 'saveRun')
      .mockImplementation(async function (this: WikiSuggestionStore, showId, sessionId, runId, ps) {
        // The run's proposals, then one whose page doesn't exist: its insert fails on the page
        // foreign key inside the transaction, after the first rows were written.
        return realSaveRun.call(this, showId, sessionId, runId, [
          ...ps,
          pageEdit('no-such-page', 1, 'Ghost', 'Ghost body.\n'),
        ]);
      });
    let s = '';
    const llm = await fakeProvider((n) =>
      n === 1 ? callTools(1, [transcript, alice(s)]) : answer('done'),
    );
    const w = await sdkWorld(llm);
    s = w.sessionId;
    const r = await generate(w.me, s);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(502);
    expect(r.json).toEqual(FAILED);
    expect(await allSuggestions(w.showId)).toEqual([]);
    expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
  });

  it('a timed-out run whose propose_page body is still running stores nothing, and frees the slot and lease only after the body finished', {
    timeout: 30_000,
  }, async () => {
    const realCheckLinks = WikiSuggestionStore.prototype.checkLinks;
    let bodyDone = false;
    vi.spyOn(WikiSuggestionStore.prototype, 'checkLinks').mockImplementation(async function (
      this: WikiSuggestionStore,
      ...a: Parameters<WikiSuggestionStore['checkLinks']>
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      const out = await realCheckLinks.apply(this, a);
      bodyDone = true;
      return out;
    });
    let s = '';
    const llm = await fakeProvider((n) =>
      n === 1 ? callTools(1, [transcript, alice(s)]) : answer('done'),
    );
    const w = await sdkWorld(llm);
    s = w.sessionId;
    const started = Date.now();
    const r = await generate(w.me, s, aiEnv({ WIKI_GENERATE_TIMEOUT_SEC: '0.5' }));
    expect(r.status).toBe(502);
    expect(r.json).toEqual(FAILED);
    expect(bodyDone).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
    expect(await runLeaseRows(s)).toEqual([]);
    vi.restoreAllMocks();
    await new Promise((r2) => setTimeout(r2, 300));
    expect(await allSuggestions(w.showId)).toEqual([]);
  });

  it('A misquote is sent back to the model: the retried proposal is the only one stored', async () => {
    let s = '';
    const llm = await fakeProvider((n) =>
      n === 1
        ? callTools(1, [transcript])
        : n === 2
          ? callTools(2, [alice(s, 'we never said that')])
          : n === 3
            ? callTools(3, [alice(s)])
            : answer('done'),
    );
    const w = await sdkWorld(llm);
    s = w.sessionId;
    const r = await generate(w.me, s);
    expect(r.status).toBe(200);
    expect(sentIn(llm, 3)).toContain('Proposal not recorded');
    expect(sentIn(llm, 3)).toContain('not found within 30 s of 00:01:00');
    const body = wikiGenerateResponseSchema.parse(r.json);
    expect(body.suggestions).toHaveLength(1);
    const detail = await w.wiki().getSuggestion(body.suggestions[0]?.id ?? '');
    expect(detail?.body_md).toContain('[Alice joined the band]');
    expect(detail?.body_md).not.toContain('we never said that');
  });

  it('A page in another show is unreadable: read_wiki_page answers "Page not found."', async () => {
    let pageB = '';
    const llm = await fakeProvider((n) =>
      n === 1
        ? callTools(1, [transcript, { name: 'read_wiki_page', args: { page_id: pageB } }])
        : answer('done'),
    );
    const w = await sdkWorld(llm);
    pageB = (await w.page({ kind: 'topic', title: 'Secret', body_md: 'B-BODY-MARKER' }, w.showB))
      .id;
    const r = await generate(w.me, w.sessionId);
    expect(r.status).toBe(200);
    expect(sentIn(llm, 2)).toContain('Page not found.');
    expect(sentIn(llm, 2)).not.toContain('B-BODY-MARKER');
    expect(sentIn(llm, 2)).not.toContain('Secret');
  });

  it("a carried citation of show B's session in the target's pending suggestion gets the must-quote error, and B's words are never read", async () => {
    let s = '';
    let pageId = '';
    let wSessionB = '';
    const llm = await fakeProvider((n) =>
      n === 1
        ? callTools(1, [transcript])
        : n === 2
          ? callTools(2, [
              propose({
                page_id: pageId,
                title: 'Bob',
                aliases: [],
                body_md: `Bob. [Alice joined the band](cite:${wSessionB}@60)\n`,
                rationale: 'Carry forward.',
              }),
            ])
          : answer('done'),
    );
    const w = await sdkWorld(llm);
    s = w.sessionId;
    wSessionB = w.sessionB;
    await seedWords(w.sessionB);
    const bob = await w.page({ kind: 'person', title: 'Bob', body_md: 'Bob.\n' });
    pageId = bob.id;
    // A pending suggestion for Bob inserted directly (not through propose_page), citing B.
    await testDb().run(
      `insert into wiki_suggestions (id, show_id, session_id, run_id, page_id, base_revision, kind,
         title, body_md, aliases_json, rationale, status, created_by, created_by_name,
         created_at_utc)
       values (?, ?, ?, ?, ?, 1, 'person', 'Bob', ?, '[]'::jsonb, 'direct', 'pending', ?, 'Test User', ?)`,
      crypto.randomUUID(),
      w.showId,
      w.sessionId,
      crypto.randomUUID(),
      bob.id,
      `Bob. [Alice joined the band](cite:${w.sessionB}@60)\n`,
      w.me.id,
      new Date().toISOString(),
    );
    const gets = vi.spyOn(env.ports.sessions, 'get');
    const r = await generate(w.me, s);
    expect(r.status).toBe(200);
    expect(sentIn(llm, 3)).toContain(`new citations must quote this session (${s})`);
    expect(wikiGenerateResponseSchema.parse(r.json).suggestions).toEqual([]);
    expect(gets.mock.calls.map(([id]) => id)).not.toContain(w.sessionB);
  });

  it('a run supersedes the older pending suggestion for its target', async () => {
    let s = '';
    let pageId = '';
    const llm = await fakeProvider((n) =>
      n === 1
        ? callTools(1, [transcript])
        : n === 2
          ? callTools(2, [
              propose({
                page_id: pageId,
                title: 'Carol',
                aliases: [],
                body_md: `Carol sings. [Alice joined the band](cite:${s}@60)\n`,
                rationale: 'Newer.',
              }),
            ])
          : answer('done'),
    );
    const w = await sdkWorld(llm);
    s = w.sessionId;
    const carol = await w.page({ kind: 'person', title: 'Carol', body_md: 'Carol.\n' });
    pageId = carol.id;
    const [older] = await w.seed([pageEdit(carol.id, 1, 'Carol', 'Carol, older.\n')]);
    const r = await generate(w.me, s);
    expect(r.status).toBe(200);
    const [newer] = wikiGenerateResponseSchema.parse(r.json).suggestions;
    expect(newer).toMatchObject({ status: 'pending', page_id: carol.id, base_revision: 1 });
    expect((await w.wiki().getSuggestion(older?.id ?? ''))?.status).toBe('superseded');
  });
});

// -- the real WikiToolPort ------------------------------------------------------------------------

describe('_wikiToolPort over the caller-bound catalog (a member granted on shows A and B)', () => {
  const portFor = (w: World, sessionId = w.sessionId) =>
    createWikiToolPort(
      {
        catalog: catalogFor().forUser(w.me.id),
        sessions: env.ports.sessions,
        caller: userCaller(w.me.id),
      },
      w.showId,
      sessionId,
    );

  it("sessionWords: a session of A's show gives its words; a session of B and one in no accessible show give null", async () => {
    const w = await world();
    const other = await seedSession({ showId: w.showId });
    await seedWords(other);
    await seedWords(w.sessionB);
    await seedWords(w.sessionC);
    const port = portFor(w);
    const words = await port.sessionWords(other);
    expect(words?.map((x) => x.word)).toEqual(['Alice', 'joined', 'the', 'band', 'in', 'Paris']);
    expect(words?.[0]).toMatchObject({ session_time: '00:01:00:00', speaker: 'Host' });
    expect(await port.sessionWords(w.sessionB)).toBeNull();
    expect(await port.sessionWords(w.sessionC)).toBeNull();
    expect(await port.sessionWords('no-such-session')).toBeNull();
  });

  it('readPending: a pending suggestion of A; null for a suggestion of B and a resolved one of A', async () => {
    const w = await world();
    const [pendingA] = await w.seed([newPage('Dora')]);
    const [ofB] = await w.seed([newPage('Eve')], w.showB, w.sessionB);
    const [resolvedA] = await w.seed([newPage('Finn')]);
    await w.wiki().dismissSuggestion(resolvedA?.id ?? '');
    const port = portFor(w);
    expect(await port.readPending(pendingA?.id ?? '')).toMatchObject({
      suggestionId: pendingA?.id,
      pageId: null,
      kind: 'person',
      title: 'Dora',
      bodyMd: 'Dora body.\n',
    });
    expect(await port.readPending(ofB?.id ?? '')).toBeNull();
    expect(await port.readPending(resolvedA?.id ?? '')).toBeNull();
    expect(await port.readPending('no-such-suggestion')).toBeNull();
  });

  it('readPage: a live page of A with its pending suggestion id; null for a page of B and a deleted page; the merge target for a merged one', async () => {
    const w = await world();
    const live = await w.page({ kind: 'topic', title: 'Live', body_md: 'Live body.\n' });
    const [pending] = await w.seed([
      { ...pageEdit(live.id, 1, 'Live', 'Live, newer.\n'), kind: 'topic' },
    ]);
    const ofB = await w.page({ kind: 'topic', title: 'In B' }, w.showB);
    const gone = await w.page({ kind: 'topic', title: 'Gone' });
    expect(
      (await send(w.me, 'DELETE', `/api/wiki/pages/${gone.id}?expected_revision=1`)).status,
    ).toBe(200);
    const from = await w.page({ kind: 'topic', title: 'From' });
    const into = await w.page({ kind: 'topic', title: 'Into' });
    const merged = await send(w.me, 'POST', `/api/wiki/pages/${from.id}/merge`, {
      into_page_id: into.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    expect(merged.status).toBe(200);
    const port = portFor(w);
    expect(await port.readPage(live.id)).toEqual({
      id: live.id,
      kind: 'topic',
      title: 'Live',
      aliases: [],
      revision: 1,
      bodyMd: 'Live body.\n',
      pendingSuggestionId: pending?.id,
    });
    expect(await port.readPage(ofB.id)).toBeNull();
    expect(await port.readPage(gone.id)).toBeNull();
    expect(await port.readPage('no-such-page')).toBeNull();
    expect(await port.readPage(from.id)).toEqual({ mergedInto: into.id });
    // The list holds only A's live pages, with the pending flag, and A's pending new pages.
    const pages = await port.listPages();
    expect(pages.map((p) => [p.title, p.pending])).toEqual([
      ['Into', false],
      ['Live', true],
    ]);
    await w.seed([newPage('Gina')]);
    await w.seed([newPage('Hal')], w.showB, w.sessionB);
    expect((await port.listPendingNew()).map((p) => p.title)).toEqual(['Gina']);
  });

  it('pendingFor, nameHolder, sessionPageId, checkLinks and normalize are scoped to A', async () => {
    const w = await world();
    const [ida] = await w.seed([newPage('Ída')]);
    await w.seed([newPage('Ida')], w.showB, w.sessionB);
    const port = portFor(w);
    const [norm] = await port.normalize(['ÍDA']);
    expect(norm).toBe('ida');
    expect((await port.pendingFor({ normTitle: norm ?? '' }))?.suggestionId).toBe(ida?.id);
    const inB = await w.page({ kind: 'person', title: 'Jo' }, w.showB);
    expect(await port.nameHolder(['Jo'])).toBeNull();
    const inA = await w.page({ kind: 'person', title: 'Jo' });
    expect(await port.nameHolder(['jo'])).toBe(inA.id);
    expect(inB.id).not.toBe(inA.id);
    expect(await port.sessionPageId()).toBeNull();
    const own = await w.page({ kind: 'session', title: 'S1', session_id: w.sessionId });
    expect(await port.sessionPageId()).toBe(own.id);
    expect(await port.checkLinks(`[q](cite:${w.sessionId}@1)`)).toEqual([]);
    const bad = await port.checkLinks(`[q](cite:${w.sessionB}@1)`);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain(`cite:${w.sessionB}@1`);
  });
});

// -- list, read, accept, dismiss ------------------------------------------------------------------

describe('GET /api/shows/:showId/wiki/suggestions', () => {
  it('lists pending suggestions newest first by default, filters by status and page_id, and ignores unknown parameters', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Kim', body_md: 'Kim.\n' });
    const [first] = await w.seed([newPage('Lee')]);
    const [second] = await w.seed([pageEdit(p.id, 1, 'Kim', 'Kim, more.\n')]);
    const [third] = await w.seed([newPage('Max')]);
    await w.wiki().dismissSuggestion(third?.id ?? '');
    const r = await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/suggestions?junk=1`);
    expect(r.status).toBe(200);
    const list = wikiSuggestionListSchema.parse(r.json);
    expect(list.truncated).toBe(false);
    expect(list.suggestions.map((x) => x.id)).toEqual([second?.id, first?.id]);
    expect(list.suggestions[0]).toMatchObject({
      page: { title: 'Kim', revision: 1, state: 'live' },
      stale: false,
    });
    const byPage = wikiSuggestionListSchema.parse(
      (await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/suggestions?page_id=${p.id}`)).json,
    );
    expect(byPage.suggestions.map((x) => x.id)).toEqual([second?.id]);
    const dismissed = wikiSuggestionListSchema.parse(
      (await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/suggestions?status=dismissed`)).json,
    );
    expect(dismissed.suggestions.map((x) => [x.id, x.status])).toEqual([[third?.id, 'dismissed']]);
  });

  it('401 anonymous; the masked 404 for an ungranted member, an outsider and a missing show; 422 for a bad status', async () => {
    const w = await world();
    const path = `/api/shows/${w.showId}/wiki/suggestions`;
    const anon = await send(null, 'GET', path);
    expect(anon.status).toBe(401);
    expect(anon.json).toEqual({ detail: 'Login required.' });
    for (const [who, p] of [
      [w.ungranted, path],
      [w.nonMember, path],
      [w.me, '/api/shows/no-such-show/wiki/suggestions'],
    ] as Array<[TestCaller, string]>) {
      const r = await send(who, 'GET', p);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ detail: WIKI_DETAIL.showNotFound });
    }
    const bad = await send(w.me, 'GET', `${path}?status=open`);
    expect(bad.status).toBe(422);
    expect(Array.isArray(bad.json.detail)).toBe(true);
  });
});

describe('GET /api/wiki/suggestions/:suggestionId', () => {
  it('answers the suggestion plus body_md, and the masked 404 otherwise', async () => {
    const w = await world();
    const [s] = await w.seed([newPage('Ned')]);
    const r = await send(w.me, 'GET', `/api/wiki/suggestions/${s?.id}`);
    expect(r.status).toBe(200);
    const detail = wikiSuggestionDetailSchema.parse(r.json);
    expect(detail).toEqual({ ...s, body_md: 'Ned body.\n' });
    const anon = await send(null, 'GET', `/api/wiki/suggestions/${s?.id}`);
    expect(anon.status).toBe(401);
    expect(anon.json).toEqual({ detail: 'Login required.' });
    for (const [who, id] of [
      [w.ungranted, s?.id],
      [w.nonMember, s?.id],
      [w.me, 'no-such-suggestion'],
    ] as Array<[TestCaller, string]>) {
      const m = await send(who, 'GET', `/api/wiki/suggestions/${id}`);
      expect(m.status).toBe(404);
      expect(m.json).toEqual({ detail: D.suggestionNotFound });
    }
  });
});

describe('POST /api/wiki/suggestions/:suggestionId/accept', () => {
  const accept = (who: TestCaller | null, id: string | undefined, body: unknown = {}) =>
    send(who, 'POST', `/api/wiki/suggestions/${id}/accept`, body);

  it('200 for an existing page: the reviewer authors the revision, and the suggestion is accepted', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Olga', body_md: 'Olga.\n' });
    const [s] = await w.seed([pageEdit(p.id, 1, 'Olga', 'Olga, more.\n')]);
    const r = await accept(w.owner, s?.id, { expected_revision: 1 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const body = wikiSuggestionAcceptResponseSchema.parse(r.json);
    expect(body.page).toMatchObject({ id: p.id, revision: 2, body_md: 'Olga, more.\n' });
    expect(body.suggestion).toMatchObject({
      id: s?.id,
      status: 'accepted',
      resolved_revision: 2,
      resolved_by_name: 'Test User',
    });
  });

  it('Accept a stale suggestion against the current revision', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Pia', body_md: 'Pia.\n' });
    const [s] = await w.seed([pageEdit(p.id, 1, 'Pia', 'Pia, suggested.\n')]);
    const edit = await send(w.me, 'PUT', `/api/wiki/pages/${p.id}`, {
      expected_revision: 1,
      body_md: 'Pia, edited.\n',
    });
    expect(edit.status).toBe(200);
    const stale = wikiSuggestionDetailSchema.parse(
      (await send(w.me, 'GET', `/api/wiki/suggestions/${s?.id}`)).json,
    );
    expect(stale).toMatchObject({ base_revision: 1, page: { revision: 2 }, stale: true });
    const r = await accept(w.me, s?.id, { expected_revision: 2 });
    expect(r.status).toBe(200);
    const body = wikiSuggestionAcceptResponseSchema.parse(r.json);
    expect(body.page.revision).toBe(3);
    expect(body.suggestion).toMatchObject({ status: 'accepted', resolved_revision: 3 });
  });

  it('201 for a new page, with "edit, then accept" overrides', async () => {
    const w = await world();
    const [s] = await w.seed([newPage('Quinn')]);
    const r = await accept(w.me, s?.id, {
      title: 'Quinn Q',
      body_md: 'Edited.\n',
      aliases: ['QQ'],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const body = wikiSuggestionAcceptResponseSchema.parse(r.json);
    expect(body.page).toMatchObject({
      kind: 'person',
      title: 'Quinn Q',
      body_md: 'Edited.\n',
      aliases: ['QQ'],
      revision: 1,
    });
    expect(body.suggestion).toMatchObject({ status: 'accepted', resolved_revision: 1 });
  });

  it('each 409 body: version conflict, merged, deleted, title used, session has a page, already resolved', async () => {
    const w = await world();
    // Version conflict.
    const p = await w.page({ kind: 'person', title: 'Rae', body_md: 'Rae.\n' });
    const [s] = await w.seed([pageEdit(p.id, 1, 'Rae', 'Rae, more.\n')]);
    await send(w.me, 'PUT', `/api/wiki/pages/${p.id}`, { expected_revision: 1, body_md: 'x\n' });
    const conflict = await accept(w.me, s?.id, { expected_revision: 1 });
    expect(conflict.status).toBe(409);
    expect(wikiVersionConflictSchema.parse(conflict.json).current.revision).toBe(2);
    // Merged.
    const from = await w.page({ kind: 'person', title: 'Sam' });
    const into = await w.page({ kind: 'person', title: 'Samuel' });
    const [onFrom] = await w.seed([pageEdit(from.id, 1, 'Sam', 'Sam, more.\n')]);
    await send(w.me, 'POST', `/api/wiki/pages/${from.id}/merge`, {
      into_page_id: into.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    const merged = await accept(w.me, onFrom?.id, { expected_revision: 1 });
    expect(merged.status).toBe(409);
    expect(wikiMergedConflictSchema.parse(merged.json)).toEqual({
      detail: WIKI_DETAIL.merged,
      merged_into: into.id,
    });
    // Deleted.
    const del = await w.page({ kind: 'person', title: 'Tia' });
    const [onDel] = await w.seed([pageEdit(del.id, 1, 'Tia', 'Tia, more.\n')]);
    await send(w.me, 'DELETE', `/api/wiki/pages/${del.id}?expected_revision=1`);
    const deleted = await accept(w.me, onDel?.id, { expected_revision: 2 });
    expect(deleted.status).toBe(409);
    expect(deleted.json).toEqual({ detail: WIKI_DETAIL.deleted });
    // Title used.
    const [uma] = await w.seed([newPage('Uma')]);
    const holder = await w.page({ kind: 'topic', title: 'Uma' });
    const taken = await accept(w.me, uma?.id);
    expect(taken.status).toBe(409);
    expect(wikiPageIdConflictSchema.parse(taken.json)).toEqual({
      detail: WIKI_DETAIL.titleUsed,
      page_id: holder.id,
    });
    // Session already has a page.
    const [sess] = await w.seed([newPage('Session one', { kind: 'session' })]);
    const own = await w.page({ kind: 'session', title: 'S', session_id: w.sessionId });
    const sessionTaken = await accept(w.me, sess?.id);
    expect(sessionTaken.status).toBe(409);
    expect(wikiPageIdConflictSchema.parse(sessionTaken.json)).toEqual({
      detail: WIKI_DETAIL.sessionHasPage,
      page_id: own.id,
    });
    // Each refusal left its suggestion pending.
    for (const id of [s?.id, onFrom?.id, onDel?.id, uma?.id, sess?.id]) {
      expect((await w.wiki().getSuggestion(id ?? ''))?.status).toBe('pending');
    }
    // Accept twice.
    const [vic] = await w.seed([newPage('Vic')]);
    expect((await accept(w.me, vic?.id)).status).toBe(201);
    const twice = await accept(w.owner, vic?.id);
    expect(twice.status).toBe(409);
    expect(wikiSuggestionResolvedConflictSchema.parse(twice.json)).toEqual({
      detail: D.resolved,
      status: 'accepted',
    });
  });

  it('each 422: expected_revision missing for an existing page, a schema failure, a rule failure', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Wes', body_md: 'Wes.\n' });
    const [s] = await w.seed([pageEdit(p.id, 1, 'Wes', 'Wes, more.\n')]);
    const missing = await accept(w.me, s?.id, {});
    expect(missing.status).toBe(422);
    expect(missing.json).toEqual({ detail: D.expectedRevisionRequired });
    for (const body of [
      { expected_revision: 0 },
      { expected_revision: 1, title: 'a\nb' },
      { expected_revision: 1, body_md: 'x'.repeat(100_001) },
      { expected_revision: 1, aliases: Array.from({ length: 51 }, (_, i) => `a${i}`) },
    ]) {
      const r = await accept(w.me, s?.id, body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect(Array.isArray(r.json.detail)).toBe(true);
    }
    const rule = await accept(w.me, s?.id, {
      expected_revision: 1,
      body_md: `[q](cite:${w.sessionB}@1)`,
    });
    expect(rule.status).toBe(422);
    expect(rule.json).toEqual({ detail: expect.stringContaining(`cite:${w.sessionB}@1`) });
    expect((await w.wiki().getSuggestion(s?.id ?? ''))?.status).toBe('pending');
  });

  it('401 anonymous, and the masked 404 for an ungranted member, an outsider and a missing id, before the body is read', async () => {
    const w = await world();
    const [s] = await w.seed([newPage('Xan')]);
    const anon = await accept(null, s?.id);
    expect(anon.status).toBe(401);
    expect(anon.json).toEqual({ detail: 'Login required.' });
    for (const [who, id] of [
      [w.ungranted, s?.id],
      [w.nonMember, s?.id],
      [w.me, 'no-such-suggestion'],
    ] as Array<[TestCaller, string]>) {
      const r = await accept(who, id, { expected_revision: 0 });
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ detail: D.suggestionNotFound });
    }
    expect((await w.wiki().getSuggestion(s?.id ?? ''))?.status).toBe('pending');
  });
});

describe('POST /api/wiki/suggestions/:suggestionId/dismiss', () => {
  it('200 with the dismissed suggestion; 409 already resolved; 401; the masked 404s', async () => {
    const w = await world();
    const [s] = await w.seed([newPage('Yara')]);
    const path = `/api/wiki/suggestions/${s?.id}/dismiss`;
    expect((await send(null, 'POST', path)).status).toBe(401);
    for (const [who, p] of [
      [w.ungranted, path],
      [w.nonMember, path],
      [w.me, '/api/wiki/suggestions/no-such-suggestion/dismiss'],
    ] as Array<[TestCaller, string]>) {
      const r = await send(who, 'POST', p);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ detail: D.suggestionNotFound });
    }
    const r = await send(w.owner, 'POST', path);
    expect(r.status).toBe(200);
    expect(wikiSuggestionSchema.parse(r.json)).toMatchObject({
      id: s?.id,
      status: 'dismissed',
      resolved_by_name: 'Test User',
      resolved_revision: null,
    });
    const again = await send(w.me, 'POST', path);
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ detail: D.resolved, status: 'dismissed' });
    const accepted = await send(w.me, 'POST', `/api/wiki/suggestions/${s?.id}/accept`, {});
    expect(accepted.status).toBe(409);
    expect(accepted.json).toEqual({ detail: D.resolved, status: 'dismissed' });
  });
});
