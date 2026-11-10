// batch-autogenerate task 3.5 (design D6, D7 wiki, D12): the wiki runner, shared by
// `POST …/wiki/generate` and the batch worker, takes a caller-chosen run id (the batch records it on
// the item before the turn), stores its suggestions under that id, and returns typed outcomes.
// Integration (real catalog and hub) against a fake AI SDK provider.

import { afterEach, describe, expect, it } from 'vitest';
import { answer, callTools, type FakeScript } from '../test/fakeLlm';
import { closeFakes, fakeProvider, genSession, sdkAdmin, sdkEnv } from '../test/generationFixtures';
import { principalFor } from '../test/generationPrincipal';
import { catalogFor, seedUser, testDb } from '../test/helpers';
import { harnessHub } from '../test/session/sessionRows';
import { runWiki } from './wiki';

let s = '';
const proposeAlice: FakeScript = (n) =>
  n === 1
    ? callTools(1, [{ name: 'get_transcript_words', args: { page: 0 } }])
    : n === 2
      ? callTools(2, [
          {
            name: 'propose_page',
            args: {
              kind: 'person',
              title: 'Alice',
              aliases: [],
              body_md: `Alice plays bass. [Alice joined the band](cite:${s}@60)\n`,
              rationale: 'Alice is introduced in this session.',
            },
          },
        ])
      : answer('done');

async function setup(script: FakeScript, words = true) {
  const llm = await fakeProvider(script);
  const { studioId, sessionId } = await genSession();
  s = sessionId;
  if (words) {
    const hub = await harnessHub(sessionId);
    for (const word of ['Alice', 'joined', 'the', 'band']) {
      await hub.insertTranscriptWord({ session_time: '00:01:00:00', speaker: 'Host', word });
    }
  }
  const uid = await sdkAdmin(studioId, llm.baseURL);
  const p = await principalFor(uid, sdkEnv());
  const row = await p.catalog.sessions.getSessionIndexRow(sessionId);
  if (!row) throw new Error('no row');
  return { llm, studioId, sessionId, p, row };
}

afterEach(closeFakes);

describe('runWiki (design D6)', () => {
  it('stores the run’s suggestions under the caller-chosen run id', async () => {
    const { sessionId, p, row } = await setup(proposeAlice);
    const out = await runWiki(p, sessionId, { row, runId: 'chosen-run-1' });
    expect(out.kind).toBe('ok');
    expect(out.kind === 'ok' && out.suggestions.map((x) => x.title)).toEqual(['Alice']);
    const rows = await testDb().all<{ run_id: string }>(
      'SELECT run_id FROM wiki_suggestions WHERE session_id = ?',
      sessionId,
    );
    expect(rows.map((r) => r.run_id)).toEqual(['chosen-run-1']);
  });

  it('a batch run records its run id under the slot; a refusal stores nothing and asks nothing', async () => {
    const { llm, sessionId, p, row } = await setup(proposeAlice);
    const seen: string[] = [];
    const out = await runWiki(p, sessionId, {
      row,
      runId: 'r-batch',
      batch: {
        beforeRun: async (runId) => {
          seen.push(runId);
          return 'stop';
        },
      },
    });
    expect(out).toEqual({ kind: 'stopped' });
    expect(seen).toEqual(['r-batch']);
    expect(llm.requests).toHaveLength(0);
  });

  it('unconfigured and no transcript, before any request; a failed turn stores nothing', async () => {
    const a = await setup(proposeAlice);
    const bare = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(bare, a.studioId, 'admin');
    expect(await runWiki(await principalFor(bare, sdkEnv()), a.sessionId, { row: a.row })).toEqual({
      kind: 'unconfigured',
    });
    const b = await setup(proposeAlice, false);
    expect(await runWiki(b.p, b.sessionId, { row: b.row })).toMatchObject({
      kind: 'precondition',
      code: 'no-transcript',
    });
    expect(b.llm.requests).toHaveLength(0);
    const c = await setup(() => ({
      status: 429,
      body: '{"error":"slow"}',
      headers: { 'retry-after-ms': '5' },
    }));
    expect(await runWiki(c.p, c.sessionId, { row: c.row })).toMatchObject({
      kind: 'failed',
      rateLimited: true,
    });
  });
});
