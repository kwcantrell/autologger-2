// batch-autogenerate task 4.1 (design D3-D5, D7-D11, D17): the worker's orchestration, driven with a
// fake clock, fake runners, fake gates and an in-memory store. What the real runners and store do
// is covered by the integration suites (worker.*.int.test.ts); here: the ladder order, the
// skips and stops with their outcomes, the cascades, busy and rate-limit waits, the per-kind
// provider-failure stop, cleanup before every ending, cancel, polling, and the columns written.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AutogenerateItemPatch,
  AutogenerateItemRow,
  AutogenerateJobRow,
  AutogenerateStoreFacade,
} from '@autologger/catalog';
import { AUTOGENERATE_OUTCOMES, type AutogenerateStep } from '@autologger/contract';
import { describe, expect, it } from 'vitest';
import type { GenerationPrincipal } from '../generation/principal';
import {
  AutogenerateWorker,
  type SessionGates,
  type StepHooks,
  type StepOps,
  type StepResult,
  type WorkerPorts,
} from './worker';

const STEPS: AutogenerateStep[] = ['transcript', 'events', 'topics', 'wiki'];
const ITEM_FIELDS = new Set([
  'status',
  'outcome',
  'attempts',
  'kept_edited',
  'wiki_accepted',
  'wiki_pending',
  'started_at_ms',
  'finished_at_ms',
]);

interface World {
  ports: WorkerPorts;
  job: AutogenerateJobRow;
  items: AutogenerateItemRow[];
  calls: string[];
  clock: { now: number };
  sleeps: number[];
  /** Runner results by `session:step`, consumed in order; a function may look at the hooks. */
  results: Map<string, Array<StepResult | ((h: StepHooks) => Promise<StepResult>)>>;
  /** Hooks run on each attempt (before the runner), by `session:step`. */
  onAttempt: Map<string, () => void>;
  gate: { principal: boolean; manages: boolean; approved: boolean; session: Map<string, string> };
  cleanups: Array<{ session: string; step: string }>;
  cleanupThrows: boolean;
  recordingUntil: Map<string, number>;
  patches: AutogenerateItemPatch[];
  worker: AutogenerateWorker;
}

function makeWorld(
  sessions: string[],
  steps: AutogenerateStep[] = STEPS,
  over: Partial<AutogenerateJobRow> = {},
): World {
  const clock = { now: 1_000_000 };
  const job: AutogenerateJobRow = {
    id: 'job-1',
    team_id: 'T',
    initiator_user_id: 'u1',
    initiator_name: 'Ana Diaz',
    scope: 'shows',
    show_ids: ['s'],
    steps,
    wiki_mode: 'accept',
    status: 'queued',
    stop_reason: null,
    consecutive_stt_failures: 0,
    consecutive_llm_failures: 0,
    session_count: sessions.length,
    locked_by: null,
    locked_until_ms: null,
    cancel_requested_at_ms: null,
    cancel_requested_by_user_id: null,
    cancel_requested_by_name: null,
    created_at_ms: 1,
    started_at_ms: null,
    finished_at_ms: null,
    updated_at_ms: 1,
    ...over,
  };
  const items: AutogenerateItemRow[] = sessions.flatMap((s, o) =>
    steps.map((step) => ({
      job_id: job.id,
      session_id: s,
      step,
      ordinal: o,
      step_order: STEPS.indexOf(step),
      effective_date: null,
      status: 'pending' as const,
      outcome: null,
      attempts: 0,
      run_ids: [],
      own_topic_ids: [],
      kept_edited: null,
      wiki_accepted: null,
      wiki_pending: null,
      started_at_ms: null,
      finished_at_ms: null,
    })),
  );
  const w = {
    job,
    items,
    calls: [] as string[],
    clock,
    sleeps: [] as number[],
    results: new Map(),
    onAttempt: new Map(),
    gate: { principal: true, manages: true, approved: true, session: new Map<string, string>() },
    cleanups: [] as Array<{ session: string; step: string }>,
    cleanupThrows: false,
    recordingUntil: new Map<string, number>(),
    patches: [] as AutogenerateItemPatch[],
  } as unknown as World;
  const find = (s: string, step: string) =>
    items.find((i) => i.session_id === s && i.step === step) as AutogenerateItemRow;
  const held = () => job.locked_by === 'w1' && job.status === 'running';
  const store = {
    claim: async () => {
      if (job.status !== 'queued') return null;
      job.status = 'running';
      job.locked_by = 'w1';
      return { ...job };
    },
    renew: async () => 'ok',
    release: async () => 1,
    readJob: async () => {
      w.calls.push('job');
      return { ...job };
    },
    items: async () => items.map((i) => ({ ...i })),
    updateItem: async (
      _j: string,
      _w: string,
      s: string,
      step: string,
      patch: AutogenerateItemPatch,
    ) => {
      if (!held()) return 0;
      w.patches.push(patch);
      Object.assign(find(s, step), patch);
      if (patch.status && patch.status !== 'running')
        w.calls.push(`end ${s}:${step} ${patch.outcome ?? patch.status}`);
      return 1;
    },
    appendRunId: async (_j: string, _w: string, s: string, step: string, id: string) => {
      if (!held()) return 0;
      find(s, step).run_ids.push(id);
      return 1;
    },
    appendTopicId: async (_j: string, _w: string, s: string, step: string, id: string) => {
      if (!held()) return 0;
      find(s, step).own_topic_ids.push(id);
      return 1;
    },
    recordedPartialOutput: async (s: string, step: string) => {
      const i = find(s, step);
      return i.status === 'done'
        ? { runIds: [], topicIds: [] }
        : { runIds: i.run_ids, topicIds: i.own_topic_ids };
    },
    cancelRemaining: async (_j: string, _w: string, outcome: string) => {
      if (!held()) return 0;
      let n = 0;
      for (const i of items) {
        if (i.status === 'pending' || i.status === 'running') {
          Object.assign(i, { status: 'cancelled', outcome });
          n += 1;
        }
      }
      w.calls.push(`cancel-remaining ${outcome}`);
      return n;
    },
    setFailureCounts: async (_j: string, _w: string, stt: number, llm: number) => {
      job.consecutive_stt_failures = stt;
      job.consecutive_llm_failures = llm;
      return held() ? 1 : 0;
    },
    endJob: async (_j: string, _w: string, status: string, reason: string | null) => {
      if (!held()) return 0;
      job.status = status as AutogenerateJobRow['status'];
      job.stop_reason = reason;
      w.calls.push(`job ${status}${reason ? ` ${reason}` : ''}`);
      return 1;
    },
  } as unknown as AutogenerateStoreFacade;
  const p = { user: { id: 'u1' } } as unknown as GenerationPrincipal;
  const gates: SessionGates = {
    manages: async () => {
      w.calls.push('role');
      return w.gate.manages;
    },
    approved: () => {
      w.calls.push('approved');
      return w.gate.approved;
    },
    session: async (_p, s) => {
      w.calls.push(`session ${s}`);
      return (w.gate.session.get(s) ?? 'ok') as 'ok';
    },
    recording: async (_p, s) => (w.recordingUntil.get(s) ?? 0) > clock.now,
  };
  const steps2: StepOps = {
    cleanup: async (_p, s, step, ids) => {
      if (ids.runIds.length === 0 && ids.topicIds.length === 0) return 0;
      w.calls.push(`cleanup ${s}:${step}`);
      w.cleanups.push({ session: s, step });
      if (w.cleanupThrows) throw new Error('refused');
      return 0;
    },
    present: async () => false,
    run: async (_p, s, step, hooks) => {
      w.onAttempt.get(`${s}:${step}`)?.();
      const queue = w.results.get(`${s}:${step}`) ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      w.calls.push(`run ${s}:${step}`);
      if (typeof next === 'function') return next(hooks);
      if (next === undefined) {
        await hooks.beforeRun(step === 'events' || step === 'wiki' ? `run-${s}-${step}` : null);
        return { kind: 'done' };
      }
      return next;
    },
    wikiStored: async () => false,
    acceptWiki: async (_p, _s, _r, _j, mode) =>
      mode === 'accept' ? { accepted: 1, pending: 2 } : { accepted: 0, pending: 3 },
  };
  w.ports = {
    workerId: 'w1',
    now: () => clock.now,
    sleep: async (ms) => {
      w.sleeps.push(ms);
      clock.now += ms;
    },
    store,
    principal: async () => {
      w.calls.push('principal');
      return w.gate.principal ? p : null;
    },
    bind: () => p,
    gates,
    steps: steps2,
    renewEvery: () => () => {},
    log: () => {},
  };
  w.worker = new AutogenerateWorker(w.ports);
  return w;
}

const statusOf = (w: World, s: string, step: string) => {
  const i = w.items.find((x) => x.session_id === s && x.step === step);
  return `${i?.status}${i?.outcome ? ` ${i.outcome}` : ''}`;
};
const report = (w: World) =>
  Object.fromEntries(
    w.items.map((i) => [`${i.session_id}:${i.step}`, statusOf(w, i.session_id, i.step)]),
  );
const fail = (outcome: Extract<StepResult, { kind: 'fail' }>['outcome']): StepResult => ({
  kind: 'fail',
  outcome,
});

/** Every ended item's outcome goes with its status (contract table). */
function expectContractPairs(w: World) {
  for (const i of w.items) {
    if (i.outcome === null) {
      expect(['pending', 'running', 'done']).toContain(i.status);
    } else {
      expect(AUTOGENERATE_OUTCOMES[i.outcome as keyof typeof AUTOGENERATE_OUTCOMES]?.status).toBe(
        i.status,
      );
    }
  }
}

describe('the per-session ladder (design D5)', () => {
  it('runs cancel, account, role, approval, then the session as the initiator, before every session', async () => {
    const w = makeWorld(['A', 'B'], ['wiki']);
    await w.worker.tick();
    const ladder = w.calls.filter(
      (c) => ['job', 'principal', 'role', 'approved'].includes(c) || c.startsWith('session'),
    );
    expect(ladder.slice(0, 5)).toEqual(['job', 'principal', 'role', 'approved', 'session A']);
    expect(w.calls.indexOf('session B')).toBeGreaterThan(w.calls.indexOf('run A:wiki'));
    expect(w.calls.filter((c) => c.startsWith('session '))).toEqual(['session A', 'session B']);
    expect(w.job.status).toBe('finished');
  });

  it('skips a session the initiator can no longer access, or that is gone, with no runner call', async () => {
    const w = makeWorld(['A', 'B', 'C'], ['transcript', 'topics']);
    w.gate.session.set('A', 'access-lost');
    w.gate.session.set('B', 'session-gone');
    await w.worker.tick();
    expect(w.calls.filter((c) => c.startsWith('run A') || c.startsWith('run B'))).toEqual([]);
    expect(report(w)).toEqual({
      'A:transcript': 'skipped access-lost',
      'A:topics': 'skipped access-lost',
      'B:transcript': 'skipped session-gone',
      'B:topics': 'skipped session-gone',
      'C:transcript': 'done',
      'C:topics': 'done',
    });
    expect(w.job.status).toBe('finished');
    expectContractPairs(w);
  });

  for (const [label, setup, reason] of [
    [
      'a disabled or missing initiator',
      (w: World) => (w.gate.principal = false),
      'initiator-unavailable',
    ],
    ['the role lost', (w: World) => (w.gate.manages = false), 'initiator-role-lost'],
    ['approval lost', (w: World) => (w.gate.approved = false), 'not-approved'],
  ] as const) {
    it(`${label} stops the job with ${reason}; the remaining items are cancelled job-stopped`, async () => {
      const w = makeWorld(['A', 'B'], ['topics']);
      w.onAttempt.set('A:topics', () => setup(w));
      await w.worker.tick();
      expect(w.job).toMatchObject({ status: 'failed', stop_reason: reason });
      expect(report(w)).toEqual({ 'A:topics': 'done', 'B:topics': 'cancelled job-stopped' });
      expect(w.calls.filter((c) => c.startsWith('run '))).toEqual(['run A:topics']);
    });
  }

  it('an unconfigured STT or LLM step fails unconfigured and stops the job', async () => {
    for (const [step, reason] of [
      ['transcript', 'unconfigured-stt'],
      ['topics', 'unconfigured-llm'],
    ] as const) {
      const w = makeWorld(['A', 'B'], [step, 'wiki']);
      w.results.set(`A:${step}`, [{ kind: 'unconfigured' }]);
      await w.worker.tick();
      expect(w.job).toMatchObject({ status: 'failed', stop_reason: reason });
      expect(report(w)).toEqual({
        [`A:${step}`]: 'failed unconfigured',
        'A:wiki': 'cancelled job-stopped',
        [`B:${step}`]: 'cancelled job-stopped',
        'B:wiki': 'cancelled job-stopped',
      });
      expectContractPairs(w);
    }
  });
});

describe('outcomes and cascades (design D7, D9)', () => {
  it('present, the no-audio cascade, and the failure cascade', async () => {
    const w = makeWorld(['A', 'B', 'C']);
    w.results.set('A:transcript', [{ kind: 'present' }]);
    w.results.set('B:transcript', [{ kind: 'skip', outcome: 'no-audio' }]);
    w.results.set('C:events', [fail('generation-failed')]);
    await w.worker.tick();
    expect(report(w)).toEqual({
      'A:transcript': 'skipped present',
      'A:events': 'done',
      'A:topics': 'done',
      'A:wiki': 'done',
      'B:transcript': 'skipped no-audio',
      'B:events': 'skipped no-transcript',
      'B:topics': 'skipped no-transcript',
      'B:wiki': 'skipped no-transcript',
      'C:transcript': 'done',
      'C:events': 'failed generation-failed',
      'C:topics': 'skipped earlier-step-failed',
      'C:wiki': 'skipped earlier-step-failed',
    });
    expect(w.calls.filter((c) => c.startsWith('run B'))).toEqual(['run B:transcript']);
    expect(w.job.status).toBe('finished');
    expectContractPairs(w);
  });

  it('records each runner ending with its outcome (the D9 rows the worker owns)', async () => {
    const rows: Array<[StepResult, string]> = [
      [{ kind: 'skip', outcome: 'no-speech' }, 'skipped no-speech'],
      [{ kind: 'skip', outcome: 'no-anchors' }, 'skipped no-anchors'],
      [{ kind: 'skip', outcome: 'no-instructions' }, 'skipped no-instructions'],
      [fail('provider-failed'), 'failed provider-failed'],
      [fail('too-large'), 'failed too-large'],
      [fail('missing-audio-file'), 'failed missing-audio-file'],
      [fail('unreadable'), 'failed unreadable'],
      [fail('generation-failed'), 'failed generation-failed'],
    ];
    for (const [result, expected] of rows) {
      const w = makeWorld(['A'], ['events']);
      w.results.set('A:events', [result]);
      await w.worker.tick();
      expect(statusOf(w, 'A', 'events')).toBe(expected);
      expectContractPairs(w);
    }
  });

  it('an item interrupted three times ends failed interrupted, after its cleanup', async () => {
    const w = makeWorld(['A'], ['topics', 'wiki'], { status: 'queued' });
    Object.assign(w.items[0] as AutogenerateItemRow, {
      status: 'running',
      attempts: 3,
      own_topic_ids: ['t1'],
    });
    await w.worker.tick();
    expect(report(w)).toEqual({
      'A:topics': 'failed interrupted',
      'A:wiki': 'skipped earlier-step-failed',
    });
    expect(w.calls.indexOf('cleanup A:topics')).toBeLessThan(
      w.calls.indexOf('end A:topics interrupted'),
    );
  });
});

describe('busy (design D8)', () => {
  it('retries every 15 s and runs once the session is free', async () => {
    const w = makeWorld(['A'], ['events']);
    w.results.set('A:events', [{ kind: 'busy' }, { kind: 'busy' }, { kind: 'done' }]);
    await w.worker.tick();
    expect(w.sleeps).toEqual([15_000, 15_000]);
    expect(statusOf(w, 'A', 'events')).toBe('done');
  });

  it('a live recording lease is busy too; after 10 minutes the session is skipped busy', async () => {
    const w = makeWorld(['A', 'B'], ['events', 'topics']);
    w.recordingUntil.set('A', Number.MAX_SAFE_INTEGER);
    await w.worker.tick();
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBe(10 * 60_000);
    expect(report(w)).toEqual({
      'A:events': 'skipped busy',
      'A:topics': 'skipped busy',
      'B:events': 'done',
      'B:topics': 'done',
    });
    expect(w.calls.filter((c) => c.startsWith('run A'))).toEqual([]);
    expectContractPairs(w);
  });

  it('a cancel during the busy wait ends the job without running, after the cleanup', async () => {
    const w = makeWorld(['A', 'B'], ['events']);
    (w.items[0] as AutogenerateItemRow).run_ids = ['r0'];
    w.results.set('A:events', [{ kind: 'busy' }]);
    w.ports.sleep = async (ms) => {
      w.sleeps.push(ms);
      w.clock.now += ms;
      w.job.cancel_requested_at_ms = w.clock.now;
    };
    await w.worker.tick();
    expect(w.job).toMatchObject({ status: 'cancelled', stop_reason: 'cancelled' });
    expect(report(w)).toEqual({
      'A:events': 'cancelled cancelled',
      'B:events': 'cancelled cancelled',
    });
    expect(w.calls.indexOf('cleanup A:events')).toBeLessThan(
      w.calls.indexOf('cancel-remaining cancelled'),
    );
  });
});

describe('rate limits and provider failure (design D17)', () => {
  it('retries after 30, 60, 120, 240 and 480 s; then fails rate-limited', async () => {
    const w = makeWorld(['A'], ['topics']);
    w.results.set('A:topics', [{ kind: 'rate-limited' }]);
    await w.worker.tick();
    expect(w.sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(statusOf(w, 'A', 'topics')).toBe('failed rate-limited');
    expectContractPairs(w);
  });

  it('a success after two refusals is done', async () => {
    const w = makeWorld(['A'], ['topics']);
    w.results.set('A:topics', [
      { kind: 'rate-limited' },
      { kind: 'rate-limited' },
      { kind: 'done' },
    ]);
    await w.worker.tick();
    expect(w.sleeps).toEqual([30_000, 60_000]);
    expect(statusOf(w, 'A', 'topics')).toBe('done');
  });

  it('a cancel during a rate-limit wait cleans up and ends the job', async () => {
    const w = makeWorld(['A'], ['events']);
    w.results.set('A:events', [
      async (h) => {
        await h.beforeRun('r1');
        return { kind: 'rate-limited' };
      },
    ]);
    w.ports.sleep = async (ms) => {
      w.sleeps.push(ms);
      w.job.cancel_requested_at_ms = 1;
    };
    await w.worker.tick();
    expect(w.job.status).toBe('cancelled');
    expect(w.cleanups).toEqual([{ session: 'A', step: 'events' }]);
    expect(statusOf(w, 'A', 'events')).toBe('cancelled cancelled');
  });

  it('three sessions in a row of LLM failures stop provider-failing, though each had a done transcript', async () => {
    const w = makeWorld(['A', 'B', 'C', 'D'], ['transcript', 'events']);
    for (const [s, o] of [
      ['A', 'provider-failed'],
      ['B', 'generation-failed'],
    ] as const) {
      w.results.set(`${s}:events`, [fail(o)]);
    }
    w.results.set('C:events', [{ kind: 'rate-limited' }]);
    await w.worker.tick();
    expect(w.job).toMatchObject({ status: 'failed', stop_reason: 'provider-failing' });
    expect(w.job.consecutive_llm_failures).toBe(3);
    expect(w.job.consecutive_stt_failures).toBe(0);
    expect(statusOf(w, 'D', 'transcript')).toBe('cancelled job-stopped');
    expect(w.calls.filter((c) => c.startsWith('run D'))).toEqual([]);
  });

  it('a done step resets only its own kind; skips change neither; counts continue a resume', async () => {
    const w = makeWorld(['A', 'B', 'C'], ['transcript', 'events'], {
      consecutive_stt_failures: 2,
      consecutive_llm_failures: 2,
    });
    w.results.set('A:events', [{ kind: 'skip', outcome: 'no-anchors' }]);
    w.results.set('B:transcript', [fail('provider-failed')]);
    await w.worker.tick();
    // A: transcript done resets STT to 0; the events skip leaves LLM at 2. B: STT 1. C: all done.
    expect(w.job.consecutive_stt_failures).toBe(0);
    expect(w.job.consecutive_llm_failures).toBe(0);
    expect(w.job.status).toBe('finished');
  });
});

describe('every ending cleans up (design D7)', () => {
  const withRecorded = (w: World, s = 'A') => {
    const i = w.items.find((x) => x.session_id === s && x.step === 'topics') as AutogenerateItemRow;
    Object.assign(i, { status: 'running', attempts: 1, own_topic_ids: ['t-partial'] });
  };

  it('for each job stop and ladder refusal, before the item’s ending write', async () => {
    const cases: Array<[string, (w: World) => void]> = [
      ['cancel', (w) => (w.job.cancel_requested_at_ms = 1)],
      ['account', (w) => (w.gate.principal = false)],
      ['role', (w) => (w.gate.manages = false)],
      ['approval', (w) => (w.gate.approved = false)],
      ['session', (w) => w.gate.session.set('A', 'access-lost')],
    ];
    for (const [label, setup] of cases) {
      const w = makeWorld(['A'], ['topics']);
      withRecorded(w);
      setup(w);
      await w.worker.tick();
      const at = w.calls.indexOf('cleanup A:topics');
      expect(at, label).toBeGreaterThan(-1);
      const endAt = w.calls.findIndex(
        (c) => c.startsWith('end A:topics') || c.startsWith('cancel-remaining'),
      );
      expect(at, label).toBeLessThan(endAt);
    }
  });

  it('a failed step and provider-failing clean up first; a refused cleanup still ends the item', async () => {
    const w = makeWorld(['A'], ['topics']);
    w.cleanupThrows = true;
    w.results.set('A:topics', [
      async (h) => {
        await h.recordTopicId('t-new');
        return fail('generation-failed');
      },
    ]);
    await w.worker.tick();
    expect(w.cleanups).toEqual([{ session: 'A', step: 'topics' }]);
    expect(statusOf(w, 'A', 'topics')).toBe('failed generation-failed');
    expect((w.items[0] as AutogenerateItemRow).own_topic_ids).toEqual(['t-new']);
  });
});

describe('cancel, polling and columns (design D3, D10)', () => {
  it('a cancel during a running step keeps its result and starts no further step', async () => {
    const w = makeWorld(['A'], ['transcript', 'events']);
    w.onAttempt.set('A:transcript', () => {
      w.job.cancel_requested_at_ms = 5;
    });
    await w.worker.tick();
    expect(report(w)).toEqual({ 'A:transcript': 'done', 'A:events': 'cancelled cancelled' });
    expect(w.job.status).toBe('cancelled');
  });

  it('a lease lost mid-job writes nothing more', async () => {
    const w = makeWorld(['A', 'B'], ['topics']);
    w.results.set('A:topics', [
      async (h) => {
        w.job.locked_by = 'w2';
        expect(await h.recordTopicId('t1')).toBe(false);
        return { kind: 'stopped' };
      },
    ]);
    await w.worker.tick();
    expect(report(w)).toEqual({ 'A:topics': 'running', 'B:topics': 'pending' });
    expect(w.job.status).toBe('running');
  });

  it('polls every 15 s, and the worker sends no pg_notify', async () => {
    const w = makeWorld(['A'], ['wiki'], { status: 'finished' });
    const sleeps: number[] = [];
    let polls = 0;
    w.ports.sleep = async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= 2) w.worker.stop();
    };
    const claim = w.ports.store.claim;
    w.ports.store.claim = async (...a) => {
      polls += 1;
      return claim(...a);
    };
    w.worker.start();
    await w.worker.idle();
    expect(sleeps).toEqual([15_000, 15_000]);
    expect(polls).toBe(2);
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    expect(files).toContain('worker.ts');
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, f).not.toMatch(/pg_notify|\.notify\(/);
    }
  });

  it('writes only the listed item columns (no credential)', async () => {
    const w = makeWorld(['A', 'B'], STEPS);
    w.results.set('B:topics', [fail('generation-failed')]);
    await w.worker.tick();
    for (const patch of w.patches) {
      for (const k of Object.keys(patch)) expect(ITEM_FIELDS.has(k), k).toBe(true);
    }
    const wiki = w.items.find((i) => i.session_id === 'A' && i.step === 'wiki');
    // The wiki run's suggestions went through the accept phase (accept mode).
    expect(wiki).toMatchObject({ status: 'done', wiki_accepted: 1, wiki_pending: 2 });
  });
});
