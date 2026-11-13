// Tests for docker/verify-node-modules.mjs, the build-time assertion that a runtime image ships
// the dependency tree `npm ci` installed from the lockfile (job 019), and a static check that
// every runtime stage that copies a deps stage's tree copies all of it and runs the assertion.
// Run: node --test docker/scripts/verify-node-modules.test.mjs   (part of the root `npm test`)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyNodeModules } from '../verify-node-modules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'docker/verify-node-modules.mjs');

const UNDICI7 = { version: '7.30.2', resolved: 'https://r/undici-7.tgz', integrity: 'sha512-seven' };
const UNDICI8 = { version: '8.12.4', resolved: 'https://r/undici-8.tgz', integrity: 'sha512-eight' };

// The lockfile shape behind the incident: a workspace (packages/transcription) whose undici is
// nested in its own node_modules, while the hoisted copy is older.
function lockfile() {
  return {
    name: 'root',
    lockfileVersion: 3,
    packages: {
      '': { name: 'root', workspaces: ['packages/*'] },
      'node_modules/undici': { ...UNDICI7 },
      'node_modules/@x/transcription': { resolved: 'packages/transcription', link: true },
      'node_modules/devtool': { version: '1.0.0', integrity: 'sha512-dev', dev: true },
      'packages/transcription': { name: '@x/transcription', version: '0.0.0' },
      'packages/transcription/node_modules/undici': { ...UNDICI8 },
      'packages/transcription/node_modules/devonly': { version: '2.0.0', integrity: 'sha512-d2', dev: true },
    },
  };
}

let dir;
function write(path, value) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
}
function pkg(path, version) {
  write(join(path, 'package.json'), { name: path.split('/').pop(), version });
}

/** An image tree as `npm ci --omit=dev` installs it, with only the lockfile's prod entries. */
function installTree() {
  const lock = lockfile();
  write('package-lock.json', lock);
  const hidden = { name: 'root', lockfileVersion: 3, requires: true, packages: {} };
  for (const [k, v] of Object.entries(lock.packages)) if (k !== '' && !v.dev) hidden.packages[k] = v;
  write('app/node_modules/.package-lock.json', hidden);
  pkg('app/node_modules/undici', '7.30.2');
  pkg('app/packages/transcription', '0.0.0');
  pkg('app/packages/transcription/node_modules/undici', '8.12.4');
  mkdirSync(join(dir, 'app/node_modules/@x'), { recursive: true });
  symlinkSync('../../packages/transcription', join(dir, 'app/node_modules/@x/transcription'));
}
const verify = (omit = ['dev']) =>
  verifyNodeModules({ root: join(dir, 'app'), lockfile: join(dir, 'package-lock.json'), omit });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-nm-'));
  installTree();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verifyNodeModules', () => {
  it('passes on the full npm ci tree, nested workspace node_modules included', () => {
    assert.deepEqual(verify(), []);
  });

  it('fails when a workspace-nested package was not copied into the image (the incident)', () => {
    rmSync(join(dir, 'app/packages/transcription/node_modules'), { recursive: true });
    assert.deepEqual(verify(), ['packages/transcription/node_modules/undici: missing from the image']);
  });

  it('fails when a copied package has another version than npm ci installed', () => {
    pkg('app/packages/transcription/node_modules/undici', '7.30.2');
    assert.match(verify().join('\n'), /undici: image has 7\.30\.2, npm ci installed 8\.12\.4/);
  });

  it('fails when the install differs from the committed lockfile', () => {
    const lock = lockfile();
    lock.packages['packages/transcription/node_modules/undici'] = { ...UNDICI8, version: '8.13.0' };
    write('package-lock.json', lock);
    assert.match(verify().join('\n'), /installed 8\.12\.4 differs from the lockfile's 8\.13\.0/);
  });

  it('fails when the install carries a package the lockfile does not name', () => {
    const hidden = JSON.parse(readFileSync(join(dir, 'app/node_modules/.package-lock.json'), 'utf8'));
    hidden.packages['node_modules/stray'] = { version: '1.0.0' };
    write('app/node_modules/.package-lock.json', hidden);
    pkg('app/node_modules/stray', '1.0.0');
    assert.deepEqual(verify(), ['node_modules/stray: installed but absent from the lockfile']);
  });

  it('fails when the lockfile names a prod package nested in a shipped workspace that npm ci lacks', () => {
    const hidden = JSON.parse(readFileSync(join(dir, 'app/node_modules/.package-lock.json'), 'utf8'));
    delete hidden.packages['packages/transcription/node_modules/undici'];
    write('app/node_modules/.package-lock.json', hidden);
    assert.deepEqual(verify(), [
      'packages/transcription/node_modules/undici: in the lockfile for workspace packages/transcription but not installed',
    ]);
  });

  it('honours --omit: a dev-only nested entry is required only without --omit=dev', () => {
    assert.deepEqual(verify(['dev']), []);
    assert.deepEqual(verify([]), [
      'packages/transcription/node_modules/devonly: in the lockfile for workspace packages/transcription but not installed',
    ]);
  });

  it('fails when a workspace link is missing', () => {
    rmSync(join(dir, 'app/node_modules/@x/transcription'));
    assert.match(verify().join('\n'), /node_modules\/@x\/transcription: workspace link missing/);
  });

  it('fails without a hidden lockfile', () => {
    rmSync(join(dir, 'app/node_modules/.package-lock.json'));
    assert.match(verify().join('\n'), /\.package-lock\.json is missing/);
  });

  it('as a CLI, exits 1 and names the missing package, exits 0 on a full tree', () => {
    const args = [SCRIPT, '--root', join(dir, 'app'), '--lockfile', join(dir, 'package-lock.json'), '--omit', 'dev'];
    const ok = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /matches the lockfile's npm ci tree/);
    rmSync(join(dir, 'app/packages/transcription/node_modules'), { recursive: true });
    const bad = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /packages\/transcription\/node_modules\/undici: missing from the image/);
  });
});

// Each runtime stage that ships a deps stage's tree: [dockerfile, stage, deps stage, npm ci omit].
const RUNTIME_STAGES = [
  ['docker/Dockerfile', 'api', 'api-deps', ' --omit dev'],
  ['docker/Dockerfile', 'dev', 'dev-deps', ''],
  ['docker/media-worker.Dockerfile', 'media-worker', 'worker-deps', ' --omit dev,peer'],
];

function stages(file) {
  const text = readFileSync(join(ROOT, file), 'utf8').replace(/\\\n\s*/g, ' ');
  const out = {};
  let name = null;
  for (const line of text.split('\n')) {
    const m = /^FROM\s+\S+\s+AS\s+(\S+)/i.exec(line);
    if (m) {
      name = m[1];
      out[name] = [];
    } else if (name && line.trim() && !line.startsWith('#')) out[name].push(line.trim());
  }
  return out;
}

describe('Dockerfile runtime stages ship the whole npm ci tree', () => {
  for (const [file, stage, deps, omit] of RUNTIME_STAGES) {
    it(`${file} ${stage}: stages every node_modules in ${deps}, copies /deps/, then verifies`, () => {
      const s = stages(file);
      assert.ok(
        s[deps].some((l) => /^RUN mkdir -p \/deps .*find \. -type d -name node_modules -prune/.test(l)),
        `${deps} stages node_modules under /deps`,
      );
      const lines = s[stage];
      const copies = lines.filter((l) => l.startsWith('COPY') && l.includes(`--from=${deps}`));
      assert.deepEqual(copies.map((l) => / \/deps\/ \.\/$/.test(l)), [true], `${stage} copies ${deps} /deps/ only`);
      const copyAt = lines.indexOf(copies[0]);
      const verifyAt = lines.findIndex((l) => l.includes('verify-node-modules.mjs --root /app'));
      assert.ok(verifyAt > copyAt, `${stage} runs the verify step after copying`);
      const lastCopy = lines.findLastIndex((l) => l.startsWith('COPY'));
      assert.ok(verifyAt > lastCopy, `${stage} verifies after its last COPY`);
      assert.ok(lines[verifyAt].endsWith(`--lockfile /tmp/verify/package-lock.json${omit}`), `${stage} omit flags`);
      assert.ok(/--mount=type=bind,source=docker\/verify-node-modules\.mjs/.test(lines[verifyAt]), 'bind-mounted');
    });
  }
});
