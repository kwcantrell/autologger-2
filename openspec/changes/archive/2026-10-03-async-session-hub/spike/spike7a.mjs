// async-session-hub (ADR 0021 slice 7a) assumption spike, design "Assumptions and evidence"
// A1-A10 and task 1.1. Run from the repo root (or the dev container's checkout):
//   node openspec/changes/async-session-hub/spike/spike7a.mjs
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
const require = createRequire(new URL("../../../../server/package.json", import.meta.url));
const Database = require('better-sqlite3');
console.log('node', process.version, 'better-sqlite3', require('better-sqlite3/package.json').version);
const db = new Database(':memory:');
db.exec('CREATE TABLE t (x INTEGER)');
// A1 db.transaction refuses async fn
try { db.transaction(async () => { db.prepare('INSERT INTO t VALUES (1)').run(); })(); console.log('A1 no throw'); } catch (e) { console.log('A1', e.message, 'rows', db.prepare('SELECT count(*) c FROM t').get().c, 'inTx', db.inTransaction); }
db.exec('DELETE FROM t');
// A2 raw BEGIN IMMEDIATE; a statement from another caller sees uncommitted rows; ROLLBACK undoes
db.exec('BEGIN IMMEDIATE'); console.log('A2 inTx after BEGIN', db.inTransaction);
db.prepare('INSERT INTO t VALUES (2)').run();
console.log('A2 other caller sees uncommitted', db.prepare('SELECT count(*) c FROM t').get().c);
db.exec('ROLLBACK'); console.log('A2 after ROLLBACK', db.prepare('SELECT count(*) c FROM t').get().c, 'inTx', db.inTransaction);
// A3 a microtask-only await chain finishes before a setImmediate callback queued at its start
{ const order = []; setImmediate(() => order.push('immediate'));
  const run = async () => { for (let i = 0; i < 1000; i++) await Promise.resolve(i); order.push('chain'); };
  await run(); await new Promise((r) => setImmediate(r)); console.log('A3 order', order.join(',')); }
// A3b two chains in the same tick DO interleave
{ const log = []; const run = async (n) => { for (let i = 0; i < 3; i++) { log.push(n + i); await Promise.resolve(); } };
  await Promise.all([run('a'), run('b')]); console.log('A3b same-tick', log.join(',')); }
// A3c same-tick chains interleave inside an open BEGIN without a lock: b's write joins a's transaction
{ db.exec('DELETE FROM t');
  const a = async () => { db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO t VALUES (10)').run(); await Promise.resolve(); await Promise.resolve(); db.exec('ROLLBACK'); };
  const b = async () => { await Promise.resolve(); db.prepare('INSERT INTO t VALUES (20)').run(); };
  await Promise.all([a(), b()]); console.log('A3c rows after a rolled back', JSON.stringify(db.prepare('SELECT x FROM t').all())); }
// A5 ALS survives awaits, absent outside
{ const als = new AsyncLocalStorage(); let inner, detached;
  await als.run({ id: 1 }, async () => { await Promise.resolve(); inner = als.getStore(); setTimeout(() => { detached = als.getStore(); }, 0); });
  await new Promise((r) => setTimeout(r, 5)); console.log('A5 inside', JSON.stringify(inner), 'outside', als.getStore(), 'detached timer', JSON.stringify(detached)); }
// A6 closed connection
{ const d2 = new Database(':memory:'); d2.close(); try { d2.prepare('SELECT 1').get(); } catch (e) { console.log('A6', e.constructor.name, e.message); } }
// A7 failed ROLLBACK with an open iterator
{ const d3 = new Database(':memory:'); d3.exec('CREATE TABLE u (x); INSERT INTO u VALUES (1),(2)'); d3.exec('BEGIN IMMEDIATE');
  const it = d3.prepare('SELECT x FROM u').iterate(); it.next();
  try { d3.exec('ROLLBACK'); console.log('A7 rollback ok'); } catch (e) { console.log('A7', e.message, 'inTx', d3.inTransaction); } it.return(); }
// A8 200 concurrent HTTP requests, each running a 50-await microtask chain: count interleavings
{ let active = 0, interleavings = 0;
  const server = http.createServer(async (req, res) => { active++; if (active > 1) interleavings++; for (let i = 0; i < 50; i++) await Promise.resolve(); active--; res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const { port } = server.address();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
  await Promise.all(Array.from({ length: 200 }, () => new Promise((r, j) => http.get({ port, host: '127.0.0.1', agent }, (res) => { res.resume(); res.on('end', r); }).on('error', j))));
  console.log('A8 requests 200 interleavings', interleavings); agent.destroy(); server.close(); }
// A9 under a per-call FIFO lock, two same-tick read-then-write chains alternate between calls
{ let tail = Promise.resolve();
  const locked = (fn) => { const run = tail.then(fn); tail = run.catch(() => {}); return run; };
  const syncState = { rolling: false, starts: 0 };
  const syncToggle = () => { if (syncState.rolling) syncState.rolling = false; else { syncState.rolling = true; syncState.starts++; } };
  syncToggle.call(); // two toggles as two synchronous blocks (today)
  syncToggle.call();
  const st = { rolling: false, starts: 0 };
  const toggle = async () => { const snap = await locked(() => st.rolling); if (snap) await locked(() => { st.rolling = false; }); else await locked(() => { st.rolling = true; st.starts++; }); };
  await Promise.all([toggle(), toggle()]);
  console.log('A9 sync two toggles: starts', syncState.starts, 'rolling', syncState.rolling, '| async per-call lock: starts', st.starts, 'rolling', st.rolling); }
// A10 a timer armed inside als.run inherits the context; one armed through als.exit does not
{ const als = new AsyncLocalStorage(); let inherited, exited;
  als.run({ hub: 1, open: true }, () => {
    setTimeout(() => { inherited = als.getStore(); }, 0);
    als.exit(() => setTimeout(() => { exited = als.getStore(); }, 0));
  });
  await new Promise((r) => setTimeout(r, 5));
  console.log('A10 timer in run:', JSON.stringify(inherited), '| timer via als.exit:', exited); }
