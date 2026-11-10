// batch-autogenerate task 4.4 (design D4, D5; batch spec "The worker acts as the initiator and
// re-checks before every session"; core-ports-architecture "A batch job's session work runs as its
// initiator"): the per-session re-check as the initiator, against real Postgres and a stubbed AI SDK
// provider. The binding check records every catalog statement with its binding through the
// `GatedCatalog` the catalog-binding suite uses, and every session storage call's caller through a
// wrapped test registry.

import * as topicGenerateModule from '@autologger/ai-runtime/topicGenerate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hubFor } from '../generation/principal';
import { type AgWorld, agWorld, reportOf, scripted } from '../test/autogenerateWorld';
import { GatedCatalog } from '../test/gatedCatalog';
import { closeFakes, sdkAdmin } from '../test/generationFixtures';
import { env, envWith } from '../test/harness';
import { catalogFor, loginCookie, testDb } from '../test/helpers';
import { saveSdkCredential } from '../test/llmRoutes';
import { testRegistry } from '../test/session/sessionRows';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeFakes();
});

/** Runs `fn` after the topics turn of `turn` (from 1) returned, before the runner reads it. */
function afterTopicsTurn(turn: number, fn: () => Promise<unknown>) {
  const real = topicGenerateModule.generateTopicsTurn;
  let n = 0;
  vi.spyOn(topicGenerateModule, 'generateTopicsTurn').mockImplementation(async (o) => {
    const out = await real(o);
    n += 1;
    if (n === turn) await fn();
    return out;
  });
}

const run = (w: AgWorld) => w.worker('w1').worker.tick();

describe('the per-session re-check (design D5)', () => {
  it('a session deleted between two sessions is skipped session-gone with no provider call', async () => {
    const script = scripted();
    const w = await agWorld({ sessions: 3, steps: ['topics'], script });
    afterTopicsTurn(1, () =>
      testDb().run('UPDATE sessions SET ui_hidden = 1 WHERE id = ?', w.sessions[1]),
    );
    await run(w);
    expect(await reportOf(w)).toEqual({
      '1:topics': 'done',
      '2:topics': 'skipped session-gone',
      '3:topics': 'done',
    });
    expect(script.turns.topics).toBe(2);
    expect((await w.job()).status).toBe('finished');
  });

  it('the initiator demoted to member (with grants on every show) mid-job: the step finishes, the job stops role-lost', async () => {
    const script = scripted();
    const w = await agWorld({ sessions: 3, steps: ['topics'], script });
    afterTopicsTurn(1, async () => {
      await testDb().run(
        "UPDATE user_studio_memberships SET role = 'member' WHERE user_id = ? AND studio_id = ?",
        w.uid,
        w.studioId,
      );
      await catalogFor().auth.authGrantShow(w.uid, w.showId, w.uid, new Date().toISOString());
    });
    await run(w);
    expect(await w.job()).toMatchObject({ status: 'failed', stop_reason: 'initiator-role-lost' });
    expect(await reportOf(w)).toEqual({
      '1:topics': 'done',
      '2:topics': 'cancelled job-stopped',
      '3:topics': 'cancelled job-stopped',
    });
    expect(script.turns.topics).toBe(1);
  });

  for (const [label, change, reason] of [
    [
      'removed from the team',
      (w: AgWorld) => catalogFor().auth.authRemoveMembership(w.uid, w.studioId),
      'initiator-role-lost',
    ],
    [
      'account disabled',
      (w: AgWorld) =>
        testDb().run(
          'UPDATE users SET disabled_at_utc = ? WHERE id = ?',
          new Date().toISOString(),
          w.uid,
        ),
      'initiator-unavailable',
    ],
    [
      'RUN_FEATURE_EMAILS no longer lists the initiator',
      async (_w: AgWorld, cfg: Record<string, unknown>) => {
        cfg.RUN_FEATURE_EMAILS = 'default-user@example.com';
      },
      'not-approved',
    ],
  ] as const) {
    it(`${label}: the job stops ${reason} before the next session`, async () => {
      const cfg: Record<string, unknown> = { HOST: '127.0.0.1' };
      const script = scripted();
      const w = await agWorld({ sessions: 2, steps: ['topics'], script, env: envWith(cfg) });
      const { worker, ports } = w.worker('w1');
      // The change lands between sessions: right after session 1's step ended.
      const update = ports.store.updateItem.bind(ports.store);
      ports.store.updateItem = async (...a) => {
        const n = await update(...a);
        if (a[2] === w.sessions[0] && a[4].status === 'done') await change(w, cfg);
        return n;
      };
      await worker.tick();
      expect(await w.job()).toMatchObject({ status: 'failed', stop_reason: reason });
      expect(await reportOf(w)).toEqual({
        '1:topics': 'done',
        '2:topics': 'cancelled job-stopped',
      });
      expect(script.turns.topics).toBe(1);
    });
  }
});

describe('acting as the initiator (design D4)', () => {
  it('every catalog and session statement of the steps, cleanup included, runs as the initiator; job writes as autogenerate-worker', async () => {
    const gated = new GatedCatalog(env.ports.catalog);
    const callers: string[] = [];
    const registry = testRegistry({
      wrap: (inner) => ({
        tx: (caller, fn) => {
          callers.push(
            caller.kind === 'user' ? `user:${caller.userId}` : `system:${caller.reason}`,
          );
          return inner.tx(caller, fn);
        },
        snapshot: (caller, fn) => {
          callers.push(
            caller.kind === 'user' ? `user:${caller.userId}` : `system:${caller.reason}`,
          );
          return inner.snapshot(caller, fn);
        },
      }),
    });
    try {
      const e = envWith({ HOST: '127.0.0.1' }, { catalog: gated, sessions: registry });
      const w = await agWorld({
        sessions: 2,
        steps: ['events', 'topics'],
        script: scripted(),
        env: e,
      });
      // A recorded partial topic of an earlier attempt of session 1's topics item (the cleanup).
      const partial = await (await hubFor(w.p, w.sessions[0] as string)).insertTopic({
        session_time: '00:00:01',
        duration_sec: 1,
        topic_level: 1,
        summary: 'Partial',
      });
      await testDb().run(
        `UPDATE autogenerate_items SET status = 'running', attempts = 1, own_topic_ids = ?
         WHERE job_id = ? AND session_id = ? AND step = 'topics'`,
        partial.id,
        w.jobId,
        w.sessions[0],
      );
      const fromStatement = gated.bindings.length;
      callers.length = 0;
      await run(w);
      expect(await reportOf(w)).toEqual({
        '1:events': 'done',
        '1:topics': 'done',
        '2:events': 'done',
        '2:topics': 'done',
      });
      expect(
        (await (await hubFor(w.p, w.sessions[0] as string)).listTopics()).map((t) => t.id),
      ).not.toContain(partial.id);
      // Session storage: every call as the initiator, except a hub's own open (`session-open`).
      expect(callers.length).toBeGreaterThan(10);
      expect(new Set(callers.filter((c) => c !== 'system:session-open'))).toEqual(
        new Set([`user:${w.uid}`]),
      );
      // Catalog: job and item statements under the worker's reason; everything else as the user,
      // apart from the initiator re-read and its registry load (D4) under the same reason.
      const jobSql = /autogenerate_(jobs|items)/;
      for (const s of gated.bindings.slice(fromStatement)) {
        if (jobSql.test(s.sql)) expect(s.binding, s.sql).toBe('system:autogenerate-worker');
        else expect(['system:autogenerate-worker', `user:${w.uid}`], s.sql).toContain(s.binding);
      }
      const sys = gated.bindings
        .slice(fromStatement)
        .filter((s) => s.binding === 'system:autogenerate-worker');
      for (const s of sys) {
        expect(
          jobSql.test(s.sql) || /FROM users WHERE id|FROM studio_definitions/.test(s.sql),
          s.sql,
        ).toBe(true);
      }
      expect(gated.bindings.slice(fromStatement).some((s) => s.binding === `user:${w.uid}`)).toBe(
        true,
      );
    } finally {
      await registry.closeAll();
    }
  });

  it('provider requests carry the initiator’s own key, and a key changed mid-job is used from the next step', async () => {
    const w = await agWorld({
      sessions: 2,
      steps: ['topics'],
      script: scripted(),
      apiKey: 'sk-initiator-one',
    });
    // Another manager of the team has a key on the same provider; it is never used.
    await sdkAdmin(w.studioId, w.llm.baseURL, { apiKey: 'sk-other-manager' });
    afterTopicsTurn(1, async () =>
      saveSdkCredential(w.llm.baseURL, {
        cookie: await loginCookie(w.uid),
        apiKey: 'sk-initiator-two',
      }),
    );
    const before = w.llm.meta.length;
    await run(w);
    const keys = w.llm.meta.slice(before).map((m) => String(m.headers.authorization));
    expect(keys.length).toBeGreaterThan(2);
    const first = keys.slice(0, 3);
    expect(new Set(first)).toEqual(new Set(['Bearer sk-initiator-one']));
    expect(new Set(keys.slice(3))).toEqual(new Set(['Bearer sk-initiator-two']));
  });
});
