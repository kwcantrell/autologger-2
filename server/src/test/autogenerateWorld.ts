// A batch autogenerate world for the worker integration suites (batch-autogenerate tasks 4.3-4.7):
// a team whose show has the instruction-bearing `slate` button, N sessions in a fixed order with an
// anchored transcript, an initiator admin with an AI SDK credential on a fake provider, a job
// created as that initiator, and workers on the real ports with a fake clock and fake sleeps.
// Test infrastructure.

import {
  type AutogenerateItemRow,
  type AutogenerateStepName,
  autogenerateWorkerCatalog,
  type CatalogFacade,
  createCatalog,
} from '@autologger/catalog';
import { parseWikiLinks } from '@autologger/contract';
import type { Bindings } from '../appEnv';
import { createWorkerPorts, type WorkerPortOptions } from '../autogenerate/ports';
import { AutogenerateWorker, type WorkerPorts } from '../autogenerate/worker';
import type { GenerationPrincipal } from '../generation/principal';
import { answer, callTools, type FakeLlm, type FakeReply, type FakeScript } from './fakeLlm';
import {
  fakeProvider,
  genSession,
  sdkAdmin,
  sdkEnv,
  seedAnchoredTranscript,
} from './generationFixtures';
import { principalFor } from './generationPrincipal';
import { seedSession, testDb } from './helpers';

export type TurnKind = 'events' | 'topics' | 'wiki';

/** The kind of a turn's request, from the tools it offers. */
export function turnKind(body: Record<string, unknown>): TurnKind {
  const names = ((body.tools ?? []) as Array<{ function: { name: string } }>).map(
    (t) => t.function.name,
  );
  if (names.includes('create_event')) return 'events';
  if (names.includes('create_topic')) return 'topics';
  return 'wiki';
}

/** How many model replies the turn already got (its round, from 0). */
export function roundOf(body: Record<string, unknown>): number {
  return ((body.messages ?? []) as Array<{ role: string }>).filter((m) => m.role === 'assistant')
    .length;
}

export const slate = (message: string) => ({
  name: 'create_event',
  args: { category: 'slate', message, session_time: '00:00:03:00' },
});
export const topic = (summary: string) => ({
  name: 'create_topic',
  args: { session_time: '00:00:01', duration_sec: 5, topic_level: 2, summary },
});
const READ = { name: 'get_transcript_words', args: { page: 0 } };

/** A provider script: per turn kind and per that kind's turn number (from 1), the replies after the
 * transcript read. The default per kind: events one slate, topics two topics, wiki nothing. */
export function scripted(
  override: (kind: TurnKind, turn: number, round: number) => FakeReply | undefined = () =>
    undefined,
): FakeScript & { turns: Record<TurnKind, number> } {
  const turns: Record<TurnKind, number> = { events: 0, topics: 0, wiki: 0 };
  const script = ((_n: number, body: Record<string, unknown>) => {
    const kind = turnKind(body);
    const round = roundOf(body);
    if (round === 0) turns[kind] += 1;
    const o = override(kind, turns[kind], round);
    if (o) return o;
    if (round === 0) return callTools(1, [READ]);
    if (round === 1) {
      if (kind === 'events') return callTools(2, [slate(`Batch slate ${turns.events}`)]);
      if (kind === 'topics') {
        return callTools(2, [topic(`Gen ${turns.topics}a`), topic(`Gen ${turns.topics}b`)]);
      }
    }
    return answer('done');
  }) as FakeScript & { turns: Record<TurnKind, number> };
  script.turns = turns;
  return script;
}

export interface AgWorld {
  studioId: string;
  showId: string;
  sessions: string[];
  uid: string;
  p: GenerationPrincipal;
  llm: FakeLlm;
  jobId: string;
  clock: { t: number };
  env: Bindings;
  root: CatalogFacade;
  items(): Promise<AutogenerateItemRow[]>;
  item(sessionId: string, step: AutogenerateStepName): Promise<AutogenerateItemRow>;
  job(): Promise<Record<string, unknown>>;
  worker(
    id: string,
    over?: Partial<WorkerPortOptions>,
  ): { worker: AutogenerateWorker; ports: WorkerPorts };
}

export async function agWorld(o: {
  sessions: number;
  steps: AutogenerateStepName[];
  wikiMode?: 'accept' | 'pending';
  script: FakeScript;
  /** Seed each session's anchored transcript (default true). */
  transcript?: boolean;
  env?: Bindings;
  apiKey?: string;
}): Promise<AgWorld> {
  const llm = await fakeProvider(o.script);
  const first = await genSession();
  const sessions = [first.sessionId];
  for (let i = 1; i < o.sessions; i += 1)
    sessions.push(await seedSession({ showId: first.showId }));
  for (const [i, s] of sessions.entries()) {
    await testDb().run('UPDATE sessions SET episode_date = ? WHERE id = ?', `2024-01-${10 + i}`, s);
    if (o.transcript !== false) await seedAnchoredTranscript(s);
  }
  const uid = await sdkAdmin(first.studioId, llm.baseURL, { apiKey: o.apiKey });
  const env = o.env ?? sdkEnv();
  const p = await principalFor(uid, env);
  const clock = { t: 1_800_000_000_000 };
  const created = await p.catalog.autogenerate.createJob({
    teamId: first.studioId,
    initiatorId: uid,
    initiatorName: 'Initiator Name',
    scope: { sessionIds: sessions },
    steps: o.steps,
    wikiMode: o.wikiMode ?? 'accept',
    expectedSessions: sessions.length,
    nowMs: clock.t,
  });
  if (created.kind !== 'created') throw new Error(`job not created: ${created.kind}`);
  const root = createCatalog(env.ports.catalog, { wikiLinks: parseWikiLinks });
  const store = autogenerateWorkerCatalog(root).autogenerate;
  const jobId = created.job.id;
  return {
    studioId: first.studioId,
    showId: first.showId,
    sessions,
    uid,
    p,
    llm,
    jobId,
    clock,
    env,
    root,
    items: () => store.items(jobId),
    async item(sessionId, step) {
      const i = (await store.items(jobId)).find(
        (x) => x.session_id === sessionId && x.step === step,
      );
      if (!i) throw new Error('no item');
      return i;
    },
    async job() {
      return (await testDb().first('SELECT * FROM autogenerate_jobs WHERE id = ?', jobId)) ?? {};
    },
    worker(id, over = {}) {
      const ports = createWorkerPorts({
        env,
        root,
        workerId: id,
        now: () => clock.t,
        sleep: async (ms) => {
          clock.t += ms;
        },
        renewEvery: () => () => {},
        ...over,
      });
      ports.log = () => {};
      return { worker: new AutogenerateWorker(ports), ports };
    },
  };
}

/** `status outcome` of every item, keyed `<session index>:<step>`. */
export async function reportOf(w: AgWorld): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const i of await w.items()) {
    out[`${w.sessions.indexOf(i.session_id) + 1}:${i.step}`] =
      `${i.status}${i.outcome ? ` ${i.outcome}` : ''}`;
  }
  return out;
}

/** Resolves once `cond` holds (polled every 10 ms, at most `ms`). */
export async function until(cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}
