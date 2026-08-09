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
// PHASE-1 FIX WAVE (web-package-boundary review, Finding 3/F4): narrowed from
// {node_modules, dist, build, coverage, .git}. `dist`/`build`/`coverage` are
// legitimate skips at a REPO ROOT walk (generated output sitting next to
// source), but this walk only ever starts at `web/src` (or a synthetic test
// root shaped like it) -- nothing under `web/src` is EVER a build artifact,
// so skipping directories with those names there was pure blindness: the
// review planted `web/src/shared/build/a22.ts` importing `@autologger/domain`
// and every one of the four checks in this file stayed silently green.
// `node_modules` and `.git` are kept, but the ORIGINAL stated rationale for
// `node_modules` was wrong and is corrected here (final fix wave, N3): the
// prior comment claimed a directory named `node_modules` is "third-party
// code this policy does not govern." That is true of the REAL root
// `node_modules` (walking it would explode into thousands of unrelated
// files, and the `node_modules/@autologger/*` REACH into `packages/` is
// caught separately, by resolving the specifier string against
// `PACKAGES_ESCAPE_RE` below, not by scanning inside `node_modules` itself)
// -- but it is simply FALSE of a directory that happens to be named
// `node_modules` while living UNDER `web/src`. Nothing under `web/src` is
// ever a real package-manager install; a hand-planted `web/src/shared/
// node_modules/evil.ts` is ordinary first-party source wearing a name this
// skip-list treats as a magic signal, and it is never walked or scanned as
// a result. This is a disclosed, unfixed gap (N3; see the final-fix-wave
// describe block below and the spec delta's threat model) inherited from
// this skip-list's `queryKeyFactories.repo.test.ts` precedent, not a
// deliberate, sound exclusion the way the real-root case is. `.git` is kept
// because it never contains source and walking it risks touching
// object-store internals -- that rationale is unaffected.
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);

type Zone = 'pages' | 'api' | 'shared';
const ZONE_RANK: Record<Zone, number> = { pages: 0, api: 1, shared: 2 };

/** PHASE-1 FIX WAVE (Finding 4/F5): a symlinked directory under `web/src` is
 * now FOLLOWED rather than silently skipped. The prior code gated recursion
 * on `entry.isDirectory()`, which `fs.Dirent` always reports `false` for a
 * symlink (`isSymbolicLink()` is what's true) -- so a planted
 * `web/src/shared/attackz/symdir -> <scratch dir>` containing an offending
 * import was invisible to every check. Decision: follow, not merely
 * disclose -- this guard exists specifically to stop code from reaching
 * `packages/`, and a symlink is exactly the kind of on-disk indirection an
 * evasion would use, so leaving it unguarded was a live hole, not a
 * theoretical one. Cycle safety: each directory's REALPATH (post
 * symlink-resolution) is recorded in `seenRealDirs` before recursing, so a
 * symlink pointing at an ancestor (or at itself) is visited at most once
 * per walk rather than looping forever. A broken symlink (realpath/stat
 * throws) is skipped, matching the pre-existing `readdirSync` failure
 * mode below.
 *
 * CORRECTION (final fix wave, N4 -- the fix-wave re-review disproved the
 * prior version of this comment): a symlinked FILE is indeed WALKED and
 * SCANNED (`entry.isDirectory()` is false for it, so it falls through to
 * the extension check, same as before this change) -- but "scanned" is not
 * "caught". A symlinked file whose target lives under `packages/` is real
 * package source physically reachable from `web/src`, yet its own internal
 * relative imports resolve relative to the SYMLINK's location, not the
 * target's real location -- so they look like ordinary web/src-internal
 * paths to every check in this file, and nothing fires. This is a
 * disclosed, unfixed gap (N4; see the final-fix-wave describe block below
 * and the spec delta's threat model), not a closed one. The prior claim
 * that symlinked files "were already handled correctly ... and remain so"
 * was false and is retracted here.
 */
function walk(dir: string, out: string[] = [], seenRealDirs: Set<string> = new Set()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory(); // follows the link
      } catch {
        continue; // broken symlink
      }
    }
    if (isDir) {
      let real: string;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (seenRealDirs.has(real)) continue; // cycle guard
      seenRealDirs.add(real);
      walk(full, out, seenRealDirs);
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** PHASE-1 FIX WAVE (Finding 5/F6): anchored to a filename SUFFIX rather than
 * a substring. The prior `.includes('.test.')` check exempted anything
 * merely CONTAINING that token anywhere in its basename --
 * `a7_bridge.test.shim.ts` read as a test file, was never scanned by any
 * rule here, yet vitest's own `*.test.ts` glob does not collect it either
 * (the file doesn't END in `.test.ts`), so it was live, importable,
 * ungoverned production code wearing a test name. The suffix regex mirrors
 * this project's actual test-file convention (`.test.ts` / `.test.tsx` /
 * `.int.test.ts` / ... -- always a TRAILING `.test.<ext>`) and still exempts
 * every real test file, including `clientAggregates.pinning.test.ts` (ends
 * `.test.ts`) and `api/types.conformance.test.ts` (ends `.test.ts`).
 */
const TEST_FILE_SUFFIX_RE = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function isProductionFile(relPath: string): boolean {
  return !TEST_FILE_SUFFIX_RE.test(path.basename(relPath));
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

interface DynamicImportEdge {
  line: number;
  specifier: string;
  raw: string;
}

/** Walks `sf`'s AST for every dynamic `import(...)` call expression whose
 * first argument is string-literal-LIKE (`ts.isStringLiteralLike`, so a
 * no-substitution template-literal dynamic import -- ``import(`../foo`)`` --
 * is caught identically to `import('../foo')`, matching how the static-edge
 * walk above already treats the two forms as equivalent). A `CallExpression`
 * is a dynamic import iff its callee is the bare `import` keyword
 * (`node.expression.kind === ts.SyntaxKind.ImportKeyword`) -- this is
 * `web-docs/src/lib/extractImports.ts`'s own `walkSourceFile` check (its
 * `CallExpression`/`ImportKeyword` branch), reused here rather than
 * reinvented, per the standing "in-repo precedent beats invention" rule.
 *
 * A non-literal first argument (a bare variable, a template literal WITH a
 * substitution, a concatenation, a function call) cannot be resolved
 * statically and is deliberately NOT guessed at -- silently skipped, same
 * as `extractImports.ts` treats it as a distinct `DynamicImportWarning`
 * rather than a resolved edge. This is a disclosed residual (task-1-2
 * report, "Dynamic-import hole" section): a determined evasion can still
 * hide a `packages/`-bound dynamic import behind a non-literal argument.
 *
 * Also deliberately NOT matched: `import(...)` used in TYPE position
 * (`typeof import('x')` / a direct `import('x').Member` type reference) --
 * a distinct AST node kind, `ts.ImportTypeNode`, not a `CallExpression` at
 * all, and not what the task that added this function named ("import(...)
 * call expressions"). `extractImports.ts` resolves that shape too, as a
 * SEPARATE branch of its own walk (`ts.isImportTypeNode`) -- this function
 * deliberately does not adopt that second branch; see the same report
 * section for why that is disclosed as a second residual rather than
 * silently left uncovered.
 *
 * Scope: this function feeds ONLY the cross-workspace-package
 * (`packages/`-escape) check below. The pre-existing `parseImportEdges` --
 * which feeds the layering/admin-index-cross/transitive-reachability checks
 * -- is intentionally untouched and still does not resolve any dynamic
 * form at all (its own doc comment and the `dynamic import() is NOT
 * matched` unit test below both still describe current, accurate
 * behavior); widening those OTHER rules to dynamic imports was not asked
 * for by the task that added this function and is out of scope here.
 */
function parseDynamicImportEdges(rel: string, content: string): DynamicImportEdge[] {
  const sf = parseFile(rel, content);
  const edges: DynamicImportEdge[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        const line = lineAt(sf, node.getStart(sf));
        edges.push({ line, specifier: arg.text, raw: textOfLine(content, line) });
      }
      // else: non-literal argument -- cannot resolve statically, not guessed at (disclosed residual above).
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return edges;
}

/** Resolves an import specifier to a path relative to web/src, or null if not web/src-internal.
 *
 * PHASE-1 FIX WAVE (Finding 1/F1, CRITICAL): the alias branch now normalizes
 * too. It previously returned `specifier.slice(2)` UN-normalized, so
 * `@/shared/../../../packages/domain/src/index` resolved to the literal
 * string `shared/../../../packages/domain/src/index` -- which does not
 * start with `../`, so `PACKAGES_ESCAPE_RE` never matched it even though the
 * path genuinely escapes into `packages/`. Demonstrated to bundle: `vite
 * build` emitted `validateEventPalette` (an identifier that exists nowhere
 * in `web/src`) into the shipped chunk while this guard reported zero
 * violations. The SAME bug independently mis-zoned the pre-existing
 * layering/admin-index-cross checks (`zoneOf('shared/../pages/index/...')`
 * read as `'shared'` instead of `'pages'`) -- so this one-line fix repairs
 * both the new cross-workspace rule and the two rules it shares
 * `resolveTargetRel` with.
 */
function resolveTargetRel(importerRel: string, specifier: string): string | null {
  if (
    specifier.startsWith('@/api/') ||
    specifier.startsWith('@/shared/') ||
    specifier.startsWith('@/pages/')
  ) {
    return path.posix.normalize(specifier.slice(2)); // strip leading "@/", then normalize (closes F1/F2)
  }
  if (specifier.startsWith('.')) {
    const importerDir = path.posix.dirname(importerRel);
    return path.posix.normalize(path.posix.join(importerDir, specifier));
  }
  return null; // bare package specifier (react, clsx, ...) -- not web/src-internal
}

// --- Cross-workspace package-boundary guard (web-package-boundary, tasks
// 1.1/1.2; spec "Production web code does not reach the package graph") ---
//
// No production file under web/src SHALL import from packages/, by relative
// path OR by `@autologger/*` bare specifier, at any layer. Unlike the
// pages/api/shared layering rule above, this carve-out-free: it applies to
// EVERY production file regardless of zone (there is no "packages" zone to
// gate on), and it is NOT relaxed for type-only imports -- the spec scenario
// has no value/type-only qualifier, so a `import type` from packages/ is
// still a reach into the package graph this rule forbids.
//
// Reuses existing machinery rather than adding a second resolution path:
// `resolveTargetRel` already normalizes a relative specifier to a path
// relative to web/src even when that path escapes web/src entirely (it has
// no "stays inside root" guard) -- so a relative import that reaches
// packages/ (which sits two directory levels above web/src: src -> web ->
// repo root -> packages) normalizes to a string starting with one or more
// `../` segments followed by `packages`, regardless of how deeply nested the
// importing file is. `isAutologgerBareSpecifier` covers the other form: a
// bare `@autologger/*` specifier, which `resolveTargetRel` already treats as
// "not web/src-internal" (returns null) and is checked directly against the
// raw specifier instead.
//
// Also checked against a literal-argument dynamic `import(...)` call (see
// `parseDynamicImportEdges` above): the original static-only implementation
// left `import('../../../../packages/domain/src/index')` completely
// unreached (a demonstrated hole -- planting exactly that call in a
// production file passed both this guard and `tsc --noEmit -p web`), since
// dynamic import is a `CallExpression`, never an `ImportDeclaration`/
// `ExportDeclaration` node the original walk matched. The rule applied to a
// resolved dynamic edge is identical to a static one -- same
// `packagesEscapeTarget` call, same `cross-workspace-package` violation kind
// -- because the requirement ("production web code does not reach the
// package graph") does not distinguish import syntax; only the SPECIFIER
// matters. Non-literal dynamic-import arguments remain a disclosed residual
// (see `parseDynamicImportEdges`'s doc comment).
// PHASE-1 FIX WAVE (Findings 2 and 6 / F3 and F7): generalized from
// `^(?:\.\.\/)+packages(\/|$)`, which only matched a normalized target that
// lands on `packages` IMMEDIATELY after the leading `../` run. Two
// demonstrated evasions of that narrower form:
//  - F3: `../../../../node_modules/@autologger/domain/src/index` normalizes
//    to `(../)+node_modules/@autologger/...` -- the root workspace symlinks
//    (`node_modules/@autologger/domain -> ../../packages/domain`, verified)
//    make this resolve and bundle identically to a `packages/` path, but the
//    old regex never looked for `node_modules/@autologger` at all.
//  - F7: `../../../../../<repo-dir-name>/packages/domain/src/index` (an
//    out-and-back traversal above the repo root and back down through
//    whatever the checkout directory happens to be named) normalizes to
//    `(../)+<repo-dir-name>/packages/...` -- one intermediate segment
//    between the `../` run and `packages`, which the old anchor rejected.
// The new pattern allows any number of intermediate `segment/` hops between
// the leading `../` run and the forbidden target segment
// (`packages` or `node_modules/@autologger`), which closes F7 GENERICALLY
// (it does not depend on knowing the checkout is named `autologger-2`;
// verified against both the synthetic general form and the literal
// real-repo reproduction -- see the phase-1 fix-wave report) as well as F3.
// No new false-positive surface: every existing conforming target this
// guard resolves stays INSIDE web/src (never starts with `../` at all), so
// only genuine escapes can match either the old or the new pattern.
const PACKAGES_ESCAPE_RE = /^(?:\.\.\/)+(?:[^/]+\/)*(?:packages|node_modules\/@autologger)(\/|$)/;

function isAutologgerBareSpecifier(specifier: string): boolean {
  return specifier === '@autologger' || specifier.startsWith('@autologger/');
}

/** Returns the offending target (the raw `@autologger/*` specifier, or the
 * path-relative-to-web/src that escapes into packages/) if `specifier`
 * reaches the package graph from `importerRel`, else null. */
function packagesEscapeTarget(importerRel: string, specifier: string): string | null {
  if (isAutologgerBareSpecifier(specifier)) return specifier;
  const targetRel = resolveTargetRel(importerRel, specifier);
  if (targetRel !== null && PACKAGES_ESCAPE_RE.test(targetRel)) return targetRel;
  return null;
}

// --- Final fix wave (N1): a production file SHALL NOT import a test file
// ---
//
// Threat model (see the spec delta's "no exhaustiveness" note): this guard
// has been defeated seven times, and the owner ruled the arms race over --
// fix the one finding that is independently a defect (a production file
// importing a *.test.ts file) and disclose the rest rather than chase every
// remaining shape. This is deliberately NOT a transitive
// package-reachability check -- it does not ask "does the imported test
// file itself reach packages/?" (that is the analysis the owner ruled out).
// It is the narrow, honest rule stated flatly: no production file under
// web/src imports a test file, full stop, regardless of what that test file
// does or does not import. A production->test edge is a defect in its own
// right (the imported file is invisible to vitest's `*.test.ts` collection
// glob, so it ships as ordinary bundled code while living under a name that
// says "not shipped") -- this rule closes that edge directly rather than
// asking what lies beyond it.
//
// `TEST_TARGET_RE` matches both the common extension-less specifier form
// (`./leakN1.test`, the form TS module resolution expects) and an explicit
// extension (`./leakN1.test.ts`), so either spelling of "imports a file
// named *.test[.ext]" is caught the same way `isProductionFile` recognizes
// the SAME suffix on the importer's own name.
const TEST_TARGET_RE = /\.test(\.(ts|tsx|mts|cts|js|jsx|mjs|cjs))?$/;

/** Returns the resolved target if `specifier` (from production file
 * `importerRel`) points at a test file, else null. Only a DIRECT edge is
 * checked -- what the test file itself imports is out of scope by design. */
function testFileImportTarget(importerRel: string, specifier: string): string | null {
  const targetRel = resolveTargetRel(importerRel, specifier);
  if (targetRel !== null && TEST_TARGET_RE.test(path.posix.basename(targetRel))) return targetRel;
  return null;
}

interface Violation {
  file: string;
  line: number;
  kind: 'layering' | 'admin-index-cross' | 'cross-workspace-package' | 'production-imports-test';
  from: string;
  to: string;
  specifier: string;
  text: string;
}

/** Per-file scan: cross-workspace-package (every production file, any zone or
 * none) + layering/admin-users-index (zoned files only) violations for one
 * production file. */
function scanFileForViolations(rel: string, content: string): Violation[] {
  const sourceZone = zoneOf(rel);
  const violations: Violation[] = [];

  for (const edge of parseImportEdges(rel, content)) {
    const packagesTarget = packagesEscapeTarget(rel, edge.specifier);
    if (packagesTarget !== null) {
      violations.push({
        file: rel,
        line: edge.line,
        kind: 'cross-workspace-package',
        from: rel,
        to: packagesTarget,
        specifier: edge.specifier,
        text: edge.raw,
      });
    }

    const testTarget = testFileImportTarget(rel, edge.specifier);
    if (testTarget !== null) {
      violations.push({
        file: rel,
        line: edge.line,
        kind: 'production-imports-test',
        from: rel,
        to: testTarget,
        specifier: edge.specifier,
        text: edge.raw,
      });
    }

    if (!sourceZone) continue;
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

  // Dynamic `import(...)` calls with a literal specifier are checked against
  // the SAME packages-escape rule as static edges above -- and only that
  // rule (layering/admin-index-cross stay static-edge-only; see
  // `parseDynamicImportEdges`'s doc comment for why).
  for (const dyn of parseDynamicImportEdges(rel, content)) {
    const packagesTarget = packagesEscapeTarget(rel, dyn.specifier);
    if (packagesTarget !== null) {
      violations.push({
        file: rel,
        line: dyn.line,
        kind: 'cross-workspace-package',
        from: rel,
        to: packagesTarget,
        specifier: dyn.specifier,
        text: dyn.raw,
      });
    }

    const testTarget = testFileImportTarget(rel, dyn.specifier);
    if (testTarget !== null) {
      violations.push({
        file: rel,
        line: dyn.line,
        kind: 'production-imports-test',
        from: rel,
        to: testTarget,
        specifier: dyn.specifier,
        text: dyn.raw,
      });
    }
  }

  return violations;
}

/** Full-tree scan: every production file under `root`. The three governed
 * zones (pages/api/shared) are where layering/admin-index violations can
 * occur (`scanFileForViolations` no-ops those checks for an unzoned file),
 * but the cross-workspace-package check (web-package-boundary) applies to
 * every production file regardless of zone -- so this walk is no longer
 * zone-gated, and `filesExamined` now counts (and the existing
 * non-zero-files assertion below now proves) that the packages-check's walk
 * reaches real files too, not just the zoned ones. */
function scanTree(root: string): { violations: Violation[]; filesExamined: number } {
  const files = walk(root);
  let filesExamined = 0;
  const violations: Violation[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!isProductionFile(rel)) continue;
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

  it('parseDynamicImportEdges: a literal-string dynamic import() is matched', () => {
    const edges = parseDynamicImportEdges(
      'fixture.ts',
      `async function f() { return await import('../index/AppShell'); }`,
    );
    expect(edges).toMatchObject([{ specifier: '../index/AppShell' }]);
  });

  it('parseDynamicImportEdges: a no-substitution template-literal dynamic import() is matched identically', () => {
    const edges = parseDynamicImportEdges(
      'fixture.ts',
      'async function f() { return await import(`../index/AppShell`); }',
    );
    expect(edges).toMatchObject([{ specifier: '../index/AppShell' }]);
  });

  it('parseDynamicImportEdges: a non-literal (variable) argument is NOT matched (disclosed residual)', () => {
    const edges = parseDynamicImportEdges(
      'fixture.ts',
      `async function f(spec: string) { return await import(spec); }`,
    );
    expect(edges).toEqual([]);
  });

  it('parseDynamicImportEdges: a template literal WITH a substitution is NOT matched (disclosed residual)', () => {
    const edges = parseDynamicImportEdges(
      'fixture.ts',
      `async function f(sub: string) { return await import(\`../\${sub}/AppShell\`); }`,
    );
    expect(edges).toEqual([]);
  });

  it('parseDynamicImportEdges: a type-position `typeof import(...)` reference is NOT matched (disclosed residual, distinct AST kind from CallExpression)', () => {
    const edges = parseDynamicImportEdges(
      'fixture.ts',
      `type X = typeof import('../../../../packages/domain/src/index');`,
    );
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

  it('packagesEscapeTarget: a relative import that normalizes to escape web/src into packages/ is detected', () => {
    // 'shared/stray.ts' -> importerDir 'shared' (depth 1); 3 `../` cancels the
    // 1 real segment and leaves 2 escaping `../`, landing on `packages/...`.
    expect(packagesEscapeTarget('shared/stray.ts', '../../../packages/domain/src/index')).toBe(
      '../../packages/domain/src/index',
    );
  });

  it('packagesEscapeTarget: an @autologger/* bare specifier is detected regardless of importer location', () => {
    expect(packagesEscapeTarget('pages/index/main.tsx', '@autologger/domain')).toBe(
      '@autologger/domain',
    );
    expect(packagesEscapeTarget('shared/foo.ts', '@autologger/ai-runtime')).toBe(
      '@autologger/ai-runtime',
    );
  });

  it('packagesEscapeTarget: an ordinary internal relative import is NOT flagged', () => {
    expect(packagesEscapeTarget('pages/index/main.tsx', '../../api/bar')).toBeNull();
  });

  it('packagesEscapeTarget: an ordinary third-party bare specifier is NOT flagged', () => {
    expect(packagesEscapeTarget('pages/index/main.tsx', 'react')).toBeNull();
    expect(packagesEscapeTarget('shared/foo.ts', '@testing-library/react')).toBeNull();
  });

  it('scanFileForViolations: flags a cross-workspace-package import even when type-only (no carve-out, unlike layering)', () => {
    const v = scanFileForViolations(
      'shared/foo.ts',
      typeImport('DomainType', '../../packages/domain/src/index'),
    );
    expect(v.some((viol) => viol.kind === 'cross-workspace-package')).toBe(true);
  });

  it('scanFileForViolations: flags a DYNAMIC cross-workspace-package import (relative path) -- closes the demonstrated hole', () => {
    const v = scanFileForViolations(
      'shared/foo.ts',
      `async function f() { return await import('../../packages/domain/src/index'); }`,
    );
    expect(v).toMatchObject([
      { kind: 'cross-workspace-package', to: '../packages/domain/src/index' },
    ]);
  });

  it('scanFileForViolations: flags a DYNAMIC cross-workspace-package import (@autologger/* bare specifier)', () => {
    const v = scanFileForViolations(
      'shared/foo.ts',
      `async function f() { return await import('@autologger/domain'); }`,
    );
    expect(v).toMatchObject([{ kind: 'cross-workspace-package', to: '@autologger/domain' }]);
  });

  it('scanFileForViolations: does NOT flag a dynamic import whose target is a non-literal expression, even one that would otherwise resolve into packages/ (disclosed residual)', () => {
    const v = scanFileForViolations(
      'shared/foo.ts',
      [
        "const pkgPath = '../../packages/domain/src/index';",
        'async function f() { return await import(pkgPath); }',
      ].join('\n'),
    );
    expect(v).toEqual([]);
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

describe('cross-workspace-package guard — end-to-end mutation check (web-package-boundary)', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function freshRoot(prefix: string): string {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(tmpRoot, 'pages', 'index'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'shared'), { recursive: true });
    return tmpRoot;
  }

  it('DOES fire on a production relative import that escapes web/src into packages/', () => {
    const root = freshRoot('web-boundaries-pkg-relative-');
    fs.writeFileSync(
      path.join(root, 'shared', 'stray.ts'),
      valueImport('foo', '../../../packages/domain/src/index'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some((v) => v.kind === 'cross-workspace-package' && v.file === 'shared/stray.ts'),
    ).toBe(true);
  });

  it('DOES fire on a production @autologger/* bare-specifier import', () => {
    const root = freshRoot('web-boundaries-pkg-bare-');
    fs.writeFileSync(
      path.join(root, 'shared', 'strayBare.ts'),
      valueImport('foo', '@autologger/domain'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/strayBare.ts',
      ),
    ).toBe(true);
  });

  it('DOES fire on, and COUNT, a production file outside the three governed zones (proves the walk widened, not just a new zone-scoped check)', () => {
    const root = freshRoot('web-boundaries-pkg-unzoned-');
    fs.mkdirSync(path.join(root, 'types'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'types', 'ambient.ts'),
      valueImport('foo', '@autologger/domain'),
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(1);
    expect(
      violations.some((v) => v.kind === 'cross-workspace-package' && v.file === 'types/ambient.ts'),
    ).toBe(true);
  });

  it('does NOT fire on a conforming tree (internal imports + an ordinary third-party bare specifier)', () => {
    const root = freshRoot('web-boundaries-pkg-clean-');
    fs.writeFileSync(
      path.join(root, 'pages', 'index', 'main.tsx'),
      [valueImport('bar', '../../api/bar'), valueImport('clsx', 'clsx')].join('\n'),
    );
    fs.writeFileSync(path.join(root, 'api', 'bar.ts'), valueImport('baz', '../shared/baz'));
    fs.writeFileSync(path.join(root, 'shared', 'baz.ts'), 'export const baz = 1;\n');
    const { violations } = scanTree(root);
    expect(violations.filter((v) => v.kind === 'cross-workspace-package')).toEqual([]);
  });

  it('a test file crossing into packages/ is not scanned (mirrors the pinning test exemption)', () => {
    const root = freshRoot('web-boundaries-pkg-testfile-');
    fs.writeFileSync(
      path.join(root, 'shared', 'strayBare.pinning.test.ts'),
      valueImport('foo', '@autologger/domain'),
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(0);
    expect(violations).toEqual([]);
  });

  // --- Dynamic-import hole (task-1-2 report addendum) --------------------
  // Same shape of mutation pair as the static-import cases above, extended
  // to a literal-argument `import(...)` call -- this is the exact form
  // demonstrated to evade the original static-only walk while still passing
  // `tsc --noEmit -p web`.

  it('DOES fire on a DYNAMIC production relative import that escapes web/src into packages/ (closes the demonstrated hole)', () => {
    const root = freshRoot('web-boundaries-pkg-dynamic-relative-');
    fs.writeFileSync(
      path.join(root, 'shared', 'strayDynamic.ts'),
      `export async function sneak() { return await import('../../packages/domain/src/index'); }\n`,
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/strayDynamic.ts',
      ),
    ).toBe(true);
  });

  it('DOES fire on a DYNAMIC production @autologger/* bare-specifier import', () => {
    const root = freshRoot('web-boundaries-pkg-dynamic-bare-');
    fs.writeFileSync(
      path.join(root, 'shared', 'strayDynamicBare.ts'),
      `export async function sneak() { return await import('@autologger/domain'); }\n`,
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/strayDynamicBare.ts',
      ),
    ).toBe(true);
  });

  it('a test file crossing into packages/ via a DYNAMIC import is not scanned (mirrors clientAggregates.pinning.test.ts)', () => {
    const root = freshRoot('web-boundaries-pkg-dynamic-testfile-');
    fs.writeFileSync(
      path.join(root, 'shared', 'strayDynamic.pinning.test.ts'),
      `export async function sneak() { return await import('@autologger/domain'); }\n`,
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(0);
    expect(violations).toEqual([]);
  });

  it('does NOT fire on a DYNAMIC import whose target is a non-literal expression, even one pointed at packages/ (disclosed residual -- proves current, deliberate behavior rather than an accident)', () => {
    const root = freshRoot('web-boundaries-pkg-dynamic-nonliteral-');
    fs.writeFileSync(
      path.join(root, 'shared', 'strayNonLiteral.ts'),
      [
        "const pkgPath = '../../packages/domain/src/index';",
        'export async function sneak() { return await import(pkgPath); }',
      ].join('\n'),
    );
    const { violations } = scanTree(root);
    expect(violations.filter((v) => v.kind === 'cross-workspace-package')).toEqual([]);
  });
});

describe('phase-1 fix wave regression tests (web-package-boundary review — findings F1-F7)', () => {
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

  it('F1: DOES fire on an alias-plus-".." escape (`@/shared/../../../packages/domain/src/index`) that bundled real package code while un-normalized', () => {
    const root = freshRoot('web-boundaries-f1-alias-escape-');
    fs.writeFileSync(
      path.join(root, 'shared', 'attackF1.ts'),
      valueImport('foo', '@/shared/../../../packages/domain/src/index'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/attackF1.ts',
      ),
    ).toBe(true);
  });

  it('F2: the same alias-plus-".." shape no longer mis-zones the admin-index-cross rule', () => {
    const root = freshRoot('web-boundaries-f2-alias-mismzone-');
    fs.writeFileSync(
      path.join(root, 'pages', 'admin-users', 'attackF2.ts'),
      valueImport('AppShell', '@/shared/../pages/index/AppShell'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'admin-index-cross' && v.file === 'pages/admin-users/attackF2.ts',
      ),
    ).toBe(true);
  });

  it('F3: DOES fire on an explicit relative path through `node_modules/@autologger/*` (the workspace symlink target)', () => {
    const root = freshRoot('web-boundaries-f3-node-modules-');
    fs.writeFileSync(
      path.join(root, 'shared', 'attackF3.ts'),
      valueImport('foo', '../../../../node_modules/@autologger/domain/src/index'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/attackF3.ts',
      ),
    ).toBe(true);
  });

  it('F4: a production file under a directory named `build` inside web/src is now walked and scanned', () => {
    const root = freshRoot('web-boundaries-f4-build-dir-');
    fs.mkdirSync(path.join(root, 'shared', 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'shared', 'build', 'attackF4.ts'),
      valueImport('foo', '@autologger/domain'),
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBeGreaterThan(0);
    expect(
      violations.some(
        (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/build/attackF4.ts',
      ),
    ).toBe(true);
  });

  it('F4: `dist` and `coverage` directories under web/src are likewise walked (not just `build`)', () => {
    const root = freshRoot('web-boundaries-f4-dist-coverage-');
    fs.mkdirSync(path.join(root, 'shared', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shared', 'coverage'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'shared', 'dist', 'a.ts'),
      valueImport('foo', '@autologger/domain'),
    );
    fs.writeFileSync(
      path.join(root, 'shared', 'coverage', 'b.ts'),
      valueImport('foo', '@autologger/ai-runtime'),
    );
    const { violations } = scanTree(root);
    const files = violations.filter((v) => v.kind === 'cross-workspace-package').map((v) => v.file);
    expect(files).toContain('shared/dist/a.ts');
    expect(files).toContain('shared/coverage/b.ts');
  });

  it('F5: a symlinked directory under web/src is now followed, not silently skipped', () => {
    const root = freshRoot('web-boundaries-f5-symlink-');
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'web-boundaries-f5-target-'));
    fs.writeFileSync(path.join(target, 'attackF5.ts'), valueImport('foo', '@autologger/domain'));
    fs.symlinkSync(target, path.join(root, 'shared', 'symdir'), 'dir');
    try {
      const { violations } = scanTree(root);
      expect(
        violations.some(
          (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/symdir/attackF5.ts',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('F5: a symlink cycle (directory linking back to an ancestor) does not hang the walk', () => {
    const root = freshRoot('web-boundaries-f5-cycle-');
    fs.symlinkSync(root, path.join(root, 'shared', 'loopback'), 'dir');
    expect(() => scanTree(root)).not.toThrow();
  });

  it("F6: a `*.test.shim.ts` production file (not matched by vitest's `*.test.ts` glob) is no longer exempted by the substring test-file check", () => {
    const root = freshRoot('web-boundaries-f6-test-shim-');
    fs.writeFileSync(
      path.join(root, 'shared', 'attackF6.test.shim.ts'),
      valueImport('foo', '@autologger/domain'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/attackF6.test.shim.ts',
      ),
    ).toBe(true);
  });

  it('F6: a genuine `*.test.ts` file stays exempt (the suffix anchor does not over-tighten)', () => {
    const root = freshRoot('web-boundaries-f6-real-test-');
    fs.writeFileSync(
      path.join(root, 'shared', 'attackF6Control.test.ts'),
      valueImport('foo', '@autologger/domain'),
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(0);
    expect(violations).toEqual([]);
  });

  it('F7: DOES fire on an out-and-back relative escape that revisits `packages/` through an intermediate directory segment (generalized, not tied to a specific checkout name)', () => {
    const root = freshRoot('web-boundaries-f7-out-and-back-');
    fs.writeFileSync(
      path.join(root, 'shared', 'attackF7.ts'),
      valueImport('foo', '../../../some-checkout-dir/packages/domain/src/index'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'cross-workspace-package' && v.file === 'shared/attackF7.ts',
      ),
    ).toBe(true);
  });
});

describe('final fix wave (N1 — fixed): a production file SHALL NOT import a test file', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function freshRoot(prefix: string): string {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(tmpRoot, 'pages', 'index'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'shared'), { recursive: true });
    return tmpRoot;
  }

  it("N1: DOES fire when a production file imports a genuine `*.test.ts` file (production-imports-test) -- the fix-wave re-review's F6-transitive-shape survivor, now closed directly rather than by chasing what the test file itself imports", () => {
    const root = freshRoot('web-boundaries-n1-prod-imports-test-');
    // The genuine test file itself reaches into packages/ (matching the
    // re-review's exact attack shape) -- irrelevant to THIS check, which
    // fires on the production->test EDGE alone, not on what lies beyond it.
    fs.writeFileSync(
      path.join(root, 'shared', 'leakN1.test.ts'),
      valueImport('probe', '@autologger/domain'),
    );
    fs.writeFileSync(
      path.join(root, 'shared', 'consumerN1.ts'),
      `export { probe } from './leakN1.test';\n`,
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) =>
          v.kind === 'production-imports-test' &&
          v.file === 'shared/consumerN1.ts' &&
          v.to === 'shared/leakN1.test',
      ),
    ).toBe(true);
  });

  it("N1: fires identically for a DYNAMIC production->test edge (`import('./x.test')`)", () => {
    const root = freshRoot('web-boundaries-n1-dynamic-');
    fs.writeFileSync(path.join(root, 'shared', 'leakN1Dyn.test.ts'), 'export const probe = 1;\n');
    fs.writeFileSync(
      path.join(root, 'shared', 'consumerN1Dyn.ts'),
      `export async function f() { return await import('./leakN1Dyn.test'); }\n`,
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'production-imports-test' && v.file === 'shared/consumerN1Dyn.ts',
      ),
    ).toBe(true);
  });

  it('N1: an explicit-extension target (`./leakN1.test.ts`) is caught identically to the extension-less form', () => {
    const root = freshRoot('web-boundaries-n1-explicit-ext-');
    fs.writeFileSync(path.join(root, 'shared', 'leakN1Ext.test.ts'), 'export const probe = 1;\n');
    fs.writeFileSync(
      path.join(root, 'shared', 'consumerN1Ext.ts'),
      valueImport('probe', './leakN1Ext.test.ts'),
    );
    const { violations } = scanTree(root);
    expect(
      violations.some(
        (v) => v.kind === 'production-imports-test' && v.file === 'shared/consumerN1Ext.ts',
      ),
    ).toBe(true);
  });

  it('does NOT fire on an ordinary production->production edge (control)', () => {
    const root = freshRoot('web-boundaries-n1-control-');
    fs.writeFileSync(path.join(root, 'shared', 'ok.ts'), 'export const ok = 1;\n');
    fs.writeFileSync(path.join(root, 'shared', 'consumerOk.ts'), valueImport('ok', './ok'));
    const { violations } = scanTree(root);
    expect(violations.filter((v) => v.kind === 'production-imports-test')).toEqual([]);
  });

  it('does NOT flag the test file itself for its own (permitted) cross-workspace import -- only the production importer is examined', () => {
    // Mirrors the real clientAggregates.pinning.test.ts shape: the test file
    // is exempt from scanning entirely (isProductionFile), so it produces no
    // `production-imports-test` violation for its OWN import of a package.
    const root = freshRoot('web-boundaries-n1-testfile-exempt-');
    fs.writeFileSync(
      path.join(root, 'shared', 'pin.pinning.test.ts'),
      valueImport('probe', '@autologger/domain'),
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(0);
    expect(violations).toEqual([]);
  });
});

describe('final fix wave — disclosed, unfixed gaps (N2-N4; owner ruling: fix N1 only)', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function freshRoot(prefix: string): string {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(tmpRoot, 'pages', 'index'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'shared'), { recursive: true });
    return tmpRoot;
  }

  it('N2 (disclosed, NOT fixed): `import.meta.glob(...)` eager-globbing a packages/ path is invisible to the guard', () => {
    // Vite resolves and bundles `import.meta.glob`'s literal glob argument at
    // build time, exactly like a static `import` or a literal dynamic
    // `import(...)` -- but it is neither an ImportDeclaration/
    // ExportDeclaration (parseImportEdges) nor a `CallExpression` whose
    // callee is the bare `import` keyword (parseDynamicImportEdges checks
    // `node.expression.kind === ts.SyntaxKind.ImportKeyword`; here the
    // callee is a PropertyAccessExpression on `import.meta`, a distinct AST
    // shape). Neither walk matches it, so this is a real, undetected build-
    // time bundling primitive. Disclosed in the spec delta's threat model;
    // not fixed by this wave.
    const root = freshRoot('web-boundaries-n2-glob-');
    fs.writeFileSync(
      path.join(root, 'shared', 'globLeak.ts'),
      `export const modules = import.meta.glob('../../../packages/domain/src/studio.ts', { eager: true });\n`,
    );
    const { violations } = scanTree(root);
    expect(violations.filter((v) => v.kind === 'cross-workspace-package')).toEqual([]);
  });

  it('N3 (disclosed, NOT fixed): a directory literally named `node_modules` UNDER web/src is never walked, even though it is first-party code', () => {
    // EXCLUDED_DIR_NAMES keeps `node_modules` skipped -- inherited from
    // queryKeyFactories.repo.test.ts's own root-level skip-list precedent --
    // on the stated rationale "third-party code this policy does not
    // govern." That rationale is WRONG for this shape: a directory named
    // `node_modules` planted directly under `web/src` (not a real package
    // manager install; nothing under `web/src` ever is) is ordinary,
    // first-party, hand-authored source that merely carries a name the walk
    // treats as a magic skip signal. The walk excludes it anyway, so a file
    // planted here that reaches packages/ is never examined by any of this
    // file's four checks. Disclosed, not fixed.
    const root = freshRoot('web-boundaries-n3-node-modules-dir-');
    fs.mkdirSync(path.join(root, 'shared', 'node_modules'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'shared', 'node_modules', 'evilN3.ts'),
      valueImport('foo', '@autologger/domain'),
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(0);
    expect(violations).toEqual([]);
  });

  it('N4 (disclosed, NOT fixed): a symlinked FILE pointing into packages/ is scanned but not flagged, because its OWN internal imports look web/src-relative from where the symlink sits', () => {
    // walk()'s doc comment previously claimed symlinked files "were already
    // handled correctly ... and remain so." That is only half true: a
    // symlinked file IS walked and scanned (unlike a symlinked directory,
    // which F5 fixed) -- but scanning it does not help, because the
    // package-internal relative imports INSIDE the linked-to file resolve
    // relative to the symlink's own location under web/src, not to its real
    // location under packages/. The file's content is genuine package
    // source living inside web/src by construction, and nothing about that
    // is visible to a specifier-string check. Disclosed, not fixed.
    const root = freshRoot('web-boundaries-n4-symlink-file-');
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'web-boundaries-n4-target-'));
    const targetFile = path.join(target, 'packageSource.ts');
    fs.writeFileSync(targetFile, 'export const foo = 1;\n');
    fs.symlinkSync(targetFile, path.join(root, 'shared', 'leakN4.ts'));
    fs.writeFileSync(path.join(root, 'shared', 'consumerN4.ts'), valueImport('foo', './leakN4'));
    try {
      const { violations } = scanTree(root);
      expect(violations.filter((v) => v.kind === 'cross-workspace-package')).toEqual([]);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
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

  it('contains ZERO cross-workspace-package violations (web-package-boundary: no production web/src file reaches packages/)', () => {
    const { violations } = scanTree(WEB_SRC);
    expect(violations.filter((v) => v.kind === 'cross-workspace-package')).toEqual([]);
  });

  it('contains ZERO production-imports-test violations (final fix wave, N1: no production file imports a test file)', () => {
    const { violations } = scanTree(WEB_SRC);
    expect(violations.filter((v) => v.kind === 'production-imports-test')).toEqual([]);
  });

  it("the pinning test's dynamic cross-workspace import stays permitted (test files are exempt from the walk entirely)", () => {
    const rel = 'pages/index/components/aiV2/clientAggregates.pinning.test.ts';
    const content = fs.readFileSync(path.join(WEB_SRC, rel), 'utf8');
    expect(content).toContain(
      "await import('../../../../../../packages/ai-runtime/src/aggregates.ts')",
    );
    // isProductionFile is what the walk actually relies on to skip it.
    expect(isProductionFile(rel)).toBe(false);
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
