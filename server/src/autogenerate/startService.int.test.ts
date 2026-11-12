// batch-autogenerate task 9.1 (proposal "Follow-up"; design D14): `startAutogenerateJob` called by
// a server-side caller, with no HTTP request, for a given initiator and a session-id list, creates
// the same job the start route would and refuses exactly as the route does.

import { afterEach, describe, expect, it } from 'vitest';
import { closeFakes, fakeProvider } from '../test/generationFixtures';
import { principalFor } from '../test/generationPrincipal';
import { envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  NOT_APPROVED_EMAIL,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
  testDb,
} from '../test/helpers';
import { saveSdkCredential } from '../test/llmRoutes';
import { startAutogenerateJob } from './service';

afterEach(closeFakes);

const sttEnv = () =>
  envWith({ DEEPGRAM_API_KEY: 'k', DEEPGRAM_MODEL: 'nova-3', HOST: '127.0.0.1' });

async function world() {
  const team = await seedStudio();
  const show = await seedShow({ studioId: team });
  const sessions: string[] = [];
  for (const date of ['2024-03-02', '2024-03-01', '2024-03-03']) {
    const s = await seedSession({ showId: show });
    await testDb().run('UPDATE sessions SET episode_date = ? WHERE id = ?', date, s);
    sessions.push(s);
  }
  const llm = await fakeProvider(() => ({ status: 500, body: '{}' }));
  const member = async (role: 'admin' | 'member', email?: string, withLlm = true) => {
    const id = await seedUser({ email });
    await catalogFor().auth.authAddMembershipWithRole(id, team, role);
    if (withLlm) await saveSdkCredential(llm.baseURL, { cookie: await loginCookie(id) });
    return id;
  };
  return { team, show, sessions, member };
}

describe('startAutogenerateJob without a request (the playlist import hand-off)', () => {
  it('creates the job the route would: session scope, episode order, one item per session and step', async () => {
    const w = await world();
    const admin = await w.member('admin');
    const p = await principalFor(admin, sttEnv());
    const out = await startAutogenerateJob(p, w.team, {
      session_ids: [...w.sessions, w.sessions[0] as string],
      steps: ['wiki', 'transcript'],
      wiki_mode: 'accept',
      expected_sessions: 3,
    });
    expect('job' in out).toBe(true);
    const job = 'job' in out ? out.job : null;
    expect(job).toMatchObject({
      status: 'queued',
      scope: 'sessions',
      show_ids: null,
      steps: ['transcript', 'wiki'],
      initiator_id: admin,
      sessions: 3,
      counts: { pending: 6, running: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 },
    });
    const items = await testDb().all<{ session_id: string; step: string; ordinal: number }>(
      'SELECT session_id, step, ordinal FROM autogenerate_items WHERE job_id = ? ORDER BY ordinal, step_order',
      job?.id,
    );
    expect(items.map((i) => `${i.ordinal}:${i.session_id}:${i.step}`)).toEqual([
      `0:${w.sessions[1]}:transcript`,
      `0:${w.sessions[1]}:wiki`,
      `1:${w.sessions[0]}:transcript`,
      `1:${w.sessions[0]}:wiki`,
      `2:${w.sessions[2]}:transcript`,
      `2:${w.sessions[2]}:wiki`,
    ]);
  });

  it('refuses a member, an unapproved user, an unconfigured one and a live job, as the route does', async () => {
    const w = await world();
    const body = {
      session_ids: w.sessions,
      steps: ['transcript', 'topics'] as ('transcript' | 'topics')[],
      wiki_mode: 'accept' as const,
      expected_sessions: 3,
    };
    const member = await w.member('member');
    expect(await startAutogenerateJob(await principalFor(member, sttEnv()), w.team, body)).toEqual({
      status: 403,
      body: { detail: 'Admin role required.' },
    });
    const unapproved = await w.member('admin', NOT_APPROVED_EMAIL);
    expect(
      await startAutogenerateJob(await principalFor(unapproved, sttEnv()), w.team, body),
    ).toEqual({
      status: 403,
      body: { detail: 'This feature is limited to approved users on this server.' },
    });
    const bare = await w.member('admin', undefined, false);
    expect(await startAutogenerateJob(await principalFor(bare, sttEnv()), w.team, body)).toEqual({
      status: 503,
      body: { detail: 'Add a language model in Settings → Advanced to autogenerate.' },
    });
    const admin = await w.member('admin');
    const first = await startAutogenerateJob(await principalFor(admin, sttEnv()), w.team, body);
    const id = 'job' in first ? first.job.id : '';
    expect(await startAutogenerateJob(await principalFor(admin, sttEnv()), w.team, body)).toEqual({
      status: 409,
      body: { detail: 'A batch job is already running for this team.', job_id: id },
    });
  });
});
