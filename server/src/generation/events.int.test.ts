// batch-autogenerate task 3.3 (design D7 events, D9, D17): the events runner's batch behaviour.
// An integration test (real hub, Postgres and row versions) against a fake AI SDK provider:
// - the earlier attempts' events are left out of the prompt's existing events and of
//   `create_event`'s anchor basis, as a regenerate's snapshot is, while the run is no regenerate;
// - a success deletes every earlier attempt's events (also when it created none); a failure, and
//   the cleanup of an `interrupted` item, delete the events of every recorded run id; manual events
//   and other runs' events stay;
// - deletes are per row with version 1: an edited event is kept, counted, and makes events present;
// - a refused run-id record starts no run; a provider `429` is `rateLimited`.

import * as aiTurnModule from '@autologger/ai-runtime/aiTurn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, callTools, type FakeScript } from '../test/fakeLlm';
import {
  addSlateEvent,
  closeFakes,
  fakeProvider,
  genSession,
  listEvents,
  markEdited,
  sdkAdmin,
  sdkEnv,
  seedAnchoredTranscript,
} from '../test/generationFixtures';
import { principalFor } from '../test/generationPrincipal';
import { deleteOwnEvents, eventsPresent, runEvents } from './events';

const slate = (message: string) => ({
  name: 'create_event',
  args: { category: 'slate', message, session_time: '00:00:03:00' },
});
/** Read page 0, create one slate, answer. */
const createsOne: FakeScript = (n) =>
  n === 1
    ? callTools(1, [{ name: 'get_transcript_words', args: { page: 0 } }])
    : n === 2
      ? callTools(2, [slate('Batch slate')])
      : answer('done');
const createsNone: FakeScript = () => answer('nothing to log');
/** Creates one slate, then the provider fails. */
const createsThenFails: FakeScript = (n) =>
  n === 1
    ? callTools(1, [slate('Partial slate')])
    : { status: 500, body: '{"error":"x"}', headers: { 'retry-after-ms': '5' } };

async function setup(script: FakeScript) {
  const llm = await fakeProvider(script);
  const { studioId, sessionId } = await genSession();
  await seedAnchoredTranscript(sessionId);
  const uid = await sdkAdmin(studioId, llm.baseURL);
  const p = await principalFor(uid, sdkEnv());
  const row = await p.catalog.sessions.getSessionIndexRow(sessionId);
  if (!row) throw new Error('no row');
  return { llm, sessionId, p, row };
}

const messages = async (s: string) => (await listEvents(s)).map((e) => e.message).sort();
const go = async () => 'go' as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await closeFakes();
});

describe('runEvents batch options (design D7 events)', () => {
  it('excludes the earlier attempts’ events from the prompt and the anchor basis; not a regenerate', async () => {
    const { llm, sessionId, p, row } = await setup(createsOne);
    await addSlateEvent(sessionId, 'Manual slate', null);
    const earlierId = await addSlateEvent(sessionId, 'Earlier attempt slate', 'r-old');
    const spy = vi.spyOn(aiTurnModule, 'driveAiTurn');
    const out = await runEvents(p, sessionId, {
      row,
      batch: { earlierRunIds: ['r-old'], beforeRun: go },
    });
    expect(out).toMatchObject({ kind: 'ok', created: 1, keptEdited: 0 });
    expect(out.kind === 'ok' && 'deleted' in out).toBe(false);
    const prompt = JSON.stringify(llm.requests[0]?.messages);
    expect(prompt).toContain('Manual slate');
    expect(prompt).not.toContain('Earlier attempt slate');
    const generation = spy.mock.calls[0]?.[0].mcpContext?.generation;
    expect([...(generation?.regenerateSnapshotIds ?? [])]).toEqual([earlierId]);
    // Success deletes the earlier attempt's event; the manual one and this run's stay.
    expect(await messages(sessionId)).toEqual(['Batch slate', 'Manual slate']);
  });

  it('a success deletes the earlier attempts’ events even when it created none; other runs stay', async () => {
    const { sessionId, p, row } = await setup(createsNone);
    await addSlateEvent(sessionId, 'Manual slate', null);
    await addSlateEvent(sessionId, 'Earlier attempt slate', 'r-old');
    await addSlateEvent(sessionId, 'Another run slate', 'r-other');
    const out = await runEvents(p, sessionId, {
      row,
      batch: { earlierRunIds: ['r-old'], beforeRun: go },
    });
    expect(out).toMatchObject({ kind: 'ok', created: 0 });
    expect(await messages(sessionId)).toEqual(['Another run slate', 'Manual slate']);
  });

  it('a failure deletes the events of every attempt, this one included; an edited one is kept and counted', async () => {
    const { sessionId, p, row } = await setup(createsThenFails);
    await addSlateEvent(sessionId, 'Manual slate', null);
    await addSlateEvent(sessionId, 'Earlier attempt slate', 'r-old');
    const edited = await addSlateEvent(sessionId, 'Earlier edited slate', 'r-old');
    await markEdited('session_events', edited);
    await addSlateEvent(sessionId, 'Another run slate', 'r-other');
    const recorded: string[] = [];
    const out = await runEvents(p, sessionId, {
      row,
      batch: {
        earlierRunIds: ['r-old'],
        beforeRun: async (runId) => {
          recorded.push(runId);
          return 'go';
        },
      },
    });
    expect(out).toEqual({ kind: 'failed', rateLimited: false, keptEdited: 1 });
    expect(recorded).toHaveLength(1);
    expect(await messages(sessionId)).toEqual([
      'Another run slate',
      'Earlier edited slate',
      'Manual slate',
    ]);
    // The edited partial event counts as present; the unedited recorded ones would not.
    expect(await eventsPresent(p, sessionId, ['r-old'])).toBe(true);
  });

  it('the cleanup of an interrupted item deletes every recorded run’s events, as the principal', async () => {
    const { sessionId, p } = await setup(createsNone);
    await addSlateEvent(sessionId, 'Manual slate', null);
    await addSlateEvent(sessionId, 'Run one slate', 'r1');
    await addSlateEvent(sessionId, 'Run two slate', 'r2');
    expect(await eventsPresent(p, sessionId, ['r1', 'r2'])).toBe(false);
    expect(await eventsPresent(p, sessionId, ['r1'])).toBe(true);
    expect(await deleteOwnEvents(p, sessionId, ['r1', 'r2'])).toEqual({
      deleted: 2,
      keptEdited: 0,
    });
    expect(await messages(sessionId)).toEqual(['Manual slate']);
    expect(await eventsPresent(p, sessionId, [])).toBe(false);
  });

  it('a refused run-id record starts no run and makes no provider request', async () => {
    const { llm, sessionId, p, row } = await setup(createsOne);
    const out = await runEvents(p, sessionId, {
      row,
      batch: { earlierRunIds: [], beforeRun: async () => 'stop' },
    });
    expect(out).toEqual({ kind: 'stopped' });
    expect(llm.requests).toHaveLength(0);
  });

  it('a provider 429 is reported as rate-limited', async () => {
    const { sessionId, p, row } = await setup(() => ({
      status: 429,
      body: '{"error":"slow"}',
      headers: { 'retry-after-ms': '5' },
    }));
    const out = await runEvents(p, sessionId, {
      row,
      batch: { earlierRunIds: [], beforeRun: go },
    });
    expect(out).toMatchObject({ kind: 'failed', rateLimited: true });
  });
});
