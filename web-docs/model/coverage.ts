// Coverage gate (design.md D4; spec "Component model maps every tracked
// source file to exactly one component"). Pure logic, unit-tested with
// fixture-tree ComponentModel objects — the live-repo wiring (real model +
// `listTrackedFiles()`) lives in scripts/check.ts so `npm test` never runs
// against the live tree (spec "Live-repo drift gates run at build and via
// docs:check").

import { matchesAnyGlob } from '../src/lib/repo';
import type { Component, ComponentModel } from './components';

/**
 * A component glob may never be exactly one of these — the whole point of
 * the module-cluster decomposition (design.md D3, task 2.2) is that a
 * single glob covering an entire workspace's source tree produces a
 * "four-component model [that] satisfies every gate and produces a useless
 * map" (design.md D4). Scoped to the three multi-domain application
 * workspaces the model decomposes into module clusters; `e2e/` is
 * explicitly not an npm workspace (CLAUDE.md), and `web-docs/` is the
 * tooling building this very map, not app surface the model is protecting
 * against under-decomposition.
 */
export const FORBIDDEN_BARE_ROOT_GLOBS = ['server/src/**', 'web/src/**', 'companion/src/**'];

export interface CoverageIssue {
  kind: 'orphan' | 'overlap' | 'bare-root';
  message: string;
}

/**
 * True when `file` is mapped to at least one glob-bearing component or sits
 * on the model's exclusion list — i.e. it is "known" to the model, whether
 * or not it's actually covered (overlap is still a coverage violation; this
 * predicate only answers "is there anywhere to route an edge into/out of").
 * Shared by the edge extractor (phase 3) so an import resolving to a
 * genuinely unmapped in-repo file fails the gate, while one resolving to an
 * excluded file does not.
 */
export function isMappedOrExcluded(file: string, model: ComponentModel): boolean {
  if (model.exclusions.some((exclusion) => exclusion.file === file)) return true;
  return model.components.some(
    (component) => component.globs.length > 0 && matchesAnyGlob(file, component.globs),
  );
}

/**
 * Filters a tracked-file list down to files assigned to a real (glob-
 * bearing) component — the extractor's roots (task 3.1/3.2). Excluded
 * files and files matching no component are dropped (extraction never
 * treats them as program roots; `isMappedOrExcluded` separately governs
 * whether an *import into* such a file is an error). Single shared
 * definition — both `scripts/check.ts` and `scripts/snapshot.ts` import
 * this rather than each re-deriving it.
 */
export function mappedFiles(trackedFiles: string[], model: ComponentModel): string[] {
  return trackedFiles.filter((file) =>
    model.components.some(
      (component) => component.globs.length > 0 && matchesAnyGlob(file, component.globs),
    ),
  );
}

/** Structural checks on the model itself, independent of any tracked-file list. */
export function validateModelStructure(model: ComponentModel): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const component of model.components) {
    for (const glob of component.globs) {
      if (FORBIDDEN_BARE_ROOT_GLOBS.includes(glob)) {
        issues.push({
          kind: 'bare-root',
          message:
            `Component "${component.name}" declares glob "${glob}", a bare workspace ` +
            'source root. Split it into meaningful subdirectory-level components instead ' +
            "of covering an entire workspace's source tree with one glob.",
        });
      }
    }
  }
  return issues;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function globBaseDir(glob: string): string {
  if (glob.endsWith('/**')) return glob.slice(0, -3);
  const lastSlash = glob.lastIndexOf('/');
  return lastSlash === -1 ? '' : glob.slice(0, lastSlash);
}

/** The glob-bearing component whose globs' base directory shares the longest path prefix with `file`. */
function nearestComponent(file: string, components: Component[]): Component | undefined {
  let best: Component | undefined;
  let bestScore = -1;
  for (const component of [...components].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const glob of component.globs) {
      const score = commonPrefixLength(file, globBaseDir(glob));
      if (score > bestScore) {
        bestScore = score;
        best = component;
      }
    }
  }
  return best;
}

/**
 * Checks that every file in `files` matches exactly one glob-bearing
 * component, unless it is on the model's exclusion list. Also folds in
 * `validateModelStructure` so a single call surfaces every coverage-gate
 * violation.
 */
export function checkCoverage(files: string[], model: ComponentModel): CoverageIssue[] {
  const issues: CoverageIssue[] = [...validateModelStructure(model)];
  const globComponents = model.components.filter((component) => component.globs.length > 0);
  const excluded = new Set(model.exclusions.map((exclusion) => exclusion.file));

  for (const file of [...files].sort()) {
    if (excluded.has(file)) continue;

    const matches = globComponents
      .filter((component) => matchesAnyGlob(file, component.globs))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (matches.length === 0) {
      const nearest = nearestComponent(file, globComponents);
      issues.push({
        kind: 'orphan',
        message:
          `Orphan tracked file: ${file} — matches no component and is not excluded. ` +
          `Nearest component: ${nearest ? nearest.name : '(none declared)'}. ` +
          `Remedy: add "${file}" to ${nearest ? `"${nearest.name}"'s` : 'a component’s'} ` +
          'globs, or add an exclusion entry with a reason.',
      });
    } else if (matches.length > 1) {
      const names = matches.map((component) => component.name);
      issues.push({
        kind: 'overlap',
        message:
          `Overlapping component globs for ${file}: matched by ` +
          `${names.map((name) => `"${name}"`).join(' and ')}. ` +
          "Remedy: narrow one component's globs so each tracked file matches exactly one component.",
      });
    }
  }

  return issues;
}
