// batch-autogenerate task 3.4 (design D7 topics, R12; topic-generation "the topics this run
// created"): the topics runner, shared by `POST …/topics/generate` and the batch worker, identifies
// its run's topics by the ids its tool created, not by set difference:
// - a failing run deletes exactly those, so a topic a person adds meanwhile survives (manual route
//   included); the success swap still deletes the pre-run topics;
// - a manual run whose tool created none while a person added one answers the existing 502 and
//   keeps the pre-run and the person's topics (R12 edge);
// - own-topic deletes are per row with version 1: an edited topic is kept, counted and present;
// - the outcomes: unconfigured, forbidden, no words, busy, failed, rate-limited, ok.
// Integration (real hub and Postgres) against a fake AI SDK provider.

import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import * as topicGenerateModule from '@autologger/ai-runtime/topicGenerate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, callTools, type FakeScript } from '../test/fakeLlm';
import {
  closeFakes,
  fakeProvider,
  genSession,
  markEdited,
  sdkAdmin,
  sdkEnv,
  seedAnchoredTranscript,
} from '../test/generationFixtures';
import { principalFor } from '../test/generationPrincipal';
import { app } from '../test/harness';
import { catalogFor, loginCookie, NOT_APPROVED_EMAIL, seedUser } from '../test/helpers';
import { hubFor } from './principal';
import { deleteOwnTopics, runTopics, topicsPresent } from './topics';

const t = (summary: string) => ({
  name: 'create_topic',
  args: { session_time: '00:00:01', duration_sec: 5, topic_level: 2, summary },
});
const createsTwo: FakeScript = (n) =>
  n === 1
    ? callTools(1, [{ name: 'get_transcript_words', args: { page: 0 } }])
    : n === 2
      ? callTools(2, [t('Gen one'), t('Gen two')])
      : answer('done');
const readsOnly: FakeScript = (n) =>
  n === 1 ? callTools(1, [{ name: 'get_transcript_words', args: { page: 0 } }]) : answer('done');
const createsThenFails: FakeScript = (n) =>
  n === 1
    ? callTools(1, [t('Gen partial')])
    : { status: 500, body: '{"error":"x"}', headers: { 'retry-after-ms': '5' } };

async function setup(script: FakeScript, opts: { email?: string; transcript?: boolean } = {}) {
  const llm = await fakeProvider(script);
  const { studioId, sessionId } = await genSession();
  if (opts.transcript !== false) await seedAnchoredTranscript(sessionId);
  const uid = await sdkAdmin(studioId, llm.baseURL, { email: opts.email });
  const p = await principalFor(uid, sdkEnv());
  return { llm, studioId, sessionId, uid, p };
}
const person = { session_time: '00:00:09', duration_sec: 1, topic_level: 1, summary: 'Person' };
const summaries = async (p: Awaited<ReturnType<typeof principalFor>>, s: string) =>
  (await (await hubFor(p, s)).listTopics()).map((x) => x.summary).sort();

/** Runs `fn` right after the topics turn returns, before the runner reads the run's topics. */
function afterTurn(fn: () => Promise<unknown>) {
  const real = topicGenerateModule.generateTopicsTurn;
  vi.spyOn(topicGenerateModule, 'generateTopicsTurn').mockImplementation(async (o) => {
    const out = await real(o);
    await fn();
    return out;
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeFakes();
});

describe('runTopics outcomes', () => {
  it('unconfigured, forbidden and no words, before any provider request', async () => {
    const a = await setup(createsTwo);
    // An admin of the same team with no language model saved.
    const bare = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(bare, a.studioId, 'admin');
    expect(await runTopics(await principalFor(bare, sdkEnv()), a.sessionId)).toEqual({
      kind: 'unconfigured',
    });
    const b = await setup(createsTwo, { email: NOT_APPROVED_EMAIL });
    expect(await runTopics(b.p, b.sessionId)).toEqual({ kind: 'forbidden' });
    const c = await setup(createsTwo, { transcript: false });
    expect(await runTopics(c.p, c.sessionId)).toMatchObject({
      kind: 'precondition',
      code: 'no-transcript',
    });
    expect(b.llm.requests).toHaveLength(0);
    expect(c.llm.requests).toHaveLength(0);
  });

  it('busy while the session slot is held', async () => {
    const a = await setup(createsTwo);
    const held = aiChatTurns.tryAcquire(a.sessionId);
    expect(held.ok).toBe(true);
    try {
      expect(await runTopics(a.p, a.sessionId)).toEqual({ kind: 'busy' });
    } finally {
      if (held.ok) held.release();
    }
  });

  it('ok swaps the pre-run topics for the run’s; rate-limited on a 429', async () => {
    const a = await setup(createsTwo);
    await (await hubFor(a.p, a.sessionId)).insertTopic({ ...person, summary: 'Pre-run' });
    const out = await runTopics(a.p, a.sessionId);
    expect(out).toMatchObject({ kind: 'ok' });
    expect(await summaries(a.p, a.sessionId)).toEqual(['Gen one', 'Gen two']);
    const b = await setup(() => ({
      status: 429,
      body: '{"error":"slow"}',
      headers: { 'retry-after-ms': '5' },
    }));
    expect(await runTopics(b.p, b.sessionId)).toMatchObject({ kind: 'failed', rateLimited: true });
  });
});

describe('a run’s topics are the ids its tool created (design D7 topics, R12)', () => {
  it('a failing run deletes only its own topics: a person’s topic added meanwhile survives', async () => {
    const a = await setup(createsThenFails);
    await (await hubFor(a.p, a.sessionId)).insertTopic({ ...person, summary: 'Pre-run' });
    afterTurn(async () => (await hubFor(a.p, a.sessionId)).insertTopic(person));
    expect(await runTopics(a.p, a.sessionId)).toMatchObject({ kind: 'failed', rateLimited: false });
    expect(await summaries(a.p, a.sessionId)).toEqual(['Person', 'Pre-run']);
  });

  it('the manual route too: a failing run keeps a person’s concurrent topic (502 unchanged)', async () => {
    const a = await setup(createsThenFails);
    afterTurn(async () => (await hubFor(a.p, a.sessionId)).insertTopic(person));
    const res = await app.request(
      `/api/sessions/${a.sessionId}/topics/generate`,
      { method: 'POST', headers: { cookie: await loginCookie(a.uid) } },
      sdkEnv(),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ detail: 'Topic generation failed.' });
    expect(await summaries(a.p, a.sessionId)).toEqual(['Person']);
  });

  it('the manual route: no topic created while a person added one is the 502; nothing is deleted', async () => {
    const a = await setup(readsOnly);
    await (await hubFor(a.p, a.sessionId)).insertTopic({ ...person, summary: 'Pre-run' });
    afterTurn(async () => (await hubFor(a.p, a.sessionId)).insertTopic(person));
    const res = await app.request(
      `/api/sessions/${a.sessionId}/topics/generate`,
      { method: 'POST', headers: { cookie: await loginCookie(a.uid) } },
      sdkEnv(),
    );
    expect(res.status).toBe(502);
    expect(await summaries(a.p, a.sessionId)).toEqual(['Person', 'Pre-run']);
  });

  it('own-topic deletes use version 1: an edited topic is kept, counted, and present', async () => {
    const a = await setup(createsTwo);
    const hub = await hubFor(a.p, a.sessionId);
    const one = await hub.insertTopic({ ...person, summary: 'Partial one' });
    const two = await hub.insertTopic({ ...person, summary: 'Partial two' });
    expect(await topicsPresent(a.p, a.sessionId, [one.id, two.id])).toBe(false);
    await markEdited('session_topics', two.id);
    expect(await deleteOwnTopics(a.p, a.sessionId, [one.id, two.id, 'no-such-id'])).toEqual({
      deleted: 1,
      keptEdited: 1,
    });
    expect(await summaries(a.p, a.sessionId)).toEqual(['Partial two']);
    expect(await topicsPresent(a.p, a.sessionId, [one.id, two.id])).toBe(true);
  });

  it('a batch allocator records every topic id before its insert; a refusal fails the turn', async () => {
    const a = await setup(createsTwo);
    const recorded: string[] = [];
    const out = await runTopics(a.p, a.sessionId, {
      batch: {
        beforeRun: async () => 'go',
        recordTopicId: async (id) => {
          recorded.push(id);
          return true;
        },
      },
    });
    expect(out).toMatchObject({ kind: 'ok' });
    const ids = (await (await hubFor(a.p, a.sessionId)).listTopics()).map((x) => x.id).sort();
    expect([...recorded].sort()).toEqual(ids);

    const b = await setup(createsTwo);
    const refused = await runTopics(b.p, b.sessionId, {
      batch: { beforeRun: async () => 'go', recordTopicId: async () => false },
    });
    expect(refused).toMatchObject({ kind: 'stopped' });
    expect(await summaries(b.p, b.sessionId)).toEqual([]);
  });
});
