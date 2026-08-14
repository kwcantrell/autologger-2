/// <reference types="node" />
// Like noAgentAuthoredMarkup.repo.test.ts, this file needs Node's filesystem
// APIs (walking web/src from disk); the directive scopes the Node
// global-module types to this file alone rather than widening
// web/tsconfig.json's `types` for the whole workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// --- Query-key factory grep-clean guard (code-health-tail task 4.6, finding
// 2.8) ---
//
// `sessionStatusKeys` (web/src/api/hooks/useSessionStatus.ts),
// `audioSegmentsKeys` (web/src/api/hooks/useAudio.ts) and `showKeys`
// (web/src/api/hooks/useShows.ts) are the single owners of the
// session-status, audio-segments, studio-shows and show React Query key
// literals (unquoted here on purpose — this file is in its own scan scope).
// Every other consumer — hooks, components, tests — must build keys through
// the factories, so the key shapes cannot drift apart the way finding 2.8's
// nine scattered copies could. This guard scans all of web/src and fails on
// any QUOTED occurrence of either literal outside its factory module.
//
// Deliberately quoted-forms-only (`'…'`, `"…"`, backtick): prose comments
// naming the domain (e.g. feedRowSeek.transition.test.tsx's "Flips the
// session-status query's cached data") are fine and must not false-positive —
// only a string literal can reconstitute a bare key.
//
// NOTE ON THIS FILE'S OWN FIXTURES: the literals below are built via
// concatenation (`SESSION_STATUS`, `AUDIO_SEGMENTS`, `STUDIO_SHOWS`, `SHOW`)
// so this file — itself in scope — never contains the quoted contiguous run
// its own scan looks for.
//
// NOTE ON THE BARE show ROOT: it is an ordinary English word, so unlike the
// hyphenated literals it can plausibly collide with an unrelated string (a
// `describe` title, a discriminant value). That is deliberate and the tradeoff
// is accepted: the root IS the key prefix `HomeSettingsModal` invalidates by,
// so a stray copy is exactly the drift this guard exists to catch. A genuine
// non-key collision should be renamed, not exempted — an exemption list would
// reopen the hole.

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

// Built via concatenation — see the file header note.
const SESSION_STATUS = ['session', 'status'].join('-');
const AUDIO_SEGMENTS = ['audio', 'segments'].join('-');
const STUDIO_SHOWS = ['studio', 'shows'].join('-');
const SHOW = ['sh', 'ow'].join('');

/** file (relative to the scan root, posix separators) allowed to hold each literal. */
const FACTORY_MODULE: Record<string, string> = {
  [SESSION_STATUS]: 'api/hooks/useSessionStatus.ts',
  [AUDIO_SEGMENTS]: 'api/hooks/useAudio.ts',
  [STUDIO_SHOWS]: 'api/hooks/useShows.ts',
  [SHOW]: 'api/hooks/useShows.ts',
};

function quotedPattern(literal: string): RegExp {
  return new RegExp(`['"\`]${literal}['"\`]`);
}

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
  literal: string;
  file: string;
  line: number;
  text: string;
}

/** Scans `root` for quoted key literals outside their factory modules. */
function scanForBareKeyLiterals(root: string): Hit[] {
  const hits: Hit[] = [];
  const patterns = Object.keys(FACTORY_MODULE).map(
    (literal) => [literal, quotedPattern(literal)] as const,
  );
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [literal, pattern] of patterns) {
      if (rel === FACTORY_MODULE[literal]) continue;
      lines.forEach((line, idx) => {
        if (pattern.test(line)) {
          hits.push({ literal, file: rel, line: idx + 1, text: line.trim() });
        }
      });
    }
  }
  return hits;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// this file: web/src/queryKeyFactories.repo.test.ts -> the scan root is web/src itself.
const WEB_SRC = here;

describe('detection predicate (mutation check — proves the guard actually fires)', () => {
  it('matches every quote style around a bare key literal', () => {
    expect(quotedPattern(SESSION_STATUS).test(`queryKey: ['${SESSION_STATUS}', sessionId]`)).toBe(
      true,
    );
    expect(quotedPattern(SESSION_STATUS).test(`invalidateQueries(["${SESSION_STATUS}"])`)).toBe(
      true,
    );
    expect(quotedPattern(AUDIO_SEGMENTS).test(`\`${AUDIO_SEGMENTS}\``)).toBe(true);
  });

  it('does NOT match unquoted prose naming the domain', () => {
    expect(
      quotedPattern(SESSION_STATUS).test(`/** Flips the ${SESSION_STATUS} query's cached data */`),
    ).toBe(false);
    expect(quotedPattern(AUDIO_SEGMENTS).test(`// re-anchor the ${AUDIO_SEGMENTS} cache`)).toBe(
      false,
    );
  });
});

describe('scanForBareKeyLiterals — end-to-end mutation check on a real filesystem walk', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('DOES find a reintroduced bare literal outside the factory module (proves the guard is not vacuous)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'query-key-guard-mutation-'));
    fs.mkdirSync(path.join(tmpRoot, 'api', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'stray.ts'),
      `export const key = ['${SESSION_STATUS}', 'abc'];\n`,
    );
    const hits = scanForBareKeyLiterals(tmpRoot);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ literal: SESSION_STATUS, file: 'stray.ts', line: 1 });
  });

  it('allows the literal inside its own factory module, and prose elsewhere (proves the guard does not just always-fire)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'query-key-guard-mutation-clean-'));
    fs.mkdirSync(path.join(tmpRoot, 'api', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'api', 'hooks', 'useSessionStatus.ts'),
      `export const sessionStatusKeys = { all: () => ['${SESSION_STATUS}'] as const };\n`,
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'api', 'hooks', 'useAudio.ts'),
      `export const audioSegmentsKeys = { bySession: (id: string) => ['${AUDIO_SEGMENTS}', id] as const };\n`,
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'prose.ts'),
      `// the ${SESSION_STATUS} and ${AUDIO_SEGMENTS} caches are factory-keyed\n`,
    );
    expect(scanForBareKeyLiterals(tmpRoot)).toEqual([]);
  });
});

describe('web/src grep-clean guard — factories are the only key-literal owners (finding 2.8)', () => {
  it('contains ZERO bare session-status/audio-segments/studio-shows/show key literals outside the factory modules', () => {
    expect(scanForBareKeyLiterals(WEB_SRC)).toEqual([]);
  });
});
