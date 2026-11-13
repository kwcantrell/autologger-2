// Guard: every `tsc` the repo runs is TypeScript 7 from the `typescript` package (job 008).
// Run: node --test scripts/tsc-version.test.mjs   (part of the root `npm test`)
//
// Why `@typescript/typescript6` is pinned to exactly 6.0.1 in server, web and
// packages/ai-runtime: the guard tests that need the compiler API import it, because the
// TypeScript 7 `typescript` package exports no compiler API. Versions 6.0.2 and later depend on
// `"@typescript/old": "npm:typescript@^6"`. npm hoists that alias to the root, and its `tsc` bin
// takes over `node_modules/.bin/tsc`, so every typecheck silently runs TypeScript 6 and still
// passes. Versions 6.0.0 and 6.0.1 depend on `typescript@^6` under its real name, which npm nests
// because it conflicts with the root `typescript@7`. Dependabot's grouped minor/patch PR would
// move the pin; this test is what fails that PR. Lift the pin only when this test still passes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPESCRIPT_DIR = join(ROOT, 'node_modules/typescript');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The `tsc` that `npm run` finds from `dir`: npm puts each ancestor's node_modules/.bin on PATH,
// nearest first, up to the workspace root.
function resolveTsc(dir) {
  for (let d = dir; ; d = dirname(d)) {
    const bin = join(d, 'node_modules/.bin/tsc');
    if (existsSync(bin)) return realpathSync(bin);
    if (d === ROOT) return null;
  }
}

// Workspaces whose own scripts call `tsc`. The root `typecheck` also runs the root bin.
function workspacesRunningTsc() {
  const root = readJson(join(ROOT, 'package.json'));
  const dirs = [];
  for (const pattern of root.workspaces) {
    const names = pattern.endsWith('/*')
      ? readdirNames(join(ROOT, pattern.slice(0, -2))).map((n) => `${pattern.slice(0, -2)}/${n}`)
      : [pattern];
    for (const ws of names) {
      const pkgPath = join(ROOT, ws, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const scripts = Object.values(readJson(pkgPath).scripts ?? {});
      if (scripts.some((s) => /(^|[\s&;|])tsc(\s|$)/.test(s))) dirs.push(ws);
    }
  }
  return dirs;
}

function readdirNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('tsc resolves to TypeScript 7', () => {
  it('the root node_modules/typescript is the `typescript` package at 7.x', () => {
    const pkg = readJson(join(TYPESCRIPT_DIR, 'package.json'));
    assert.equal(pkg.name, 'typescript');
    assert.match(pkg.version, /^7\./);
  });

  it('the root node_modules/.bin/tsc belongs to node_modules/typescript and prints 7.x', () => {
    const tsc = resolveTsc(ROOT);
    assert.ok(tsc, 'no node_modules/.bin/tsc at the root');
    const typescriptDir = realpathSync(TYPESCRIPT_DIR);
    assert.ok(
      tsc.startsWith(typescriptDir + '/'),
      `root tsc resolves to ${tsc}, not inside ${typescriptDir}`,
    );
    const run = spawnSync(tsc, ['--version'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Version 7\./);
  });

  it('every workspace that runs tsc resolves to the root TypeScript 7 binary', () => {
    const rootTsc = resolveTsc(ROOT);
    const workspaces = workspacesRunningTsc();
    assert.ok(workspaces.length > 0, 'found no workspace that runs tsc');
    const wrong = workspaces
      .map((ws) => ({ ws, tsc: resolveTsc(join(ROOT, ws)) }))
      .filter(({ tsc }) => tsc !== rootTsc);
    assert.deepEqual(wrong, []);
  });
});
