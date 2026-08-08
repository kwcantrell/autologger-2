import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// --- Package boundary + layer-graph guard ---
// (openspec/changes/package-split-foundation, design D9; spec
// "package-architecture" requirement "Workspace packages form an acyclic,
// down-only layer graph enforced by a repo test"; task 1.3.)
//
// WHY THIS EXISTS. Panel-verified (design.md D1/D9, three independent sandbox
// replicas): npm workspace hoisting resolves an UNDECLARED cross-package
// import just fine, and `tsc --noEmit` never reads a package.json's
// `dependencies` at all — so nothing in the toolchain stops
// `packages/ports/src/*` from importing `@autologger/domain` without
// declaring it, or reaching straight into `server/src`. This repo test is the
// boundary enforcement the compiler structurally cannot provide.
//
// THREE CHECKS over every `packages/*/src/**/*.ts` file's import specifiers
// (spec requirement, D2's declared layer order):
//   (a) undeclared dependency — a `@autologger/*` specifier not present in
//       the importing package's own `dependencies`/`peerDependencies`;
//   (b) app-internal / cross-package escape — a relative specifier that
//       resolves outside the importing file's OWN package `src/` root (into
//       `server/src`, `web/src`, or even a sibling package's `src/` reached
//       by a relative path instead of its `@autologger/*` specifier — the
//       manifest check in (a) is worthless if a relative path can walk
//       around it), or a bare specifier naming an app workspace package
//       directly (`autologger-server`, `autologger-web`,
//       `companion-module-autologger`);
//   (c) disallowed layer edge — a `@autologger/*` import whose direction
//       isn't one of D2's three allowed edges (`contract -> domain`,
//       `ports -> domain`, `ports -> contract`), independent of whether it
//       happens to be declared in the manifest: a package could legally
//       *declare* a backwards dependency and this check still has to catch
//       the edge itself.
//
// Import-specifier extraction is a dependency-free regex scan over file text
// (the same idiom `apiResponseShapes.repo.test.ts` and
// `cursorAdapters.repo.test.ts` use), not a real TS parser — deliberately: a
// repo-invariant guard should not need the compiler to run to catch a
// boundary violation.
//
// MUTATION-CHECKED against a synthetic tmp package tree below (proves the
// checks actually fire, and don't always-fire), then run for real against
// `packages/*/src` — today an empty inter-package edge set, since no package
// imports another yet (2.x-4.x move real modules in and declare the D2
// edges). The negative case (spec scenario "Boundary test fails on a
// violation") is demonstrated out-of-band during implementation and recorded
// in `.apply/ledger.md`, not committed here as a fixture.
//
// EXTENSION POINT for task 6.2 (directory-graph acyclicity sweep over
// `server/src`, re-running after phases 3-4 kill the `session <-> aiV2` and
// `auth <-> node` directory cycles): `extractImportSpecifiers` and
// `findCycles` below are generic over any directory/file set and are the
// pieces that sweep should reuse rather than re-deriving a parallel walker.
// Deliberately NOT wired into a `server/src`-wide check yet — doing so today
// would require allowlisting the two known legacy cycles, and this file
// preassigned itself as their eventual removal site; adding that allowlist
// now would just be more state task 6.2 has to remember to delete.

// ---------------------------------------------------------------------------
// Import-specifier extraction (dependency-free regex scan)
// ---------------------------------------------------------------------------

/** Every import/export/dynamic-import specifier a TS source file's text
 * names, in encounter order (duplicates included — callers care about
 * distinct violations, not distinct specifiers). Matches:
 *   - `import ... from 'x'` / `import type ... from 'x'` (any clause shape)
 *   - `export ... from 'x'` / `export type ... from 'x'` / `export * from 'x'`
 *   - side-effect-only `import 'x'`
 *   - dynamic `import('x')`
 * Non-greedy `[^;]*?` between the keyword and `from` cannot cross a `;`, so
 * adjacent semicolon-terminated statements on one line can't bleed into each
 * other; this repo's lint config requires semicolons, so that's the only
 * shape in practice. */
function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const fromClauseRe = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(fromClauseRe)) specifiers.push(m[1]);
  const sideEffectRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const m of content.matchAll(sideEffectRe)) specifiers.push(m[1]);
  const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of content.matchAll(dynamicRe)) specifiers.push(m[1]);
  return specifiers;
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

function walkTsFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkTsFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function relOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

interface PackageManifest {
  name: string;
  dir: string;
  declaredDeps: Set<string>;
}

/** Reads every immediate subdirectory of `packagesRoot` that has a
 * `package.json` as a package manifest — `dependencies` and
 * `peerDependencies` merged into one declared-deps set (D2's `contract`'s
 * `zod` peerDependency and any `@autologger/*` dependency are both
 * "declared" for boundary purposes; the runtime-identity distinction between
 * dependency and peerDependency is D8's concern, not this guard's). */
function discoverPackages(packagesRoot: string): PackageManifest[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: PackageManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesRoot, entry.name);
    const pkgJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declaredDeps = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    result.push({ name: pkg.name, dir, declaredDeps });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Boundary checks
// ---------------------------------------------------------------------------

/** D2's declared layer order — the only inter-package edges any package's
 * import graph is allowed to contain, regardless of manifest declaration. */
const ALLOWED_LAYER_EDGES = new Set<string>([
  '@autologger/contract->@autologger/domain',
  '@autologger/ports->@autologger/domain',
  '@autologger/ports->@autologger/contract',
  // persistence-package-extraction task 2.1 (design D1/D6): storage's only
  // permitted L1 edge — it speaks ports, never a sibling L1 package.
  '@autologger/storage->@autologger/ports',
  // persistence-package-extraction task 3.1 (design D1/D6): catalog's two
  // permitted L1 edges — domain (pure predicates/normalizers) and ports (the
  // CatalogDb port it speaks through); no better-sqlite3, no storage sibling.
  '@autologger/catalog->@autologger/domain',
  '@autologger/catalog->@autologger/ports',
  // persistence-package-extraction task 4.2 (design D1/D6): session-core's
  // three permitted L1 edges. Added ahead of the task 4.3 module move (the
  // package has no production imports yet beyond a placeholder) so the move
  // commit's gate is green from the first file it lands, not red until the
  // last one; no storage/catalog sibling edge.
  '@autologger/session-core->@autologger/domain',
  '@autologger/session-core->@autologger/contract',
  '@autologger/session-core->@autologger/ports',
]);

/** Bare specifiers naming an app workspace's own package.json `name` — the
 * "or via bare workspace specifiers" clause of the spec requirement. */
const APP_WORKSPACE_BARE_NAMES = new Set([
  'autologger-server',
  'autologger-web',
  'companion-module-autologger',
]);

type ViolationKind = 'undeclared-dependency' | 'escape' | 'disallowed-layer-edge';

interface BoundaryViolation {
  file: string;
  specifier: string;
  kind: ViolationKind;
  detail: string;
}

/** The full boundary scan over `packagesRoot`'s packages, parameterized over
 * `repoRoot` so it runs identically against a synthetic tmp tree (mutation
 * checks below) and the real repo (the actual guard). */
function checkPackagesBoundary(repoRoot: string): BoundaryViolation[] {
  const packagesRoot = path.join(repoRoot, 'packages');
  const packages = discoverPackages(packagesRoot);
  const violations: BoundaryViolation[] = [];

  for (const pkg of packages) {
    const srcDir = path.join(pkg.dir, 'src');
    for (const file of walkTsFiles(srcDir)) {
      const relFile = relOf(repoRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      for (const specifier of extractImportSpecifiers(content)) {
        if (specifier.startsWith('@autologger/')) {
          const targetName = specifier.split('/').slice(0, 2).join('/');
          if (targetName === pkg.name) continue; // self-import: not a cross-package edge
          if (!pkg.declaredDeps.has(targetName)) {
            violations.push({
              file: relFile,
              specifier,
              kind: 'undeclared-dependency',
              detail: `${pkg.name} imports ${targetName} but does not declare it in dependencies/peerDependencies`,
            });
          }
          const edge = `${pkg.name}->${targetName}`;
          if (!ALLOWED_LAYER_EDGES.has(edge)) {
            violations.push({
              file: relFile,
              specifier,
              kind: 'disallowed-layer-edge',
              detail: `disallowed layer edge ${edge} (allowed: ${[...ALLOWED_LAYER_EDGES].join(', ')})`,
            });
          }
        } else if (specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), specifier);
          const ownSrcDir = srcDir;
          const withinOwnPackage =
            resolved === ownSrcDir || resolved.startsWith(ownSrcDir + path.sep);
          if (!withinOwnPackage) {
            const relResolved = relOf(repoRoot, resolved);
            violations.push({
              file: relFile,
              specifier,
              kind: 'escape',
              detail: `relative import escapes ${pkg.name}'s own src/ root, resolving to ${relResolved}`,
            });
          }
        } else if (APP_WORKSPACE_BARE_NAMES.has(specifier)) {
          violations.push({
            file: relFile,
            specifier,
            kind: 'escape',
            detail: `bare specifier names an app workspace package directly: ${specifier}`,
          });
        }
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Cycle detection (generic graph utility — task 6.2's reuse point)
// ---------------------------------------------------------------------------

/** Standard DFS 3-color cycle detection over an adjacency map. Returns one
 * representative cycle (as a node path, first node repeated at the end) per
 * strongly-connected back-edge found; empty when the graph is acyclic.
 * Generic over any string-keyed directed graph — not specific to packages —
 * so task 6.2's `server/src` directory-graph sweep can call this directly
 * instead of reimplementing traversal. */
function findCycles(edges: Map<string, Set<string>>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cycles: string[][] = [];

  function visit(node: string, stack: string[]) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === WHITE) {
        visit(next, stack);
      } else if (c === GRAY) {
        const idx = stack.indexOf(next);
        cycles.push([...stack.slice(idx), next]);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of edges.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node, []);
  }
  return cycles;
}

/** Builds the inter-package edge set actually present in `packagesRoot`'s
 * source (not the manifest-declared set — the graph this test asserts is
 * acyclic against is the graph of what the code actually imports). */
function packageImportGraph(repoRoot: string): Map<string, Set<string>> {
  const packagesRoot = path.join(repoRoot, 'packages');
  const packages = discoverPackages(packagesRoot);
  const graph = new Map<string, Set<string>>(packages.map((p) => [p.name, new Set<string>()]));
  for (const pkg of packages) {
    const srcDir = path.join(pkg.dir, 'src');
    for (const file of walkTsFiles(srcDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const specifier of extractImportSpecifiers(content)) {
        if (!specifier.startsWith('@autologger/')) continue;
        const targetName = specifier.split('/').slice(0, 2).join('/');
        if (targetName === pkg.name) continue;
        graph.get(pkg.name)?.add(targetName);
      }
    }
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Real repo root
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
// this file: server/src/packageBoundaries.repo.test.ts -> repo root is two levels up.
const REPO_ROOT = path.resolve(here, '..', '..');

// ---------------------------------------------------------------------------
// Mutation checks — prove the predicates actually fire, and don't always-fire
// ---------------------------------------------------------------------------

describe('checkPackagesBoundary (mutation check on a synthetic package tree)', () => {
  let tmpRoot: string;

  function writeTree(root: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  const CLEAN_FILES: Record<string, string> = {
    'packages/domain/package.json': JSON.stringify({ name: '@autologger/domain' }),
    'packages/domain/src/index.ts': `export const x = 1;\n`,
    'packages/contract/package.json': JSON.stringify({
      name: '@autologger/contract',
      dependencies: { '@autologger/domain': '*' },
    }),
    'packages/contract/src/index.ts': `import { x } from '@autologger/domain';\nexport const y = x;\n`,
    'packages/ports/package.json': JSON.stringify({
      name: '@autologger/ports',
      dependencies: { '@autologger/domain': '*', '@autologger/contract': '*' },
    }),
    'packages/ports/src/index.ts': `import { x } from '@autologger/domain';\nimport { y } from '@autologger/contract';\nexport const z = x + y;\n`,
    'server/src/marker.ts': `export const marker = true;\n`,
    'web/src/marker.ts': `export const marker = true;\n`,
  };

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a clean tree with declared deps and the allowed layer order produces zero violations', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-boundary-clean-'));
    writeTree(tmpRoot, CLEAN_FILES);
    expect(checkPackagesBoundary(tmpRoot)).toEqual([]);
  });

  it('DOES flag an undeclared cross-package import (proves the manifest check is not vacuous)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-boundary-undeclared-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      'packages/ports/package.json': JSON.stringify({ name: '@autologger/ports' }), // deps dropped
    });
    const violations = checkPackagesBoundary(tmpRoot);
    expect(
      violations.some(
        (v) => v.kind === 'undeclared-dependency' && v.detail.includes('@autologger/domain'),
      ),
    ).toBe(true);
  });

  it('DOES flag a declared-but-backwards layer edge (domain -> contract)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-boundary-backwards-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      'packages/domain/package.json': JSON.stringify({
        name: '@autologger/domain',
        dependencies: { '@autologger/contract': '*' }, // declared, still disallowed direction
      }),
      'packages/domain/src/index.ts': `import { y } from '@autologger/contract';\nexport const x = y;\n`,
    });
    const violations = checkPackagesBoundary(tmpRoot);
    expect(
      violations.some(
        (v) =>
          v.kind === 'disallowed-layer-edge' &&
          v.detail.includes('@autologger/domain->@autologger/contract'),
      ),
    ).toBe(true);
  });

  it('DOES flag a relative import reaching into server/src', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-boundary-server-escape-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      'packages/domain/src/index.ts': `import { marker } from '../../../server/src/marker';\nexport const x = marker;\n`,
    });
    const violations = checkPackagesBoundary(tmpRoot);
    expect(
      violations.some((v) => v.kind === 'escape' && v.detail.includes('server/src/marker')),
    ).toBe(true);
  });

  it('DOES flag a relative import reaching into web/src', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-boundary-web-escape-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      'packages/domain/src/index.ts': `import { marker } from '../../../web/src/marker';\nexport const x = marker;\n`,
    });
    const violations = checkPackagesBoundary(tmpRoot);
    expect(violations.some((v) => v.kind === 'escape' && v.detail.includes('web/src/marker'))).toBe(
      true,
    );
  });

  it('DOES flag a relative import that reaches into a sibling package src, bypassing its manifest declaration', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-boundary-sibling-escape-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      'packages/domain/src/index.ts': `import { y } from '../../contract/src/index';\nexport const x = y;\n`,
    });
    const violations = checkPackagesBoundary(tmpRoot);
    expect(
      violations.some((v) => v.kind === 'escape' && v.detail.includes('contract/src/index')),
    ).toBe(true);
  });

  it('DOES flag a bare specifier naming an app workspace package directly', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-boundary-bare-workspace-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      'packages/domain/src/index.ts': `import { marker } from 'autologger-server';\nexport const x = marker;\n`,
    });
    const violations = checkPackagesBoundary(tmpRoot);
    expect(
      violations.some((v) => v.kind === 'escape' && v.detail.includes('autologger-server')),
    ).toBe(true);
  });

  it('does NOT flag a self-import by the package naming itself', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-boundary-self-import-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      'packages/domain/src/other.ts': `import { x } from '@autologger/domain';\nexport const w = x;\n`,
    });
    const violations = checkPackagesBoundary(tmpRoot);
    expect(violations).toEqual([]);
  });
});

describe('extractImportSpecifiers (mutation check)', () => {
  it('extracts a named import, a type-only import, a side-effect import, and a dynamic import', () => {
    const content = [
      `import { a, b } from 'named-mod';`,
      `import type { C } from 'type-mod';`,
      `import 'side-effect-mod';`,
      `const x = await import('dynamic-mod');`,
    ].join('\n');
    const specifiers = extractImportSpecifiers(content);
    expect(specifiers).toContain('named-mod');
    expect(specifiers).toContain('type-mod');
    expect(specifiers).toContain('side-effect-mod');
    expect(specifiers).toContain('dynamic-mod');
  });

  it('extracts a re-export and a wildcard export', () => {
    const content = [`export { a } from 're-export-mod';`, `export * from 'wildcard-mod';`].join(
      '\n',
    );
    const specifiers = extractImportSpecifiers(content);
    expect(specifiers).toContain('re-export-mod');
    expect(specifiers).toContain('wildcard-mod');
  });

  it('handles a multi-line import clause without bleeding into the next statement', () => {
    const content = [
      `import {`,
      `  a,`,
      `  b,`,
      `} from 'multi-line-mod';`,
      `import { c } from 'next-mod';`,
    ].join('\n');
    const specifiers = extractImportSpecifiers(content);
    expect(specifiers).toContain('multi-line-mod');
    expect(specifiers).toContain('next-mod');
    // Must not have fused the two statements into one over-long match.
    expect(specifiers.filter((s) => s === 'multi-line-mod' || s === 'next-mod')).toHaveLength(2);
  });
});

describe('findCycles (mutation check)', () => {
  it('reports no cycles for an acyclic graph', () => {
    const graph = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set()],
    ]);
    expect(findCycles(graph)).toEqual([]);
  });

  it('DOES report a 2-node cycle', () => {
    const graph = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['a'])],
    ]);
    expect(findCycles(graph).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The real guard
// ---------------------------------------------------------------------------

describe('packages/* boundary — real repo (spec: "Boundary test fails on a violation")', () => {
  it('every packages/* import is declared, stays inside its own src or a declared dependency, and follows the layer order', () => {
    const violations = checkPackagesBoundary(REPO_ROOT);
    expect(violations).toEqual([]);
  });
});

describe('packages/* layer graph — real repo (spec: "L0 packages do not reach upward")', () => {
  it('the actual inter-package import graph is acyclic and contains only the D2-allowed edges', () => {
    const graph = packageImportGraph(REPO_ROOT);
    expect(findCycles(graph)).toEqual([]);
    for (const [from, targets] of graph) {
      for (const to of targets) {
        expect(ALLOWED_LAYER_EDGES.has(`${from}->${to}`)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Task 6.1 — dedicated enforcement checks (design D6): the checks genuinely
// new to this phase, on top of the per-phase `ALLOWED_LAYER_EDGES` /
// `SERVER_SRC_LAYER_DIRS` deltas already landed in phases 2-4. All three
// reuse the walker/extraction primitives above rather than deriving a
// parallel one. Negative-case coverage for these three checks is a
// one-time, working-tree-only demonstration recorded in `.apply/ledger.md`
// (task 6.2) — matching this file's existing discipline for the original
// three checks (see the file-header note above): a repo-invariant guard
// doesn't ship permanent fixtures proving its own violations.
// ---------------------------------------------------------------------------

/** The three layer-1 sibling packages (design D1): each may reach downward
 * into L0 only, never into another L1 package. This check is deliberately
 * independent of `ALLOWED_LAYER_EDGES` above (rather than trusting that set
 * to simply omit L1-L1 entries) so a future edit that mistakenly ADDS an
 * L1-L1 edge to `ALLOWED_LAYER_EDGES` itself cannot silently defeat the
 * sibling rule — this is the "no-L1->L1-sibling assertion" task 6.1 calls
 * for. */
const L1_PACKAGES = new Set<string>([
  '@autologger/session-core',
  '@autologger/catalog',
  '@autologger/storage',
]);

describe('L1 packages are siblings — no L1 package imports another L1 package (task 6.1, design D1)', () => {
  it('the real inter-package import graph contains no edge between two L1 packages', () => {
    const graph = packageImportGraph(REPO_ROOT);
    const siblingViolations: string[] = [];
    for (const [from, targets] of graph) {
      if (!L1_PACKAGES.has(from)) continue;
      for (const to of targets) {
        if (L1_PACKAGES.has(to)) siblingViolations.push(`${from}->${to}`);
      }
    }
    expect(siblingViolations).toEqual([]);
  });
});

// Third-party bare-specifier vs manifest check, over PRODUCTION source only
// (design D6, spec scenario "Boundary test fails on an undeclared third-party
// specifier"). Every third-party bare specifier a package's production
// source imports must be declared in that package's own
// `dependencies`/`peerDependencies` — an undeclared import resolves today
// only via npm workspace hoisting from the server workspace's installs,
// which is exactly the silent-duplication risk D5/D8 close for
// `better-sqlite3`. `*.test.ts` files and each package's REVIEWED, explicit
// test-infrastructure exemption list (below) are exempt and may use
// devDependencies (`vitest`) freely.
//
// Type-only-import decision: every import specifier counts, including
// `import type { X } from 'y'`. `tsc` erases type-only imports at build
// time, but this check is about MANIFEST DECLARATION HONESTY, not runtime
// necessity (design D6's wording: "every third-party bare specifier
// imported") — a type-only import from an undeclared third-party package
// still means the manifest misrepresents what the source touches, and would
// silently ride on hoisting the moment that same import needed a value.
const NODE_BUILTIN_PREFIX = 'node:';

/** Reviewed, explicit per-package test-infrastructure exemption list (design
 * D6: "named in a per-package list inside the boundary test — reviewed, not
 * improvised"). Both listed files import `vitest` (a devDependency) and are
 * non-exported test infrastructure consumed only by that package's own unit
 * tests, never by production modules (see each file's own header comment for
 * the duplicate-per-package provenance decided at tasks 2.4/4.3). Paths are
 * package-relative. `@autologger/catalog` has no test-infrastructure files
 * outside `*.test.ts`, so it has no entry here. */
const TEST_INFRASTRUCTURE_EXEMPTIONS: Record<string, readonly string[]> = {
  '@autologger/storage': ['src/test/fakeClock.ts'],
  '@autologger/session-core': ['src/test/fakeClock.ts', 'src/test/fakeCore.ts'],
};

interface ThirdPartyViolation {
  file: string;
  specifier: string;
  detail: string;
}

/** The bare package name a third-party specifier resolves to for manifest
 * lookup — `@scope/pkg/subpath` -> `@scope/pkg`, `pkg/subpath` -> `pkg` (the
 * same two-segments-if-scoped-else-one-segment shape `checkPackagesBoundary`
 * already applies to `@autologger/*` specifiers above). */
function thirdPartyPackageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

/** Every third-party (non-`@autologger/*`, non-relative, non-`node:`) bare
 * specifier imported by a package's production source, cross-checked against
 * that package's own declared `dependencies`/`peerDependencies`. */
function checkThirdPartySpecifiers(repoRoot: string): ThirdPartyViolation[] {
  const packagesRoot = path.join(repoRoot, 'packages');
  const packages = discoverPackages(packagesRoot);
  const violations: ThirdPartyViolation[] = [];
  for (const pkg of packages) {
    const srcDir = path.join(pkg.dir, 'src');
    const exemptFiles = new Set(
      (TEST_INFRASTRUCTURE_EXEMPTIONS[pkg.name] ?? []).map((rel) =>
        path.join(pkg.dir, ...rel.split('/')),
      ),
    );
    for (const file of walkTsFiles(srcDir)) {
      if (file.endsWith('.test.ts')) continue;
      if (exemptFiles.has(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const specifier of extractImportSpecifiers(content)) {
        if (specifier.startsWith('.')) continue;
        if (specifier.startsWith('@autologger/')) continue;
        if (specifier.startsWith(NODE_BUILTIN_PREFIX)) continue;
        const pkgName = thirdPartyPackageName(specifier);
        if (!pkg.declaredDeps.has(pkgName)) {
          violations.push({
            file: relOf(repoRoot, file),
            specifier,
            detail: `${pkg.name}'s production source imports third-party specifier '${specifier}' but its manifest does not declare '${pkgName}' in dependencies/peerDependencies`,
          });
        }
      }
    }
  }
  return violations;
}

describe('packages/* third-party bare specifiers are declared in the manifest (task 6.1, design D6)', () => {
  it('every third-party specifier imported by production source is declared (dependencies/peerDependencies)', () => {
    expect(checkThirdPartySpecifiers(REPO_ROOT)).toEqual([]);
  });
});

// Interface-only assertion (design D3; spec "Persistence facades are
// consumed through package-exported interfaces" / "Interface-only
// consumption is continuously enforced"): among server/src PRODUCTION files,
// only `node/config.ts` (the composition root) may import the concrete
// persistence classes from `@autologger/session-core` / `@autologger/catalog`
// as named imports. Everyone else consumes the facade interfaces, which are
// all named with a `Facade` suffix (`SessionHubFacade`, `CatalogFacade`,
// ...) — a word-boundary match on the bare concrete identifier can't trip on
// them, since there is no word boundary between an identifier and an
// immediately-following `Facade` suffix (verified against the real barrel
// exports: `SessionHubFacade`, `SessionHubRegistryFacade`, `CatalogFacade`,
// `AuthStoreFacade`, `ShowsStoreFacade`, `StudioRegistryFacade`,
// `SessionIndexStoreFacade`, `ProfileAssemblerFacade`); likewise
// `createCatalog`/`CatalogDb` don't match `\bCatalog\b` for the same reason.
// This argument is about which identifiers appear IN a matched clause, a
// dimension orthogonal to which specifier string routed the clause to
// identifier-matching in the first place (design D7's prefix match on
// `CONCRETE_PACKAGE_SPECIFIERS`) — prefix-matching the specifier does not
// change how the clause's own text is scanned, so the argument still holds
// unchanged once subpath specifiers are also routed into this same
// identifier check.
const CONCRETE_PERSISTENCE_IDENTIFIERS = [
  'SessionHub',
  'SessionHubRegistry',
  'Catalog',
  'AuthStore',
  'ShowsStore',
  'StudioRegistry',
  'SessionIndexStore',
  'ProfileAssembler',
] as const;

const CONCRETE_PACKAGE_SPECIFIERS = new Set<string>([
  '@autologger/session-core',
  '@autologger/catalog',
]);

/** True when `specifier` names one of the concrete-bearing packages, either
 * as its bare specifier or through a subpath (design D7): every package
 * manifest declares a `./*` export map entry pointing at `./src/*.ts`, so
 * `@autologger/session-core/SessionHub` genuinely resolves and reaches the
 * concrete class same as the bare specifier — an exact-match `Set.has` check
 * lets that subpath slip past unflagged. */
function specifierNamesConcretePackage(specifier: string): boolean {
  for (const pkg of CONCRETE_PACKAGE_SPECIFIERS) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) return true;
  }
  return false;
}

const COMPOSITION_ROOT_REL = 'node/config.ts';

/** Captures an `import`/`export` clause's text (between the keyword and
 * `from`) alongside its specifier — a superset of `extractImportSpecifiers`'s
 * `fromClauseRe` (which discards the clause), needed here because the
 * violation is about WHICH identifiers a clause names, not just which module
 * it names. Widened from `\bimport\b` to `\b(?:import|export)\b` (design D7)
 * so a re-export clause is scanned too, not only an import clause — a bare
 * `import`-only match let a module re-export a concrete identifier from one
 * of the packages above without ever writing an import clause itself.
 *
 * The keyword alternation MUST stay non-capturing (`(?:...)`): a capturing
 * form shifts every later group index by one, so the code below that reads
 * group 1 as the clause and group 2 as the specifier would instead read the
 * matched keyword as the clause and the clause text as the "specifier" —
 * which can never equal a package name, so `specifierNamesConcretePackage`
 * would always return false and the whole check would silently pass on
 * every input. That failure mode produces no error and no red test; it was
 * only caught by writing task 4.3's mutation coverage. */
const IMPORT_CLAUSE_RE = /\b(?:import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g;

/** True when a captured clause is a wildcard/namespace form against one of
 * the concrete-bearing packages (design D7) — a bare `*`, optionally preceded
 * by a `type` keyword and optionally followed by an `as <name>` binding, with
 * no other named identifiers in the clause. This form is rejected outright
 * rather than identifier-matched: a namespace binding never spells the
 * concrete class's name in the clause itself (the class is reached as a
 * property access on the bound identifier, e.g. `binding.SessionHub`), so the
 * per-identifier word-boundary scan below cannot see it — and both packages'
 * barrels re-export the concrete classes as ordinary values, so any namespace
 * or full re-export clause against them reaches every concrete class
 * transitively. The leading `(?:type\s+)?` is load-bearing, not cosmetic: a
 * whole-branch audit found `import type * as sc from '...'` and `export type
 * * from '...'` both defeated the original type-blind pattern — the `type`
 * keyword sat between the anchor and the `*`, so `^\s*\*` never matched. Both
 * forms still reach every concrete class transitively (a type-only namespace
 * import still names the class as a type, which this check's own composition
 * root exemption and the facade-suffix argument above are silent on — the
 * check treats "reaches the identifier at all" as the property to reject, not
 * "reaches it as a value"). */
function clauseIsWildcard(clause: string): boolean {
  return /^\s*(?:type\s+)?\*(?:\s+as\s+\w+)?\s*$/.test(clause);
}

interface ConcreteImportViolation {
  file: string;
  /** The matched concrete identifier name, or `'*'` for a wildcard/namespace
   * clause rejected without needing to see a named identifier. */
  identifier: string;
  specifier: string;
}

/** Every production `.ts` file under `server/src`: excludes `*.test.ts` /
 * `*.int.test.ts` (both end in `.test.ts`) and everything under
 * `server/src/test/` (test-only infrastructure — exempt per the spec
 * scenario's "tests exempt"). */
function walkServerSrcProductionFiles(repoRoot: string): string[] {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  return walkTsFiles(srcRoot).filter((f) => {
    const rel = relOf(srcRoot, f);
    return !rel.endsWith('.test.ts') && !rel.startsWith('test/');
  });
}

function checkInterfaceOnlyConsumption(repoRoot: string): ConcreteImportViolation[] {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  const violations: ConcreteImportViolation[] = [];
  for (const file of walkServerSrcProductionFiles(repoRoot)) {
    const rel = relOf(srcRoot, file);
    if (rel === COMPOSITION_ROOT_REL) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(IMPORT_CLAUSE_RE)) {
      const clause = m[1];
      const specifier = m[2];
      if (!specifierNamesConcretePackage(specifier)) continue;
      if (clauseIsWildcard(clause)) {
        violations.push({ file: relOf(repoRoot, file), identifier: '*', specifier });
        continue;
      }
      for (const identifier of CONCRETE_PERSISTENCE_IDENTIFIERS) {
        if (new RegExp(`\\b${identifier}\\b`).test(clause)) {
          violations.push({ file: relOf(repoRoot, file), identifier, specifier });
        }
      }
    }
  }
  return violations;
}

describe('interface-only consumption of persistence facades (task 6.1, design D3)', () => {
  it('only node/config.ts imports the concrete persistence identifiers among server/src production files', () => {
    expect(checkInterfaceOnlyConsumption(REPO_ROOT)).toEqual([]);
  });
});

// Mutation coverage for checkInterfaceOnlyConsumption (task 4.3, design D7):
// the check above had, until this phase, exactly one assertion and it ran
// only against the live tree — a refactor that made the check vacuous (see
// the non-capturing-group note on IMPORT_CLAUSE_RE above) would still pass
// that assertion, since the live tree happens to hold zero violations either
// way. These synthetic trees exercise the function's `repoRoot` parameter
// directly, so no permanent violation fixture enters the real tree; cleaned
// up per-test via `afterEach`, same idiom `checkPackagesBoundary`'s
// synthetic-tree describe block above uses.
describe('checkInterfaceOnlyConsumption (mutation check on a synthetic server/src tree)', () => {
  let tmpRoot: string;

  function writeTree(root: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a tree with no persistence-package imports at all produces zero violations', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-clean-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/sessions.ts': `export const anotherMarker = 1;\n`,
    });
    expect(checkInterfaceOnlyConsumption(tmpRoot)).toEqual([]);
  });

  it('negative controls do not fire: a facade import, an `export type` clause, and the composition root importing concretes legitimately', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-negative-'));
    writeTree(tmpRoot, {
      // Composition root: the one production file allowed to name a
      // concrete identifier directly.
      'server/src/node/config.ts': [
        "import { SessionHubRegistry } from '@autologger/session-core';",
        'export const registry = SessionHubRegistry;',
        '',
      ].join('\n'),
      // Facade import elsewhere: the `Facade`-suffixed identifier abuts the
      // bare concrete name with no word boundary between them, so the
      // per-identifier scan must not trip on it.
      'server/src/routers/facadeConsumer.ts': [
        "import type { SessionHubRegistryFacade } from '@autologger/session-core';",
        'export const useIt = (f: SessionHubRegistryFacade) => f;',
        '',
      ].join('\n'),
      // A type-only re-export clause naming something other than a concrete
      // identifier: exercises the widened keyword alternation on a benign
      // re-export, distinct from the facade-import case above.
      'server/src/routers/typeReExport.ts': [
        "export type { SomeUnrelatedType } from '@autologger/session-core';",
        '',
      ].join('\n'),
    });
    expect(checkInterfaceOnlyConsumption(tmpRoot)).toEqual([]);
  });

  it('DOES flag a bare concrete import outside the composition root', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-bare-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': [
        "import { SessionHubRegistry } from '@autologger/session-core';",
        'export const x = SessionHubRegistry;',
        '',
      ].join('\n'),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some(
        (v) => v.identifier === 'SessionHubRegistry' && v.specifier === '@autologger/session-core',
      ),
    ).toBe(true);
  });

  it('DOES flag a deep-subpath concrete import (specifier prefix match closes the exact-match hole)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-subpath-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': [
        "import { SessionHub } from '@autologger/session-core/SessionHub';",
        'export const x = SessionHub;',
        '',
      ].join('\n'),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some(
        (v) =>
          v.identifier === 'SessionHub' && v.specifier === '@autologger/session-core/SessionHub',
      ),
    ).toBe(true);
  });

  it('DOES flag a re-export clause naming a concrete identifier (widened keyword alternation closes the re-export hole)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-reexport-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': [
        "export { SessionHub } from '@autologger/session-core';",
        '',
      ].join('\n'),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some(
        (v) => v.identifier === 'SessionHub' && v.specifier === '@autologger/session-core',
      ),
    ).toBe(true);
  });

  it('DOES flag a namespace import wildcard clause (`import * as` binding) against a concrete-bearing package', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-wildcard-import-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': [
        "import * as sc from '@autologger/session-core';",
        'export const x = sc;',
        '',
      ].join('\n'),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some((v) => v.identifier === '*' && v.specifier === '@autologger/session-core'),
    ).toBe(true);
  });

  it('DOES flag a wildcard re-export clause (`export *`) against a concrete-bearing package', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-wildcard-export-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': ["export * from '@autologger/session-core';", ''].join('\n'),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some((v) => v.identifier === '*' && v.specifier === '@autologger/session-core'),
    ).toBe(true);
  });

  it('DOES flag a type-only namespace import wildcard clause (`import type * as`) against a concrete-bearing package', () => {
    // Whole-branch audit finding: the original clauseIsWildcard anchor
    // (`^\s*\*...`) never matched once a `type` keyword sat between the
    // anchor and the `*`, so this exact shape passed unflagged before the
    // fix.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-wildcard-type-import-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': [
        "import type * as sc from '@autologger/session-core';",
        'export type UseIt = sc.SessionHub;',
        '',
      ].join('\n'),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some((v) => v.identifier === '*' && v.specifier === '@autologger/session-core'),
    ).toBe(true);
  });

  it('DOES flag a type-only wildcard re-export clause (`export type *`) against a concrete-bearing package', () => {
    // Same finding as above, re-export shape.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-wildcard-type-export-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': ["export type * from '@autologger/session-core';", ''].join(
        '\n',
      ),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some((v) => v.identifier === '*' && v.specifier === '@autologger/session-core'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// server/src directory-level acyclicity (task 6.2 extension point — reuses
// extractImportSpecifiers/findCycles above rather than re-deriving a walker)
// ---------------------------------------------------------------------------
//
// package-split-foundation's exploration found two directory-level cycles in
// `server/src` (design.md Context, D3/D4): `session <-> aiV2` (through
// `session/dashboardStore.ts` -> `aiV2/catalog.ts` while `aiV2/aggregates.ts`
// -> `session/{topicStore,transcriptStore}`) and `auth <-> node` (through
// `auth/identity.ts`'s `KvStore` type import and `node/config.ts` ->
// `auth/oauth_google`). The contract-package move (phase 3) and the
// `KvStore`-to-`@autologger/ports` move (phase 4) were each designed to kill
// one direction of its cycle. This guard proves both stayed dead.
//
// SCOPE: production (non-test) files only. A pre-existing test-only edge
// used to live here (`session/eventStore.test.ts` imported
// `isAutoGeneratedMetadataJson` from `../routers/events`, predating this
// change), which — combined with the many production `routers -> session`
// edges — would have read as a `session <-> routers` cycle had test files
// been included. persistence-package-extraction task 4.1 killed that edge
// outright: the predicate moved to `@autologger/domain`, and
// `eventStore.test.ts` now imports it from there, so this scope carve-out no
// longer has anything to except (kept as a historical note; not a live
// exception anymore).
// persistence-package-extraction task 3.1/3.4 (design D6): `db`'s production
// modules and unit tests moved to `@autologger/catalog` at task 3.2/3.3; its
// three `*.int.test.ts` files (packages never import the app harness those
// files need) relocated to `server/src/test/` at task 3.4, which fully
// emptied `server/src/db/` — so `db` is pruned from this list here. No
// positive directory pin ever named `db` (unlike the `aiV2 -> session` /
// `node -> auth` pins tracked below), so nothing else needs restating for
// this prune.
// persistence-package-extraction task 4.3 (design D6): `session`'s
// production modules and unit tests moved to `@autologger/session-core` at
// this task (mirroring the `db` prune above); its two `*.int.test.ts` files
// (packages never import the app harness those files need) stay at
// `server/src/session/` for now and relocate to `server/src/test/` at task
// 4.4 — so `server/src/session/` is not yet fully empty, but it holds no
// production files anymore, and `session` is pruned from this production-
// import-graph list here since the directory's only remaining role is
// int-test-only. No positive directory pin ever named `session` alone (the
// pin below was `aiV2 -> session`, retired together with this prune — see
// the removed assertion note below).
const SERVER_SRC_LAYER_DIRS = [
  'node',
  'auth',
  'middleware',
  'routers',
  'aiV2',
  'logImport',
  'ai-runtime',
];

/** Production-only `.ts` files under `dir` (excludes `*.test.ts` and
 * `*.int.test.ts` — both end in `.test.ts`). */
function walkProductionTsFiles(dir: string): string[] {
  return walkTsFiles(dir).filter((f) => !f.endsWith('.test.ts'));
}

/** Builds the directory-level import graph over `server/src`'s layering
 * directories (`SERVER_SRC_LAYER_DIRS`), from production files' relative
 * import specifiers only. An edge `a -> b` means some production file under
 * `server/src/a` imports (directly, by relative specifier) a file that
 * resolves under `server/src/b`. Root-level files (`app.ts`, `appEnv.ts`,
 * `env.ts`, `main.ts`) and the `test/` support directory are intentionally
 * not graph nodes — they're composition-root/test-infra, not part of the
 * layering-cycle history this guard checks. */
function serverSrcDirectoryImportGraph(repoRoot: string): Map<string, Set<string>> {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  const graph = new Map<string, Set<string>>(SERVER_SRC_LAYER_DIRS.map((d) => [d, new Set()]));
  for (const dirName of SERVER_SRC_LAYER_DIRS) {
    for (const file of walkProductionTsFiles(path.join(srcRoot, dirName))) {
      const content = fs.readFileSync(file, 'utf8');
      for (const specifier of extractImportSpecifiers(content)) {
        if (!specifier.startsWith('.')) continue;
        let resolved = path.resolve(path.dirname(file), specifier);
        if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.ts`)) {
          resolved = `${resolved}.ts`;
        }
        const rel = path.relative(srcRoot, resolved);
        const targetDir = rel.split(path.sep)[0];
        if (SERVER_SRC_LAYER_DIRS.includes(targetDir) && targetDir !== dirName) {
          graph.get(dirName)?.add(targetDir);
        }
      }
    }
  }
  return graph;
}

describe('server/src directory import graph — real repo (task 6.2: former cycles stay dead)', () => {
  it("is acyclic across server/src's layering directories (production imports only)", () => {
    const graph = serverSrcDirectoryImportGraph(REPO_ROOT);
    expect(findCycles(graph)).toEqual([]);
  });

  it('does NOT contain the retired direction: auth -> node', () => {
    const graph = serverSrcDirectoryImportGraph(REPO_ROOT);
    expect(graph.get('auth')?.has('node')).toBe(false);
    // The reverse, one-directional edge is legitimate and expected to
    // remain: node -> auth (the composition root's node/config.ts ->
    // auth/oauth_google).
    //
    // persistence-package-extraction task 4.3 (design D6): the former
    // `session -> aiV2` retired-direction check and `aiV2 -> session`
    // positive pin are both REMOVED here (not flipped to `false`/restated) —
    // task 4.3's move rewrote aiV2's imports to the `@autologger/session-core`
    // bare specifier and pruned `session` from `SERVER_SRC_LAYER_DIRS` above,
    // so `session` is no longer a node in this directory-relative walker's
    // graph at all; the directory pairing stopped being a meaningful question
    // the moment `server/src/session/` held no production files. `node ->
    // auth` is unaffected by 4.3 and is the sole surviving positive directory
    // pin this guard restates.
    expect(graph.get('node')?.has('auth')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 2.5 — the three layering-enforcement checks (design D6; spec
// "package-architecture" requirement "The server app's module directories
// have declared, test-enforced roles"): the panel's most convergent finding
// was that the draft declared `routers/` HTTP-only and the AI runtime
// Hono-free while shipping no mechanism. All three reuse
// `walkProductionTsFiles`/`extractImportSpecifiers`/`relOf` above rather than
// deriving a parallel walker. Negative-case coverage for checks (1) and (2)
// is a one-time, working-tree-only demonstration recorded in
// `.apply/ledger.md` (task 2.6), matching this file's existing discipline
// (see the file-header note): a repo-invariant guard doesn't ship permanent
// fixtures proving its own violations.
//
// RESIDUAL BYPASSES (design D6, matching D7's stated-not-closed posture):
// like every check in this file, these are textual scans over import/export
// specifiers, not a real parser or a runtime trace. A module that obtains a
// forbidden dependency dynamically at runtime rather than through ordinary
// static import syntax, that evaluates code built from a string at runtime,
// or that reaches the forbidden dependency indirectly by importing a third,
// otherwise-innocuous-looking module which itself holds that dependency, is
// invisible to a specifier-text scan. This was demonstrated during the
// phase-2 review (recorded in `.apply/ledger.md`) and is a known, accepted
// limit of this style of guard, not something a future edit here should try
// to silently patch over with a parallel ad hoc scan.
// ---------------------------------------------------------------------------

const AI_RUNTIME_DIR_REL = 'ai-runtime';
const ROUTERS_DIR_REL = 'routers';

function isHonoSpecifier(specifier: string): boolean {
  return specifier === 'hono' || specifier.startsWith('hono/') || specifier.startsWith('@hono/');
}

/** True when a relative `specifier`, resolved from `fromFile`, lands under
 * `server/src/<targetDirRel>/` — same extensionless-resolution fallback
 * `serverSrcDirectoryImportGraph` above uses (append `.ts` when the
 * extensionless path doesn't exist). Non-relative specifiers never match. */
function relativeSpecifierResolvesUnderDir(
  srcRoot: string,
  fromFile: string,
  specifier: string,
  targetDirRel: string,
): boolean {
  if (!specifier.startsWith('.')) return false;
  let resolved = path.resolve(path.dirname(fromFile), specifier);
  if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.ts`)) {
    resolved = `${resolved}.ts`;
  }
  const targetDir = path.join(srcRoot, targetDirRel);
  return resolved === targetDir || resolved.startsWith(targetDir + path.sep);
}

/** True when a relative `specifier`, resolved from `fromFile`, names
 * `server/src/appEnv.ts` itself (the file, not merely something under a
 * directory of that name — `appEnv.ts` is a root-level file). */
function relativeSpecifierResolvesToAppEnv(
  srcRoot: string,
  fromFile: string,
  specifier: string,
): boolean {
  if (!specifier.startsWith('.')) return false;
  let resolved = path.resolve(path.dirname(fromFile), specifier);
  if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.ts`)) {
    resolved = `${resolved}.ts`;
  }
  return resolved === path.join(srcRoot, 'appEnv.ts');
}

interface AiRuntimePurityViolation {
  file: string;
  specifier: string;
  detail: string;
}

/** Check (1) — runtime purity (spec scenario "AI runtime Hono-freedom is
 * continuously enforced"): no production file under `server/src/ai-runtime/`
 * may import `hono`, a `hono/*` subpath, a `@hono/*` scoped package,
 * `server/src/appEnv` by relative specifier, or anything resolving under
 * `server/src/routers/`. */
function checkAiRuntimePurity(repoRoot: string): AiRuntimePurityViolation[] {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  const runtimeDir = path.join(srcRoot, AI_RUNTIME_DIR_REL);
  const violations: AiRuntimePurityViolation[] = [];
  for (const file of walkProductionTsFiles(runtimeDir)) {
    const relFile = relOf(repoRoot, file);
    const content = fs.readFileSync(file, 'utf8');
    for (const specifier of extractImportSpecifiers(content)) {
      if (isHonoSpecifier(specifier)) {
        violations.push({ file: relFile, specifier, detail: `imports ${specifier}` });
      } else if (relativeSpecifierResolvesToAppEnv(srcRoot, file, specifier)) {
        violations.push({
          file: relFile,
          specifier,
          detail: 'imports server/src/appEnv by relative specifier',
        });
      } else if (relativeSpecifierResolvesUnderDir(srcRoot, file, specifier, ROUTERS_DIR_REL)) {
        violations.push({
          file: relFile,
          specifier,
          detail: 'imports a module resolving under server/src/routers/',
        });
      }
    }
  }
  return violations;
}

describe('ai-runtime Hono-freedom — real repo (task 2.5, design D6, spec scenario "AI runtime Hono-freedom is continuously enforced")', () => {
  it('no production file under server/src/ai-runtime/ imports hono, hono/*, @hono/*, appEnv, or anything under server/src/routers/', () => {
    expect(checkAiRuntimePurity(REPO_ROOT)).toEqual([]);
  });
});

/** Check (2) — router membership (spec scenario "Routers directory holds
 * only HTTP-layer modules"): every production module ANYWHERE under
 * `server/src/routers/` — recursively, not just its direct children — must
 * import `hono`/`hono/*`/`@hono/*` or `appEnv`. `walkProductionTsFiles`
 * already recurses, so this walks every subdirectory too; there are none
 * today, but a file placed one directory deeper (e.g.
 * `server/src/routers/sub/whatever.ts`) is still attributed to `routers` by
 * both `serverSrcDirectoryImportGraph` above and the atlas's
 * `server/src/routers/**` glob, so this check must see it too — a
 * direct-children-only filter would make the check blind to exactly the
 * non-HTTP cluster this phase exists to foreclose, one directory deeper. */
function checkRouterMembership(repoRoot: string): string[] {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  const routersDir = path.join(srcRoot, ROUTERS_DIR_REL);
  const violations: string[] = [];
  for (const file of walkProductionTsFiles(routersDir)) {
    const content = fs.readFileSync(file, 'utf8');
    const specifiers = extractImportSpecifiers(content);
    const hasHono = specifiers.some(isHonoSpecifier);
    const hasAppEnv = specifiers.some((s) => relativeSpecifierResolvesToAppEnv(srcRoot, file, s));
    if (!hasHono && !hasAppEnv) violations.push(relOf(repoRoot, file));
  }
  return violations;
}

describe('routers/ HTTP-layer membership — real repo (task 2.5, design D6, spec scenario "Routers directory holds only HTTP-layer modules")', () => {
  it('every production module anywhere under server/src/routers/ imports hono/hono-subpath/@hono-subpath or appEnv', () => {
    expect(checkRouterMembership(REPO_ROOT)).toEqual([]);
  });
});

/** The moved AI-runtime cluster's basenames (this phase's move, design D2) —
 * the spec scenario's second conjunct names these 11 explicitly: "...and
 * none of the AI runtime modules (...) is among them" [the router-membership
 * modules]. `checkRouterMembership` above only catches a reintroduced file
 * of this shape TRANSITIVELY, if it also happens to stay Hono-free — a mover
 * who (re)adds a `hono`/`appEnv` import alongside one of these basenames
 * would satisfy check (2) while still violating the named scenario. This
 * list is asserted against directly below rather than trusted to that
 * transitive coincidence. */
const AI_RUNTIME_MOVED_BASENAMES = [
  'aiMcpServer.ts',
  'aiV2SdkSpawn.ts',
  'aiChatRunner.ts',
  'aiV2PendingQuestions.ts',
  'aiTurnOrchestrator.ts',
  'aiTurn.ts',
  'aiChatRelay.ts',
  'topicGenerate.ts',
  'aiChatRegistry.ts',
  'eventGeneratePrompt.ts',
  'processGroupKill.ts',
] as const;

describe('routers/ excludes the moved AI-runtime cluster by name — real repo (task 2.5, design D6, spec scenario "Routers directory holds only HTTP-layer modules")', () => {
  it('none of the 11 named AI runtime module basenames exists anywhere under server/src/routers/', () => {
    const srcRoot = path.join(REPO_ROOT, 'server', 'src');
    const routersDir = path.join(srcRoot, ROUTERS_DIR_REL);
    const found = walkTsFiles(routersDir)
      .map((f) => path.basename(f))
      .filter((name) => (AI_RUNTIME_MOVED_BASENAMES as readonly string[]).includes(name));
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ApiError-at-app-level enforcement (design D3; spec "package-architecture"
// requirement "The server app's module directories have declared,
// test-enforced roles" — the third of its three rules: "the composition
// root's error mapper does not import upward into the router layer"). Landed
// by a whole-branch-audit fix wave: the spec claimed all three rules "SHALL
// be enforced by the boundary repo test, not by one-time inspection," but
// only rules (a) routers-HTTP-only and (b) ai-runtime-home/Hono-freedom had
// checks — this class had none, so a future PR could reintroduce `ApiError`
// inside `server/src/routers/` (or re-import it from there) with every gate
// green. Reuses `IMPORT_CLAUSE_RE` (the interface-only check's clause+
// specifier extractor, above) and `relativeSpecifierResolvesUnderDir` (the
// ai-runtime purity check's resolver, below) rather than deriving new
// primitives — same "extend, never fork" discipline as every other check in
// this file. A second fix wave (final review of this branch) closed a
// vacuity gap the first wave left open: the original check only asserted
// the two negative halves, so a synthetic tree where `ApiError` didn't
// exist anywhere passed cleanly even though the requirement's positive
// clause ("SHALL live at app level") was unmet. `checkApiErrorHome` below
// now also asserts `server/src/httpError.ts` declares the class.
// ---------------------------------------------------------------------------

interface ApiErrorHomeViolation {
  file: string;
  kind: 'declared-in-routers' | 'import-resolves-into-routers' | 'not-declared-at-app-level';
  detail: string;
}

const HTTP_ERROR_FILE_REL = 'httpError.ts';

/** Matches either shape the spec scenario's "declares a class named
 * ApiError" covers: the ordinary `class ApiError` declaration, or a class
 * expression assigned directly to that name (`const`/`let`/`var ApiError =
 * class ...`) — the shape a contributor reaches for when a factory or a
 * mixin-style base feels more idiomatic than `class ApiError extends Error`.
 * This is also the regex the positive app-level check below reuses to
 * confirm `httpError.ts` itself declares the class, so widening it here
 * strengthens both the positive and the negative assertions identically.
 * Still textual, not a parser: an aliased declaration assigned under a
 * different local name and re-exported as `ApiError`, or a declaration
 * built through a factory function, is invisible to it — see the residual
 * note on `checkApiErrorHome` below for the full bypass list this check
 * accepts rather than closes. */
const API_ERROR_CLASS_DECL_RE = /\bclass\s+ApiError\b|\b(?:const|let|var)\s+ApiError\s*=\s*class\b/;

/** Three checks over `server/src`: (1) `server/src/httpError.ts` exists and
 * declares a class named `ApiError` — the requirement's positive half
 * ("SHALL live at app level"), without which a synthetic tree where
 * `ApiError` doesn't exist anywhere would pass the two negative checks
 * below vacuously, the same non-vacuity failure mode the layering
 * enumeration (D6 check 3) exists to foreclose; (2) no production file
 * under `server/src/routers/` declares a class named `ApiError` — the class
 * must not be reintroduced at its old home; (3) no `server/src` production
 * file's `ApiError` import specifier resolves into `server/src/routers/` —
 * the composition root's error mapper, and every router that throws it,
 * must import from app level, never from the router layer they themselves
 * live in. All three are textual scans, same limits as every other check in
 * this file (no real parser, no runtime trace).
 *
 * RESIDUAL BYPASSES, stated rather than closed (matching D6/D7's posture):
 * a two-step launder — a `routers/` file re-exports `ApiError` under its own
 * name, and a second file reaches the class through a namespace import of
 * that re-exporting module (`import * as helpers from './routers/_helpers';
 * helpers.ApiError`) — defeats both the class-declaration scan (the class
 * is declared once, at app level, satisfying check 1) and the import-clause
 * scan (the clause names no `ApiError` identifier, only the namespace
 * binding). The sibling `checkInterfaceOnlyConsumption` (D7) closes the
 * analogous hole by rejecting wildcard/namespace clauses against its
 * concrete-bearing packages outright — that treatment is deliberately NOT
 * applied here: `checkInterfaceOnlyConsumption` targets two specific
 * packages that legitimate code has no reason to namespace-import at all,
 * while a namespace import of an ordinary `server/src` module such as
 * `./routers/_helpers` is plausibly legitimate code in this repo (no
 * concrete-bearing-package restriction exists over `server/src` files
 * generally), so rejecting every namespace import into `routers/` risks a
 * false positive on honest code rather than closing a real gap. Also
 * unreached: an aliased re-export (`export { ApiError as HttpError } from
 * './httpError'` then a routers file re-exporting `HttpError` under a
 * different local name again), and a dynamically-constructed import
 * specifier. And, same hazard class the widened `IMPORT_CLAUSE_RE`-based
 * checks in this file already document: this is a raw-text scan with no
 * comment/string stripping, so a prose comment in a routers file that
 * happens to spell `class ApiError` or `const ApiError = class` — even
 * while documenting this very rule — would red the gate on a false
 * positive. Never quote either declaration form inside a `server/src`
 * production file's comments. */
function checkApiErrorHome(repoRoot: string): ApiErrorHomeViolation[] {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  const violations: ApiErrorHomeViolation[] = [];

  const httpErrorFile = path.join(srcRoot, HTTP_ERROR_FILE_REL);
  const httpErrorContent = fs.existsSync(httpErrorFile)
    ? fs.readFileSync(httpErrorFile, 'utf8')
    : '';
  if (!API_ERROR_CLASS_DECL_RE.test(httpErrorContent)) {
    violations.push({
      file: relOf(repoRoot, httpErrorFile),
      kind: 'not-declared-at-app-level',
      detail: 'server/src/httpError.ts does not declare a class named ApiError',
    });
  }

  const routersDir = path.join(srcRoot, ROUTERS_DIR_REL);
  for (const file of walkProductionTsFiles(routersDir)) {
    const content = fs.readFileSync(file, 'utf8');
    if (API_ERROR_CLASS_DECL_RE.test(content)) {
      violations.push({
        file: relOf(repoRoot, file),
        kind: 'declared-in-routers',
        detail: 'declares a class named ApiError under server/src/routers/',
      });
    }
  }

  for (const file of walkServerSrcProductionFiles(repoRoot)) {
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(IMPORT_CLAUSE_RE)) {
      const clause = m[1];
      const specifier = m[2];
      if (!/\bApiError\b/.test(clause)) continue;
      if (relativeSpecifierResolvesUnderDir(srcRoot, file, specifier, ROUTERS_DIR_REL)) {
        violations.push({
          file: relOf(repoRoot, file),
          kind: 'import-resolves-into-routers',
          detail: `imports ApiError from a specifier resolving under server/src/routers/: ${specifier}`,
        });
      }
    }
  }

  return violations;
}

describe('ApiError lives at app level, not in routers/ — real repo (design D3, spec scenario "The error mapper does not import upward into routers")', () => {
  it('server/src/httpError.ts declares ApiError, no production file under server/src/routers/ declares ApiError, and no ApiError import resolves into server/src/routers/', () => {
    expect(checkApiErrorHome(REPO_ROOT)).toEqual([]);
  });
});

/** Directories legitimately excluded from the `SERVER_SRC_LAYER_DIRS`
 * completeness comparison despite containing production `.ts` files by
 * `walkProductionTsFiles`'s filter (files not ending `.test.ts`) — named and
 * reviewed, per the spec scenario's "or named on an explicit exemption
 * list". `test/` holds test infrastructure (`harness.ts`, `apiFixtures.ts`,
 * `setup.int.ts`, ...) consumed only by test files, never by app production
 * code; the directory-import-graph section's own header comment above
 * records the same reasoning for why it (and root-level files) are not
 * graph nodes — composition-root/test-infra, not a layering directory.
 * Root-level files such as `app.ts`/`appEnv.ts`/`env.ts`/`main.ts` never
 * enter this comparison at all: they are direct children of `server/src`,
 * not directories, so they can't be "a directory containing production
 * files" in the first place — no exemption entry is needed for them. */
const SERVER_SRC_LAYER_DIR_EXEMPTIONS = new Set<string>(['test']);

interface LayerDirEnumerationResult {
  /** Directories under `server/src` holding production files that are
   * neither enumerated in `SERVER_SRC_LAYER_DIRS` nor on the exemption
   * list — the "new/renamed directory silently invisible" hole. */
  unenumeratedNonExempt: string[];
  /** Directories enumerated in `SERVER_SRC_LAYER_DIRS` that hold zero
   * production files — the "renamed/emptied directory passes vacuously"
   * hole `walkTsFiles`'s missing-directory swallow creates. */
  enumeratedButEmpty: string[];
}

/** Check (3) — enumeration completeness and non-vacuity (spec scenario "The
 * layering enumeration matches the filesystem and is non-vacuous"). */
function checkServerSrcLayerDirEnumeration(repoRoot: string): LayerDirEnumerationResult {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const topLevelDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const unenumeratedNonExempt: string[] = [];
  for (const dirName of topLevelDirs) {
    if (SERVER_SRC_LAYER_DIR_EXEMPTIONS.has(dirName)) continue;
    if (SERVER_SRC_LAYER_DIRS.includes(dirName)) continue;
    const hasProduction = walkProductionTsFiles(path.join(srcRoot, dirName)).length > 0;
    if (hasProduction) unenumeratedNonExempt.push(dirName);
  }

  const enumeratedButEmpty: string[] = [];
  for (const dirName of SERVER_SRC_LAYER_DIRS) {
    const hasProduction = walkProductionTsFiles(path.join(srcRoot, dirName)).length > 0;
    if (!hasProduction) enumeratedButEmpty.push(dirName);
  }

  return { unenumeratedNonExempt, enumeratedButEmpty };
}

describe('server/src layering enumeration is complete and non-vacuous — real repo (task 2.5, design D6, spec scenario "The layering enumeration matches the filesystem and is non-vacuous")', () => {
  it('every server/src directory holding production files is enumerated in SERVER_SRC_LAYER_DIRS or named on the exemption list', () => {
    const { unenumeratedNonExempt } = checkServerSrcLayerDirEnumeration(REPO_ROOT);
    expect(unenumeratedNonExempt).toEqual([]);
  });

  it('every directory enumerated in SERVER_SRC_LAYER_DIRS contains at least one production file', () => {
    const { enumeratedButEmpty } = checkServerSrcLayerDirEnumeration(REPO_ROOT);
    expect(enumeratedButEmpty).toEqual([]);
  });
});
