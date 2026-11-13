import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./run-steps.mjs', import.meta.url));

function run(steps, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'run-steps-'));
  try {
    return runIn(dir, steps, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir, steps, env) {
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

// Each step waits for the other's marker file: only steps that overlap can both finish.
const rendezvous = (mine, other) =>
  `touch ${mine}; for i in $(seq 100); do [ -e ${other} ] && exit 0; sleep 0.1; done; exit 1`;

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'run-steps-rv-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('steps run concurrently by default', () => {
  withTmp((tmp) => {
    const r = run([
      { name: 's1', cmd: rendezvous(`${tmp}/a`, `${tmp}/b`) },
      { name: 's2', cmd: rendezvous(`${tmp}/b`, `${tmp}/a`) },
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /all 2 steps passed/);
  });
});

test('CHECK_CONCURRENCY=1 runs steps one at a time in declared order', () => {
  withTmp((tmp) => {
    // `second` fails unless `first` has already finished; `first` finishes only after `second` starts
    // when they overlap, so the output order differs between the two modes.
    const first = { name: 'first', cmd: `echo first; touch ${tmp}/first-done` };
    const second = { name: 'second', cmd: `[ -e ${tmp}/first-done ] && echo second` };
    const serial = run([first, second], { CHECK_CONCURRENCY: '1' });
    assert.equal(serial.code, 0, serial.out);
    assert.ok(serial.out.indexOf('===== first') < serial.out.indexOf('===== second'));
    assert.match(serial.out, /concurrency 1\)/);
  });
  withTmp((tmp) => {
    // `slow` cannot finish until `fast` has run, so with 2 slots `fast` reports first.
    const slow = { name: 'slow first', cmd: `for i in $(seq 100); do [ -e ${tmp}/fast ] && exit 0; sleep 0.1; done; exit 1` };
    const fast = { name: 'fast second', cmd: `touch ${tmp}/fast; echo fast` };
    const parallel = run([slow, fast], { CHECK_CONCURRENCY: '2' });
    assert.equal(parallel.code, 0, parallel.out);
    assert.ok(parallel.out.indexOf('===== fast second') < parallel.out.indexOf('===== slow first'));
  });
});
