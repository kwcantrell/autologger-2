import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { concurrencyFrom, defaultConcurrency, failureExcerpt } from './run-steps.mjs';

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
    // `slow` cannot finish until `fast` has run (plus a 1s margin for a loaded host), so with 2 slots
    // `fast` reports first.
    const slow = { name: 'slow first', cmd: `for i in $(seq 100); do [ -e ${tmp}/fast ] && sleep 1 && exit 0; sleep 0.1; done; exit 1` };
    const fast = { name: 'fast second', cmd: `touch ${tmp}/fast; echo fast` };
    const parallel = run([slow, fast], { CHECK_CONCURRENCY: '2' });
    assert.equal(parallel.code, 0, parallel.out);
    assert.ok(parallel.out.indexOf('===== fast second') < parallel.out.indexOf('===== slow first'));
  });
});

test('default concurrency is a quarter of the cores and never below 1', () => {
  assert.equal(defaultConcurrency(20), 5);
  assert.equal(defaultConcurrency(8), 2);
  assert.equal(defaultConcurrency(4), 1);
  assert.equal(defaultConcurrency(2), 1);
  assert.equal(defaultConcurrency(1), 1);
  assert.ok(defaultConcurrency() >= 1);
});

test('CHECK_CONCURRENCY overrides the default; junk falls back to it', () => {
  assert.equal(concurrencyFrom({ CHECK_CONCURRENCY: '7' }), 7);
  assert.equal(concurrencyFrom({ CHECK_CONCURRENCY: '1' }), 1);
  assert.equal(concurrencyFrom({ CHECK_CONCURRENCY: '0' }), defaultConcurrency());
  assert.equal(concurrencyFrom({ CHECK_CONCURRENCY: 'x' }), defaultConcurrency());
  assert.equal(concurrencyFrom({}), defaultConcurrency());
});

test('failed step output is repeated just before the summary', () => {
  const noisy = 'for i in $(seq 40); do echo noise$i; done; echo FAIL-test-name; exit 1';
  const r = run([{ name: 'broken', cmd: noisy }, echo('ok', 'fine')]);
  const tail = r.out.slice(r.out.indexOf('===== failed step output'));
  assert.match(tail, /--- broken \(last lines\) ---\n(.*\n)*FAIL-test-name\n/);
  assert.ok(tail.indexOf('FAIL-test-name') < tail.indexOf('===== summary'));
});

// What `npm run test -w server` prints when one vitest test times out (vitest 4, piped).
const VITEST_UNDER_NPM = `
> test
> vitest run

 RUN  v4.1.12 /repo/server

 ❯ src/upload.test.ts (3 tests | 1 failed) 5054ms
   × slow upload finishes 5003ms
 ✓ src/other.test.ts (12 tests) 40ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/upload.test.ts > uploads > slow upload finishes
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/upload.test.ts:4:1
      2| test('ok one', () => { expect(1).toBe(1); });
      3| test('ok two', () => { expect(2).toBe(2); });
      4| test('slow upload finishes', async () => {
       | ^
      5|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 14 passed (15)
   Start at  13:46:37
   Duration  5.2s (transform 14ms, setup 0ms, import 22ms, tests 5.1s, environment 0ms)

npm error Lifecycle script \`test\` failed with error:
npm error code 1
npm error path /repo/server
npm error workspace server
npm error location /repo/server
npm error command failed
npm error command sh -c vitest run
`;

test('the excerpt of a failing vitest-under-npm step names the test and its error', () => {
  const ex = failureExcerpt('test server', VITEST_UNDER_NPM);
  assert.match(ex, /FAIL {2}src\/upload\.test\.ts > uploads > slow upload finishes/);
  assert.match(ex, /Error: Test timed out in 5000ms\./);
  assert.match(ex, /× slow upload finishes/);
  assert.match(ex, /Tests {2}1 failed \| 14 passed/);
  assert.doesNotMatch(ex, /npm error/);
  assert.doesNotMatch(ex, /✓ src\/other/);
});

test('the runner prints the failing vitest test before its summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-steps-'));
  try {
    writeFileSync(join(dir, 'out.txt'), VITEST_UNDER_NPM);
    const r = runIn(dir, [{ name: 'test server', cmd: `cat ${join(dir, 'out.txt')}; exit 1` }], {});
    const tail = r.out.slice(r.out.indexOf('===== failed step output'));
    const name = tail.indexOf('FAIL  src/upload.test.ts > uploads > slow upload finishes');
    assert.ok(name > 0);
    assert.ok(name < tail.indexOf('===== summary'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the excerpt keeps only the last lines when nothing looks like a failure', () => {
  const out = `${Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')}\n`;
  const ex = failureExcerpt('quiet', out);
  const last = Array.from({ length: 8 }, (_, i) => `line${22 + i}`);
  assert.equal(ex, ['--- quiet (last lines) ---', ...last].join('\n'));
});

test('the excerpt strips colour codes', () => {
  const ex = failureExcerpt('c', '\x1b[31m FAIL \x1b[39m src/a.test.ts > b\n');
  assert.match(ex, /^ FAIL {2}src\/a\.test\.ts > b$/m);
});

test('logged errors from passing tests do not crowd out the failure summary', () => {
  const logs = Array.from({ length: 20 }, (_, i) => `stderr | logged Error number ${i}`).join('\n');
  const ex = failureExcerpt('test server', `${logs}\n${VITEST_UNDER_NPM}`);
  assert.match(ex, /FAIL {2}src\/upload\.test\.ts > uploads > slow upload finishes/);
  assert.match(ex, /Error: Test timed out in 5000ms\./);
});
