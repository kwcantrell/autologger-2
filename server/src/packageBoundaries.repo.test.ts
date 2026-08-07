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
// SCOPE: production (non-test) files only. A pre-existing, out-of-scope test
// file (`session/eventStore.test.ts` imports `isAutoGeneratedMetadataJson`
// from `../routers/events`, predating this change — present on `main` before
// this branch) creates a `session -> routers` test-only edge that, combined
// with the many production `routers -> session` edges, would read as a
// `session <-> routers` cycle if test files were included. That pairing is
// neither of the two cycles this change targets and isn't touched by any
// phase here, so folding it into this guard would either force an unrelated
// fix or an unrelated allowlist entry — out of scope for this sweep. Every
// directory this change actually rewired (session, aiV2, auth, node) is
// still covered in full via its production import edges.
const SERVER_SRC_LAYER_DIRS = [
  'db',
  'node',
  'session',
  'auth',
  'middleware',
  'routers',
  'aiV2',
  'logImport',
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

  it('does NOT contain the two retired directions: session -> aiV2, auth -> node', () => {
    const graph = serverSrcDirectoryImportGraph(REPO_ROOT);
    expect(graph.get('session')?.has('aiV2')).toBe(false);
    expect(graph.get('auth')?.has('node')).toBe(false);
    // The reverse, one-directional edges are legitimate and expected to remain:
    // aiV2 -> session (D4: aiV2/{aggregates,mcpTools}.ts read session stores/hub)
    // and node -> auth (the composition root's node/config.ts -> auth/oauth_google).
    expect(graph.get('aiV2')?.has('session')).toBe(true);
    expect(graph.get('node')?.has('auth')).toBe(true);
  });
});
