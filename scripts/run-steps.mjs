#!/usr/bin/env node
// Runs a suite of shell steps concurrently and reports them as labelled blocks.
//   node scripts/run-steps.mjs test|typecheck     # a suite defined in SUITES below
//   node scripts/run-steps.mjs --steps steps.json # [{ "name": "...", "cmd": "..." }, ...]
// Each step's output is printed as one block when the step ends (never interleaved), then a
// summary lists every step in declared order with its duration and pass/fail. Exit code is 0 only
// when every step passed. CHECK_CONCURRENCY sets how many steps run at once (default: a quarter
// of the machine's cores, at least 1); 1 runs them one at a time in declared order.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CORE_DIVISOR = 4;
// A failed step's excerpt: its failure lines (vitest, node --test, unittest, tsc), then its last
// lines without npm's trailer. scripts/lib/check_change.py COMMAND_TAIL_LINES must fit a few.
const EXCERPT_MATCHES = 12;
const EXCERPT_TAIL = 8;
const FAILURE_LINE = /^\s*(FAIL|ERROR|not ok)\b|^\s*[×✗]\s|\b\w*Error\b|\berror TS\d+|timed out/;
const NPM_TRAILER = /^npm (error|ERR!)/;
const ANSI = /\x1b\[[0-9;]*m/g;
const ws = (name) => `npm run test -w ${name}`;
const WORKSPACES = [
  'server',
  'web',
  'companion',
  'media-worker',
  'packages/domain',
  'packages/contract',
  'packages/ports',
  'packages/storage',
  'packages/catalog',
  'packages/session-core',
  'packages/transcription',
  'packages/media-import',
  'packages/log-import',
  'packages/ai-runtime',
];
const PACKAGES = WORKSPACES.filter((w) => w.startsWith('packages/'));

export const SUITES = {
  test: [
    {
      name: 'python scripts/lib',
      cmd: "python3 -m unittest discover -s scripts/lib -p 'test_*.py'",
    },
    {
      name: 'node scripts',
      cmd: 'node --test docker/scripts/compose-run.test.mjs docker/scripts/supabase-keys.test.mjs docker/scripts/verify-node-modules.test.mjs scripts/check-docs-site.test.mjs scripts/tsc-version.test.mjs scripts/run-steps.test.mjs',
    },
    ...WORKSPACES.map((w) => ({ name: `test ${w}`, cmd: ws(w) })),
  ],
  typecheck: [
    { name: 'typecheck server', cmd: 'npm run typecheck -w server' },
    { name: 'typecheck web', cmd: 'npm run typecheck -w web' },
    { name: 'typecheck web (node)', cmd: 'tsc --noEmit -p web/tsconfig.node.json' },
    { name: 'typecheck companion', cmd: 'npm run typecheck -w companion' },
    { name: 'typecheck media-worker', cmd: 'npm run typecheck -w media-worker' },
    ...PACKAGES.map((p) => ({ name: `typecheck ${p}`, cmd: `tsc --noEmit -p ${p}` })),
  ],
};

export function concurrencyFrom(env = process.env) {
  const n = Number.parseInt(env.CHECK_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : defaultConcurrency();
}

/** A quarter of the cores, never below 1: each step already starts its own workers. */
export function defaultConcurrency(cores = availableParallelism()) {
  return Math.max(1, Math.floor(cores / DEFAULT_CORE_DIVISOR));
}

function runOne(step, cwd) {
  return new Promise((done) => {
    const started = Date.now();
    let out = '';
    const child = spawn(step.cmd, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => {
      out += b;
    });
    child.stderr.on('data', (b) => {
      out += b;
    });
    const finish = (code, extra = '') =>
      done({ step, code, out: out + extra, ms: Date.now() - started });
    child.on('error', (e) => finish(127, String(e)));
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

/** Runs the steps with at most `concurrency` at once; resolves true when every step passed. */
export async function runSteps(steps, { concurrency, cwd = process.cwd(), log = console.log }) {
  const results = new Array(steps.length);
  let next = 0;
  const worker = async () => {
    while (next < steps.length) {
      const i = next++;
      const r = await runOne(steps[i], cwd);
      results[i] = r;
      const status = r.code === 0 ? 'ok' : `FAILED (exit ${r.code})`;
      const body = r.out.endsWith('\n') || r.out === '' ? r.out : `${r.out}\n`;
      log(`===== ${r.step.name}: ${status} =====\n${body}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, steps.length) }, worker));
  const width = Math.max(...results.map((r) => r.step.name.length));
  const lines = results.map(
    (r) =>
      `${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.step.name.padEnd(width)}  ${(r.ms / 1000).toFixed(1)}s`,
  );
  const failed = results.filter((r) => r.code !== 0);
  if (failed.length) {
    // Repeated just before the summary so a tail of the log still names the failing tests.
    const excerpts = failed.map((r) => failureExcerpt(r.step.name, r.out));
    log(`===== failed step output =====\n${excerpts.join('\n')}\n`);
  }
  log(
    `===== summary (concurrency ${concurrency}) =====\n${lines.join('\n')}\n${
      failed.length
        ? `${failed.length} of ${results.length} steps failed: ${failed.map((r) => r.step.name).join(', ')}`
        : `all ${results.length} steps passed`
    }`,
  );
  return failed.length === 0;
}

/** The lines of a failed step's output that name what failed, then its last lines. */
export function failureExcerpt(name, out) {
  const lines = out
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && !NPM_TRAILER.test(l));
  const matches = [...new Set(lines.filter((l) => FAILURE_LINE.test(l)))];
  const shown = matches.slice(0, EXCERPT_MATCHES);
  const parts = [];
  if (shown.length) parts.push(`--- ${name} (failure lines) ---`, ...shown);
  parts.push(`--- ${name} (last lines) ---`, ...lines.slice(-EXCERPT_TAIL));
  return parts.join('\n');
}

async function main(argv) {
  let steps;
  if (argv[0] === '--steps') steps = JSON.parse(readFileSync(argv[1], 'utf8'));
  else steps = SUITES[argv[0]];
  if (!Array.isArray(steps)) {
    console.error(`usage: run-steps.mjs <${Object.keys(SUITES).join('|')}> | --steps <file.json>`);
    return 2;
  }
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return (await runSteps(steps, { concurrency: concurrencyFrom(), cwd })) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
