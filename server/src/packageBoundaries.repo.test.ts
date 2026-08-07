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

const COMPOSITION_ROOT_REL = 'node/config.ts';

/** Captures an `import`'s clause text (between `import` and `from`) alongside
 * its specifier — a superset of `extractImportSpecifiers`'s `fromClauseRe`
 * (which discards the clause), needed here because the violation is about
 * WHICH identifiers a clause names, not just which module it names. */
const IMPORT_CLAUSE_RE = /\bimport\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g;

interface ConcreteImportViolation {
  file: string;
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
      if (!CONCRETE_PACKAGE_SPECIFIERS.has(specifier)) continue;
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
const SERVER_SRC_LAYER_DIRS = ['node', 'auth', 'middleware', 'routers', 'aiV2', 'logImport'];

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
