// session-tables (ADR 0021 slice 7b-1) hub benchmark, design D11 / task 8.2. 7a's sequence
// (spike/bench7a.mts of async-session-hub) on the Postgres session storage, plus the largest real
// transcript replace. Written against the design's API (D2, D3, D9); if an implemented name differs,
// the task records the one-line import change in its evidence.
//
// Run INSIDE the dev app container, so the numbers are the stack's network path (design A0b), after
// `make dev-up` has applied the migration. The working tree's packages are bind-mounted at /app:
//   docker cp openspec/changes/session-tables/spike/bench7b.mts autologger-dev-app:/tmp/bench7b.mts
//   docker exec -w /app -e BENCH_REPO=/app autologger-dev-app npx tsx /tmp/bench7b.mts
// It uses the app's PG* settings, creates one throwaway show and one session per run under the seed
// team `test-studios` (as the system task `bench`), and deletes everything it created at the end.
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const repo = process.env.BENCH_REPO ?? resolve(import.meta.dirname, '../../../..');
const storage = await import(join(repo, 'packages/storage/src/index.ts'));
const core = await import(join(repo, 'packages/session-core/src/index.ts'));

const N = 5000;
const RUNS = 5;
const WORDS = 31_621;
const ctx = { frameRate: 24, startOffsetFrames: 0 };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const env = process.env;
const catalogDb = new storage.PostgresCatalogDb({
  host: env.PGHOST as string,
  port: Number(env.PGPORT),
  user: env.PGUSER as string,
  password: env.PGPASSWORD as string,
  database: env.PGDATABASE as string,
});
const admin = catalogDb.bindSystem('bench');
const sessions = new storage.PostgresSessionDb(catalogDb.bindSystem('session-hub'));
const showId = `bench7b-${randomUUID()}`;
const created: string[] = [];
const now = new Date().toISOString();
await admin.run(
  'insert into shows (id, studio_id, name, show_code, created_at_utc) values (?, ?, ?, ?, ?)',
  showId,
  'test-studios',
  'bench7b',
  'BENCH',
  now,
);
const newSession = async () => {
  const id = `bench7b-${randomUUID()}`;
  await admin.run('insert into sessions (id, show_id, created_at_utc) values (?, ?, ?)', id, showId, now);
  created.push(id);
  return id;
};

const add: number[] = [];
const list: number[] = [];
const replace: number[] = [];
try {
  for (let run = 0; run < RUNS; run++) {
    const registry = new core.SessionHubRegistry({ storage: (id: string) => sessions.forSession(id) });
    const hub = await registry.get(await newSession());
    let t = performance.now();
    for (let i = 0; i < N; i++) {
      await hub.addEvent({ category: 'c', message: `m${i}`, metadataJson: '{}', markedAtUtc: null, ctx });
    }
    add.push(((performance.now() - t) * 1000) / N);
    t = performance.now();
    for (let i = 0; i < N; i++) await hub.listEvents({ limit: 200, offset: 0 });
    list.push(((performance.now() - t) * 1000) / N);
    await registry.closeAll();
  }
  const registry = new core.SessionHubRegistry({ storage: (id: string) => sessions.forSession(id) });
  const hub = await registry.get(await newSession());
  const words = Array.from({ length: WORDS }, (_, i) => ({
    session_time: '00:00:01',
    speaker: '1',
    word: `word${i}`,
    start_sec: i * 0.31,
    end_sec: i * 0.31 + 0.2,
  }));
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    const back = await hub.replaceTranscriptWords(words);
    replace.push(performance.now() - t);
    if (back.length !== WORDS) throw new Error(`replace returned ${back.length} words`);
  }
  await registry.closeAll();
} finally {
  for (const id of created) {
    for (const table of [
      'session_events',
      'session_transport',
      'session_audio_segments',
      'session_transcript_words',
      'session_topics',
      'session_transcript_paragraphs',
      'session_transcript_sentiment',
      'session_dashboards',
      'session_meta',
    ]) {
      await admin.run(`delete from ${table} where session_id = ?`, id);
    }
    await admin.run('delete from sessions where id = ?', id);
  }
  await admin.run('delete from shows where id = ?', showId);
  await catalogDb.close();
}
console.log(`node ${process.version} runs ${RUNS} N ${N} (7a after: addEvent 166.1 us, listEvents 425.6 us)`);
console.log(`addEvent us/call per run: ${add.map((x) => x.toFixed(1)).join(' ')} median ${median(add).toFixed(1)}`);
console.log(`listEvents us/call per run: ${list.map((x) => x.toFixed(1)).join(' ')} median ${median(list).toFixed(1)}`);
console.log(`replaceTranscriptWords ${WORDS} words ms: ${replace.map((x) => x.toFixed(0)).join(' ')} median ${median(replace).toFixed(0)}`);
