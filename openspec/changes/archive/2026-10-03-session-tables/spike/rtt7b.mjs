// session-tables spike: the database round trip as the app sees it in a compose stack (design A0b).
// Writes no row: `select 1`, and a READ COMMITTED transaction shaped like the hub's addEvent (the
// pipelined BEGIN + preamble + row lock on a session id that does not exist, then seven reads,
// then COMMIT), as catalog_system. Run inside the dev app container, where the app's PG* settings
// and node_modules are (stdin, so `postgres` resolves from /app and nothing is copied in):
//   docker exec -i -w /app autologger-dev-app node --input-type=module - \
//     < openspec/changes/session-tables/spike/rtt7b.mjs
import postgres from 'postgres';

const sql = postgres({ max: 1, onnotice: () => {}, types: { bigint: { to: 20, from: [20], parse: Number, serialize: String } } });
const PRE = "select set_config('role', $1, true), set_config('app.user_id', $2, true)";
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const N = 2000;
await sql.unsafe('select 1');
const rtt = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await sql.unsafe('select 1 as x', [], { prepare: true });
  rtt.push((performance.now() - t) * 1000);
}
const tx = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await Promise.all([
    sql.unsafe('begin isolation level read committed'),
    sql.unsafe(PRE, ['catalog_system', ''], { prepare: true }),
    sql.unsafe('select 1 from sessions where id = $1 for update', ['rtt7b-no-such-session'], { prepare: true }),
  ]);
  for (let k = 0; k < 7; k++) {
    await sql.unsafe('select count(*) as n from sessions where id = $1', ['rtt7b-no-such-session'], { prepare: true });
  }
  await sql.unsafe('commit');
  tx.push((performance.now() - t) * 1000);
}
// A transaction that takes a transaction id writes a commit record, so its COMMIT waits for the
// WAL flush (synchronous_commit on), as every session write will; nothing else is written.
const flush = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await Promise.all([sql.unsafe('begin isolation level read committed'), sql.unsafe(PRE, ['catalog_system', ''], { prepare: true })]);
  await sql.unsafe('select pg_current_xact_id() as x', [], { prepare: true });
  await sql.unsafe('commit');
  flush.push((performance.now() - t) * 1000);
}
console.log(`node ${process.version} N ${N}`);
console.log(`A0b select 1 round trip us: median ${median(rtt).toFixed(0)}`);
console.log(`A0b 9-round-trip READ COMMITTED transaction us: median ${median(tx).toFixed(0)}`);
console.log(`A0b 3-round-trip transaction with a commit record (WAL flush) us: median ${median(flush).toFixed(0)}`);
await sql.end();
