// batch-autogenerate task 4.5 (design D3, D8; batch spec "One session at a time, sharing the
// per-session single-flight"): the batch step shares the session's AI slot and run lease with
// manual runs and AI chat, a live recording lease is busy, two workers never run one job (or one
// session) at once, and a job whose team row vanishes stops its worker without writes. Real
// Postgres, stubbed AI SDK provider, fake clock.

import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import * as topicGenerateModule from '@autologger/ai-runtime/topicGenerate';
import { LeaseStore } from '@autologger/session-core/leaseStore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agWorld, reportOf, scripted } from '../test/autogenerateWorld';
import { closeFakes } from '../test/generationFixtures';
import { app } from '../test/harness';
import { loginCookie, testDb } from '../test/helpers';
import { insertRaw, testStorage } from '../test/session/sessionRows';

const BUSY_DETAIL =
  'A turn (AI chat, AI v2, topic generation, or event generation) is already in progress for this session; ' +
  'wait for it to finish before generating topics again. These features share one per-session AI slot by design.';

afterEach(async () => {
  vi.restoreAllMocks();
  aiChatTurns.reset();
  await closeFakes();
});

describe('busy (design D8)', () => {
  it('an AI chat turn holding the slot makes the batch step wait, then run', async () => {
    const w = await agWorld({ sessions: 1, steps: ['events'], script: scripted() });
    const s = w.sessions[0] as string;
    const chat = aiChatTurns.tryAcquire(s);
    expect(chat.ok).toBe(true);
    const sleeps: number[] = [];
    const { worker } = w.worker('w1', {
      sleep: async (ms) => {
        sleeps.push(ms);
        w.clock.t += ms;
        // The chat turn ends after the second wait (40 s into it).
        if (sleeps.length === 2 && chat.ok) chat.release();
      },
    });
    await worker.tick();
    expect(sleeps).toEqual([15_000, 15_000]);
    expect(await reportOf(w)).toEqual({ '1:events': 'done' });
  });

  it('a live recording lease leads to busy after the 10-minute window', async () => {
    const w = await agWorld({ sessions: 2, steps: ['topics'], script: scripted() });
    const s = w.sessions[0] as string;
    await insertRaw(testStorage(s), 'session_leases', {
      kind: 'recording',
      holder_client_id: 'recorder-tab',
      holder_user_id: w.uid,
      heartbeat_at_ms: Date.now(),
      expires_at_ms: Date.now() + 3_600_000,
    });
    const start = w.clock.t;
    await w.worker('w1').worker.tick();
    expect(w.clock.t - start).toBe(10 * 60_000);
    expect(await reportOf(w)).toEqual({ '1:topics': 'skipped busy', '2:topics': 'done' });
  });

  it('a batch step holding the slot makes a manual topics/generate answer its existing 409', async () => {
    const w = await agWorld({ sessions: 1, steps: ['topics'], script: scripted() });
    const s = w.sessions[0] as string;
    let manual: { status: number; body: unknown } | null = null;
    const real = topicGenerateModule.generateTopicsTurn;
    vi.spyOn(topicGenerateModule, 'generateTopicsTurn').mockImplementation(async (o) => {
      const res = await app.request(
        `/api/sessions/${s}/topics/generate`,
        { method: 'POST', headers: { cookie: await loginCookie(w.uid) } },
        w.env,
      );
      manual = { status: res.status, body: await res.json() };
      return real(o);
    });
    await w.worker('w1').worker.tick();
    expect(manual).toEqual({ status: 409, body: { detail: BUSY_DETAIL } });
    expect(await reportOf(w)).toEqual({ '1:topics': 'done' });
  });
});

describe('two workers (design D3)', () => {
  it('never run the same job or the same session at once', async () => {
    const script = scripted();
    const w = await agWorld({ sessions: 3, steps: ['topics'], script });
    let inFlight = 0;
    let most = 0;
    const real = topicGenerateModule.generateTopicsTurn;
    vi.spyOn(topicGenerateModule, 'generateTopicsTurn').mockImplementation(async (o) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        return await real(o);
      } finally {
        inFlight -= 1;
      }
    });
    const claims = vi.spyOn(LeaseStore.prototype, 'claimRunLease');
    const [a, b] = await Promise.all([w.worker('wA').worker.tick(), w.worker('wB').worker.tick()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(most).toBe(1);
    expect(script.turns.topics).toBe(3);
    expect(claims).toHaveBeenCalled();
    expect((await w.job()).status).toBe('finished');
  });

  it('a job whose team row is deleted mid-job stops the worker without writes', async () => {
    const script = scripted();
    const w = await agWorld({ sessions: 3, steps: ['topics'], script });
    const real = topicGenerateModule.generateTopicsTurn;
    let n = 0;
    vi.spyOn(topicGenerateModule, 'generateTopicsTurn').mockImplementation(async (o) => {
      const out = await real(o);
      n += 1;
      // As the importer would, bypassing its own refusal: the team row goes, the job cascades.
      if (n === 1) await testDb().run('DELETE FROM studio_definitions WHERE id = ?', w.studioId);
      return out;
    });
    const { worker, ports } = w.worker('w1');
    const writes: string[] = [];
    for (const k of [
      'updateItem',
      'appendRunId',
      'appendTopicId',
      'cancelRemaining',
      'endJob',
    ] as const) {
      const f = (ports.store[k] as (...a: unknown[]) => Promise<number>).bind(ports.store);
      (ports.store as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => {
        const changed = await f(...a);
        if (changed > 0) writes.push(k);
        return changed;
      };
    }
    expect(await worker.tick()).toBe(true);
    expect(await w.job()).toEqual({});
    expect(await w.items()).toEqual([]);
    expect(script.turns.topics).toBe(1);
    // Every write after the deletion changed nothing (the item writes before it did).
    const afterDelete = writes.lastIndexOf('appendTopicId');
    expect(writes.slice(afterDelete + 1)).toEqual([]);
  });
});
