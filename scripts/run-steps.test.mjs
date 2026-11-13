import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./run-steps.mjs', import.meta.url));

function run(steps, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'run-steps-'));
  const file = join(dir, 'steps.json');
  writeFileSync(file, JSON.stringify(steps));
  const r = spawnSync(process.execPath, [RUNNER, '--steps', file], {
    encoding: 'utf8',
    env: { ...process.env, CHECK_CONCURRENCY: '', ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const echo = (name, text, extra = '') => ({ name, cmd: `echo ${text}${extra}` });

test('all steps pass: exit 0 and every step in the summary', () => {
  const r = run([echo('alpha', 'a'), echo('beta', 'b')]);
  assert.equal(r.code, 0);
  assert.match(r.out, /PASS {2}alpha\s+\d+\.\ds/);
  assert.match(r.out, /PASS {2}beta\s+\d+\.\ds/);
  assert.match(r.out, /all 2 steps passed/);
});

test('one failing step: non-zero exit and its name in the summary', () => {
  const r = run([echo('alpha', 'a'), { name: 'broken', cmd: 'echo boom; exit 3' }, echo('gamma', 'g')]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /FAIL {2}broken/);
  assert.match(r.out, /PASS {2}alpha/);
  assert.match(r.out, /PASS {2}gamma/);
  assert.match(r.out, /1 of 3 steps failed: broken/);
  assert.match(r.out, /===== broken: FAILED \(exit 3\) =====\nboom\n/);
});

test('output is grouped per step, not interleaved', () => {
  const lines = (tag) => `for i in 1 2 3 4 5; do echo ${tag}$i; sleep 0.05; done`;
  const r = run([
    { name: 'one', cmd: lines('x') },
    { name: 'two', cmd: lines('y') },
  ]);
  assert.equal(r.code, 0);
  assert.match(r.out, /===== one: ok =====\nx1\nx2\nx3\nx4\nx5\n/);
  assert.match(r.out, /===== two: ok =====\ny1\ny2\ny3\ny4\ny5\n/);
});

test('steps run concurrently by default', () => {
  const started = Date.now();
  const r = run([1, 2, 3].map((n) => ({ name: `s${n}`, cmd: 'sleep 1' })));
  assert.equal(r.code, 0);
  assert.ok(Date.now() - started < 2500, 'three 1s steps should overlap');
});

test('CHECK_CONCURRENCY=1 runs steps one at a time in declared order', () => {
  const slow = { name: 'slow first', cmd: 'sleep 0.5; echo slow' };
  const fast = { name: 'fast second', cmd: 'echo fast' };
  const serial = run([slow, fast], { CHECK_CONCURRENCY: '1' });
  assert.ok(serial.out.indexOf('===== slow first') < serial.out.indexOf('===== fast second'));
  const parallel = run([slow, fast], { CHECK_CONCURRENCY: '2' });
  assert.ok(parallel.out.indexOf('===== fast second') < parallel.out.indexOf('===== slow first'));
  assert.match(serial.out, /concurrency 1\)/);
});
