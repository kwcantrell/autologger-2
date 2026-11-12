// batch-autogenerate task 4.6 (design D9, D17; batch spec "Persistent provider failure stops the
// job"): a provider that refuses every request stops the job `provider-failing` after 3 sessions,
// per provider kind; a rate limit is waited out (30 s, 60 s); a cancel during a rate-limit wait
// cleans up. Real Postgres; a stubbed speech-to-text provider (global `fetch` for DeepGram's host,
// everything else passed through) and a stubbed AI SDK provider; fake clock.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRANSCRIPTION_FIXTURES_DIR } from '@autologger/transcription';
import { transcriptGenerationLock } from '@autologger/transcription/transcriptGenerationLock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgWorld, agWorld, reportOf, scripted, slate } from '../test/autogenerateWorld';
import { callTools, type FakeReply } from '../test/fakeLlm';
import { addSlateEvent, closeFakes, listEvents } from '../test/generationFixtures';
import { app, env, envWith } from '../test/harness';

const SEG1 = join(TRANSCRIPTION_FIXTURES_DIR, 'audio', 'seg1.webm');
const DG_ENV = {
  HOST: '127.0.0.1',
  DEEPGRAM_API_KEY: 'test-deepgram-key',
  DEEPGRAM_MODEL: 'nova-3',
};
const refuse = (status: number): FakeReply => ({
  status,
  body: '{"error":"no"}',
  headers: { 'retry-after-ms': '5' },
});

afterEach(async () => {
  vi.unstubAllGlobals();
  transcriptGenerationLock.reset();
  await closeFakes();
});

/** DeepGram answers `status` (200 with one word); every other request goes to the real network
 * stack (the fake AI SDK provider on loopback). Returns the DeepGram request count. */
function stubDeepgram(status: number): { count: () => number } {
  const real = globalThis.fetch;
  let n = 0;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('deepgram')) return real(input, init);
    n += 1;
    return status === 200
      ? new Response(
          JSON.stringify({
            results: {
              channels: [
                { alternatives: [{ words: [{ word: 'hi', start: 0.5, end: 0.9, speaker: 0 }] }] },
              ],
            },
          }),
          { status },
        )
      : new Response('{"err":"x"}', { status });
  });
  return { count: () => n };
}

/** Each session gets one audio segment (no transcript), uploaded as the default user. */
async function withAudio(w: AgWorld) {
  for (const s of w.sessions) {
    const ev = await app.request(
      `/api/sessions/${s}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category: 'internal',
          message: 'Recording 1 Started',
          metadata: {},
        }),
      },
      { ...env },
    );
    expect(ev.status).toBe(200);
    const up = await app.request(
      `/api/sessions/${s}/audio/segments?recording_ordinal=1`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: readFileSync(SEG1) },
      { ...env },
    );
    expect(up.status).toBe(200);
  }
}

describe('persistent provider failure (design D17)', () => {
  it('a speech-to-text provider answering 401: provider-failing after session 3, exactly 3 requests', async () => {
    const w = await agWorld({
      sessions: 6,
      steps: ['transcript'],
      script: scripted(),
      transcript: false,
      env: envWith(DG_ENV),
    });
    await withAudio(w);
    const dg = stubDeepgram(401);
    await w.worker('w1').worker.tick();
    expect(await w.job()).toMatchObject({
      status: 'failed',
      stop_reason: 'provider-failing',
      consecutive_stt_failures: 3,
    });
    expect(dg.count()).toBe(3);
    const r = await reportOf(w);
    expect([r['1:transcript'], r['2:transcript'], r['3:transcript']]).toEqual([
      'failed provider-failed',
      'failed provider-failed',
      'failed provider-failed',
    ]);
    expect([r['4:transcript'], r['5:transcript'], r['6:transcript']]).toEqual([
      'cancelled job-stopped',
      'cancelled job-stopped',
      'cancelled job-stopped',
    ]);
  });

  it('LLM key revoked, STT fine: 3 transcripts done, 3 events provider-failed, no request for session 4', async () => {
    const script = scripted((kind) => (kind === 'events' ? refuse(401) : undefined));
    const w = await agWorld({
      sessions: 6,
      steps: ['transcript', 'events'],
      script,
      transcript: false,
      env: envWith(DG_ENV),
    });
    await withAudio(w);
    const dg = stubDeepgram(200);
    await w.worker('w1').worker.tick();
    expect(await w.job()).toMatchObject({
      status: 'failed',
      stop_reason: 'provider-failing',
      consecutive_llm_failures: 3,
      consecutive_stt_failures: 0,
    });
    const r = await reportOf(w);
    for (const i of [1, 2, 3]) {
      expect(r[`${i}:transcript`]).toBe('done');
      expect(r[`${i}:events`]).toBe('failed provider-failed');
    }
    expect(r['4:transcript']).toBe('cancelled job-stopped');
    expect(dg.count()).toBe(3);
    expect(script.turns.events).toBeLessThanOrEqual(3 * 3); // three sessions, SDK retries included
  });

  it('a 429 twice, then 200: done after the 30 s and 60 s waits; the LLM count is reset', async () => {
    let refused = 0;
    // Each refusal is three requests (the AI SDK's two retries).
    const script = scripted((kind, _t, round) => {
      if (kind === 'topics' && round === 0 && refused < 6) {
        refused += 1;
        return refuse(429);
      }
      return undefined;
    });
    const w = await agWorld({ sessions: 1, steps: ['topics'], script });
    const sleeps: number[] = [];
    await w
      .worker('w1', {
        sleep: async (ms) => {
          sleeps.push(ms);
          w.clock.t += ms;
        },
      })
      .worker.tick();
    expect(sleeps).toEqual([30_000, 60_000]);
    expect(await reportOf(w)).toEqual({ '1:topics': 'done' });
    expect((await w.job()).consecutive_llm_failures).toBe(0);
  });

  it('a cancel during a 429 wait after the events attempt wrote 3 events deletes them; the job is cancelled', async () => {
    const script = scripted((kind, _t, round) => {
      if (kind !== 'events') return undefined;
      if (round === 1) return callTools(2, [slate('P1'), slate('P2'), slate('P3')]);
      if (round >= 2) return refuse(429);
      return undefined;
    });
    const w = await agWorld({ sessions: 2, steps: ['events'], script });
    const s = w.sessions[0] as string;
    await addSlateEvent(s, 'Manual slate', null);
    const { worker } = w.worker('w1', {
      sleep: async (ms) => {
        w.clock.t += ms;
        await w.p.catalog.autogenerate.requestCancel(
          w.studioId,
          w.jobId,
          { id: w.uid, name: 'Initiator Name' },
          w.clock.t,
        );
      },
    });
    await worker.tick();
    expect(await w.job()).toMatchObject({ status: 'cancelled', stop_reason: 'cancelled' });
    expect(await reportOf(w)).toEqual({
      '1:events': 'cancelled cancelled',
      '2:events': 'cancelled cancelled',
    });
    expect((await listEvents(s)).map((e) => e.message)).toEqual(['Manual slate']);
  });
});
