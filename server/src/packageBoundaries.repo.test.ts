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

// --- What counts as an import/export CLAUSE (the run between the keyword and
// `from`) -------------------------------------------------------------------
//
// Assembled from named fragments and shared by BOTH scanners in this file
// (`extractImportSpecifiers` below and `IMPORT_CLAUSE_RE` further down, which
// additionally captures the clause text). One definition, not two hand-kept-in-
// sync copies: these two must never disagree about what a clause is, and until
// ai-runtime-package's phase-3 fix they were two separate literals that had to
// be edited in lockstep by hand — which is how task 3.1 got to make the same
// mistake twice in one commit.
//
// Ordinary clause content: anything that is not a terminator and not a `/`.
// `;` ends the statement. `(`, `)`, `=` and the three quote characters cannot
// appear between the keyword and `from` in ANY legal clause, and each reliably
// means the scan has left the clause and entered a function signature, an
// initializer, or a string literal (`\x60` is a backtick, spelled numerically
// so this fragment stays readable inside a template literal).
const CLAUSE_PLAIN_CHAR_SRC = String.raw`[^;()='"\x60/]`;
// A block comment IS legal clause content, and its body may contain every one
// of the characters excluded above. DETERMINISTIC by construction: the body is
// "not a `*`, or a `*` not followed by `/`", so the comment can end at exactly
// one place — the first `*/`. A lazy `[\s\S]*?` body would instead be able to
// end at every later `*/` too, which combined with the alternation below makes
// the number of ways to partition a comment exponential; see the linear-time
// mutation check on `extractImportSpecifiers`.
const CLAUSE_BLOCK_COMMENT_SRC = String.raw`/\*(?:[^*]|\*(?!/))*\*/`;
// A line comment is legal clause content too (a multi-line clause routinely
// carries one). The trailing lookahead is what makes it deterministic: without
// it, `[^\n]*` could give back characters one at a time for the plain-char
// branch to re-consume, which is the same exponential blowup again.
const CLAUSE_LINE_COMMENT_SRC = String.raw`//[^\n]*(?=\n|$)`;
// A `/` that starts neither comment form. No legal clause contains one, so
// this branch matches only malformed or unexpected input — and it is here so
// that such input makes the scanner keep looking (and at worst over-report)
// rather than stop dead at the slash and silently miss the import behind it.
// It also makes the three `/` branches exhaustive: every `/` has exactly one
// branch that can consume it, which is why the alternation is unambiguous.
const CLAUSE_LONE_SLASH_SRC = '/(?![*/])';
// Lazy: stop at the first `from`. Every group inside MUST stay non-capturing —
// see the group-index warning on `IMPORT_CLAUSE_RE`, which wraps this run in
// the one capturing group it reads as the clause.
const CLAUSE_RUN_SRC = `(?:${CLAUSE_PLAIN_CHAR_SRC}|${CLAUSE_BLOCK_COMMENT_SRC}|${CLAUSE_LINE_COMMENT_SRC}|${CLAUSE_LONE_SLASH_SRC})*?`;

/** Strips the comment forms a captured clause may legally contain, so the
 * clause-inspecting checks below (`clauseIsWildcard`, and the `\bIdentifier\b`
 * scans in `checkInterfaceOnlyConsumption` / `checkApiErrorHome`) read the
 * identifiers a clause actually BINDS rather than whatever its comments happen
 * to spell. Cuts both ways: without it `import * /* ns *\/ as x from '…'` stops
 * looking like a wildcard clause (a real miss), and a clause fused onto a prose
 * comment that merely mentions a concrete class name reads as a violation (a
 * real false positive). Same two fragments the run above is built from, so the
 * stripper can never recognise a comment shape the scanner doesn't. */
const CLAUSE_COMMENT_RE = new RegExp(`${CLAUSE_BLOCK_COMMENT_SRC}|${CLAUSE_LINE_COMMENT_SRC}`, 'g');
function stripClauseComments(clause: string): string {
  return clause.replace(CLAUSE_COMMENT_RE, ' ');
}

const IMPORT_FROM_RE = new RegExp(
  `\\b(?:import|export)\\b${CLAUSE_RUN_SRC}\\bfrom\\s*['"]([^'"]+)['"]`,
  'g',
);

/** Every import/export/dynamic-import specifier a TS source file's text
 * names, in encounter order (duplicates included — callers care about
 * distinct violations, not distinct specifiers). Matches:
 *   - `import ... from 'x'` / `import type ... from 'x'` (any clause shape)
 *   - `export ... from 'x'` / `export type ... from 'x'` / `export * from 'x'`
 *   - side-effect-only `import 'x'`
 *   - dynamic `import('x')`
 * The clause run cannot cross a `;`, so adjacent semicolon-terminated
 * statements on one line can't bleed into each other; this repo's lint config
 * requires semicolons, so that's the only shape in practice.
 *
 * `;` alone is NOT enough, though (ai-runtime-package task 3.1). A statement
 * like `export function f(` followed — many lines later, still with no `;` —
 * by the WORD "from" inside a string literal (`"...derived from " + '...'`)
 * matched as if it were an import clause, and reported the string-continuation
 * text as an undeclared third-party specifier. This was latent all along; it
 * surfaced the moment `mcpTools.ts` moved into a package, because
 * `checkThirdPartySpecifiers` only walks `packages/`.
 *
 * That is why `CLAUSE_PLAIN_CHAR_SRC` excludes `(`, `)`, `=` and the quotes —
 * and why the run must ALSO carry explicit comment branches. Task 3.1 shipped
 * the exclusions alone, and a denylist of characters that "cannot appear in a
 * legal clause" is wrong about exactly one thing: those characters appear
 * constantly INSIDE a comment, and a comment is legal clause content. The
 * result was total blindness — `import { x /* (see ADR-7) *\/ } from '…'`
 * matched nothing at all, in EVERY check in this file, silently. The comment
 * branches restore it. (An allowlist of clause characters, `[\w\s{},*]`, was
 * rejected for the same reason and would have been wrong the same way.)
 *
 * What the run still cannot do, stated rather than closed:
 *   - It is not comment- or string-aware ABOVE the keyword, so the word
 *     `import`/`export` inside a prose comment starts a run like any other,
 *     and a specifier quoted in prose is reported like a real one. Deliberate:
 *     it over-reports (a red gate someone investigates) instead of
 *     under-reporting (the failure this whole note exists about).
 *   - A clause is matched textually, not parsed. A specifier built at runtime,
 *     or an import written without the `from` keyword, is invisible.
 *   - Because a run may cross comment lines, one prose comment mentioning
 *     `export` can fuse onto the real import below it. The specifier captured
 *     is still that import's own — the run stops at the FIRST `from` — but the
 *     captured CLAUSE spans the comment, which is why the clause-reading
 *     checks strip comments via `stripClauseComments`. */
function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const m of content.matchAll(IMPORT_FROM_RE)) specifiers.push(m[1]);
  const sideEffectRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const m of content.matchAll(sideEffectRe)) specifiers.push(m[1]);
  const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of content.matchAll(dynamicRe)) specifiers.push(m[1]);
  return specifiers;
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

// `.mts`/`.cts` are equally valid TypeScript module sources — invisible to a
// package `tsconfig`'s glob-less `include` and to the architecture atlas the
// same way — and a walk matching only `.ts` does not see them (design D1
// check 4, task 2.3; spec scenario "Non-`.ts` TypeScript sources cannot evade
// the walk"). Widened here rather than in a second walker because
// `walkTsFiles` is the primitive `checkPackagesBoundary`, `packageImportGraph`,
// `checkThirdPartySpecifiers`, `checkInterfaceOnlyConsumption`,
// `serverSrcDirectoryImportGraph`, `checkAiRuntimePurity`, and
// `checkRouterMembership` all call — widening it once here covers every one
// of them, rather than requiring each to be told separately.
const TS_SOURCE_EXTENSION_RE = /\.(?:ts|mts|cts)$/;

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
    } else if (TS_SOURCE_EXTENSION_RE.test(entry.name)) {
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
  // feature-service-packages task 2.3 (design D1): the two service packages
  // that import anything, ahead of their module moves (2.1's placeholder
  // already declares these in each package.json) so the gate is green from
  // the first real file each move lands rather than red until the last one.
  // `media-import` needs no entry — it imports no workspace package at all —
  // and NEITHER service package imports `contract`: adding an edge no file
  // actually has would itself be a defect (D1), so this set stays exact.
  '@autologger/transcription->@autologger/domain',
  '@autologger/transcription->@autologger/ports',
  '@autologger/transcription->@autologger/session-core',
  '@autologger/log-import->@autologger/domain',
  '@autologger/log-import->@autologger/ports',
  '@autologger/log-import->@autologger/session-core',
  // ai-runtime-package task 1.3: only the `ports` edge, added ahead of task
  // 1.5's full membership entry (`ai-runtime -> {domain, contract,
  // session-core, ports}`) and ahead of task 1.5 adding `ai-runtime` to
  // `SERVICE_PACKAGES`. Unlike the transcription/log-import precedent above
  // (whose edges all landed in one scaffold task before any module move),
  // this package's own scaffold task (1.1) deliberately withheld every
  // layer-graph entry as task 1.5's job — but task 1.3's `fakeClock.ts` (this
  // task) was the first file in the package to actually import
  // `@autologger/ports` (a type-only `Clock` import, mirroring the other
  // four `fakeClock` copies), which `checkPackagesBoundary` flags regardless
  // of type-only-ness. Without this single entry, task 1.3 could not leave
  // `npm test` green — demonstrated. `ai-runtime` remaining absent from
  // `SERVICE_PACKAGES` for one more unit does not defeat any check that
  // exists yet: the flat-service-edge checks and the completeness assertion
  // that would care are task 1.5/1.6's own additions (design.md's Impact
  // section walks through exactly this intermediate state when motivating
  // 1.6). Task 1.5 adds the other three edges plus `SERVICE_PACKAGES`
  // membership; it must not re-add this one. Phase 5 (owner-ruled deviation,
  // M3) deletes `fakeClock.ts` itself — it had zero readers, phase 2's tests
  // used a local `Clock` literal and a sleep seam instead — but this edge
  // stays: five of the package's production modules import `Clock` from
  // `@autologger/ports` (design D3), so the edge is independently load-bearing.
  '@autologger/ai-runtime->@autologger/ports',
  // ai-runtime-package task 1.5: the remaining three edges the package's
  // moving modules need (spec "Feature services are packages in a flat
  // layer above persistence": `ai-runtime -> {domain, contract, session-core,
  // ports}`), landed together with `ai-runtime`'s `SERVICE_PACKAGES`
  // membership below — the two-step split (ports at 1.3, the rest here) was
  // task 1.3's own atomicity call (design D8: an edge lands with the file
  // that needs it), not a re-litigation of it.
  '@autologger/ai-runtime->@autologger/domain',
  '@autologger/ai-runtime->@autologger/contract',
  '@autologger/ai-runtime->@autologger/session-core',
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
 * checks below) and the real repo (the actual guard). `allowedEdges` defaults
 * to the production `ALLOWED_LAYER_EDGES` constant but is a plain function
 * argument, never a module-level mutation — a synthetic case that needs a
 * *different* allowed-edge set (task 2.5's "same import with its entry added
 * to `ALLOWED_LAYER_EDGES` is still flagged [by the independent sibling
 * check]") passes its own `Set` in rather than `.add()`ing onto the shared
 * one, so a mid-test throw in one case can't leak a mutated constant into a
 * later, unrelated case. */
function checkPackagesBoundary(
  repoRoot: string,
  allowedEdges: ReadonlySet<string> = ALLOWED_LAYER_EDGES,
): BoundaryViolation[] {
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
          if (!allowedEdges.has(edge)) {
            violations.push({
              file: relFile,
              specifier,
              kind: 'disallowed-layer-edge',
              detail: `disallowed layer edge ${edge} (allowed: ${[...allowedEdges].join(', ')})`,
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

  // ai-runtime-package task 3.1 regression: an `export function` whose
  // parameter list and body run for many lines with no `;`, followed by the
  // WORD "from" at the end of a string literal, used to match as an import
  // clause and report the string-continuation text as a specifier. Latent
  // until `mcpTools.ts` — which carries exactly this shape in an MCP tool
  // description — moved into a package, since `checkThirdPartySpecifiers`
  // only walks `packages/`.
  it('does not treat the word "from" inside a string literal as an import clause', () => {
    const content = [
      `export function buildThing(`,
      `  a: string,`,
      `) {`,
      `  const description =`,
      `    "Per-speaker talk time and the session's total duration, derived from " +`,
      `    'word timings.';`,
      `  return description + a`,
      `}`,
      `import { real } from 'real-mod';`,
    ].join('\n');
    const specifiers = extractImportSpecifiers(content);
    expect(specifiers).toEqual(['real-mod']);
  });

  // ai-runtime-package phase-3 review, finding C1. Task 3.1's fix for the
  // regression above excluded `; ( ) = ' " \`` from the clause run — characters
  // that cannot appear in a legal clause, but appear constantly inside a
  // COMMENT within one, and a comment is legal clause content. Every import
  // written that way became invisible to every check in this file at once:
  // boundary escape, undeclared dependency, layer edge, all four service-
  // sibling checks, third-party specifiers, AI-runtime purity, router
  // membership, interface-only consumption, the server-manifest scan. Silent,
  // not red. The negative control that shipped with the regression used
  // `/* keep */` and `café` — the two shapes that happen to survive it — so it
  // passed throughout. Each shape below carries a character the shipped run
  // excluded, and each returned `[]` before the fix.
  it('still sees a clause whose inline block comment carries clause-illegal characters', () => {
    const content = [
      `import { a /* (see ADR-7) */ } from 'paren-comment-mod';`,
      `import { b /* don't */ } from 'apostrophe-comment-mod';`,
      `import { c /* \`tpl\` */ } from 'backtick-comment-mod';`,
      `import { d /* a=b */ } from 'equals-comment-mod';`,
    ].join('\n');
    const specifiers = extractImportSpecifiers(content);
    expect(specifiers).toContain('paren-comment-mod');
    expect(specifiers).toContain('apostrophe-comment-mod');
    expect(specifiers).toContain('backtick-comment-mod');
    expect(specifiers).toContain('equals-comment-mod');
  });

  it('still sees a multi-line clause carrying a // comment, and a non-ASCII identifier', () => {
    const content = [
      `import {`,
      `  a, // (concrete) don't use — see aiV2.ts`,
      `  b,`,
      `} from 'line-comment-mod';`,
      `import café from 'unicode-mod';`,
    ].join('\n');
    const specifiers = extractImportSpecifiers(content);
    expect(specifiers).toContain('line-comment-mod');
    expect(specifiers).toContain('unicode-mod');
  });

  it('still sees a clause carrying a multi-line block comment', () => {
    const content = [
      `import {`,
      `  a,`,
      `  /* spans lines`,
      `     and holds (parens) = 'quotes' */`,
      `  b,`,
      `} from 'block-comment-mod';`,
    ].join('\n');
    expect(extractImportSpecifiers(content)).toContain('block-comment-mod');
  });

  // The comment branches must stay DETERMINISTIC — able to end in exactly one
  // place each. The first replacement drafted for C1 used a lazy
  // `/\*[\s\S]*?\*\/` body and a bare `//[^\n]*`; both can end in many places,
  // so the alternation could partition a comment run exponentially many ways.
  // It passed every case above on short inputs and then never finished
  // scanning THIS file, or `fixtures/api-responses/_mutable.ts` (1.1 kB). A
  // guard that hangs reports nothing, which is C1's outcome by another route,
  // so it is worth a test rather than a comment.
  //
  // The shape below is the reduced form of the real trigger: a comment
  // mentioning `import`, followed by consecutive comment lines carrying the
  // characters the plain-character branch excludes. Growth is violent —
  // 6 lines took 2.2 s under the lazy draft and 7 took 141 s, against ~0 ms
  // here — so the budget is a hang detector with a ~1000x margin over the real
  // cost, not a performance measurement.
  it('scans a comment run that never reaches a `from` in linear time', () => {
    const content = [
      '// a `.json` import widens the captured literal',
      ...Array.from(
        { length: 6 },
        (_, i) => `// prose (line ${i}) with \`ticks\`, 'quotes' and a .json/path`,
      ),
    ].join('\n');
    const started = Date.now();
    expect(extractImportSpecifiers(content)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
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

// Sanity assertion mirroring the `SERVICE_PACKAGES membership constant`
// block below — the no-L1->L1-sibling check above, and `checkNoL1ImportsService`
// (which takes `L1_PACKAGES` as its default second argument), both depend on
// this constant actually naming real packages; without this it could go
// empty or typo'd and every check built on it would pass vacuously.
describe('L1_PACKAGES membership constant (spec: "mutation-covered against their own constants")', () => {
  it('is non-empty and every member names a package that exists under packages/', () => {
    expect(L1_PACKAGES.size).toBeGreaterThan(0);
    for (const name of L1_PACKAGES) {
      expect(name.startsWith('@autologger/')).toBe(true);
      const shortName = name.slice('@autologger/'.length);
      expect(fs.existsSync(path.join(REPO_ROOT, 'packages', shortName, 'package.json'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Service-package (L2) layer checks — feature-service-packages tasks 2.3/2.5,
// design D1, spec "package-architecture" requirement "Feature services are
// packages in a flat layer above persistence".
//
// The panel BUILT AND RAN two bypasses against a single direct-edge check
// (design D1, "observed, not theorized"), and a post-gate delta-spec review
// separately found a third gap by reasoning about the scenario's wording
// (since executed by this phase's reviewer):
//   - adding one `ALLOWED_LAYER_EDGES` entry defeated a direct-edge check
//     that consulted that set;
//   - adding a `session-core -> media-import` entry and re-exporting through
//     `session-core` laundered a service-to-service dependency past a
//     direct-sibling check with the full boundary test green — closed by
//     check (2) below;
//   - the post-gate delta-spec review found the transitive-reachability
//     scenario as originally drafted could not distinguish its check's
//     presence from its absence — every chain it described was already
//     caught by check (1) or check (2). Narrowed to require an L0
//     intermediate (`transcription -> domain -> media-import`), the only
//     route check (3), genuine transitive reachability, below, uniquely
//     closes — a route this phase's reviewer has since executed for real.
// Hence FOUR checks, not one, matching the spec's four enforcement clauses.
//
// STATED RESIDUAL (design D1, spec "Stated residual bypasses" — not claimed
// to be closed by any of the below): these are textual scans over import
// syntax. A service that receives another service's function as an
// INJECTED PARAMETER has no import edge and is not caught. Neither is a
// dependency reached through `createRequire`, a non-literal dynamic
// `import()`, `eval`, or code outside the walked root.
// ---------------------------------------------------------------------------

/** The four service (L2) packages named by this capability (design D1): each
 * may import L0 (`domain`/`contract`/`ports`) and L1 (`session-core`/
 * `catalog`/`storage`) but never another service package. This is a gloss on
 * four named members, not a universal quantifier over anything
 * service-shaped. `@autologger/ai-runtime` (ai-runtime-package task 1.5) is
 * the fourth: it additionally carries its own, already-shipped Hono-freedom
 * rule (`checkAiRuntimePurity`, below) — membership here does not stand in
 * for that check, the two are independent obligations over the same package.
 * Passed as a default parameter — never read as a closed-over module global
 * — by every check function below, so the mutation-coverage vacuum probes (a
 * typo'd or emptied copy) can override it per call without mutating this
 * constant in place. Completeness — every non-L0/L1 `packages/*` directory
 * names itself here or on an explicit exemption list — is a separate
 * assertion below (task 1.6): this constant being *wrong* (empty, typo'd) is
 * covered by the non-empty/exists check immediately following; this constant
 * being *incomplete* (a real package silently omitted) is what task 1.6
 * closes, because checks (1)-(3) are evaluated against this set and cannot
 * see their own blind spot. */
const SERVICE_PACKAGES = new Set<string>([
  '@autologger/transcription',
  '@autologger/media-import',
  '@autologger/log-import',
  '@autologger/ai-runtime',
]);

/** Check (1) — the direct no-sibling rule. Built on `packageImportGraph`
 * (which records only edges the source actually imports, never consulting
 * `ALLOWED_LAYER_EDGES`) and, like `L1_PACKAGES`'s check above, takes no
 * `ALLOWED_LAYER_EDGES`/`allowedEdges` parameter at all — there is
 * structurally nothing here an edge-set entry could satisfy. Mirrors the
 * L1_PACKAGES construction immediately above rather than reusing
 * `checkPackagesBoundary`'s edge-set-consulting logic. */
function checkNoServiceSiblingImports(
  graph: Map<string, Set<string>>,
  servicePackages: ReadonlySet<string> = SERVICE_PACKAGES,
): string[] {
  const violations: string[] = [];
  for (const [from, targets] of graph) {
    if (!servicePackages.has(from)) continue;
    for (const to of targets) {
      if (servicePackages.has(to)) violations.push(`${from}->${to}`);
    }
  }
  return violations;
}

/** Check (2) — no L1 persistence package imports a service package. This is
 * the check that closes the laundering-through-a-persistence-package bypass
 * the panel ran against check (1) alone: a single `ALLOWED_LAYER_EDGES` entry
 * plus a re-export through an L1 package moved a service-to-service
 * dependency past the direct-sibling check with the full boundary test
 * green. Independent of `ALLOWED_LAYER_EDGES` for the same reason as (1). */
function checkNoL1ImportsService(
  graph: Map<string, Set<string>>,
  l1Packages: ReadonlySet<string> = L1_PACKAGES,
  servicePackages: ReadonlySet<string> = SERVICE_PACKAGES,
): string[] {
  const violations: string[] = [];
  for (const [from, targets] of graph) {
    if (!l1Packages.has(from)) continue;
    for (const to of targets) {
      if (servicePackages.has(to)) violations.push(`${from}->${to}`);
    }
  }
  return violations;
}

/** Check (3) — transitive reachability between service packages through ANY
 * chain of workspace-package imports, not merely a direct edge. This is what
 * closes the route neither (1) nor (2) sees: laundering through an L0
 * package (`transcription -> domain -> media-import`) — an L1 intermediate
 * would already be caught by check (2), so only an L0 intermediate proves
 * this check's presence rather than (2)'s. Traverses the FULL inter-package
 * graph (every package, not just services or L1s), since the laundering hop
 * can be any layer. */
function checkServiceTransitiveReachability(
  graph: Map<string, Set<string>>,
  servicePackages: ReadonlySet<string> = SERVICE_PACKAGES,
): string[] {
  const violations: string[] = [];
  for (const start of servicePackages) {
    if (!graph.has(start)) continue;
    const seen = new Set<string>();
    const stack = [...(graph.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || seen.has(node)) continue;
      seen.add(node);
      if (node !== start && servicePackages.has(node)) {
        violations.push(`${start}~>${node}`);
      }
      for (const next of graph.get(node) ?? []) stack.push(next);
    }
  }
  return violations;
}

describe('Service packages are a flat sibling layer — real repo (task 2.3, design D1)', () => {
  it('no service package imports another service package, directly', () => {
    const graph = packageImportGraph(REPO_ROOT);
    expect(checkNoServiceSiblingImports(graph)).toEqual([]);
  });

  it('no L1 persistence package imports a service package', () => {
    const graph = packageImportGraph(REPO_ROOT);
    expect(checkNoL1ImportsService(graph)).toEqual([]);
  });

  it('no service package is transitively reachable from another through any chain of workspace-package imports', () => {
    const graph = packageImportGraph(REPO_ROOT);
    expect(checkServiceTransitiveReachability(graph)).toEqual([]);
  });
});

describe('SERVICE_PACKAGES membership constant (spec: "mutation-covered against their own constants")', () => {
  it('is non-empty and every member names a package that exists under packages/', () => {
    expect(SERVICE_PACKAGES.size).toBeGreaterThan(0);
    for (const name of SERVICE_PACKAGES) {
      expect(name.startsWith('@autologger/')).toBe(true);
      const shortName = name.slice('@autologger/'.length);
      expect(fs.existsSync(path.join(REPO_ROOT, 'packages', shortName, 'package.json'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SERVICE_PACKAGES completeness (task 1.6, design D7; spec "The
// service-package membership constant is complete" / scenario "A package
// omitted from the membership constant is caught").
//
// The non-empty/exists check immediately above covers the constant being
// WRONG (empty, or naming a package that doesn't exist). It does not cover
// the constant being INCOMPLETE — a real `packages/*` directory silently
// missing from it. That matters because checks (1)-(3) above are all
// evaluated AGAINST `SERVICE_PACKAGES`: a package omitted from the set is
// simply invisible to every one of them, so a genuine service-to-service
// violation sourced from that package passes checks (1)-(3) and the whole
// boundary test green, with nothing objecting. This check closes that from
// the enumeration side rather than the import-graph side: it fires the
// moment a directory exists and is unaccounted for, independent of whether
// anything has imported anything yet.
// ---------------------------------------------------------------------------

/** L0 packages (design D2's layer 0): pure-foundation, never a service or L1
 * member. Named here — rather than the completeness check inlining
 * `'@autologger/domain'`/`'@autologger/contract'`/`'@autologger/ports'`
 * literals — so the check's logic reads as "every packages/* directory is
 * accounted for by ONE of four named categories," matching the spec's own
 * phrasing, and so a future L0 addition has one constant to update instead
 * of a literal buried inside a loop body. */
const L0_PACKAGES = new Set<string>([
  '@autologger/domain',
  '@autologger/contract',
  '@autologger/ports',
]);

/** Explicit, reviewed exemption list (spec: "in that constant or on an
 * explicit exemption list") — never a silent filter. Empty today: every
 * directory under `packages/` is L0, L1, or a named service. An entry here
 * would need its own reason recorded inline, the same discipline
 * `TEST_INFRASTRUCTURE_EXEMPTIONS` and `SERVER_SRC_LAYER_DIR_EXEMPTIONS`
 * already follow elsewhere in this file. */
const SERVICE_PACKAGE_EXEMPTIONS = new Set<string>();

/** Every `packages/*` directory (by manifest `name`) that is not L0, not L1,
 * not in `SERVICE_PACKAGES`, and not on the exemption list — i.e. every
 * package `SERVICE_PACKAGES` has silently omitted. Reuses `discoverPackages`
 * rather than a fresh directory walk; takes every category as a parameter
 * (never a closed-over module global) so the mutation demonstration below
 * can pass a deliberately-omitting copy of `SERVICE_PACKAGES` without
 * mutating the shared constant in place. */
function checkServicePackageCompleteness(
  repoRoot: string,
  l0: ReadonlySet<string> = L0_PACKAGES,
  l1: ReadonlySet<string> = L1_PACKAGES,
  servicePackages: ReadonlySet<string> = SERVICE_PACKAGES,
  exemptions: ReadonlySet<string> = SERVICE_PACKAGE_EXEMPTIONS,
): string[] {
  const packagesRoot = path.join(repoRoot, 'packages');
  const packages = discoverPackages(packagesRoot);
  const missing: string[] = [];
  for (const pkg of packages) {
    if (l0.has(pkg.name)) continue;
    if (l1.has(pkg.name)) continue;
    if (servicePackages.has(pkg.name)) continue;
    if (exemptions.has(pkg.name)) continue;
    missing.push(pkg.name);
  }
  return missing.sort();
}

describe('SERVICE_PACKAGES completeness — real repo (task 1.6, spec "The service-package membership constant is complete")', () => {
  it('every packages/* directory that is not L0 or L1 is named in SERVICE_PACKAGES or on the exemption list', () => {
    expect(checkServicePackageCompleteness(REPO_ROOT)).toEqual([]);
  });
});

// Mutation coverage for the four service-layer checks (task 2.5). These
// invoke the SAME exported check functions and the SAME production
// `SERVICE_PACKAGES`/`L1_PACKAGES` constants the real-repo assertions above
// use — a synthetic tree built from invented package names, or a locally
// re-derived sibling set, would pass this coverage whether or not the
// shipped checks work; that vacuum is exactly what the typo'd/emptied cases
// at the bottom of this block exist to rule out. Every tree uses the real
// `@autologger/*` names so the production constants' `.has()` calls actually
// match. `packageImportGraph` (not `checkPackagesBoundary`) supplies the
// graph for checks (1)-(3), matching how the real-repo assertions above call
// them; `checkPackagesBoundary` itself is exercised directly only for the
// allowed-edge-independence case, which needs its `allowedEdges` parameter.
describe('service-layer checks (mutation check on synthetic package trees, task 2.5)', () => {
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

  /** Domain/ports/session-core (L0/L1) plus all four service packages,
   * wired with only legal downward edges — the tree every case below starts
   * from and overrides. */
  const CLEAN_SERVICE_FILES: Record<string, string> = {
    'packages/domain/package.json': JSON.stringify({ name: '@autologger/domain' }),
    'packages/domain/src/index.ts': `export const x = 1;\n`,
    'packages/ports/package.json': JSON.stringify({
      name: '@autologger/ports',
      dependencies: { '@autologger/domain': '*' },
    }),
    'packages/ports/src/index.ts': `import { x } from '@autologger/domain';\nexport const y = x;\n`,
    'packages/session-core/package.json': JSON.stringify({
      name: '@autologger/session-core',
      dependencies: { '@autologger/domain': '*', '@autologger/ports': '*' },
    }),
    'packages/session-core/src/index.ts': `import { x } from '@autologger/domain';\nimport { y } from '@autologger/ports';\nexport const z = x + y;\n`,
    'packages/transcription/package.json': JSON.stringify({
      name: '@autologger/transcription',
      dependencies: {
        '@autologger/domain': '*',
        '@autologger/ports': '*',
        '@autologger/session-core': '*',
      },
    }),
    'packages/transcription/src/index.ts': `import { x } from '@autologger/domain';\nexport const t = x;\n`,
    'packages/media-import/package.json': JSON.stringify({ name: '@autologger/media-import' }),
    'packages/media-import/src/index.ts': `export const m = 1;\n`,
    'packages/log-import/package.json': JSON.stringify({
      name: '@autologger/log-import',
      dependencies: {
        '@autologger/domain': '*',
        '@autologger/ports': '*',
        '@autologger/session-core': '*',
      },
    }),
    'packages/log-import/src/index.ts': `import { x } from '@autologger/domain';\nexport const l = x;\n`,
    // ai-runtime-package task 1.5: the fourth service package, mirroring the
    // real package.json's declared deps (domain/contract/ports/session-core)
    // even though — like transcription/log-import above — this synthetic
    // index.ts only exercises one of them; declaring an edge nothing imports
    // is a manifest-honesty question this fixture isn't testing.
    'packages/ai-runtime/package.json': JSON.stringify({
      name: '@autologger/ai-runtime',
      dependencies: {
        '@autologger/domain': '*',
        '@autologger/contract': '*',
        '@autologger/ports': '*',
        '@autologger/session-core': '*',
      },
    }),
    'packages/ai-runtime/src/index.ts': `import { x } from '@autologger/domain';\nexport const a = x;\n`,
  };

  it('clean tree → zero violations on all three graph-based checks', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-clean-'));
    writeTree(tmpRoot, CLEAN_SERVICE_FILES);
    const graph = packageImportGraph(tmpRoot);
    expect(checkNoServiceSiblingImports(graph)).toEqual([]);
    expect(checkNoL1ImportsService(graph)).toEqual([]);
    expect(checkServiceTransitiveReachability(graph)).toEqual([]);
  });

  it('DOES flag a direct service->service import', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-direct-'));
    writeTree(tmpRoot, {
      ...CLEAN_SERVICE_FILES,
      'packages/transcription/src/index.ts': `import { x } from '@autologger/domain';\nimport { m } from '@autologger/media-import';\nexport const t = x + m;\n`,
    });
    const graph = packageImportGraph(tmpRoot);
    expect(checkNoServiceSiblingImports(graph)).toEqual([
      '@autologger/transcription->@autologger/media-import',
    ]);
  });

  it('DOES flag a direct service->service import sourced from the new ai-runtime member (task 1.5)', () => {
    // Task 1.5's own gate-intent demonstration: this case is what "the four
    // service checks with the new member present" cashes out to — proof that
    // `ai-runtime`, once added to `SERVICE_PACKAGES`, is caught as a SOURCE
    // of a sibling violation exactly like the three pre-existing members
    // above, not merely present in the constant's non-emptiness check.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-direct-ai-runtime-'));
    writeTree(tmpRoot, {
      ...CLEAN_SERVICE_FILES,
      'packages/ai-runtime/src/index.ts': `import { x } from '@autologger/domain';\nimport { m } from '@autologger/media-import';\nexport const a = x + m;\n`,
    });
    const graph = packageImportGraph(tmpRoot);
    expect(checkNoServiceSiblingImports(graph)).toEqual([
      '@autologger/ai-runtime->@autologger/media-import',
    ]);
  });

  it('the same service->service import is STILL flagged once its entry is added to ALLOWED_LAYER_EDGES (independence from that set)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-independence-'));
    writeTree(tmpRoot, {
      ...CLEAN_SERVICE_FILES,
      'packages/transcription/package.json': JSON.stringify({
        name: '@autologger/transcription',
        dependencies: {
          '@autologger/domain': '*',
          '@autologger/ports': '*',
          '@autologger/session-core': '*',
          '@autologger/media-import': '*',
        },
      }),
      'packages/transcription/src/index.ts': `import { x } from '@autologger/domain';\nimport { m } from '@autologger/media-import';\nexport const t = x + m;\n`,
    });
    const forbiddenEdge = '@autologger/transcription->@autologger/media-import';

    // Pre-entry: checkPackagesBoundary's OWN edge-set-consulting check fails
    // on this edge too (unsurprising — it isn't in ALLOWED_LAYER_EDGES yet).
    const preEntryViolations = checkPackagesBoundary(tmpRoot, ALLOWED_LAYER_EDGES);
    expect(
      preEntryViolations.some(
        (v) => v.kind === 'disallowed-layer-edge' && v.detail.includes(forbiddenEdge),
      ),
    ).toBe(true);

    // Post-entry: add the edge to a LOCAL copy (never `.add()` onto the
    // shared module-level Set — task 2.5) and pass it as a function
    // argument. checkPackagesBoundary's own check now falls silent for this
    // edge...
    const edgesWithEntry = new Set([...ALLOWED_LAYER_EDGES, forbiddenEdge]);
    const postEntryViolations = checkPackagesBoundary(tmpRoot, edgesWithEntry);
    expect(
      postEntryViolations.some(
        (v) => v.kind === 'disallowed-layer-edge' && v.detail.includes(forbiddenEdge),
      ),
    ).toBe(false);

    // ...but the independent sibling check does not consult that set at all
    // (it has no such parameter) and still fails.
    const graph = packageImportGraph(tmpRoot);
    expect(checkNoServiceSiblingImports(graph)).toEqual([forbiddenEdge]);
  });

  it('DOES flag an L1->L2 import (session-core importing media-import)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-l1-to-l2-'));
    writeTree(tmpRoot, {
      ...CLEAN_SERVICE_FILES,
      'packages/session-core/src/index.ts': `import { x } from '@autologger/domain';\nimport { y } from '@autologger/ports';\nimport { m } from '@autologger/media-import';\nexport const z = x + y + m;\n`,
    });
    const graph = packageImportGraph(tmpRoot);
    expect(checkNoL1ImportsService(graph)).toEqual([
      '@autologger/session-core->@autologger/media-import',
    ]);
    // And this laundering route is NOT what the direct-sibling check exists
    // to catch — no service package imports another service package here.
    expect(checkNoServiceSiblingImports(graph)).toEqual([]);
  });

  /** Overrides `domain` to import `media-import` (the laundering hop) and
   * `log-import`/`ai-runtime` to import nothing (so their own, separate
   * `-> domain ->` edges in `CLEAN_SERVICE_FILES` don't ALSO become
   * transitively reachable to `media-import` and produce extra, unrelated
   * violations in these transcription-focused cases — `ai-runtime`'s entry
   * added task 1.5, matching the pre-existing `log-import` neutralization). */
  const TRANSITIVE_THROUGH_L0_FILES: Record<string, string> = {
    ...CLEAN_SERVICE_FILES,
    'packages/domain/package.json': JSON.stringify({
      name: '@autologger/domain',
      dependencies: { '@autologger/media-import': '*' },
    }),
    'packages/domain/src/index.ts': `import { m } from '@autologger/media-import';\nexport const x = m;\n`,
    'packages/log-import/src/index.ts': `export const l = 1;\n`,
    'packages/ai-runtime/src/index.ts': `export const a = 1;\n`,
  };

  it('DOES flag a three-package transitive chain through an L0 intermediate (transcription -> domain -> media-import)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-transitive-'));
    writeTree(tmpRoot, TRANSITIVE_THROUGH_L0_FILES);
    const graph = packageImportGraph(tmpRoot);
    // Neither check (1) nor check (2) sees this route: the intermediate hop
    // (`domain`) is L0, not a service and not L1.
    expect(checkNoServiceSiblingImports(graph)).toEqual([]);
    expect(checkNoL1ImportsService(graph)).toEqual([]);
    // Only genuine transitive reachability catches it.
    expect(checkServiceTransitiveReachability(graph)).toEqual([
      '@autologger/transcription~>@autologger/media-import',
    ]);
  });

  it('DOES flag a .mts file importing a sibling service package', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-mts-'));
    writeTree(tmpRoot, {
      ...CLEAN_SERVICE_FILES,
      'packages/transcription/src/extra.mts': `import { m } from '@autologger/media-import';\nexport const e = m;\n`,
    });
    const graph = packageImportGraph(tmpRoot);
    expect(checkNoServiceSiblingImports(graph)).toEqual([
      '@autologger/transcription->@autologger/media-import',
    ]);
  });

  // Vacuum probes (task 2.5): a typo'd or emptied membership constant must
  // make the POSITIVE-violation cases above FAIL, not silently pass, or the
  // mutation coverage is testing nothing. Re-run the direct-sibling,
  // L1->L2, and transitive fixtures with a corrupted constant passed
  // explicitly as the function argument (never a module-level edit).
  describe("typo'd/emptied membership constants defeat the checks (proving the constants are load-bearing)", () => {
    // Typos the shared TARGET of all violation scenarios below
    // (`media-import` is the package every positive case reaches into —
    // directly, as an L1's import, or as the far end of a transitive chain)
    // rather than a source-side name, so one constant defeats every case:
    // a typo anywhere in the constant is a defect regardless of which
    // member it lands on, and the L1->L2 scenario in particular has no
    // `transcription` name in play at all to typo. Derived FROM the
    // production `SERVICE_PACKAGES` constant (task 1.5: "invoking the
    // production check functions and production membership constants")
    // rather than a hand-copied literal list — a hand-copied list of the
    // pre-1.5 three members would silently under-cover the moment a fourth
    // (`ai-runtime`) joined, exactly the staleness this file's own D7
    // discussion warns against elsewhere. Deriving via `.map()` means this
    // set always has one member for every real `SERVICE_PACKAGES` entry
    // (four today, `ai-runtime` included), with only the shared target
    // typo'd.
    const TYPOD_SERVICE_PACKAGES = new Set<string>(
      [...SERVICE_PACKAGES].map((name) =>
        name === '@autologger/media-import' ? '@autologger/media-imports' : name,
      ),
    );
    const EMPTY_SERVICE_PACKAGES = new Set<string>();
    const EMPTY_L1_PACKAGES = new Set<string>();

    it("a typo'd SERVICE_PACKAGES fails to catch the direct service->service violation", () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-vacuum-direct-typo-'));
      writeTree(tmpRoot, {
        ...CLEAN_SERVICE_FILES,
        'packages/transcription/src/index.ts': `import { x } from '@autologger/domain';\nimport { m } from '@autologger/media-import';\nexport const t = x + m;\n`,
      });
      const graph = packageImportGraph(tmpRoot);
      expect(checkNoServiceSiblingImports(graph, TYPOD_SERVICE_PACKAGES)).toEqual([]);
    });

    it('an empty SERVICE_PACKAGES fails to catch the direct service->service violation', () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-vacuum-direct-empty-'));
      writeTree(tmpRoot, {
        ...CLEAN_SERVICE_FILES,
        'packages/transcription/src/index.ts': `import { x } from '@autologger/domain';\nimport { m } from '@autologger/media-import';\nexport const t = x + m;\n`,
      });
      const graph = packageImportGraph(tmpRoot);
      expect(checkNoServiceSiblingImports(graph, EMPTY_SERVICE_PACKAGES)).toEqual([]);
    });

    it("a typo'd SERVICE_PACKAGES fails to catch a violation sourced from the new ai-runtime member (task 1.5)", () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-vacuum-direct-ai-runtime-typo-'));
      writeTree(tmpRoot, {
        ...CLEAN_SERVICE_FILES,
        'packages/ai-runtime/src/index.ts': `import { x } from '@autologger/domain';\nimport { m } from '@autologger/media-import';\nexport const a = x + m;\n`,
      });
      const graph = packageImportGraph(tmpRoot);
      expect(checkNoServiceSiblingImports(graph, TYPOD_SERVICE_PACKAGES)).toEqual([]);
    });

    it('an empty SERVICE_PACKAGES fails to catch a violation sourced from the new ai-runtime member (task 1.5)', () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-vacuum-direct-ai-runtime-empty-'));
      writeTree(tmpRoot, {
        ...CLEAN_SERVICE_FILES,
        'packages/ai-runtime/src/index.ts': `import { x } from '@autologger/domain';\nimport { m } from '@autologger/media-import';\nexport const a = x + m;\n`,
      });
      const graph = packageImportGraph(tmpRoot);
      expect(checkNoServiceSiblingImports(graph, EMPTY_SERVICE_PACKAGES)).toEqual([]);
    });

    it("a typo'd SERVICE_PACKAGES fails to catch the L1->L2 violation", () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-vacuum-l1l2-typo-'));
      writeTree(tmpRoot, {
        ...CLEAN_SERVICE_FILES,
        'packages/session-core/src/index.ts': `import { x } from '@autologger/domain';\nimport { y } from '@autologger/ports';\nimport { m } from '@autologger/media-import';\nexport const z = x + y + m;\n`,
      });
      const graph = packageImportGraph(tmpRoot);
      expect(checkNoL1ImportsService(graph, L1_PACKAGES, TYPOD_SERVICE_PACKAGES)).toEqual([]);
    });

    it('an empty L1_PACKAGES fails to catch the L1->L2 violation', () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-vacuum-l1l2-empty-'));
      writeTree(tmpRoot, {
        ...CLEAN_SERVICE_FILES,
        'packages/session-core/src/index.ts': `import { x } from '@autologger/domain';\nimport { y } from '@autologger/ports';\nimport { m } from '@autologger/media-import';\nexport const z = x + y + m;\n`,
      });
      const graph = packageImportGraph(tmpRoot);
      expect(checkNoL1ImportsService(graph, EMPTY_L1_PACKAGES, SERVICE_PACKAGES)).toEqual([]);
    });

    it("a typo'd SERVICE_PACKAGES fails to catch the transitive-through-L0 violation", () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-vacuum-transitive-typo-'));
      writeTree(tmpRoot, TRANSITIVE_THROUGH_L0_FILES);
      const graph = packageImportGraph(tmpRoot);
      expect(checkServiceTransitiveReachability(graph, TYPOD_SERVICE_PACKAGES)).toEqual([]);
    });

    it('an empty SERVICE_PACKAGES fails to catch the transitive-through-L0 violation', () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-layer-vacuum-transitive-empty-'));
      writeTree(tmpRoot, TRANSITIVE_THROUGH_L0_FILES);
      const graph = packageImportGraph(tmpRoot);
      expect(checkServiceTransitiveReachability(graph, EMPTY_SERVICE_PACKAGES)).toEqual([]);
    });
  });

  // Task 1.6's own demonstration (spec scenario "A package omitted from the
  // membership constant is caught"): a real service-to-service violation,
  // sourced from a package that EXISTS on disk but has been omitted from
  // `SERVICE_PACKAGES`, escapes checks (1)-(3) — because all three are
  // evaluated against that same set — while the completeness check fires
  // regardless, since it reasons from the filesystem rather than the import
  // graph. Both halves are asserted together: the omission is real (checks
  // (1)-(3) go silent) AND it is caught by something else (completeness
  // fires), proving the constant's incompleteness is detected by a
  // mechanism other than the checks it parameterizes.
  describe('SERVICE_PACKAGES completeness closes the omission hole (task 1.6, spec "A package omitted from the membership constant is caught")', () => {
    it('omitting ai-runtime from SERVICE_PACKAGES silences checks (1)-(3) on a real ai-runtime->media-import violation, but completeness still fires', () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-completeness-omission-'));
      writeTree(tmpRoot, {
        ...CLEAN_SERVICE_FILES,
        'packages/ai-runtime/src/index.ts': `import { x } from '@autologger/domain';\nimport { m } from '@autologger/media-import';\nexport const a = x + m;\n`,
      });

      // Simulate the omission by deriving a copy of SERVICE_PACKAGES with
      // `ai-runtime` removed — never `.delete()`-ing the shared module-level
      // Set — and passing it explicitly, matching this file's existing
      // vacuum-probe discipline.
      const omittingAiRuntime = new Set(
        [...SERVICE_PACKAGES].filter((name) => name !== '@autologger/ai-runtime'),
      );
      const graph = packageImportGraph(tmpRoot);

      // Checks (1)-(3), evaluated against the incomplete constant, are all
      // silent on the real ai-runtime->media-import violation — `ai-runtime`
      // simply isn't a recognized service package under this constant.
      expect(checkNoServiceSiblingImports(graph, omittingAiRuntime)).toEqual([]);
      expect(checkNoL1ImportsService(graph, L1_PACKAGES, omittingAiRuntime)).toEqual([]);
      expect(checkServiceTransitiveReachability(graph, omittingAiRuntime)).toEqual([]);

      // The completeness check, reasoning from the filesystem rather than
      // the import graph, catches the omission itself — it would fire even
      // if `packages/ai-runtime/src/index.ts` imported nothing at all.
      expect(
        checkServicePackageCompleteness(tmpRoot, L0_PACKAGES, L1_PACKAGES, omittingAiRuntime),
      ).toEqual(['@autologger/ai-runtime']);
    });
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
 * improvised"). Each listed file imports `vitest` (a devDependency) and is
 * non-exported test infrastructure consumed only by that package's own unit
 * tests, never by production modules (see each file's own header comment for
 * the duplicate-per-package provenance decided at tasks 2.4/4.3). Paths are
 * package-relative. `@autologger/catalog` has no test-infrastructure files
 * outside `*.test.ts`, so it has no entry here.
 *
 * `@autologger/log-import`'s entry (feature-service-packages task 2.4) was
 * landed ahead of the file it governs — the one deliberate exception to that
 * change's atomicity rule (design D8), because the boundary-test delta
 * belongs with the check that would otherwise flag it, not with the module
 * move. At task 2.4, `packages/log-import/src/test/fakeClock.ts` did not
 * exist yet — phase 5 moved the package's modules (and this file) in;
 * `checkThirdPartySpecifiers` below walks every production `.ts` file under a
 * package's `src/` the moment the package (already scaffolded at task 2.1)
 * has one, so an unexempted `fakeClock.ts` landing in phase 5 would have been
 * red on arrival without this entry already in place. The file now exists,
 * duplicate-per-package per the final policy (task 2.4/4.3). */
const TEST_INFRASTRUCTURE_EXEMPTIONS: Record<string, readonly string[]> = {
  '@autologger/storage': ['src/test/fakeClock.ts'],
  '@autologger/session-core': ['src/test/fakeClock.ts', 'src/test/fakeCore.ts'],
  '@autologger/log-import': ['src/test/fakeClock.ts'],
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
 * only caught by writing task 4.3's mutation coverage.
 *
 * The clause run is `CLAUSE_RUN_SRC`, the SAME source fragment
 * `extractImportSpecifiers` is built from, rather than a second literal kept
 * in sync by hand — this check's walked root now includes the service packages
 * (task 3.5, design D9), so the same file is in scope for both scanners and
 * they must not disagree about what a clause is. Sharing the fragment is what
 * makes that structural. (They HAD disagreed: task 3.1 edited one and the
 * phase-3 fix found both wrong in the same way.) Callers must run the captured
 * clause through `stripClauseComments` before reading identifiers out of it —
 * the run admits comments, and a comment binds nothing. */
const IMPORT_CLAUSE_RE = new RegExp(
  `\\b(?:import|export)\\b(${CLAUSE_RUN_SRC})\\bfrom\\s*['"]([^'"]+)['"]`,
  'g',
);

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

/** The production files this check walks (ai-runtime-package task 3.5, design
 * D9): `server/src` PLUS every service package's own `src/`.
 *
 * The baseline requirement this implements is scoped "**Outside the
 * packages**, production code SHALL otherwise reference the facade interfaces
 * only" — which, with a `server/src`-only walk, meant a module's obligation to
 * import `SessionHubRegistryFacade` rather than the concrete
 * `SessionHub`/`Catalog` classes was DISCHARGED BY THE ACT OF MOVING it into a
 * package: 13 AI-runtime modules would have left the walked root with no gate
 * objecting. The delta widens the walked root instead of asserting the
 * property in a new scenario with no mechanism. Derived from the production
 * `SERVICE_PACKAGES` constant — never a hand-listed copy — so a fifth service
 * package joins this walk by being added to that one set.
 *
 * Package `src/test/` subtrees are excluded for the same reason
 * `server/src/test/` is: they hold test infrastructure (each package's
 * `fakeClock.ts`), consumed only by test files, never by production code. */
function walkInterfaceOnlyProductionFiles(repoRoot: string): string[] {
  const files = walkServerSrcProductionFiles(repoRoot);
  for (const name of SERVICE_PACKAGES) {
    const pkgSrc = path.join(repoRoot, 'packages', name.slice('@autologger/'.length), 'src');
    for (const file of walkProductionTsFiles(pkgSrc)) {
      if (relOf(pkgSrc, file).startsWith('test/')) continue;
      files.push(file);
    }
  }
  return files;
}

function checkInterfaceOnlyConsumption(repoRoot: string): ConcreteImportViolation[] {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  const violations: ConcreteImportViolation[] = [];
  for (const file of walkInterfaceOnlyProductionFiles(repoRoot)) {
    // `relOf` against `server/src` yields an escaping `../../packages/...`
    // path for a service-package file, which can never equal
    // COMPOSITION_ROOT_REL — the composition-root exemption stays scoped to
    // the app's own `node/config.ts` and does not leak into the packages.
    const rel = relOf(srcRoot, file);
    if (rel === COMPOSITION_ROOT_REL) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(IMPORT_CLAUSE_RE)) {
      const clause = stripClauseComments(m[1]);
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

describe('interface-only consumption of persistence facades (task 6.1, design D3; walk widened by ai-runtime-package task 3.5, design D9)', () => {
  it('only node/config.ts imports the concrete persistence identifiers among server/src AND service-package production files', () => {
    expect(checkInterfaceOnlyConsumption(REPO_ROOT)).toEqual([]);
  });

  // Non-vacuity for the WIDENED half specifically: the `server/src` half has
  // always had files, so the assertion above would stay green if the service
  // packages contributed nothing at all — which is exactly the "discharged by
  // relocation" failure D9 exists to prevent.
  it('the widened walk actually reaches production files inside the service packages', () => {
    const serverOnly = new Set(walkServerSrcProductionFiles(REPO_ROOT));
    const widened = walkInterfaceOnlyProductionFiles(REPO_ROOT);
    const fromPackages = widened.filter((f) => !serverOnly.has(f));
    expect(fromPackages.length).toBeGreaterThan(0);
    for (const name of SERVICE_PACKAGES) {
      const shortName = name.slice('@autologger/'.length);
      expect(
        fromPackages.some((f) => relOf(REPO_ROOT, f).startsWith(`packages/${shortName}/src/`)),
      ).toBe(true);
    }
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

  // ai-runtime-package phase-3 review, finding C1 — the two ways a comment
  // inside a clause used to defeat THIS check specifically. The first shape
  // was invisible to the scanner outright (the run stopped at the `(`); the
  // second reached the scanner but not `clauseIsWildcard`, whose anchored
  // pattern cannot match once anything sits between the keyword and the `*`.
  // Both are why the run carries comment branches and why the captured clause
  // is run through `stripClauseComments` before any identifier is read out.
  it('DOES flag a named concrete import whose clause carries an inline comment', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-comment-named-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': [
        "import { SessionHub /* (concrete — don't) */ } from '@autologger/session-core';",
        'export const x = SessionHub;',
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

  it('DOES flag a wildcard clause carrying an inline comment', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-comment-wildcard-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'server/src/routers/bad.ts': [
        "import * /* namespace */ as sc from '@autologger/session-core';",
        'export const x = sc;',
        '',
      ].join('\n'),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some((v) => v.identifier === '*' && v.specifier === '@autologger/session-core'),
    ).toBe(true);
  });

  // ai-runtime-package task 3.5 (design D9): the widened walk fires from a
  // PACKAGE location, not merely from `server/src`. Without this case the
  // widening is unfalsifiable — every existing case above lives under
  // `server/src`, so a revert to the narrow walk would leave all of them
  // green. The tree deliberately puts a clean `server/src` beside a violating
  // service package, so the only thing that can produce a violation here is
  // the package half of the walk. Uses a REAL `SERVICE_PACKAGES` member name
  // (the production constant drives the walk), so dropping that member from
  // the constant also fails this case.
  it('DOES flag a concrete import inside a SERVICE PACKAGE (the widened walk, design D9)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-package-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'packages/ai-runtime/src/bad.ts': [
        "import { SessionHubRegistry } from '@autologger/session-core';",
        'export const x = SessionHubRegistry;',
        '',
      ].join('\n'),
    });
    const violations = checkInterfaceOnlyConsumption(tmpRoot);
    expect(
      violations.some(
        (v) =>
          v.file === 'packages/ai-runtime/src/bad.ts' &&
          v.identifier === 'SessionHubRegistry' &&
          v.specifier === '@autologger/session-core',
      ),
    ).toBe(true);
  });

  // Negative control for the exclusion the widened walk carries: a package's
  // own `src/test/` infrastructure is out of scope, exactly as
  // `server/src/test/` is.
  it("does NOT flag a service package's own src/test/ infrastructure", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-only-package-test-'));
    writeTree(tmpRoot, {
      'server/src/node/config.ts': `export const marker = true;\n`,
      'packages/ai-runtime/src/test/fakeThing.ts': [
        "import { SessionHubRegistry } from '@autologger/session-core';",
        'export const x = SessionHubRegistry;',
        '',
      ].join('\n'),
    });
    expect(checkInterfaceOnlyConsumption(tmpRoot)).toEqual([]);
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
// (packages never import the app harness those files need) stayed at
// `server/src/session/` until relocating to `server/src/test/` at task 4.4,
// which fully emptied `server/src/session/` — the directory no longer
// exists — and `session` is pruned from this production-import-graph list
// here since the directory's only remaining role, in the interim between
// the two tasks, was int-test-only. No positive directory pin ever named
// `session` alone (the pin below was `aiV2 -> session`, retired together
// with this prune — see the removed assertion note below).
// feature-service-packages task 5.3 (design D8): `logImport`'s six
// production modules and four unit tests all moved to
// `@autologger/log-import` in this one unit (mirroring the `db` prune
// above — no test files stayed behind, unlike `session`'s partial prune),
// which fully emptied `server/src/logImport/`; the directory itself no
// longer exists. `logImport` is pruned from this list in the same unit
// that empties it — a delay here is exactly what the change's own
// non-vacuity check (`enumeratedButEmpty`) exists to catch. No positive
// directory pin ever named `logImport`, so nothing else needs restating
// for this prune.
// ai-runtime-package task 3.1/3.4 (design D1/D8/E9): `ai-runtime`'s 11
// production modules and `aiV2`'s 2 all moved to `@autologger/ai-runtime` in
// ONE dispatch unit — the two directories could not move separately, because
// `aiV2SdkSpawn.ts` and two moving test files carry a VALUE import of
// `AGGREGATE_MCP_SERVER_NAME` from `aiV2/mcpTools`, and `checkPackagesBoundary`
// walks test files, so a split would have left three `escape` violations red
// for a whole phase. Both directories no longer exist; both are pruned from
// this list in that same unit (a delay is what `enumeratedButEmpty` catches),
// and — because this enumeration is a PERMISSION LIST, so removal alone would
// let a later change re-create either directory for the price of re-adding an
// entry — both are additionally barred BY NAME by
// `checkForbiddenServerSrcDirs` below. The former `routers -> ai-runtime` and
// `ai-runtime -> aiV2` directory edges vanish with their endpoints; no
// positive directory pin ever named either, so nothing else needs restating.
const SERVER_SRC_LAYER_DIRS = ['node', 'auth', 'middleware', 'routers'];

/** Matches `*.test.ts`, `*.int.test.ts` (both end in `.test.ts`), and the
 * widened `.mts`/`.cts` test-source shapes (`*.test.mts`, `*.test.cts`) —
 * `walkTsFiles`'s `TS_SOURCE_EXTENSION_RE` widening (task 2.3) means a
 * `.test.mts`/`.test.cts` file is now visible to the walk it feeds, so this
 * filter has to recognise those extensions too or such a file would count as
 * production source instead of being excluded like its `.ts` counterpart. */
const PRODUCTION_TEST_FILE_RE = /\.test\.(?:ts|mts|cts)$/;

/** Production-only TypeScript-source files under `dir` (excludes
 * `*.test.ts`/`*.int.test.ts`/`*.test.mts`/`*.test.cts`). */
function walkProductionTsFiles(dir: string): string[] {
  return walkTsFiles(dir).filter((f) => !PRODUCTION_TEST_FILE_RE.test(f));
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

/** The AI runtime's home after ai-runtime-package task 3.1: a package, not a
 * `server/src` directory. Repo-root-relative segments so the purity check can
 * be re-rooted for its own vacuum probe. */
const AI_RUNTIME_PACKAGE_SRC_REL = ['packages', 'ai-runtime', 'src'] as const;
const ROUTERS_DIR_REL = 'routers';

/** Directories that SHALL NOT exist under `server/src` (ai-runtime-package
 * task 3.4; spec scenario "The emptied directories cannot be re-created").
 * `SERVER_SRC_LAYER_DIRS` is a permission list: pruning an entry does not
 * forbid re-creation, it only makes a re-created directory *unenumerated* —
 * and re-adding the entry is then the entire cost of bringing it back, with
 * every other post-move check silent (they are scoped to
 * `server/src/routers/`, `server/src/node/`, or the package). This by-name
 * prohibition is the only check that objects.
 *
 * "SHALL cease to exist rather than remain as empty or shim-bearing" is taken
 * at its word: mere EXISTENCE of the directory is the violation, not the
 * presence of production files in it — an empty directory named `ai-runtime`
 * is precisely the "vacated but not gone" state the requirement rules out,
 * and a shim-bearing one would otherwise have to be caught file-by-file. */
const FORBIDDEN_SERVER_SRC_DIRS = ['ai-runtime', 'aiV2'] as const;

function checkForbiddenServerSrcDirs(repoRoot: string): string[] {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  return FORBIDDEN_SERVER_SRC_DIRS.filter((dirName) =>
    fs.existsSync(path.join(srcRoot, dirName)),
  ).map((dirName) => `server/src/${dirName}`);
}

describe('the emptied AI-runtime directories cannot be re-created — real repo (ai-runtime-package task 3.4, spec scenario "The emptied directories cannot be re-created")', () => {
  it('neither server/src/ai-runtime/ nor server/src/aiV2/ exists', () => {
    expect(checkForbiddenServerSrcDirs(REPO_ROOT)).toEqual([]);
  });

  it('the check names the directory when one is re-created (synthetic root — no fixture enters the real tree)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forbidden-server-dirs-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'server', 'src', 'ai-runtime'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'server', 'src', 'ai-runtime', 'aiTurn.ts'),
        'export const x = 1;\n',
      );
      fs.mkdirSync(path.join(tmpRoot, 'server', 'src', 'aiV2'), { recursive: true });
      expect(checkForbiddenServerSrcDirs(tmpRoot)).toEqual([
        'server/src/ai-runtime',
        'server/src/aiV2',
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

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

interface AiRuntimePurityResult {
  violations: AiRuntimePurityViolation[];
  /** How many production files the walk actually saw. Returned rather than
   * asserted inside, so the non-vacuity property is checkable from the
   * outside — see the vacuum probe below. */
  walked: number;
}

/** Check (1) — runtime purity (spec scenario "AI runtime Hono-freedom is
 * enforced in its package home"): no production file under
 * `@autologger/ai-runtime`'s sources may import `hono`, a `hono/*` subpath, a
 * `@hono/*` scoped package, `server/src/appEnv` by relative specifier, or
 * anything else resolving under `server/src/`.
 *
 * ai-runtime-package task 3.4 re-points this at the package. That is a BODY
 * edit, not a constant swap: the function took only `repoRoot` and computed
 * `srcRoot = repoRoot/server/src` before joining the runtime directory onto
 * it. `srcRoot` survives — the appEnv and `server/src/` arms resolve their
 * relative specifiers AGAINST the app, from wherever the walked file happens
 * to live — but the walked root is now the package's `src/`.
 *
 * The `server/src/` arm is stated as the delta words it ("or any module under
 * `server/src/`"), widened from the pre-move `server/src/routers/` scoping:
 * from a package, a relative reach into ANY app directory is the same defect,
 * and the narrower form would have made task 3.8's "relative reach into
 * `server/src/`" demonstration indistinguishable from its routers-only
 * predecessor. The routers case keeps its own detail string, since that is
 * the specific reach the pre-move rule was written against.
 *
 * NOT subsumed by `checkPackagesBoundary`'s escape rule, and the honest scope
 * note matters: now that the runtime is a package, the appEnv and
 * `server/src/` arms ARE also covered by that rule — only the `hono`/`@hono/*`
 * arm is strictly non-redundant, because a `hono` import inside a package that
 * DECLARED `hono` as a dependency satisfies every boundary rule while defeating
 * this one. All three arms are kept anyway (defense in depth on a rule whose
 * whole point is that architecture without a mechanism goes false silently),
 * but "its property did not change" would be an overstatement. */
function checkAiRuntimePurity(
  repoRoot: string,
  runtimeDirOverride?: string,
): AiRuntimePurityResult {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  const runtimeDir = runtimeDirOverride ?? path.join(repoRoot, ...AI_RUNTIME_PACKAGE_SRC_REL);
  const violations: AiRuntimePurityViolation[] = [];
  const files = walkProductionTsFiles(runtimeDir);
  for (const file of files) {
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
      } else if (relativeSpecifierResolvesUnderDir(srcRoot, file, specifier, '.')) {
        violations.push({
          file: relFile,
          specifier,
          detail: 'imports a module resolving under server/src/',
        });
      }
    }
  }
  return { violations, walked: files.length };
}

describe('ai-runtime Hono-freedom — real repo (task 2.5, design D6; re-pointed at the package by ai-runtime-package task 3.4, spec scenario "AI runtime Hono-freedom is enforced in its package home")', () => {
  it('no production file under packages/ai-runtime/src/ imports hono, hono/*, @hono/*, appEnv, or anything under server/src/', () => {
    expect(checkAiRuntimePurity(REPO_ROOT).violations).toEqual([]);
  });

  // PERMANENT non-vacuity assertion (spec scenario "The Hono-freedom check
  // cannot pass vacuously"; design D8 point 4). `walkTsFiles` swallows ENOENT
  // and returns `[]` for a missing directory, so a mis-pointed walked root
  // makes every assertion above pass while checking nothing — and unlike the
  // `server/src` region this check used to live in, `packages/` has no
  // `enumeratedButEmpty` analogue that would notice. The repo's own idiom for
  // this is a standing assertion, not a deleted-after-the-branch canary.
  it('the walked root actually contains production files (the assertion above is not vacuous)', () => {
    expect(checkAiRuntimePurity(REPO_ROOT).walked).toBeGreaterThan(0);
  });

  // The vacuum probe that makes the assertion above falsifiable: point the
  // walk at a path that does not exist and confirm it reports ZERO files
  // rather than erroring — i.e. that a mis-pointed root really would sail
  // through the violations assertion with nothing to say.
  it('a walked root that does not exist yields zero files and zero violations — which is why the count is asserted', () => {
    const missing = path.join(REPO_ROOT, 'packages', 'ai-runtime-does-not-exist', 'src');
    const result = checkAiRuntimePurity(REPO_ROOT, missing);
    expect(result.walked).toBe(0);
    expect(result.violations).toEqual([]);
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
 * the spec scenario's second conjunct names these 13 explicitly: "...and
 * none of the AI runtime modules (...) is among them" [the router-membership
 * modules]. `checkRouterMembership` above only catches a reintroduced file
 * of this shape TRANSITIVELY, if it also happens to stay Hono-free — a mover
 * who (re)adds a `hono`/`appEnv` import alongside one of these basenames
 * would satisfy check (2) while still violating the named scenario. This
 * list is asserted against directly below rather than trusted to that
 * transitive coincidence.
 *
 * Widened 11 -> 13 by ai-runtime-package task 3.4: `mcpTools.ts` and
 * `aggregates.ts` moved into `@autologger/ai-runtime` from the retired
 * `server/src/aiV2/`, and the scenario's enumeration names them alongside the
 * original 11. Accepted residual, recorded at the gate: `aggregates.ts` is a
 * generic-enough basename that this list now also forbids an unrelated future
 * `server/src/routers/aggregates.ts`. */
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
  'mcpTools.ts',
  'aggregates.ts',
] as const;

describe('routers/ excludes the moved AI-runtime cluster by name — real repo (task 2.5, design D6, spec scenario "Routers directory holds only HTTP-layer modules")', () => {
  it('none of the 13 named AI runtime module basenames exists anywhere under server/src/routers/', () => {
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
 * specifier. And the class-declaration half is a raw-text scan with no
 * comment or string stripping (the import half runs its clause through
 * `stripClauseComments`; this one has no clause to strip), so a prose
 * comment in a routers file that happens to spell `class ApiError` or
 * `const ApiError = class` — even while documenting this very rule — would
 * red the gate on a false positive. Never quote either declaration form
 * inside a `server/src` production file's comments. */
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
      const clause = stripClauseComments(m[1]);
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

// ---------------------------------------------------------------------------
// server/src/node/ membership (feature-service-packages task 2.6, design D8's
// companion rule; spec "package-architecture" requirement "The server app's
// module directories have declared, test-enforced roles", scenario "The
// composition-root directory holds only the composition root"): the fourth
// rule that requirement names, alongside the routers-HTTP-only,
// ai-runtime-Hono-free, and ApiError-home checks above. `server/src/node/`'s
// documented role — composition-root wiring, the system clock, and presence —
// went false once already (design.md Context: 11 production files, 2011 LOC,
// most of it a transcription feature and a media-import feature) because
// nothing checked it. This check pins the role by name, and RECURSIVELY: the
// post-gate delta-spec review found "directly under" escapable, because a
// feature accumulating one directory deeper
// (`server/src/node/<feature>/`) is invisible to both this file's
// top-level-only `SERVER_SRC_LAYER_DIRS` enumeration and to the AI-runtime
// cluster's flat `path.basename` check above — the identical drift this
// check exists to prevent could recur with every other gate green. Hence
// "anywhere under", not "directly under".
// ---------------------------------------------------------------------------

const NODE_DIR_REL = 'node';

/** The composition root's exact production membership (spec scenario "The
 * composition-root directory holds only the composition root"): once
 * feature-service-packages phase 4 completed, `server/src/node/` held
 * exactly three files (config.ts, systemClock.ts, presence.ts) — nothing
 * else, at any depth. `nextjs-frontend-migration` task 3.1 adds a fourth:
 * `nextFrontend.ts` joins in the same composition-root wiring role (design
 * D1 — it wraps the `next` package the way config.ts wraps SQLite/blob
 * construction). Named for what it actually holds — `node/`-RELATIVE PATHS,
 * compared via `relOf`, never a bare basename — because a name like "allowed
 * basenames" would invite a future editor to add a bare basename for a
 * nested file and silently widen the rule this constant exists to keep
 * narrow. */
const NODE_DIR_ALLOWED_RELATIVE_PATHS = new Set<string>([
  'config.ts',
  'systemClock.ts',
  'presence.ts',
  'nextFrontend.ts',
]);

/** Recursively walks `server/src/node/` (via `walkProductionTsFiles`, which
 * already recurses) and flags any production file whose path **relative to
 * `node/` itself** is not one of the three allowed relative paths.
 *
 * Relative-to-`node/` — not relative-to-repo-root, and deliberately not
 * `path.basename` — is the load-bearing choice: a file at
 * `node/transcription/deepgram.ts` has a `node/`-relative path of
 * `transcription/deepgram.ts`, which equals no entry in
 * `NODE_DIR_ALLOWED_RELATIVE_PATHS` regardless of what the file's own
 * basename is. A `path.basename`-only check (the AI-runtime cluster's
 * flat-list shape, reused unchanged, would have been the wrong tool here)
 * would have accepted `node/transcription/config.ts` as "just config.ts" —
 * exactly the false negative the spec scenario calls out by name ("a
 * subdirectory is itself a violation, not an exemption"). Takes
 * `allowedRelativePaths` as a function argument, never a closed-over module
 * global, matching this file's existing discipline for
 * `SERVICE_PACKAGES`/`L1_PACKAGES` above, so a vacuum-probe case can pass a
 * corrupted copy without mutating the shared constant. */
function checkNodeDirMembership(
  repoRoot: string,
  allowedRelativePaths: ReadonlySet<string> = NODE_DIR_ALLOWED_RELATIVE_PATHS,
): string[] {
  const srcRoot = path.join(repoRoot, 'server', 'src');
  const nodeDir = path.join(srcRoot, NODE_DIR_REL);
  const violations: string[] = [];
  for (const file of walkProductionTsFiles(nodeDir)) {
    const relToNodeDir = relOf(nodeDir, file);
    if (!allowedRelativePaths.has(relToNodeDir)) {
      violations.push(relOf(repoRoot, file));
    }
  }
  return violations;
}

describe('server/src/node/ holds only the composition root — real repo (task 2.6, design D8, spec scenario "The composition-root directory holds only the composition root")', () => {
  // ENABLED by feature-service-packages task 4.1 (folded into the same unit
  // as task 4.8's verification, since 4.1's own move is what satisfies the
  // precondition below — see task-4a-report.md). server/src/node/ now holds
  // exactly config.ts, systemClock.ts, presence.ts (and their tests):
  // deepgram.ts, audioMerge.ts, transcriptRemap.ts,
  // transcriptGenerationLock.ts, generateTranscript.ts moved to
  // @autologger/transcription in this same commit, and ytdlp.ts,
  // youtubeImportGuard.ts, youtubeImportScratch.ts already moved to
  // @autologger/media-import at phase 3. The `it.skip` this comment used to
  // gate (task tasks.md 4.8: "enable the task-2.6 membership check if it was
  // landed disabled") is now a plain `it` — flipped here rather than at 4.8
  // because leaving it disabled past this point is exactly the "an
  // un-re-enabled skip is worse than no check at all" failure this
  // requirement's own history warns about. The always-on canary the phase-2
  // fix wave added specifically to fail the moment this directory actually
  // emptied out (so the skip could not outlive phase 4 unnoticed) fired as
  // designed once this move landed, and task 4.8's verification (see
  // task-4d-report.md) confirmed both that the canary had fired and that the
  // check above is non-vacuous — flat and nested violations are each
  // independently flagged — before deleting the now-purposeless canary.
  it('every production file anywhere under server/src/node/ is config.ts, systemClock.ts, presence.ts, or nextFrontend.ts', () => {
    expect(checkNodeDirMembership(REPO_ROOT)).toEqual([]);
  });
});

// Mutation coverage (task 2.6) — runs now and unconditionally, since it
// exercises the exported check function and constant directly against a
// synthetic tree and does not depend on the real repo's current, mid-
// migration contents.
describe('checkNodeDirMembership (mutation check on a synthetic server/src/node tree, task 2.6)', () => {
  let tmpRoot: string;

  function writeTree(root: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  const THREE_ALLOWED_FILES: Record<string, string> = {
    'server/src/node/config.ts': `export const marker = true;\n`,
    'server/src/node/systemClock.ts': `export const marker = true;\n`,
    'server/src/node/presence.ts': `export const marker = true;\n`,
  };

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a tree with exactly the three allowed files produces zero violations', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-membership-clean-'));
    writeTree(tmpRoot, THREE_ALLOWED_FILES);
    expect(checkNodeDirMembership(tmpRoot)).toEqual([]);
  });

  it('test files alongside the three allowed files do not count against membership', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-membership-tests-exempt-'));
    writeTree(tmpRoot, {
      ...THREE_ALLOWED_FILES,
      'server/src/node/config.test.ts': `export const marker = true;\n`,
      'server/src/node/presence.test.ts': `export const marker = true;\n`,
    });
    expect(checkNodeDirMembership(tmpRoot)).toEqual([]);
  });

  it('DOES flag a fourth, FLAT file directly under server/src/node/', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-membership-flat-violation-'));
    writeTree(tmpRoot, {
      ...THREE_ALLOWED_FILES,
      'server/src/node/deepgram.ts': `export const x = 1;\n`,
    });
    expect(checkNodeDirMembership(tmpRoot)).toEqual(['server/src/node/deepgram.ts']);
  });

  it('DOES flag a file accumulating in a NESTED subdirectory under server/src/node/ — the property this check exists for', () => {
    // The spec scenario names this case explicitly: "a subdirectory is
    // itself a violation, not an exemption." This is also the case a flat
    // top-level-only enumeration (SERVER_SRC_LAYER_DIRS above) and a
    // `path.basename`-only check (the AI-runtime cluster's shape) would both
    // miss — the identical drift this requirement's own history records
    // recurring unchecked.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-membership-nested-violation-'));
    writeTree(tmpRoot, {
      ...THREE_ALLOWED_FILES,
      'server/src/node/transcription/deepgram.ts': `export const x = 1;\n`,
    });
    const violations = checkNodeDirMembership(tmpRoot);
    expect(violations).toEqual(['server/src/node/transcription/deepgram.ts']);
  });

  it('a nested file that happens to share an allowed basename is STILL flagged (path, not basename, is what is checked)', () => {
    // Proves the check compares the node/-relative PATH, not
    // `path.basename` — a file at node/transcription/config.ts is not "just
    // config.ts" relocated; it is a fourth, disallowed path.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-membership-nested-shadow-'));
    writeTree(tmpRoot, {
      ...THREE_ALLOWED_FILES,
      'server/src/node/transcription/config.ts': `export const x = 1;\n`,
    });
    const violations = checkNodeDirMembership(tmpRoot);
    expect(violations).toEqual(['server/src/node/transcription/config.ts']);
  });

  // Vacuum probe: an emptied allowed-basenames set, passed as the function
  // argument (never `.add()`/`.clear()`-ed onto the shared module-level
  // constant), must make even the CLEAN case fail, or the constant is not
  // load-bearing. Matches this file's existing discipline for
  // SERVICE_PACKAGES/L1_PACKAGES above.
  it('an emptied allowed-basenames set flags even the three legitimate files (the constant is load-bearing)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-membership-vacuum-'));
    writeTree(tmpRoot, THREE_ALLOWED_FILES);
    const violations = checkNodeDirMembership(tmpRoot, new Set<string>());
    expect(violations.sort()).toEqual([
      'server/src/node/config.ts',
      'server/src/node/presence.ts',
      'server/src/node/systemClock.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Server-manifest scan (task 1.7, design D7; spec "A service package
// declares its own dependencies and owns its test fixtures" / scenario "The
// server app declares the workspace packages it imports").
//
// npm workspace hoisting resolves an UNDECLARED `@autologger/*` import from
// `server/src` just fine — nothing in the toolchain objects — so a workspace
// package the server app imports without declaring it in `server/
// package.json`'s own `dependencies` resolves silently instead of failing
// loudly. The immediately-preceding change (feature-service-packages)
// shipped exactly three such undeclared dependencies through this hole; no
// gate caught them, and they were hand-fixed during apply. This change
// re-exposes the same hole by hand-adding a tenth package
// (`@autologger/ai-runtime`, task 1.1) and cannot in good conscience decline
// to close the one hole that has already demonstrably failed.
//
// SCOPED TO THE `@autologger/*` DIRECTION ONLY (spec: "the third-party
// direction remains unscanned ... records that as an open gap rather than
// claiming a general fix"). An app module importing one of a service
// package's THIRD-PARTY dependencies (e.g. `exceljs`) without the server
// declaring it is deliberately NOT checked here — extending this scan to
// that direction would make the delta's own "open gap" sentence false.
function checkServerManifestDeclaresWorkspaceImports(repoRoot: string): string[] {
  const serverSrcRoot = path.join(repoRoot, 'server', 'src');
  const pkgJsonPath = path.join(repoRoot, 'server', 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const declared = new Set(Object.keys(pkgJson.dependencies ?? {}));
  const missing = new Set<string>();
  for (const file of walkProductionTsFiles(serverSrcRoot)) {
    const content = fs.readFileSync(file, 'utf8');
    for (const specifier of extractImportSpecifiers(content)) {
      if (!specifier.startsWith('@autologger/')) continue;
      const pkgName = specifier.split('/').slice(0, 2).join('/');
      if (!declared.has(pkgName)) missing.add(pkgName);
    }
  }
  return [...missing].sort();
}

describe('server/package.json declares every @autologger/* workspace package server/src imports (task 1.7, spec "The server app declares the workspace packages it imports")', () => {
  it('every @autologger/* specifier in server/src production sources is declared in server/package.json dependencies', () => {
    expect(checkServerManifestDeclaresWorkspaceImports(REPO_ROOT)).toEqual([]);
  });
});

describe('checkServerManifestDeclaresWorkspaceImports (mutation check on a synthetic server tree, task 1.7)', () => {
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

  const DECLARING_MANIFEST = JSON.stringify({
    name: 'autologger-server',
    dependencies: { '@autologger/domain': '*', '@autologger/ports': '*' },
  });

  it('a declared @autologger/* import produces zero violations', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'server-manifest-clean-'));
    writeTree(tmpRoot, {
      'server/package.json': DECLARING_MANIFEST,
      'server/src/node/config.ts': `import { x } from '@autologger/domain';\nexport const y = x;\n`,
    });
    expect(checkServerManifestDeclaresWorkspaceImports(tmpRoot)).toEqual([]);
  });

  it('DOES flag a production @autologger/* import the manifest does not declare (proves the scan is not vacuous)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'server-manifest-undeclared-'));
    writeTree(tmpRoot, {
      'server/package.json': DECLARING_MANIFEST,
      'server/src/node/config.ts': `import { x } from '@autologger/domain';\nimport { y } from '@autologger/session-core';\nexport const z = x;\n`,
    });
    expect(checkServerManifestDeclaresWorkspaceImports(tmpRoot)).toEqual([
      '@autologger/session-core',
    ]);
  });

  it('does NOT flag an undeclared @autologger/* import inside a *.test.ts file (production-source-only scope)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'server-manifest-test-file-'));
    writeTree(tmpRoot, {
      'server/package.json': DECLARING_MANIFEST,
      'server/src/node/config.ts': `import { x } from '@autologger/domain';\nexport const y = x;\n`,
      'server/src/node/config.test.ts': `import { z } from '@autologger/session-core';\nexport const w = z;\n`,
    });
    expect(checkServerManifestDeclaresWorkspaceImports(tmpRoot)).toEqual([]);
  });
});
