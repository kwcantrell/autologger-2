// session-content-policies (ADR 0021 slice 7b-2) hub benchmark, design D11 / task 7.2. 7b-1's
// spike/bench7b.mts with every hub call made as a user (`hub.as(userCaller(owner))`), so it runs
// under the content policies, at 300 and at 3,000 accessible sessions (panel finding 4).
//
// Run INSIDE the dev app container after the migration is applied (`make dev-migrate`); the
// working tree's packages are bind-mounted at /app:
//   docker cp openspec/changes/session-content-policies/spike/bench7b2.mts autologger-dev-app:/tmp/bench7b2.mts
//   docker exec -w /app -e BENCH_REPO=/app autologger-dev-app npx tsx /tmp/bench7b2.mts
// It uses the app's PG* settings. As the system task `bench` it creates one throwaway user, team
// (the user its owner), show and the padding sessions, and deletes everything it created at the end.
// N and RUNS are smaller than 7b-1's (5000 x 5) by owner direction to save compute; the figures
// are per-call medians, comparable with 7b-1's.
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const repo = process.env.BENCH_REPO ?? resolve(import.meta.dirname, '../../../..');
const storage = await import(join(repo, 'packages/storage/src/index.ts'));
const core = await import(join(repo, 'packages/session-core/src/index.ts'));

const N = 3000;
const RUNS = 3;
const WORDS = 31_621;
const COUNTS_DEFAULT = [300, 3000];
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
const sessions = new storage.PostgresSessionDb(catalogDb);
const tag = `bench7b2-${randomUUID()}`;
const userId = `${tag}-u`;
const teamId = `${tag}-t`;
const showId = `${tag}-s`;
// BENCH_CALLER=system runs the same sequence as a system task (a control for machine load).
const caller = env.BENCH_CALLER === 'system' ? core.systemCaller('bench') : core.userCaller(userId);
const COUNTS_ENV = env.BENCH_COUNTS ? env.BENCH_COUNTS.split(',').map(Number) : null;
const now = new Date().toISOString();
const created: string[] = [];

await admin.run(
  'insert into users (id, google_sub, email, given_name, family_name, created_at_utc) values (?, ?, ?, ?, ?, ?)',
  userId,
  `${tag}-sub`,
  `${tag}@example.com`,
  'Bench',
  'Owner',
  now,
);
await admin.run(
  'insert into studio_definitions (id, display_name, sort_order, created_at_utc) values (?, ?, ?, ?)',
  teamId,
  'bench7b2',
  99,
  now,
);
await admin.run(
  "insert into user_studio_memberships (user_id, studio_id, role) values (?, ?, 'owner')",
  userId,
  teamId,
);
await admin.run(
  'insert into shows (id, studio_id, name, show_code, created_at_utc) values (?, ?, ?, ?, ?)',
  showId,
  teamId,
  'bench7b2',
  'BENCH',
  now,
);
let padded = 0;
const padTo = async (count: number) => {
  await admin.run(
    "insert into sessions (id, show_id, created_at_utc) select ? || '-pad-' || g, ?, ? from generate_series(?::int, ?::int) g",
    tag,
    showId,
    now,
    padded + 1,
    count,
  );
  padded = count;
};
const newSession = async () => {
  const id = `${tag}-${randomUUID()}`;
  await admin.run('insert into sessions (id, show_id, created_at_utc) values (?, ?, ?)', id, showId, now);
  created.push(id);
  return id;
};
const userHub = async (registry: { get(id: string): Promise<{ as(c: unknown): any }> }) =>
  (await registry.get(await newSession())).as(caller);

const results: string[] = [];
try {
  for (const count of COUNTS_ENV ?? COUNTS_DEFAULT) {
    await padTo(count);
    const add: number[] = [];
    const list: number[] = [];
    const replace: number[] = [];
    const chunks: string[] = [];
    for (let run = 0; run < RUNS; run++) {
      const registry = new core.SessionHubRegistry({ storage: (id: string) => sessions.forSession(id) });
      const hub = await userHub(registry);
      let t = performance.now();
      let chunk = t;
      for (let i = 0; i < N; i++) {
        await hub.addEvent({ category: 'c', message: `m${i}`, metadataJson: '{}', markedAtUtc: null, ctx });
        if ((i + 1) % 500 === 0) {
          const n = performance.now();
          chunks.push(`${i + 1 - 499}-${i + 1}: ${(((n - chunk) * 1000) / 500).toFixed(0)}`);
          chunk = n;
        }
      }
      add.push(((performance.now() - t) * 1000) / N);
      t = performance.now();
      for (let i = 0; i < N; i++) await hub.listEvents({ limit: 200, offset: 0 });
      list.push(((performance.now() - t) * 1000) / N);
      await registry.closeAll();
    }
    const registry = new core.SessionHubRegistry({ storage: (id: string) => sessions.forSession(id) });
    const hub = await userHub(registry);
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
    const accessible = count + created.length;
    results.push(
      `[~${accessible} accessible sessions] addEvent us/call: ${add.map((x) => x.toFixed(1)).join(' ')} median ${median(add).toFixed(1)}`,
      `[~${accessible} accessible sessions] listEvents us/call: ${list.map((x) => x.toFixed(1)).join(' ')} median ${median(list).toFixed(1)}`,
      `[~${accessible} accessible sessions] addEvent us/call by event count (run by run): ${chunks.join(' | ')}`,
      `[~${accessible} accessible sessions] replaceTranscriptWords ${WORDS} words ms: ${replace.map((x) => x.toFixed(0)).join(' ')} median ${median(replace).toFixed(0)}`,
    );
  }
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
  }
  await admin.run('delete from sessions where show_id = ?', showId);
  await admin.run('delete from shows where id = ?', showId);
  await admin.run('delete from user_studio_memberships where studio_id = ?', teamId);
  await admin.run('delete from studio_definitions where id = ?', teamId);
  await admin.run('delete from users where id = ?', userId);
  await catalogDb.close();
}
console.log(`node ${process.version} runs ${RUNS} N ${N} as ${env.BENCH_CALLER === 'system' ? 'the system task bench' : 'a user'} (7b-1 baseline, task 1.2: addEvent 5417.7/5278.4 us, listEvents 4973.9/5237.9 us, replace 397/408 ms)`);
for (const line of results) console.log(line);
