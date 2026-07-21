/// <reference types="node" />
// This is the one file in `web/src` that needs Node's filesystem APIs
// (walking server/web/companion/e2e from disk, task 4.5's repo-wide grep
// guard) — the web workspace otherwise targets the browser only, so
// `@types/node` isn't an ambient dependency here; this directive scopes the
// Node global-module types to this file alone rather than widening
// web/tsconfig.json's `types` for the whole workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// --- Repo-wide "no agent-authored markup" guard (ai-v2-dashboards, task 4.5;
// spec "No agent-authored markup is ever rendered") ---
//
// Standing regression guard, NO exceptions: no file under server/, web/,
// companion/, or e2e/ (per this task's explicit scope) may contain an actual
// `dangerouslySetInnerHTML` USAGE — a JSX attribute or object-literal key,
// i.e. `dangerouslySetInnerHTML` followed by `=`/`:` and an opening `{`.
//
// This is deliberately NOT a bare substring grep: this very codebase already
// carries legitimate PROSE mentions of the string in comments (e.g.
// AiV2Design.tsx's module header: "never `dangerouslySetInnerHTML`, never
// interpolated into...") documenting its absence — a naive substring match
// would false-positive on exactly the comments that record this invariant.
// The `[:=]\s*\{` requirement matches real usage shapes (the JSX-attribute
// and object-literal-key forms) and does not match prose, which never has an
// operator+brace immediately following the identifier.
//
// NOTE ON THIS FILE'S OWN FIXTURES: several strings below are deliberately
// built via concatenation/`ATTR` rather than typed as the literal
// contiguous identifier+operator+brace run this file's own scan looks for —
// not to evade the invariant (this file renders nothing; these are inert string
// values used only to unit-test the detector, exactly like
// widgetRegistry.test.tsx's literal XSS-payload test string), but because
// this repo-wide scan includes THIS file (it lives in web/src, in scope) and
// a literal match would make the guard fail on its own test fixtures. Same
// non-exception the rest of the codebase already applies to comments
// documenting the absence of real usage.

const SCAN_DIR_NAMES = ['server', 'web', 'companion', 'e2e'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.next',
  '.data',
  '.data-oauth',
  'test-results',
  'playwright-report',
  '.playwright-mcp',
]);

/** The actual detection predicate — exported implicitly via the scan
 * function below, but exercised directly (mutation-checked) against
 * representative lines in the first describe block. */
const USAGE_PATTERN = /dangerouslySetInnerHTML\s*[:=]\s*\{/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scanForDangerousInnerHtmlUsage(root: string, dirNames: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const dirName of dirNames) {
    const files = walk(path.join(root, dirName));
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (USAGE_PATTERN.test(line)) {
          hits.push({ file: path.relative(root, file), line: idx + 1, text: line.trim() });
        }
      });
    }
  }
  return hits;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// this file: web/src/noAgentAuthoredMarkup.repo.test.ts -> repo root is two
// levels up (web/src -> web -> repo root).
const REPO_ROOT = path.resolve(here, '..', '..');

// Built via concatenation, not a literal contiguous run — see the file
// header note on why this file's own fixtures avoid tripping the scan below.
const ATTR = ['dangerously', 'SetInnerHTML'].join('');

describe('detection predicate (mutation check — proves the guard actually fires)', () => {
  it('matches real JSX-attribute usage', () => {
    expect(USAGE_PATTERN.test(`<div ${ATTR}={{ __html: title }} />`)).toBe(true);
  });

  it('matches real object-literal usage', () => {
    expect(USAGE_PATTERN.test(`const props = { ${ATTR}: { __html: x } };`)).toBe(true);
  });

  it('does NOT match a prose comment documenting the invariant (the actual line in AiV2Design.tsx)', () => {
    expect(
      USAGE_PATTERN.test('// children — never `dangerouslySetInnerHTML`, never interpolated into'),
    ).toBe(false);
  });

  it('does NOT match doc prose without a following operator+brace (the actual lines in design.md/proposal.md)', () => {
    expect(USAGE_PATTERN.test('there is NO `dangerouslySetInnerHTML` anywhere')).toBe(false);
    expect(USAGE_PATTERN.test('no `dangerouslySetInnerHTML` path in')).toBe(false);
  });
});

describe('scanForDangerousInnerHtmlUsage — end-to-end mutation check on a real filesystem walk', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('DOES find an introduced usage in a fixture tree shaped like the real scan (proves the guard is not vacuous)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv2-repo-guard-mutation-'));
    const webSrc = path.join(tmpRoot, 'web', 'src');
    fs.mkdirSync(webSrc, { recursive: true });
    fs.writeFileSync(
      path.join(webSrc, 'Evil.tsx'),
      `export function Evil({ title }) {\n  return <div ${ATTR}={{ __html: title }} />;\n}\n`,
    );
    const hits = scanForDangerousInnerHtmlUsage(tmpRoot, ['web']);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe(path.join('web', 'src', 'Evil.tsx'));
  });

  it('finds nothing in an all-comments fixture tree (proves the guard does not just always-fire)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv2-repo-guard-mutation-clean-'));
    const webSrc = path.join(tmpRoot, 'web', 'src');
    fs.mkdirSync(webSrc, { recursive: true });
    fs.writeFileSync(
      path.join(webSrc, 'Clean.tsx'),
      '// never dangerouslySetInnerHTML, never interpolated\nexport function Clean() { return null; }\n',
    );
    expect(scanForDangerousInnerHtmlUsage(tmpRoot, ['web'])).toEqual([]);
  });

  it('skips excluded directories (node_modules, dist) even when they contain a real usage', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv2-repo-guard-mutation-excl-'));
    const nodeModules = path.join(tmpRoot, 'web', 'node_modules', 'somepkg');
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(
      path.join(nodeModules, 'index.js'),
      `module.exports = { ${ATTR}: { __html: "x" } };\n`,
    );
    expect(scanForDangerousInnerHtmlUsage(tmpRoot, ['web'])).toEqual([]);
  });
});

describe('repo-wide guard — no exceptions (spec: "No agent-authored markup is ever rendered")', () => {
  it('server/ + web/ + companion/ + e2e/ contain ZERO dangerouslySetInnerHTML usages', () => {
    const hits = scanForDangerousInnerHtmlUsage(REPO_ROOT, SCAN_DIR_NAMES);
    expect(hits).toEqual([]);
  });
});
