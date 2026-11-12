// batch-autogenerate task 4.3 (design D3, D7, D11; batch spec "A job resumes after a restart"):
// restart-resume against real Postgres and a stubbed AI SDK provider. A "crash" is worker A stopping
// mid-turn with no release: its turn hangs at the provider, the worker is stopped (it writes
// nothing more), the process's in-process slots are dropped and its `ai-turn` run lease row
// removed, as a dead process's would lapse; the fake clock then advances 90 s from A's claim and
// worker B claims the job.

import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import * as topicGenerateModule from '@autologger/ai-runtime/topicGenerate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAiLeaseRenewMsForTests } from '../generation/aiSlot';
import { hubFor } from '../generation/principal';
import {
  type AgWorld,
  agWorld,
  reportOf,
  scripted,
  slate,
  topic,
  until,
} from '../test/autogenerateWorld';
import { callTools, type FakeReply } from '../test/fakeLlm';
import {
  addSlateEvent,
  closeFakes,
  listEvents,
  markEdited,
  sdkAdmin,
} from '../test/generationFixtures';
import { principalFor } from '../test/generationPrincipal';
import { testDb } from '../test/helpers';

const HANG: FakeReply = { hang: true };
const ALL = ['transcript', 'events', 'topics', 'wiki'] as const;

beforeEach(() => {
  // A's turn must not renew its run lease while it hangs (the dead process renews nothing).
  __setAiLeaseRenewMsForTests(3_600_000);
});
afterEach(async () => {
  vi.restoreAllMocks();
  __setAiLeaseRenewMsForTests(undefined);
  aiChatTurns.reset();
  await closeFakes();
});

/** Process death of worker A: no release, no more writes, its slots and run leases gone. */
async function crash(w: AgWorld, a: { stop(): void }, sessionId: string) {
  a.stop();
  aiChatTurns.reset();
  await testDb().run(
    "DELETE FROM session_leases WHERE session_id = ? AND kind <> 'recording'",
    sessionId,
  );
  w.clock.t += 90_000;
}

const topicsOf = async (w: AgWorld, s: string) =>
  (await (await hubFor(w.p, s)).listTopics()).map((t) => t.summary).sort();

describe('restart-resume (design D11)', () => {
  it('a crash mid topics turn: B resumes in 90 s, no second call for session 1, partial topics deleted, topics re-run', async () => {
    // Topics turn 2 (session 2) creates two topics, then hangs.
    const script = scripted((kind, turn, round) =>
      kind === 'topics' && turn === 2 && round === 2 ? HANG : undefined,
    );
    const w = await agWorld({ sessions: 3, steps: [...ALL], script });
    const A = w.worker('wA');
    const aRun = A.worker.tick();
    await until(
      async () => (await w.item(w.sessions[1] as string, 'topics')).own_topic_ids.length === 2,
    );
    await until(() => script.turns.topics === 2 && w.llm.requests.length > 0);
    const partial = (await w.item(w.sessions[1] as string, 'topics')).own_topic_ids;
    expect(await topicsOf(w, w.sessions[1] as string)).toEqual(['Gen 2a', 'Gen 2b']);
    const session1Requests = w.llm.requests.length;
    await crash(w, A.worker, w.sessions[1] as string);
    void aRun.catch(() => {});

    const B = w.worker('wB');
    expect(await B.worker.tick()).toBe(true);
    const job = await w.job();
    expect(job).toMatchObject({ status: 'finished', locked_by: 'wB' });
    // B's claim was within 90 s of A's last renewal (its claim at t0; A never renewed).
    expect(Number(job.started_at_ms)).toBe(1_800_000_000_000);
    const report = await reportOf(w);
    expect(report).toEqual({
      '1:transcript': 'skipped present',
      '1:events': 'done',
      '1:topics': 'done',
      '1:wiki': 'done',
      '2:transcript': 'skipped present',
      '2:events': 'done',
      '2:topics': 'done',
      '2:wiki': 'done',
      '3:transcript': 'skipped present',
      '3:events': 'done',
      '3:topics': 'done',
      '3:wiki': 'done',
    });
    // Session 1 made no second provider call: B's requests are sessions 2 and 3 only.
    expect(script.turns.events).toBe(3);
    expect(script.turns.topics).toBe(4); // 1, 2 (crashed), 2 again, 3
    expect(script.turns.wiki).toBe(3);
    expect(w.llm.requests.length).toBeGreaterThan(session1Requests);
    // The two partial topics are gone; the re-run's topics stand. The step is not `present`.
    const item2 = await w.item(w.sessions[1] as string, 'topics');
    expect(item2).toMatchObject({ status: 'done', attempts: 2, kept_edited: 0 });
    expect(await topicsOf(w, w.sessions[1] as string)).toEqual(['Gen 3a', 'Gen 3b']);
    const ids = (await (await hubFor(w.p, w.sessions[1] as string)).listTopics()).map((t) => t.id);
    for (const id of partial) expect(ids).not.toContain(id);
  });

  it('a topic a person adds between the crash and the resume makes the resumed step present', async () => {
    const script = scripted((kind, turn, round) =>
      kind === 'topics' && turn === 1 && round === 2 ? HANG : undefined,
    );
    const w = await agWorld({ sessions: 1, steps: ['topics'], script });
    const s = w.sessions[0] as string;
    const A = w.worker('wA');
    void A.worker.tick().catch(() => {});
    await until(async () => (await w.item(s, 'topics')).own_topic_ids.length === 2);
    await crash(w, A.worker, s);
    await (await hubFor(w.p, s)).insertTopic({
      session_time: '00:00:09',
      duration_sec: 1,
      topic_level: 1,
      summary: 'Person',
    });
    await w.worker('wB').worker.tick();
    expect(await reportOf(w)).toEqual({ '1:topics': 'skipped present' });
    expect(await topicsOf(w, s)).toEqual(['Person']);
    expect(script.turns.topics).toBe(1);
  });

  it('an events step interrupted after 2 events: the re-run excludes them, succeeds, and they are gone', async () => {
    const script = scripted((kind, turn, round) => {
      if (kind !== 'events') return undefined;
      if (turn === 1 && round === 1)
        return callTools(2, [slate('Partial one'), slate('Partial two')]);
      if (turn === 1 && round === 2) return HANG;
      return undefined;
    });
    const w = await agWorld({ sessions: 1, steps: ['events'], script });
    const s = w.sessions[0] as string;
    await addSlateEvent(s, 'Manual slate', null);
    const A = w.worker('wA');
    void A.worker.tick().catch(() => {});
    await until(async () => (await listEvents(s)).length === 3);
    await crash(w, A.worker, s);
    const before = w.llm.requests.length;
    await w.worker('wB').worker.tick();
    expect(await reportOf(w)).toEqual({ '1:events': 'done' });
    const resumedPrompt = JSON.stringify(w.llm.requests[before]?.messages);
    expect(resumedPrompt).toContain('Manual slate');
    expect(resumedPrompt).not.toContain('Partial one');
    expect((await listEvents(s)).map((e) => e.message).sort()).toEqual([
      'Batch slate 2',
      'Manual slate',
    ]);
    expect((await w.item(s, 'events')).run_ids).toHaveLength(2);
  });

  it('an events item interrupted three times ends failed interrupted; the events of all its run ids go', async () => {
    const w = await agWorld({ sessions: 2, steps: ['events'], script: scripted() });
    const [s1, s2] = w.sessions as [string, string];
    await addSlateEvent(s1, 'Manual slate', null);
    for (const r of ['r1', 'r2', 'r3']) await addSlateEvent(s1, `Partial ${r}`, r);
    await testDb().run(
      `UPDATE autogenerate_jobs SET status = 'running', locked_by = 'dead', locked_until_ms = ?
       WHERE id = ?`,
      w.clock.t - 1,
      w.jobId,
    );
    await testDb().run(
      `UPDATE autogenerate_items SET status = 'running', attempts = 3, run_ids = 'r1,r2,r3'
       WHERE job_id = ? AND session_id = ?`,
      w.jobId,
      s1,
    );
    await w.worker('wB').worker.tick();
    expect(await reportOf(w)).toEqual({ '1:events': 'failed interrupted', '2:events': 'done' });
    expect((await listEvents(s1)).map((e) => e.message)).toEqual(['Manual slate']);
    expect((await listEvents(s2)).map((e) => e.message)).toEqual(['Batch slate 1']);
    expect((await w.job()).status).toBe('finished');
  });

  it('a wiki step interrupted after its suggestions were stored: no second wiki call; safe ones accepted', async () => {
    let s = '';
    const script = scripted((kind, _turn, round) =>
      kind === 'wiki' && round === 1
        ? callTools(2, [
            {
              name: 'propose_page',
              args: {
                kind: 'topic',
                title: 'Touring',
                aliases: [],
                body_md: 'Touring came up.\n',
                rationale: `Touring is discussed in ${s ? 'this session' : 'it'}.`,
              },
            },
          ])
        : undefined,
    );
    const w = await agWorld({ sessions: 1, steps: ['wiki'], script });
    s = w.sessions[0] as string;
    const A = w.worker('wA');
    let stall!: () => void;
    const stalled = new Promise<void>((r) => {
      stall = r;
    });
    A.ports.steps = {
      ...A.ports.steps,
      acceptWiki: () => {
        stall();
        return new Promise(() => {});
      },
    };
    void A.worker.tick().catch(() => {});
    await stalled;
    expect(await w.p.catalog.wiki.anyOfRun(s, (await w.item(s, 'wiki')).run_ids[0] as string)).toBe(
      true,
    );
    await crash(w, A.worker, s);
    await w.worker('wB').worker.tick();
    expect(script.turns.wiki).toBe(1);
    expect(await w.item(s, 'wiki')).toMatchObject({
      status: 'done',
      wiki_accepted: 1,
      wiki_pending: 0,
      attempts: 2,
    });
    const pages = await w.p.catalog.wiki.listPages(w.showId);
    expect(pages.pages.map((x: { title: string }) => x.title)).toContain('Touring');
  });

  it('the job continues after an interrupted item', async () => {
    const w = await agWorld({ sessions: 2, steps: ['topics'], script: scripted() });
    await testDb().run(
      `UPDATE autogenerate_jobs SET status = 'running', locked_by = 'dead', locked_until_ms = 1 WHERE id = ?`,
      w.jobId,
    );
    await testDb().run(
      `UPDATE autogenerate_items SET status = 'running', attempts = 3 WHERE job_id = ? AND session_id = ?`,
      w.jobId,
      w.sessions[0],
    );
    await w.worker('wB').worker.tick();
    expect(await reportOf(w)).toEqual({ '1:topics': 'failed interrupted', '2:topics': 'done' });
  });
});

describe('cross-job exclusion (design D7 "Recorded partial output, across jobs")', () => {
  /** Job 1's topics attempt writes 2 topics, its initiator is demoted (access removed) right after
   * the turn, so the attempt fails, its cleanup is refused and the topics stay recorded. */
  async function stoppedJob(sessions = 3) {
    const script = scripted((kind, turn, round) =>
      kind === 'topics' && turn === 2 && round === 2
        ? { status: 500, body: '{"error":"x"}', headers: { 'retry-after-ms': '5' } }
        : undefined,
    );
    const w = await agWorld({ sessions, steps: ['topics'], script });
    const s2 = w.sessions[1] as string;
    let calls = 0;
    const real = topicGenerateModule.generateTopicsTurn;
    vi.spyOn(topicGenerateModule, 'generateTopicsTurn').mockImplementation(async (o) => {
      const out = await real(o);
      calls += 1;
      if (calls === 2) {
        await testDb().run(
          "UPDATE user_studio_memberships SET role = 'member' WHERE user_id = ? AND studio_id = ?",
          w.uid,
          w.studioId,
        );
      }
      return out;
    });
    await w.worker('wA').worker.tick();
    vi.restoreAllMocks();
    const job = await w.job();
    expect(job).toMatchObject({ status: 'failed', stop_reason: 'initiator-role-lost' });
    const item = await w.item(s2, 'topics');
    expect(item.status).not.toBe('done');
    expect(item.own_topic_ids).toHaveLength(2);
    const left = (
      await (await hubFor(await principalFor(await adminOf(w), w.env), s2)).listTopics()
    ).map((t) => t.id);
    expect([...left].sort()).toEqual([...item.own_topic_ids].sort());
    return { w, s2, partial: item.own_topic_ids, script };
  }
  let second = '';
  async function adminOf(w: AgWorld): Promise<string> {
    if (!second) second = await sdkAdmin(w.studioId, w.llm.baseURL);
    return second;
  }
  afterEach(() => {
    second = '';
  });

  async function jobTwo(w: AgWorld, s2: string) {
    // Job 1's demoted initiator could not release its `ai-turn` run lease (refused); it lapses
    // after 40 s (A11), which the fake clock does not drive, so it is removed here as expired.
    await testDb().run("DELETE FROM session_leases WHERE session_id = ? AND kind = 'ai-turn'", s2);
    const uid = await adminOf(w);
    const p = await principalFor(uid, w.env);
    const r = await p.catalog.autogenerate.createJob({
      teamId: w.studioId,
      initiatorId: uid,
      initiatorName: 'Second Admin',
      scope: { sessionIds: [s2] },
      steps: ['topics'],
      wikiMode: 'accept',
      expectedSessions: 1,
      nowMs: w.clock.t,
    });
    if (r.kind !== 'created') throw new Error(r.kind);
    await w.worker('wC').worker.tick();
    return { p, jobId: r.job.id };
  }

  it('job 2 finds job 1’s recorded topics not present, deletes them as its initiator and generates', async () => {
    const { w, s2, partial } = await stoppedJob();
    const { p, jobId } = await jobTwo(w, s2);
    const items = await testDb().all<{ status: string; outcome: string | null }>(
      'SELECT status, outcome FROM autogenerate_items WHERE job_id = ?',
      jobId,
    );
    expect(items).toEqual([{ status: 'done', outcome: null }]);
    const ids = (await (await hubFor(p, s2)).listTopics()).map((t) => t.id);
    for (const id of partial) expect(ids).not.toContain(id);
    expect(ids).toHaveLength(2);
  });

  it('an edited one of them is kept and makes job 2’s step present', async () => {
    const { w, s2, partial } = await stoppedJob();
    await markEdited('session_topics', partial[0] as string);
    const { p, jobId } = await jobTwo(w, s2);
    const items = await testDb().all<{
      status: string;
      outcome: string | null;
      kept_edited: number;
    }>('SELECT status, outcome, kept_edited FROM autogenerate_items WHERE job_id = ?', jobId);
    expect(items).toEqual([{ status: 'skipped', outcome: 'present', kept_edited: 1 }]);
    expect((await (await hubFor(p, s2)).listTopics()).map((t) => t.id)).toEqual([partial[0]]);
  });
});

describe('lease takeover (design D7 "Fenced write-ahead")', () => {
  it('A’s next create_topic refuses after B took the lease; A inserts nothing unrecorded; B proceeds after A’s run lease is released', async () => {
    const script = scripted((kind, turn, round) => {
      if (kind !== 'topics' || turn !== 1) return undefined;
      if (round === 1) return callTools(2, [topic('A first')]);
      if (round === 2) return callTools(3, [topic('A second')]);
      return undefined;
    });
    const w = await agWorld({ sessions: 1, steps: ['topics'], script });
    const s = w.sessions[0] as string;
    const B = w.worker('wB', {
      sleep: async (ms) => {
        w.clock.t += ms;
        await new Promise((r) => setTimeout(r, 25));
      },
    });
    let bRun: Promise<boolean> | null = null;
    const A = w.worker('wA');
    const append = A.ports.store.appendTopicId.bind(A.ports.store);
    let n = 0;
    A.ports.store.appendTopicId = async (...args) => {
      n += 1;
      if (n === 2) {
        w.clock.t += 90_000;
        bRun = B.worker.tick();
        await until(async () => (await w.job()).locked_by === 'wB');
      }
      return append(...args);
    };
    await A.worker.tick();
    expect(bRun).not.toBeNull();
    expect(await (bRun as unknown as Promise<boolean>)).toBe(true);
    // A recorded its first topic, refused its second; B deleted A's recorded one and generated.
    const item = await w.item(s, 'topics');
    expect(item).toMatchObject({ status: 'done', attempts: 2 });
    const topics = await (await hubFor(w.p, s)).listTopics();
    expect(topics.map((t) => t.summary).sort()).toEqual(['Gen 2a', 'Gen 2b']);
    // Every topic in the session is recorded on the item.
    for (const t of topics) expect(item.own_topic_ids).toContain(t.id);
    expect((await w.job()).status).toBe('finished');
  });
});
