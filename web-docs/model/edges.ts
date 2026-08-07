// Component-edge projection, production/test classification, and the
// reviewed-snapshot drift gate (design.md D4; spec "Cross-component edges
// are derived, classified, and checked against a reviewed snapshot").
//
// Pure functions over already-extracted FileImport[] + the ComponentModel —
// no disk/tsconfig access here (that lives in src/lib/extractImports.ts).
// The live-repo wiring (real extraction + real model + the committed
// snapshot file) lives in scripts/check.ts and scripts/snapshot.ts,
// mirroring model/coverage.ts's split (spec "Live-repo drift gates run at
// build and via docs:check").

import type { FileImport } from '../src/lib/extractImports';
import { matchesAnyGlob } from '../src/lib/repo';
import type { Component, ComponentModel } from './components';

export type EdgeKind = 'production' | 'test';

export interface ComponentEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** A committed snapshot entry — key order (from, to, kind) kept stable for deterministic JSON. */
export interface EdgeSnapshotEntry {
  from: string;
  to: string;
  kind: EdgeKind;
}

export type EdgeSnapshot = EdgeSnapshotEntry[];

export interface ProjectedEdges {
  edges: ComponentEdge[];
  /** `${from}→${to}→${kind}` -> the underlying file-level imports backing that edge (failure-message provenance). */
  underlying: Map<string, FileImport[]>;
}

export const SNAPSHOT_REGENERATE_COMMAND = 'npm run snapshot -w web-docs';

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

function componentFor(file: string, components: Component[]): Component | undefined {
  return components.find(
    (component) => component.globs.length > 0 && matchesAnyGlob(file, component.globs),
  );
}

/**
 * True when a single underlying import should be treated as `test`-origin:
 * the importing file is a test file, or it belongs to a `test-harness`
 * component (spec: "an edge is `test` when every underlying import
 * originates in a test file or a `test-harness` component").
 */
function importIsTestOrigin(fromFile: string, fromComponent: Component): boolean {
  return isTestFile(fromFile) || fromComponent.kind === 'test-harness';
}

function edgeKey(from: string, to: string, kind: EdgeKind): string {
  return `${from}→${to}→${kind}`;
}

/**
 * Projects file-level imports onto component-level edges, classified
 * `production`/`test`. Same-component imports and imports whose target
 * belongs to no component (i.e. an excluded file — nothing to draw an edge
 * to) are dropped, not errored; the file-level "unmapped import" error is
 * extraction's job (extractFileImports), not this projection's.
 */
export function projectComponentEdges(
  imports: FileImport[],
  model: ComponentModel,
): ProjectedEdges {
  const pairHasProduction = new Map<string, boolean>();
  const pairUnderlying = new Map<string, FileImport[]>();

  for (const imp of imports) {
    const fromComponent = componentFor(imp.fromFile, model.components);
    const toComponent = componentFor(imp.toFile, model.components);
    if (!fromComponent || !toComponent) continue;
    if (fromComponent.name === toComponent.name) continue;

    const pairKey = `${fromComponent.name}→${toComponent.name}`;
    const testOrigin = importIsTestOrigin(imp.fromFile, fromComponent);
    const previouslyProduction = pairHasProduction.get(pairKey) ?? false;
    pairHasProduction.set(pairKey, previouslyProduction || !testOrigin);

    const list = pairUnderlying.get(pairKey) ?? [];
    list.push(imp);
    pairUnderlying.set(pairKey, list);
  }

  const edges: ComponentEdge[] = [];
  const underlying = new Map<string, FileImport[]>();
  for (const [pairKey, hasProduction] of pairHasProduction) {
    const separatorIndex = pairKey.indexOf('→');
    const from = pairKey.slice(0, separatorIndex);
    const to = pairKey.slice(separatorIndex + 1);
    const kind: EdgeKind = hasProduction ? 'production' : 'test';
    edges.push({ from, to, kind });
    underlying.set(edgeKey(from, to, kind), pairUnderlying.get(pairKey) ?? []);
  }

  edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  );
  return { edges, underlying };
}

export interface SnapshotDiffIssue {
  kind: 'new-edge' | 'vanished-edge';
  message: string;
}

function formatUnderlying(imports: FileImport[]): string {
  return imports
    .slice()
    .sort((a, b) => a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile))
    .map((imp) => `${imp.fromFile} → ${imp.toFile}`)
    .join(', ');
}

/**
 * Diffs the derived, classified edge set against the committed snapshot.
 * Any new or vanished edge — including a kind change, which surfaces as
 * both a vanished old-kind edge and a new new-kind edge — is a violation
 * (spec: "any difference ... SHALL fail the gate").
 */
export function diffEdgeSnapshot(
  derived: ProjectedEdges,
  snapshot: EdgeSnapshot,
): SnapshotDiffIssue[] {
  const issues: SnapshotDiffIssue[] = [];
  const snapshotKeys = new Set(snapshot.map((entry) => edgeKey(entry.from, entry.to, entry.kind)));
  const derivedKeys = new Set(derived.edges.map((edge) => edgeKey(edge.from, edge.to, edge.kind)));

  for (const edge of derived.edges) {
    const key = edgeKey(edge.from, edge.to, edge.kind);
    if (snapshotKeys.has(key)) continue;
    const underlyingImports = derived.underlying.get(key) ?? [];
    issues.push({
      kind: 'new-edge',
      message:
        `New ${edge.kind} edge ${edge.from} → ${edge.to} is not in the committed snapshot ` +
        `(web-docs/model/edges.snapshot.json). Underlying imports: ${formatUnderlying(underlyingImports)}. ` +
        `Regenerate and review: ${SNAPSHOT_REGENERATE_COMMAND}`,
    });
  }

  for (const entry of snapshot) {
    const key = edgeKey(entry.from, entry.to, entry.kind);
    if (derivedKeys.has(key)) continue;
    issues.push({
      kind: 'vanished-edge',
      message:
        `Snapshot edge ${entry.from} → ${entry.to} (${entry.kind}) has no underlying import ` +
        `anymore. Regenerate and review: ${SNAPSHOT_REGENERATE_COMMAND}`,
    });
  }

  issues.sort((a, b) => a.message.localeCompare(b.message));
  return issues;
}
