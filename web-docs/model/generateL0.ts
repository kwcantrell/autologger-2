// L0 (system architecture) mermaid source generation (design.md D1/D9;
// spec "Three-level drill-down site", "Mermaid runs strict; navigation and
// text are injection-safe", "L0 cannot silently elide edges"). Pure
// function over typed inputs (ComponentModel, EdgeSnapshot, OverlayResult) —
// no disk access here; 6.3's atlas assembly feeds it the live model +
// committed snapshot + built overlay, and the SPA (phase 7) picks which
// `{ showTest, showTooling }` variant to render (orchestrator directive:
// "toggles" at generation level means parameterized generation, not a
// single fixed source).
//
// Visibility rule (single source of truth for both nodes and edges/
// relationships — no separate "auto-include a hidden node because
// something points at it" exception): a component is visible when its kind
// is `runtime`/`datastore`/`external` (always shown) or when its kind is
// `tooling`/`test-harness` AND `showTooling` is on (spec: "tooling/
// test-harness nodes behind a toggle" — one toggle for both kinds). An
// edge/relationship renders only when BOTH endpoints are currently visible
// — this is what makes `{ showTest: true, showTooling: true }` (the
// "full" variant) the one guaranteed to contain every snapshot production
// edge and every declared relationship: production edges never touch a
// tooling/test-harness node on the live tree (verified in task 3.1/3.2's
// report), but relationships CAN (e.g. `e2e-to-*`, since `e2e` is a
// `test-harness` component) — so the renderer assertion below must be run
// against the full variant, never the default one.

import { escapeMermaidLabel } from '../src/lib/mermaidEscape';
import type { Component, ComponentKind, ComponentModel, Relationship } from './components';
import type { EdgeSnapshot } from './edges';
import { buildNavIndex, type NavIdEntry, slugifyComponentId } from './navigation';
import type { OverlayResult } from './overlay';

export interface L0GenerationOptions {
  /** Render `test`-kind snapshot edges (hidden by default). */
  showTest: boolean;
  /** Render `tooling`/`test-harness`-kind component nodes, and any edge/relationship whose endpoint is one (hidden by default). */
  showTooling: boolean;
}

export interface L0Diagram {
  source: string;
  /** id<->route mapping for every node actually rendered under this options combination — SPA post-render DOM handlers and 6.3's dangling-id check consume this, never the mermaid source text. */
  navIds: NavIdEntry[];
}

const HIDDEN_BEHIND_TOOLING_TOGGLE: readonly ComponentKind[] = ['tooling', 'test-harness'];

/** `test-harness` isn't a valid mermaid class identifier (hyphen) — every other kind name already is. */
function kindClass(kind: ComponentKind): string {
  return kind === 'test-harness' ? 'testHarness' : kind;
}

function isVisible(kind: ComponentKind, options: L0GenerationOptions): boolean {
  return options.showTooling || !HIDDEN_BEHIND_TOOLING_TOGGLE.includes(kind);
}

/** Shared line builders — the SAME builders used both to emit lines into
 * the generated source below AND (in `assertL0CoversSnapshotAndRelationships`)
 * to build the exact line a snapshot production edge / declared
 * relationship is expected to appear as, so the renderer assertion can
 * never silently drift out of sync with what the generator actually emits. */
export function productionEdgeLine(from: string, to: string): string {
  return `${slugifyComponentId(from)} --> ${slugifyComponentId(to)}`;
}

export function testEdgeLine(from: string, to: string): string {
  return `${slugifyComponentId(from)} -.->|"test"| ${slugifyComponentId(to)}`;
}

export function relationshipLine(
  relationship: Pick<Relationship, 'from' | 'to' | 'label'>,
): string {
  return (
    `${slugifyComponentId(relationship.from)} ==>|"${escapeMermaidLabel(relationship.label)}"| ` +
    `${slugifyComponentId(relationship.to)}`
  );
}

const CLASS_DEFS: readonly string[] = [
  'classDef runtime fill:#4C6EF5,color:#fff,stroke:#364FC7;',
  'classDef datastore fill:#12B886,color:#fff,stroke:#0CA678;',
  'classDef external fill:#FA5252,color:#fff,stroke:#E03131;',
  'classDef tooling fill:#868E96,color:#fff,stroke:#495057;',
  'classDef testHarness fill:#ADB5BD,color:#000,stroke:#868E96,stroke-dasharray: 3 3;',
  'classDef tinted stroke-width:4px,stroke:#F59F00;',
];

/**
 * Generates the L0 system-architecture flowchart source for one
 * `{ showTest, showTooling }` combination. Every node/edge/relationship
 * line is emitted in a fully sorted, deterministic order (spec "Builds are
 * deterministic"). `snapshot` is deliberately the raw `EdgeSnapshot` (not a
 * `ProjectedEdges`) — L0 draws the reviewed, committed edge set, never a
 * freshly re-derived one (design.md D4: the snapshot IS what L0 promises to
 * draw).
 */
export function generateL0(
  model: ComponentModel,
  snapshot: EdgeSnapshot,
  overlay: OverlayResult | undefined,
  options: L0GenerationOptions,
): L0Diagram {
  const components = [...model.components].sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map<string, Component>(components.map((c) => [c.name, c]));
  const visible = new Map<string, boolean>(
    components.map((c) => [c.name, isVisible(c.kind, options)]),
  );
  const endpointsVisible = (from: string, to: string): boolean =>
    byName.has(from) && byName.has(to) && !!visible.get(from) && !!visible.get(to);

  const tintedNames = new Set<string>(
    (overlay?.changes ?? []).flatMap((change) => change.tintedComponents),
  );

  const lines: string[] = ['flowchart TD', ...CLASS_DEFS];

  const visibleComponents = components.filter((c) => visible.get(c.name));
  for (const component of visibleComponents) {
    const id = slugifyComponentId(component.name);
    lines.push(`  ${id}["${escapeMermaidLabel(component.name)}"]:::${kindClass(component.kind)}`);
  }

  const tintedVisibleIds = visibleComponents
    .filter((c) => tintedNames.has(c.name))
    .map((c) => slugifyComponentId(c.name))
    .sort();
  if (tintedVisibleIds.length > 0) {
    lines.push(`  class ${tintedVisibleIds.join(',')} tinted;`);
  }

  const edgesToRender = [...snapshot]
    .filter((edge) => edge.kind === 'production' || options.showTest)
    .filter((edge) => endpointsVisible(edge.from, edge.to))
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
    );
  for (const edge of edgesToRender) {
    lines.push(
      `  ${edge.kind === 'production' ? productionEdgeLine(edge.from, edge.to) : testEdgeLine(edge.from, edge.to)}`,
    );
  }

  const relationshipsToRender = [...model.relationships]
    .filter((rel) => endpointsVisible(rel.from, rel.to))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const rel of relationshipsToRender) {
    lines.push(`  ${relationshipLine(rel)}`);
  }

  const navIds = buildNavIndex(visibleComponents.map((c) => c.name));

  return { source: lines.join('\n'), navIds };
}

export interface L0AssertionIssue {
  kind: 'missing-production-edge' | 'missing-relationship';
  message: string;
}

/**
 * Renderer assertion (design.md D4/spec "L0 cannot silently elide edges").
 * Verifies `source` — which MUST be generated with
 * `{ showTest: true, showTooling: true }`, the only variant where every
 * snapshot production edge and every declared relationship is guaranteed a
 * visible endpoint on both sides — contains a rendering of every snapshot
 * `production` edge and every declared relationship. Uses the exact line
 * builders `generateL0` itself uses, so a future bug that silently drops an
 * edge/relationship from the emitted source (a filter wired backwards, a
 * toggle default flipped) fails loudly here, naming the missing edge or
 * relationship, rather than shipping a diagram that quietly elides real
 * architecture. Callers pass in `snapshot`/`relationships` explicitly
 * (rather than this function re-deriving them from a `ComponentModel`) so
 * it stays a pure string-containment check, independently testable from
 * `generateL0`'s own visibility logic.
 */
export function assertL0CoversSnapshotAndRelationships(
  source: string,
  snapshot: EdgeSnapshot,
  relationships: Relationship[],
): L0AssertionIssue[] {
  const issues: L0AssertionIssue[] = [];

  for (const edge of snapshot) {
    if (edge.kind !== 'production') continue;
    const line = productionEdgeLine(edge.from, edge.to);
    if (!source.includes(line)) {
      issues.push({
        kind: 'missing-production-edge',
        message: `L0 source is missing the production edge ${edge.from} → ${edge.to} (expected line: "${line}").`,
      });
    }
  }

  for (const relationship of relationships) {
    const line = relationshipLine(relationship);
    if (!source.includes(line)) {
      issues.push({
        kind: 'missing-relationship',
        message:
          `L0 source is missing the declared relationship "${relationship.id}" ` +
          `(${relationship.from} → ${relationship.to}) (expected line: "${line}").`,
      });
    }
  }

  return issues.sort((a, b) => a.message.localeCompare(b.message));
}
