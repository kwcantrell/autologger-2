// async-session-hub (ADR 0021 slice 7a) hub micro-benchmark, design D10 / tasks 1.3 and 6.1.
// Runs the IDENTICAL sequence before and after the change: every hub and registry call is
// awaited (an await on today's synchronous value is a no-op), each run uses a fresh temp
// directory, and the event count grows the same way in every run, so addEvent's per-call
// COUNT(*) cost is the same on both sides. Run from the repo root:
//   npx tsx openspec/changes/async-session-hub/spike/bench7a.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHubRegistry } from '../../../../packages/session-core/src/index';

const N = 5000;
const RUNS = 5;
const ctx = { frameRate: 24, startOffsetFrames: 0 };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const add: number[] = [];
const list: number[] = [];
for (let run = 0; run < RUNS; run++) {
  const dir = mkdtempSync(join(tmpdir(), 'bench7a-'));
  const registry = new SessionHubRegistry(dir);
  const hub = await registry.get('bench');
  let t = performance.now();
  for (let i = 0; i < N; i++) {
    await hub.addEvent({ category: 'c', message: `m${i}`, metadataJson: '{}', markedAtUtc: null, ctx });
  }
  add.push(((performance.now() - t) * 1000) / N);
  t = performance.now();
  for (let i = 0; i < N; i++) await hub.listEvents({ limit: 200, offset: 0 });
  list.push(((performance.now() - t) * 1000) / N);
  await registry.closeAll();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`node ${process.version} runs ${RUNS} N ${N}`);
console.log(`addEvent us/call per run: ${add.map((x) => x.toFixed(1)).join(' ')} median ${median(add).toFixed(1)}`);
console.log(`listEvents us/call per run: ${list.map((x) => x.toFixed(1)).join(' ')} median ${median(list).toFixed(1)}`);
