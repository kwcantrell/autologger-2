// session-leases (ADR 0021 slice 8a) recording-lease benchmark, task 7.2. Modelled on 7b-2's
// spike/bench7b2.mts: every hub call is made as a user (`hub.as(userCaller(owner))`), so it runs
// under the content policies. Per run it opens one fresh session and times N calls each of
// claimLease (the same user and client, so every claim after the first is a refresh), heartbeatLease
// and leaseStatus, then releases. It prints the per-call median (and mean) in microseconds.
//
// Run INSIDE the dev app container; the working tree's packages are bind-mounted at /app:
//   docker cp openspec/changes/session-leases/spike/benchLease.mts autologger-dev-app:/tmp/benchLease.mts
//   docker exec -w /app -e BENCH_REPO=/app autologger-dev-app npx tsx /tmp/benchLease.mts
// It uses the app's PG* settings. As the system task `bench` it creates one throwaway user, team
// (the user its owner), show and sessions, and deletes everything it created at the end. It works
// both before the 8a migration (lease in session_meta) and after it (catalog.session_leases).
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const repo = process.env.BENCH_REPO ?? resolve(import.meta.dirname, '../../../..');
const storage = await import(join(repo, 'packages/storage/src/index.ts'));
const core = await import(join(repo, 'packages/session-core/src/index.ts'));

const N = Number(process.env.BENCH_N ?? 500);
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
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
const tag = `benchLease-${randomUUID()}`;
const userId = `${tag}-u`;
const teamId = `${tag}-t`;
const showId = `${tag}-s`;
const caller = env.BENCH_CALLER === 'system' ? core.systemCaller('bench') : core.userCaller(userId);
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
  'benchLease',
  99,
  now,
);
await admin.run("insert into user_studio_memberships (user_id, studio_id, role) values (?, ?, 'owner')", userId, teamId);
await admin.run(
  'insert into shows (id, studio_id, name, show_code, created_at_utc) values (?, ?, ?, ?, ?)',
  showId,
  teamId,
  'benchLease',
  'BENCH',
  now,
);
const newSession = async () => {
  const id = `${tag}-${randomUUID()}`;
  await admin.run('insert into sessions (id, show_id, created_at_utc) values (?, ?, ?)', id, showId, now);
  created.push(id);
  return id;
};

const time = async (fn: () => Promise<unknown>, check: (r: unknown) => boolean, label: string) => {
  const xs: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await fn();
    xs.push((performance.now() - t) * 1000);
    if (!check(r)) throw new Error(`${label} call ${i} returned ${JSON.stringify(r)}`);
  }
  return xs;
};

const per: Record<'claim' | 'heartbeat' | 'status', { med: number[]; avg: number[] }> = {
  claim: { med: [], avg: [] },
  heartbeat: { med: [], avg: [] },
  status: { med: [], avg: [] },
};
try {
  for (let run = 0; run < RUNS; run++) {
    const registry = new core.SessionHubRegistry({ storage: (id: string) => sessions.forSession(id) });
    const hub = (await registry.get(await newSession())).as(caller);
    const cid = `bench-client-${run}`;
    const claim = await time(() => hub.claimLease(cid), (r) => r === true, 'claimLease');
    const beat = await time(() => hub.heartbeatLease(cid), (r) => r === true, 'heartbeatLease');
    const status = await time(
      () => hub.leaseStatus(),
      (r) => (r as { lease_alive: boolean }).lease_alive === true,
      'leaseStatus',
    );
    await hub.releaseLease(cid);
    await registry.closeAll();
    for (const [k, xs] of [
      ['claim', claim],
      ['heartbeat', beat],
      ['status', status],
    ] as const) {
      per[k].med.push(median(xs));
      per[k].avg.push(mean(xs));
    }
  }
} finally {
  for (const id of created) {
    for (const table of ['session_leases', 'session_transport', 'session_meta']) {
      try {
        await admin.run(`delete from ${table} where session_id = ?`, id);
      } catch {
        // session_leases does not exist before the 8a migration
      }
    }
  }
  await admin.run('delete from sessions where show_id = ?', showId);
  await admin.run('delete from shows where id = ?', showId);
  await admin.run('delete from user_studio_memberships where studio_id = ?', teamId);
  await admin.run('delete from studio_definitions where id = ?', teamId);
  await admin.run('delete from users where id = ?', userId);
  await catalogDb.close();
}
console.log(`node ${process.version} runs ${RUNS} N ${N} as ${env.BENCH_CALLER === 'system' ? 'the system task bench' : 'a user'}`);
for (const k of ['claim', 'heartbeat', 'status'] as const) {
  console.log(
    `${k} us/call median per run: ${per[k].med.map((x) => x.toFixed(1)).join(' ')} -> median ${median(per[k].med).toFixed(1)}; mean per run: ${per[k].avg.map((x) => x.toFixed(1)).join(' ')}`,
  );
}
