import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFileImports, type WorkspaceRegime } from './extractImports';

// Fixture-tree unit tests (task 3.1): each scenario is a tiny real file tree
// under __fixtures__/extract-imports/<scenario>/ with its own mini
// tsconfig.json, so extraction runs the exact TypeScript resolution
// algorithm each regime uses live — not a hand-rolled resolver stand-in.
const FIXTURES_ROOT = fileURLToPath(new URL('./__fixtures__/extract-imports', import.meta.url));

function regime(name: string): WorkspaceRegime {
  return { name, dir: name, tsconfigPath: `${name}/tsconfig.json` };
}

const alwaysKnown = () => true;
const neverKnown = () => false;

describe('extractFileImports — resolution regimes', () => {
  it('resolves a plain relative import under Bundler resolution (server-like regime)', () => {
    const result = extractFileImports({
      files: ['bundler-basic/a.ts', 'bundler-basic/b.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('bundler-basic')],
    });
    expect(result.unmappedImportErrors).toEqual([]);
    expect(result.imports).toEqual([
      {
        fromFile: 'bundler-basic/a.ts',
        toFile: 'bundler-basic/b.ts',
        kind: 'static',
        isTypeOnly: false,
        line: 1,
      },
    ]);
  });

  it('resolves a `paths` alias import (web-like regime)', () => {
    const result = extractFileImports({
      files: ['paths-alias/entry.ts', 'paths-alias/foo/thing.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('paths-alias')],
    });
    expect(result.unmappedImportErrors).toEqual([]);
    expect(result.imports).toEqual([
      {
        fromFile: 'paths-alias/entry.ts',
        toFile: 'paths-alias/foo/thing.ts',
        kind: 'static',
        isTypeOnly: false,
        line: 1,
      },
    ]);
  });

  it('resolves a NodeNext `.js`-specifier import to its `.ts` file (companion-like regime)', () => {
    const result = extractFileImports({
      files: ['nodenext/entry.ts', 'nodenext/thing.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('nodenext')],
    });
    expect(result.unmappedImportErrors).toEqual([]);
    expect(result.imports).toEqual([
      {
        fromFile: 'nodenext/entry.ts',
        toFile: 'nodenext/thing.ts',
        kind: 'static',
        isTypeOnly: false,
        line: 1,
      },
    ]);
  });
});

describe('extractFileImports — dynamic imports', () => {
  it('captures a literal dynamic import() with kind dynamic-literal', () => {
    const result = extractFileImports({
      files: ['dynamic/entry.ts', 'dynamic/lazy.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('dynamic')],
    });
    const dynamicImport = result.imports.find((imp) => imp.toFile === 'dynamic/lazy.ts');
    expect(dynamicImport).toMatchObject({
      fromFile: 'dynamic/entry.ts',
      toFile: 'dynamic/lazy.ts',
      kind: 'dynamic-literal',
    });
  });

  it('warns (not errors) on a non-literal dynamic import, naming the call site, and records no edge for it', () => {
    const result = extractFileImports({
      files: ['dynamic/entry.ts', 'dynamic/lazy.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('dynamic')],
    });
    expect(result.dynamicWarnings).toHaveLength(1);
    expect(result.dynamicWarnings[0].file).toBe('dynamic/entry.ts');
    expect(result.dynamicWarnings[0].line).toBeGreaterThan(0);
    expect(result.dynamicWarnings[0].column).toBeGreaterThan(0);
    // The non-literal call itself contributes no import edge — only the
    // literal `import('./lazy')` call above it does.
    expect(result.imports.filter((imp) => imp.kind === 'dynamic-literal')).toHaveLength(1);
  });

  it('ignores an unresolvable non-TypeScript specifier (CSS) — no edge, no warning, no error', () => {
    const result = extractFileImports({
      files: ['dynamic/entry.ts', 'dynamic/lazy.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('dynamic')],
    });
    expect(result.imports.some((imp) => imp.toFile.endsWith('styles.css'))).toBe(false);
    expect(result.unmappedImportErrors).toEqual([]);
  });
});

describe('extractFileImports — type-only imports', () => {
  it('captures `import type` as a static edge with isTypeOnly true (still a real structural dependency)', () => {
    const result = extractFileImports({
      files: ['type-only/entry.ts', 'type-only/types.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('type-only')],
    });
    expect(result.imports).toEqual([
      {
        fromFile: 'type-only/entry.ts',
        toFile: 'type-only/types.ts',
        kind: 'static',
        isTypeOnly: true,
        line: 1,
      },
    ]);
  });
});

describe('extractFileImports — unmapped in-repo targets', () => {
  it('fails naming both files when an import resolves to an unmapped, unexcluded in-repo file', () => {
    const result = extractFileImports({
      files: ['unmapped/entry.ts', 'unmapped/orphan.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: (file) => file !== 'unmapped/orphan.ts',
      regimes: [regime('unmapped')],
    });
    expect(result.imports).toEqual([]);
    expect(result.unmappedImportErrors).toEqual([
      { fromFile: 'unmapped/entry.ts', toFile: 'unmapped/orphan.ts' },
    ]);
  });

  it('does not fail when the target is known (mapped or excluded)', () => {
    const result = extractFileImports({
      files: ['unmapped/entry.ts', 'unmapped/orphan.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('unmapped')],
    });
    expect(result.unmappedImportErrors).toEqual([]);
    expect(result.imports).toHaveLength(1);
  });

  it('an unknown target with isKnown always false is still reported (defensive check)', () => {
    const result = extractFileImports({
      files: ['unmapped/entry.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: neverKnown,
      regimes: [regime('unmapped')],
    });
    expect(result.unmappedImportErrors).toEqual([
      { fromFile: 'unmapped/entry.ts', toFile: 'unmapped/orphan.ts' },
    ]);
  });
});

describe('extractFileImports — determinism', () => {
  it('produces sorted, repeatable output across two runs', () => {
    const params = {
      files: ['bundler-basic/a.ts', 'bundler-basic/b.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('bundler-basic')],
    };
    const first = extractFileImports(params);
    const second = extractFileImports(params);
    expect(first).toEqual(second);
  });

  it('files outside every declared regime are skipped, not errored', () => {
    const result = extractFileImports({
      files: ['no-such-regime/entry.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: alwaysKnown,
      regimes: [regime('bundler-basic')],
    });
    expect(result.imports).toEqual([]);
    expect(result.unmappedImportErrors).toEqual([]);
  });
});
