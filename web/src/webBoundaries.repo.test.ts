/// <reference types="node" />
// Like queryKeyFactories.repo.test.ts and windowCoordinationBan.repo.test.ts,
// this file needs Node's filesystem APIs (walking web/src from disk); the
// directive scopes the Node global-module types to this file alone rather
// than widening web/tsconfig.json's `types` for the whole workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

// --- Import-direction boundary guard (web-coordination-seam, task 5.3; gate
// ruling E5) ---
//
// Spec "The web app's internal import direction is mechanically enforced":
// production VALUE imports under web/src SHALL flow only downward through
// pages -> api -> shared (api and shared SHALL NOT value-import from pages).
// This is implemented as a general one-way CHAIN rule (pages=0, api=1,
// shared=2; a value edge whose target rank is LOWER than its source rank is
// a violation) rather than a pages-specific special case: that also catches
// a `shared -> api` value edge, which design D0/E5 measured at zero today
// but which "flow only downward through pages -> api -> shared" already
// forbids in general, and it costs nothing extra to check for.
//
// TYPE-ONLY UPWARD EDGES ARE PERMITTED for the layering rule and are never
// flagged (spec: "Forbidding them would force import rewrites this rule was
// explicitly adopted to avoid"). Three exist today --
// shared/utils/{recording,timecode,audioClips}.ts each `import type` from
// api/types -- and they erase at compile time, so the runtime/bundle graph
// stays acyclic while the type graph does not.
//
// Spec "The two entry bundles stay independent": pages/admin-users SHALL NOT
// import from pages/index, IN EITHER DIRECTION. Unlike the layering rule,
// this carve-out has no value/type qualifier in the spec text, so it flags
// ANY import (value or type-only) crossing that specific boundary.
//
// SCOPE: production files only (any filename containing ".test." is
// excluded, matching the project's *.test.ts / *.test.tsx / *.int.test.ts
// convention). Test files legitimately cross the boundary --
// api/types.conformance.test.ts imports a type from
// pages/index/batchImport/logImportClient, verified by reading the file --
// and must not be flagged.

// `.mts`/`.cts` added during the phase-5 fix wave for consistency with
// `windowCoordinationBan.repo.test.ts`'s Finding-2 fix (this repo has widened
// exactly this extension set once before, per `packageBoundaries.repo.test.ts`
// design D1 check 4) -- not itself one of the phase-5 review's named findings
// against this file, but the identical gap in the identical shape of walker.

// PHASE-5 FIX RE-REVIEW, FINDING N12 (this rebuild). Fix wave 1 rebuilt
// `windowCoordinationBan.repo.test.ts` on `ts.createSourceFile` -- this
// repo's own standing recommendation once a scanner has been patched
// repeatedly -- but left THIS file's import extraction on a per-LINE regex
// scan with a `stripCommentLines` helper that blanks any line whose trimmed
// text starts with `//`, `*`, or `/*`. A leading SAME-LINE block comment
// immediately before a real import --
// `/* eslint-disable-next-line */ import { X } from '../index/Y';` -- is an
// ordinary lint-pragma shape, and `isCommentLine` blanked the WHOLE line
// (comment prefix AND the live import statement after it), erasing the
// import before `IMPORT_RE` ever ran. That defeated layering,
// admin-index-cross, AND the transitive-reachability check simultaneously,
// since all three read from the same `parseImportEdges` pipeline. The root
// cause was applying the AST remedy to the instance NAMED in the finding
// rather than to every instance of the defective pattern in the change.
//
// This file's import extraction is now AST-based too: `ts.createSourceFile`
// (same pure-parse, no-`ts.Program`, no-type-checker cost class as the line
// scan it replaces), walking real `ImportDeclaration` and `ExportDeclaration`
// nodes. Comments are parser TRIVIA, not text this scan pattern-matches --
// a leading, trailing, inline, or multi-line comment anywhere around an
// import statement cannot hide it from the AST walk, because the walk never
// looks at raw source text at all. This also incidentally closes two
// findings the phase-5 review disclosed as accepted gaps rather than fixing
// (multi-line specifier lists were already handled by the old regex's
// `[\s\S]*?`, so no change there; string-literal-embedded import-like text,
// e.g. `const s = "import { X } from '../index/Y'";`, was already immune to
// the regex too since `IMPORT_RE` requires the `import`/`export` KEYWORD --
// but is now doubly immune, since a string literal is a single AST leaf
// node, never traversed as statements).
//
// Type-only detection now reads the AST's own dedicated fields rather than
// re-deriving them from clause text: `ImportClause.isTypeOnly` /
// `ExportDeclaration.isTypeOnly` for the whole-clause form (`import type
// {...}`), and each `ImportSpecifier`/`ExportSpecifier`'s own `isTypeOnly`
// for the per-specifier inline form (`import { type A, B } from '...'` --
// MIXED, because `B` is a value specifier, the import produces a real
// runtime binding, and the carve-out must NOT apply). Still deliberately
// requires a literal `from '...'`/`'...'` string-literal module specifier
// (dynamic `import(...)` is not an `ImportDeclaration`/`ExportDeclaration`
// node at all) -- B4's dynamic-`import()` gap is unchanged and still
// disclosed below; this rebuild did not touch it and does not claim to.
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

type Zone = 'pages' | 'api' | 'shared';
const ZONE_RANK: Record<Zone, number> = { pages: 0, api: 1, shared: 2 };

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

/** Any filename containing `.test.` is a test file (`.test.ts`, `.test.tsx`, `.int.test.ts`, ...). */
function isProductionFile(relPath: string): boolean {
  return !path.basename(relPath).includes('.test.');
}

/** First path segment relative to web/src, if it is one of the three governed zones. */
function zoneOf(relPath: string): Zone | null {
  const top = relPath.split('/')[0];
  return top === 'pages' || top === 'api' || top === 'shared' ? top : null;
}

/** `pages/<sub>/...` -> `<sub>`, for the admin-users/index carve-out. Null outside `pages/`. */
function pagesSubAreaOf(relPath: string): string | null {
  const parts = relPath.split('/');
  return parts[0] === 'pages' ? (parts[1] ?? null) : null;
}

interface ImportEdge {
  line: number;
  specifier: string;
  isTypeOnly: boolean;
  raw: string;
}

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      // .ts, .mts, .cts all parse as plain TS syntax.
      return ts.ScriptKind.TS;
  }
}

function parseFile(rel: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path.extname(rel)),
  );
}

function lineAt(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function textOfLine(content: string, line: number): string {
  return content.split('\n')[line - 1]?.trim() ?? '';
}

/** Whole-clause OR per-specifier type-only-ness of an `import ... from '...'`
 * declaration. `clause.isTypeOnly` covers `import type Foo from '...'` and
 * `import type { A } from '...'`; per-specifier `isTypeOnly` covers the
 * MIXED form `import { type A, B } from '...'`, which is a VALUE import
 * (only some specifiers are type-only) -- so a named-imports clause is
 * type-only only if it has at least one specifier and EVERY specifier is
 * individually type-only. A side-effect import (`import '...';`, no clause
 * at all) always produces a real module evaluation, so it is a value edge.
 */
function isTypeOnlyImportClause(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const hasValueDefault = !!clause.name;
  if (hasValueDefault) return false;
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) return false; // `* as ns` is a value binding
    if (ts.isNamedImports(clause.namedBindings)) {
      const elements = clause.namedBindings.elements;
      return elements.length > 0 && elements.every((el) => el.isTypeOnly);
    }
  }
  return false;
}

/** Whole-clause OR per-specifier type-only-ness of an `export ... from '...'`
 * re-export declaration. `export * from '...'` and `export * as ns from
 * '...'` (no `NamedExports` clause) are value edges unless the whole
 * declaration is `export type * from '...'` / `export type * as ns from
 * '...'`. `export {} from '...'` (zero named specifiers) still evaluates
 * the target module for side effects, so it is a value edge too -- the
 * `elements.length > 0` guard below matches that ES-module semantic.
 */
function isTypeOnlyExportDeclaration(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    const elements = node.exportClause.elements;
    return elements.length > 0 && elements.every((el) => el.isTypeOnly);
  }
  return false;
}

/** Walks `sf`'s real AST for every `ImportDeclaration`/`ExportDeclaration`
 * whose module specifier is a string literal (dynamic `import(...)` is a
 * `CallExpression`, not either of these node kinds, and is not matched --
 * the disclosed B4 gap, unchanged). Comments are parser trivia and are
 * never examined as text, so no comment shape -- leading, trailing,
 * same-line, or multi-line -- can hide an import from this walk (closes
 * N12). A production file's imports/exports are always top-level
 * statements, but the walk recurses through the whole tree defensively
 * (matching `windowCoordinationBan.repo.test.ts`'s own walk shape) rather
 * than assuming that structurally.
 */
function parseImportEdges(rel: string, content: string): ImportEdge[] {
  const sf = parseFile(rel, content);
  const edges: ImportEdge[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const line = lineAt(sf, node.getStart(sf));
      edges.push({
        line,
        specifier: node.moduleSpecifier.text,
        isTypeOnly: isTypeOnlyImportClause(node.importClause),
        raw: textOfLine(content, line),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const line = lineAt(sf, node.getStart(sf));
      edges.push({
        line,
        specifier: node.moduleSpecifier.text,
        isTypeOnly: isTypeOnlyExportDeclaration(node),
        raw: textOfLine(content, line),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return edges;
}

/** Resolves an import specifier to a path relative to web/src, or null if not web/src-internal. */
function resolveTargetRel(importerRel: string, specifier: string): string | null {
  if (
    specifier.startsWith('@/api/') ||
    specifier.startsWith('@/shared/') ||
    specifier.startsWith('@/pages/')
  ) {
    return specifier.slice(2); // strip leading "@/"
  }
  if (specifier.startsWith('.')) {
    const importerDir = path.posix.dirname(importerRel);
    return path.posix.normalize(path.posix.join(importerDir, specifier));
  }
  return null; // bare package specifier (react, clsx, ...) -- not web/src-internal
}

interface Violation {
  file: string;
  line: number;
  kind: 'layering' | 'admin-index-cross';
  from: string;
  to: string;
  specifier: string;
  text: string;
}

/** Per-file scan: layering + admin-users/index violations for one production file. */
function scanFileForViolations(rel: string, content: string): Violation[] {
  const sourceZone = zoneOf(rel);
  if (!sourceZone) return [];
  const violations: Violation[] = [];

  for (const edge of parseImportEdges(rel, content)) {
    const targetRel = resolveTargetRel(rel, edge.specifier);
    if (targetRel === null) continue;
    const targetZone = zoneOf(targetRel);
    if (!targetZone) continue;

    if (!edge.isTypeOnly && ZONE_RANK[sourceZone] > ZONE_RANK[targetZone]) {
      violations.push({
        file: rel,
        line: edge.line,
        kind: 'layering',
        from: sourceZone,
        to: targetZone,
        specifier: edge.specifier,
        text: edge.raw,
      });
    }

    if (sourceZone === 'pages' && targetZone === 'pages') {
      const fromSub = pagesSubAreaOf(rel);
      const toSub = pagesSubAreaOf(targetRel);
      const crossesAdminIndex =
        (fromSub === 'admin-users' && toSub === 'index') ||
        (fromSub === 'index' && toSub === 'admin-users');
      if (crossesAdminIndex) {
        violations.push({
          file: rel,
          line: edge.line,
          kind: 'admin-index-cross',
          from: `pages/${fromSub}`,
          to: `pages/${toSub}`,
          specifier: edge.specifier,
          text: edge.raw,
        });
      }
    }
  }

  return violations;
}

/** Full-tree scan: production files under the three governed zones only. */
function scanTree(root: string): { violations: Violation[]; filesExamined: number } {
  const files = walk(root);
  let filesExamined = 0;
  const violations: Violation[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!isProductionFile(rel)) continue;
    if (!zoneOf(rel)) continue;
    filesExamined++;
    violations.push(...scanFileForViolations(rel, fs.readFileSync(file, 'utf8')));
  }
  return { violations, filesExamined };
}

// --- fixture builders ---

function valueImport(names: string, specifier: string): string {
  return `import { ${names} } from '${specifier}';`;
}

function typeImport(names: string, specifier: string): string {
  return `import type { ${names} } from '${specifier}';`;
}

/** Test-only helper: parses `content` as a standalone `fixture.ts` file and
 * returns its import/export edges, for unit-testing `parseImportEdges`'s
 * type-only classification directly against small AST fixtures rather than
 * only indirectly through `scanFileForViolations`. */
function importEdgesOf(content: string): ImportEdge[] {
  return parseImportEdges('fixture.ts', content);
}

describe('detection predicate (mutation check — proves each piece fires)', () => {
  it('parseImportEdges: `import type { A, B } from "x"` is type-only (whole-clause form)', () => {
    const edges = importEdgesOf(`import type { A, B } from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: true }]);
  });

  it('parseImportEdges: `import type Foo from "x"` (default) is type-only', () => {
    const edges = importEdgesOf(`import type Foo from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: true }]);
  });

  it('parseImportEdges: `import { type A, type B } from "x"` (every specifier inline-typed) is type-only', () => {
    const edges = importEdgesOf(`import { type A, type B } from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: true }]);
  });

  it('parseImportEdges: `import { A, type B } from "x"` (mixed) is a VALUE import', () => {
    const edges = importEdgesOf(`import { A, type B } from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: a bare default import is a VALUE import', () => {
    const edges = importEdgesOf(`import Foo from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: a namespace import (`* as X`) is a VALUE import', () => {
    const edges = importEdgesOf(`import * as Foo from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: a default + named-with-type-only-member import is a VALUE import (default alone is a value binding)', () => {
    const edges = importEdgesOf(`import Foo, { type A } from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: a side-effect import (`import "x";`, no clause) is a VALUE import', () => {
    const edges = importEdgesOf(`import 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: `export type { A } from "x"` is type-only', () => {
    const edges = importEdgesOf(`export type { A } from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: true }]);
  });

  it('parseImportEdges: `export { A, type B } from "x"` (mixed) is a VALUE import', () => {
    const edges = importEdgesOf(`export { A, type B } from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: `export * from "x"` is a VALUE import', () => {
    const edges = importEdgesOf(`export * from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: `export type * from "x"` is type-only', () => {
    const edges = importEdgesOf(`export type * from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: true }]);
  });

  it('parseImportEdges: `export * as ns from "x"` is a VALUE import', () => {
    const edges = importEdgesOf(`export * as ns from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: `export {} from "x"` (zero specifiers, side-effect re-export) is a VALUE import', () => {
    const edges = importEdgesOf(`export {} from 'x';`);
    expect(edges).toMatchObject([{ specifier: 'x', isTypeOnly: false }]);
  });

  it('parseImportEdges: `export { A } from "x"` (local re-export, no specifier) produces no edge', () => {
    // Not a re-export at all -- `export { A };` has no `moduleSpecifier`, so
    // it exports an already-in-scope local binding and crosses no file
    // boundary. Must not be mistaken for `export { A } from '...'`.
    const edges = importEdgesOf(`const A = 1;\nexport { A };`);
    expect(edges).toEqual([]);
  });

  it('parseImportEdges: a same-line leading block comment does not hide a live import (N12 regression)', () => {
    const edges = importEdgesOf(
      `/* eslint-disable-next-line */ import { A } from '../index/AppShell';`,
    );
    expect(edges).toMatchObject([{ specifier: '../index/AppShell', isTypeOnly: false }]);
  });

  it('parseImportEdges: a comment-only line does not itself produce an edge', () => {
    const edges = importEdgesOf(
      ["// import { A } from '../index/AppShell';", "import { B } from './b';"].join('\n'),
    );
    expect(edges).toMatchObject([{ specifier: './b', isTypeOnly: false }]);
  });

  it('parseImportEdges: an import-like string literal inside a string is not an edge', () => {
    const edges = importEdgesOf(`const s = "import { A } from '../index/AppShell';";`);
    expect(edges).toEqual([]);
  });

  it('parseImportEdges: dynamic import() is NOT matched (disclosed gap, unchanged by this rebuild)', () => {
    const edges = importEdgesOf(`async function f() { await import('../index/AppShell'); }`);
    expect(edges).toEqual([]);
  });

  it('resolveTargetRel: relative specifier resolves against the importer directory', () => {
    expect(resolveTargetRel('shared/utils/recording.ts', '../../api/types')).toBe('api/types');
  });

  it('resolveTargetRel: @/api|@/shared|@/pages alias specifiers resolve directly', () => {
    expect(resolveTargetRel('pages/index/main.tsx', '@/shared/theme/ThemeProvider')).toBe(
      'shared/theme/ThemeProvider',
    );
    expect(resolveTargetRel('pages/index/main.tsx', '@/api/client')).toBe('api/client');
    expect(resolveTargetRel('shared/foo.ts', '@/pages/index/Bar')).toBe('pages/index/Bar');
  });

  it('resolveTargetRel: a bare package specifier is not web/src-internal', () => {
    expect(resolveTargetRel('pages/index/main.tsx', 'react')).toBeNull();
    expect(resolveTargetRel('pages/index/main.tsx', 'clsx')).toBeNull();
  });

  it('zoneOf / pagesSubAreaOf classify a path by its first segment(s)', () => {
    expect(zoneOf('api/client.ts')).toBe('api');
    expect(zoneOf('shared/utils/recording.ts')).toBe('shared');
    expect(zoneOf('pages/index/main.tsx')).toBe('pages');
    expect(zoneOf('assets/logo.png')).toBeNull();
    expect(pagesSubAreaOf('pages/admin-users/AdminUsersPage.tsx')).toBe('admin-users');
    expect(pagesSubAreaOf('pages/index/main.tsx')).toBe('index');
  });

  it('flags a value import from shared into api (upward — the D0/E5 chain-order case)', () => {
    const v = scanFileForViolations('shared/foo.ts', valueImport('bar', '../api/bar'));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'layering', from: 'shared', to: 'api' });
  });

  it('does NOT flag a type-only import from shared into api (the carve-out)', () => {
    const v = scanFileForViolations('shared/foo.ts', typeImport('Bar', '../api/bar'));
    expect(v).toEqual([]);
  });

  it('does NOT flag a value import from pages into api or shared (downward)', () => {
    expect(
      scanFileForViolations('pages/index/foo.ts', valueImport('bar', '../../api/bar')),
    ).toEqual([]);
    expect(
      scanFileForViolations('pages/index/foo.ts', valueImport('bar', '../../shared/bar')),
    ).toEqual([]);
  });

  it('does NOT flag a value import from api into shared (downward)', () => {
    expect(scanFileForViolations('api/foo.ts', valueImport('bar', '../shared/bar'))).toEqual([]);
  });

  it('flags an admin-users import from index, and the reverse, regardless of type-only', () => {
    const toIndex = scanFileForViolations(
      'pages/admin-users/AdminUsersPage.tsx',
      valueImport('bar', '../index/components/Bar'),
    );
    expect(toIndex.some((v) => v.kind === 'admin-index-cross')).toBe(true);

    const fromIndexTypeOnly = scanFileForViolations(
      'pages/index/components/Bar.tsx',
      typeImport('Bar', '../../admin-users/AdminUsersPage'),
    );
    expect(fromIndexTypeOnly.some((v) => v.kind === 'admin-index-cross')).toBe(true);
  });

  it('does NOT flag an intra-page import (index -> index, or admin-users -> admin-users)', () => {
    expect(scanFileForViolations('pages/index/components/A.tsx', valueImport('B', './B'))).toEqual(
      [],
    );
  });
});

describe('scanTree — end-to-end mutation check on a real filesystem walk', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function freshRoot(prefix: string): string {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(tmpRoot, 'pages', 'index'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'pages', 'admin-users'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'shared'), { recursive: true });
    return tmpRoot;
  }

  it('DOES fire on a value import from shared/ into api/ (proves the layering guard is not vacuous)', () => {
    const root = freshRoot('web-boundaries-mutation-');
    fs.writeFileSync(path.join(root, 'shared', 'stray.ts'), valueImport('bar', '../api/bar'));
    fs.writeFileSync(path.join(root, 'api', 'bar.ts'), 'export const bar = 1;\n');
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'layering' && v.file === 'shared/stray.ts')).toBe(
      true,
    );
  });

  it('DOES fire on an admin-users import from pages/index (proves the carve-out guard is not vacuous)', () => {
    const root = freshRoot('web-boundaries-mutation-admin-');
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'AdminUsersPage.tsx'),
      valueImport('Bar', '../index/components/Bar'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'admin-index-cross' && v.file === 'pages/admin-users/AdminUsersPage.tsx',
      ),
    ).toBe(true);
  });

  it('does NOT fire on a conforming tree (downward value imports + the real shared->api type-only shape)', () => {
    const root = freshRoot('web-boundaries-clean-');
    fs.writeFileSync(
      path.join(root, 'pages', 'index', 'main.tsx'),
      [valueImport('bar', '../../api/bar'), valueImport('baz', '../../shared/baz')].join('\n'),
    );
    fs.writeFileSync(path.join(root, 'api', 'bar.ts'), valueImport('baz', '../shared/baz'));
    fs.writeFileSync(path.join(root, 'shared', 'baz.ts'), typeImport('LogEvent', '../api/types'));
    fs.writeFileSync(path.join(root, 'api', 'types.ts'), 'export interface LogEvent {}\n');
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(4);
    expect(violations).toEqual([]);
  });

  it('a test file crossing the boundary is not scanned (mirrors api/types.conformance.test.ts)', () => {
    const root = freshRoot('web-boundaries-testfile-');
    fs.writeFileSync(
      path.join(root, 'api', 'types.conformance.test.ts'),
      typeImport('LogImportJobStatus', '../pages/index/batchImport/logImportClient'),
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(0);
    expect(violations).toEqual([]);
  });

  it('a wrong root yields zero examined files rather than a silent pass (walk() swallows readdirSync errors)', () => {
    const { violations, filesExamined } = scanTree(
      path.join(os.tmpdir(), 'web-boundaries-does-not-exist'),
    );
    expect(filesExamined).toBe(0);
    expect(violations).toEqual([]);
  });

  it('N12 regression: a same-line leading block comment does not hide a live admin-users -> index import from the real filesystem walk', () => {
    const root = freshRoot('web-boundaries-n12-admin-');
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'attackN12.ts'),
      `/* eslint-disable-next-line */ ${valueImport('Bar', '../index/components/Bar')}`,
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.file === 'pages/admin-users/attackN12.ts' && v.kind === 'admin-index-cross',
      ),
    ).toBe(true);
  });

  it('N12 regression: a same-line leading block comment does not hide a live shared -> api layering violation', () => {
    const root = freshRoot('web-boundaries-n12-layering-');
    fs.writeFileSync(
      path.join(root, 'shared', 'attackN12.ts'),
      `/* eslint-disable-next-line */ ${valueImport('bar', '../api/bar')}`,
    );
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.file === 'shared/attackN12.ts' && v.kind === 'layering')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Transitive reachability (phase-5 fix wave, Finding 1) — closes the
// laundering-through-a-third-subarea bypass the phase-5 review demonstrated
// (B5): `admin-users -> pages/relay -> pages/index`, a two-hop re-export
// chain where EACH hop is individually permitted by the direct-edge check
// above (neither edge is the admin-users<->index PAIR that check compares
// against) but the COMPOSITE is exactly the coupling the requirement
// forbids. `server/src/packageBoundaries.repo.test.ts` carries the identical
// shape of fix for the identical reason (its own design.md records a panel
// that defeated a direct-edge-only check by adding one `ALLOWED_LAYER_EDGES`
// entry and re-exporting through a sibling package) — this mirrors that
// check's structure: build the whole-tree import graph once, then a DFS
// reachability query per direction.
//
// Fix's own wording, not restated as a new requirement: "admin-users must
// not reach pages/index through any chain of production VALUE imports.
// Preserve the existing type-only carve-out semantics at every hop." Value
// vs. type-only is exactly the distinction the general layering check
// already draws (`edge.isTypeOnly`) — a chain is only a real transitive
// dependency Rollup would bundle if every hop is a value edge, so the graph
// below excludes type-only edges at every hop, matching that carve-out
// rather than re-litigating it. (The DIRECT admin-users<->index rule above
// is unchanged and still flags a length-one type-only edge between the two
// PAIR itself, per its own un-narrowed spec wording — this transitive check
// is additive, not a replacement.)
//
// Any edge that LEAVES `pages` into `api`/`shared` and later re-enters
// `pages` as a value import is already an independent violation of the
// layering rule above (api/shared -> pages is always upward for a value
// edge, carve-out or not) -- so restricting the graph's nodes to
// `pages/<sub>` would already close everything the review demonstrated.
// The graph below is built one level more generally anyway (every governed
// zone is a node: `pages/<sub>`, `api`, `shared`), at zero extra cost, so a
// future carve-out change to the layering rule can't silently reopen this
// specific gap without this check's node set already covering it.

/** Node identifier for the transitive graph: `pages/<sub>` for pages files
 * (subarea-grained, since the whole point is admin-users vs. index vs. any
 * OTHER subarea), or the flat zone name for api/shared. Files outside the
 * three governed zones are not graph nodes (null). */
function graphNodeOf(rel: string): string | null {
  const zone = zoneOf(rel);
  if (zone === null) return null;
  if (zone === 'pages') {
    const sub = pagesSubAreaOf(rel);
    return sub ? `pages/${sub}` : null;
  }
  return zone;
}

/** Builds the whole-tree VALUE-import graph used for transitive reachability
 * (production files only, matching `scanTree`'s own file filter). Type-only
 * edges are excluded at every hop -- see the block comment above. */
function buildValueImportGraph(root: string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!isProductionFile(rel)) continue;
    const fromNode = graphNodeOf(rel);
    if (fromNode === null) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const edge of parseImportEdges(rel, content)) {
      if (edge.isTypeOnly) continue;
      const targetRel = resolveTargetRel(rel, edge.specifier);
      if (targetRel === null) continue;
      const toNode = graphNodeOf(targetRel);
      if (toNode === null || toNode === fromNode) continue;
      if (!graph.has(fromNode)) graph.set(fromNode, new Set());
      graph.get(fromNode)?.add(toNode);
    }
  }
  return graph;
}

/** Standard DFS reachability over the value-import graph — mirrors
 * `server/src/packageBoundaries.repo.test.ts`'s
 * `checkServiceTransitiveReachability` traversal shape (stack-based,
 * seen-set, full transitive closure from `start`). */
function isReachable(graph: Map<string, Set<string>>, start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [...(graph.get(start) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || seen.has(node)) continue;
    seen.add(node);
    if (node === target) return true;
    for (const next of graph.get(node) ?? []) stack.push(next);
  }
  return false;
}

describe('transitive reachability — admin-users cannot launder a value-import chain to index (mutation check)', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function freshRoot(prefix: string): string {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(tmpRoot, 'pages', 'index'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'pages', 'admin-users'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'pages', 'relay'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'shared'), { recursive: true });
    return tmpRoot;
  }

  it('DOES fire on the B5 two-hop re-export (admin-users -> relay -> index), which the direct check alone misses', () => {
    const root = freshRoot('web-boundaries-launder-');
    fs.writeFileSync(
      path.join(root, 'pages', 'index', 'AppShell.ts'),
      'export const AppShell = 1;\n',
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'relay', 'relayFromIndex.ts'),
      `export { AppShell } from '../index/AppShell';\n`,
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'attackLaunder.ts'),
      valueImport('AppShell', '../relay/relayFromIndex'),
    );

    const graph = buildValueImportGraph(root);
    expect(isReachable(graph, 'pages/admin-users', 'pages/index')).toBe(true);

    // Proves this is a NEW check closing a gap, not a duplicate of the
    // direct-edge check: on this exact tree, the direct check stays green.
    const { violations } = scanTree(root);
    expect(violations.filter((v) => v.kind === 'admin-index-cross')).toEqual([]);
  });

  it('DOES fire on a three-hop chain through two distinct relay subareas', () => {
    const root = freshRoot('web-boundaries-launder3-');
    fs.mkdirSync(path.join(root, 'pages', 'relay2'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'pages', 'index', 'AppShell.ts'),
      'export const AppShell = 1;\n',
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'relay', 'a.ts'),
      `export { AppShell } from '../index/AppShell';\n`,
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'relay2', 'b.ts'),
      `export { AppShell } from '../relay/a';\n`,
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'attack.ts'),
      valueImport('AppShell', '../relay2/b'),
    );
    const graph = buildValueImportGraph(root);
    expect(isReachable(graph, 'pages/admin-users', 'pages/index')).toBe(true);
  });

  it('DOES fire in the reverse direction (index -> relay -> admin-users)', () => {
    const root = freshRoot('web-boundaries-launder-rev-');
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'Widget.ts'),
      'export const Widget = 1;\n',
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'relay', 'relayFromAdmin.ts'),
      `export { Widget } from '../admin-users/Widget';\n`,
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'index', 'attack.ts'),
      valueImport('Widget', '../relay/relayFromAdmin'),
    );
    const graph = buildValueImportGraph(root);
    expect(isReachable(graph, 'pages/index', 'pages/admin-users')).toBe(true);
  });

  it('a type-only hop breaks the chain (the carve-out is preserved at every hop, not just the direct pair)', () => {
    const root = freshRoot('web-boundaries-launder-typeonly-');
    fs.writeFileSync(
      path.join(root, 'pages', 'index', 'AppShell.ts'),
      'export const AppShell = 1;\n',
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'relay', 'relayFromIndex.ts'),
      `export { AppShell } from '../index/AppShell';\n`,
    );
    // admin-users's own hop into the relay is TYPE-only -- erases at compile
    // time, so nothing is actually bundled, and the chain must not fire.
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'attackTypeOnly.ts'),
      typeImport('AppShell', '../relay/relayFromIndex'),
    );
    const graph = buildValueImportGraph(root);
    expect(isReachable(graph, 'pages/admin-users', 'pages/index')).toBe(false);
  });

  it('does NOT fire when the chain never reaches pages/index (relay used, but only for admin-users-local code)', () => {
    const root = freshRoot('web-boundaries-launder-clean-');
    fs.writeFileSync(path.join(root, 'pages', 'relay', 'util.ts'), 'export const util = 1;\n');
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'ok.ts'),
      valueImport('util', '../relay/util'),
    );
    const graph = buildValueImportGraph(root);
    expect(isReachable(graph, 'pages/admin-users', 'pages/index')).toBe(false);
  });

  it('N12 regression: a same-line leading block comment on the LAUNDERING hop does not hide it from the transitive graph', () => {
    const root = freshRoot('web-boundaries-n12-transitive-');
    fs.writeFileSync(
      path.join(root, 'pages', 'index', 'AppShell.ts'),
      'export const AppShell = 1;\n',
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'relay', 'relayFromIndex.ts'),
      `/* eslint-disable-next-line */ export { AppShell } from '../index/AppShell';\n`,
    );
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'attackN12Launder.ts'),
      `/* eslint-disable-next-line */ ${valueImport('AppShell', '../relay/relayFromIndex')}`,
    );
    const graph = buildValueImportGraph(root);
    expect(isReachable(graph, 'pages/admin-users', 'pages/index')).toBe(true);
  });

  it('the value-import graph is non-empty on a real fixture (proves the walk examined real files, not zero)', () => {
    const root = freshRoot('web-boundaries-launder-nonempty-');
    fs.writeFileSync(
      path.join(root, 'pages', 'index', 'main.tsx'),
      valueImport('bar', '../../api/bar'),
    );
    fs.writeFileSync(path.join(root, 'api', 'bar.ts'), 'export const bar = 1;\n');
    const graph = buildValueImportGraph(root);
    expect(graph.size).toBeGreaterThan(0);
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
// this file: web/src/webBoundaries.repo.test.ts -> the scan root is web/src itself.
const WEB_SRC = here;

describe('web/src pages -> api -> shared layering + admin-users/index independence', () => {
  it('examines a non-zero number of files (proves the root resolved to the real tree)', () => {
    const { filesExamined } = scanTree(WEB_SRC);
    expect(filesExamined).toBeGreaterThan(0);
  });

  it('contains ZERO layering or admin-users/index violations', () => {
    const { violations } = scanTree(WEB_SRC);
    expect(violations).toEqual([]);
  });

  it('the three live shared -> api type-only edges specifically produce no violation', () => {
    const files = [
      'shared/utils/recording.ts',
      'shared/utils/timecode.ts',
      'shared/utils/audioClips.ts',
    ];
    for (const rel of files) {
      const content = fs.readFileSync(path.join(WEB_SRC, rel), 'utf8');
      expect(scanFileForViolations(rel, content)).toEqual([]);
    }
  });

  it('the value-import graph over the real tree is non-empty (proves the transitive check examined real files)', () => {
    const graph = buildValueImportGraph(WEB_SRC);
    expect(graph.size).toBeGreaterThan(0);
  });

  it('pages/index is NOT transitively reachable from pages/admin-users through any chain of value imports', () => {
    const graph = buildValueImportGraph(WEB_SRC);
    expect(isReachable(graph, 'pages/admin-users', 'pages/index')).toBe(false);
  });

  it('pages/admin-users is NOT transitively reachable from pages/index through any chain of value imports', () => {
    const graph = buildValueImportGraph(WEB_SRC);
    expect(isReachable(graph, 'pages/index', 'pages/admin-users')).toBe(false);
  });
});
