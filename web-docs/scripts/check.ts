// Root `docs:check` entry point (`npm run docs:check` → `npm run check -w
// web-docs` → this file under `tsx`). Runs every live-repo drift gate from
// design.md D4 against the current working tree, hard-failing (non-zero
// exit) on any violation — never a warning, never cached, never per-file
// exempted beyond the model's own exclusion list (spec "Live-repo drift
// gates run at build and via docs:check"). Also assembles and writes
// `web-docs/atlas.json` (task 6.3) — the SAME extraction this gate battery
// already ran is what the atlas is built from, so writing it is free once
// the gates have run.
//
// Gate battery (every one below is a hard error, never a warning):
//   - component coverage                         (task 2.1/2.2)
//   - edge derivation + snapshot conformance      (task 3.1/3.2)
//   - relationship evidence                       (task 4.1)
//   - capability accounting                       (task 4.2)
//   - spec-markdown parser count-equality gate     (task 5.1)
//   - active-changes overlay (warnings only)       (task 5.3)
//   - ER schema introspection + emission           (task 5.2 — unguarded,
//                                                    no drift gate of its
//                                                    own; see runErExtraction)
//   - L0 renderer assertion (no silent elision)    (task 6.1)
//   - diagram validity (parse/structural/budget)   (task 6.3)
// `runAllGates` is async (mermaid.parse — src/lib/mermaidValidate.ts — is
// asynchronous); every gate above still runs against a single, shared
// extraction/overlay/ER pass — see the header comment on `runAllGates`.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_MIGRATIONS_DIR } from '@autologger/catalog';
import { type Atlas, buildAtlas } from '../model/atlas';
import { checkCapabilityAccounting, pendingCapabilities } from '../model/capabilities';
import type { ComponentModel } from '../model/components';
import { model } from '../model/components';
import { checkCoverage, isMappedOrExcluded, mappedFiles } from '../model/coverage';
import {
  AUTHORED_DIAGRAM_BUDGET,
  checkAuthoredDiagramStructure,
  checkDanglingNavIds,
  checkDiagramBudget,
  checkMermaidParseResult,
  checkNonEmptyDiagram,
  countMermaidArrowLines,
  type DiagramValidityIssue,
  ER_DIAGRAM_BUDGET,
  extractStateDiagramStructure,
  L0_DIAGRAM_BUDGET,
  L1_DIAGRAM_BUDGET,
} from '../model/diagramValidity';
import { diffEdgeSnapshot, type EdgeSnapshot, projectComponentEdges } from '../model/edges';
import { assertL0CoversSnapshotAndRelationships } from '../model/generateL0';
import { buildOverlay, type OverlayResult } from '../model/overlay';
import { checkRelationshipEvidence } from '../model/relationships';
import { type CapabilitySpecTree, parseAllSpecs } from '../model/specParser';
import {
  buildCatalogSchema,
  buildSessionSchema,
  type ERSchema,
  emitErDiagram,
} from '../src/lib/erSchema';
import { type ExtractionResult, extractFileImports } from '../src/lib/extractImports';
import { parseMermaidSource } from '../src/lib/mermaidValidate';
import {
  listActiveChangeNames,
  listAllActiveDeltaCapabilities,
  listBaselineCapabilities,
  listChangeDeltaCapabilities,
  listChangeDirectoriesOnDisk,
} from '../src/lib/openspec';
import { listTrackedFiles, repoRoot } from '../src/lib/repo';

export function formatPassMessage(): string {
  return 'web-docs: all drift gates passed.';
}

const SNAPSHOT_PATH = 'web-docs/model/edges.snapshot.json';
const ATLAS_PATH = 'web-docs/atlas.json';

function loadSnapshot(root: string): EdgeSnapshot {
  const snapshotFile = path.join(root, SNAPSHOT_PATH);
  try {
    const contents = readFileSync(snapshotFile, 'utf8');
    return JSON.parse(contents) as EdgeSnapshot;
  } catch {
    // Missing/unparseable snapshot: treat as empty so a first run reports
    // every derived edge as "new" rather than crashing — still a gate
    // failure (a missing snapshot is never silently satisfied).
    return [];
  }
}

/** Derives and classifies cross-component edges (task 3.1), then diffs them against the committed snapshot (task 3.2) — `extraction`/`snapshot` are shared with atlas assembly, computed once in `runAllGates`. */
function runEdgeSnapshotGate(extraction: ExtractionResult, snapshot: EdgeSnapshot): string[] {
  const issues: string[] = [];

  for (const error of extraction.unmappedImportErrors) {
    issues.push(
      `[edges:unmapped-import] ${error.fromFile} imports ${error.toFile}, which belongs to no ` +
        "component and is not on the exclusion list. Remedy: add it to a component's globs, or " +
        'add an exclusion entry with a reason.',
    );
  }

  for (const warning of extraction.dynamicWarnings) {
    // Non-literal dynamic imports are warnings, never fatal (spec "Import
    // extraction blind spots"; orchestrator directive) — printed so they
    // stay visible without failing the gate.
    console.warn(
      `[warning:non-literal-dynamic-import] ${warning.file}:${warning.line}:${warning.column} ` +
        '— target cannot be statically determined and is not recorded as an edge.',
    );
  }

  const projected = projectComponentEdges(extraction.imports, model);
  for (const diffIssue of diffEdgeSnapshot(projected, snapshot)) {
    issues.push(`[edges:${diffIssue.kind}] ${diffIssue.message}`);
  }

  return issues;
}

/** Checks each declared relationship's evidence rules against the live tree (task 4.1). */
function runRelationshipEvidenceGate(root: string): string[] {
  const readFile = (repoRelativePath: string): string | undefined => {
    try {
      return readFileSync(path.join(root, repoRelativePath), 'utf8');
    } catch {
      return undefined;
    }
  };
  return checkRelationshipEvidence(model, readFile).map(
    (issue) => `[relationships:${issue.kind}] ${issue.message}`,
  );
}

/**
 * Accounts for every baseline openspec/specs/ capability (attached /
 * cross-cutting / process), fails dangling model capability references, and
 * returns the pending-grace list — capabilities named only by an active
 * change's delta specs, not yet in the baseline (task 4.2). `pending` feeds
 * both the console notice below and the atlas's `capabilities.pending`
 * field, so it's computed once and returned rather than re-derived.
 */
function runCapabilityAccountingGate(
  allTrackedFiles: string[],
  baseline: string[],
): { pending: string[]; issues: string[] } {
  const deltas = listAllActiveDeltaCapabilities(allTrackedFiles);
  const pending = pendingCapabilities(baseline, deltas);
  if (pending.length > 0) {
    console.log(
      `web-docs: pending capabilities (named only by an active change's delta specs, not yet ` +
        `in the openspec/specs/ baseline): ${pending.join(', ')}`,
    );
  }
  const issues = checkCapabilityAccounting(model, baseline, deltas).map(
    (issue) => `[capabilities:${issue.kind}] ${issue.message}`,
  );
  return { pending, issues };
}

/**
 * Parses every baseline capability's spec.md into its requirement/scenario
 * tree and runs the count-equality gate (task 5.1). A parse issue
 * (count-mismatch, unclassified heading, or an unreadable file) is fatal.
 * Returns the parsed trees too — the atlas's `specTree` field (task 6.3)
 * reuses this same parse rather than re-reading every spec.md a second time.
 */
function runSpecParserGate(
  root: string,
  baselineCapabilities: string[],
): { trees: CapabilitySpecTree[]; issues: string[] } {
  const readSpecFile = (capability: string): string | undefined => {
    try {
      return readFileSync(path.join(root, 'openspec/specs', capability, 'spec.md'), 'utf8');
    } catch {
      return undefined;
    }
  };
  const { trees, issues } = parseAllSpecs(baselineCapabilities, readSpecFile);
  return { trees, issues: issues.map((issue) => `[spec-parser:${issue.kind}] ${issue.message}`) };
}

/**
 * Builds the active-changes overlay (task 5.3) and prints its warnings
 * (partial/untracked change directories) non-fatally — the overlay itself
 * never fails the gate; only its warnings surface. Returns the built
 * `OverlayResult` so callers (the L0 renderer-assertion gate, atlas
 * assembly) can feed it into diagram generation without re-deriving it.
 */
function buildLiveOverlay(root: string, allTrackedFiles: string[]): OverlayResult {
  const overlay = buildOverlay({
    model,
    changeDirectoriesOnDisk: listChangeDirectoriesOnDisk(root),
    activeChangeNames: listActiveChangeNames(allTrackedFiles),
    baselineCapabilities: listBaselineCapabilities(allTrackedFiles),
    deltaCapabilitiesFor: (name) => listChangeDeltaCapabilities(allTrackedFiles, name),
  });
  for (const warning of overlay.warnings) {
    console.warn(`[warning:overlay] ${warning}`);
  }
  return overlay;
}

/**
 * Renderer assertion (task 6.1; design.md D4; spec "L0 cannot silently
 * elide edges"). Checks the atlas's `full` L0 variant (`{ showTest: true,
 * showTooling: true }`) — the only variant guaranteed to give every
 * snapshot production edge and every declared relationship a visible
 * endpoint on both sides — contains a rendering of all of them.
 */
function runL0RendererAssertionGate(atlas: Atlas, snapshot: EdgeSnapshot): string[] {
  return assertL0CoversSnapshotAndRelationships(
    atlas.l0.full.source,
    snapshot,
    model.relationships,
  ).map((issue) => `[l0-renderer:${issue.kind}] ${issue.message}`);
}

/**
 * Runs ER schema introspection + mermaid emission for both the catalog and
 * session databases (task 5.2; design.md D5) against the live tree.
 * Deliberately unguarded: the spec assigns this step no drift gate of its
 * own ("the ER content itself has no drift gate — it's fully mechanical"),
 * so the only failure mode worth surfacing is introspection or emission
 * throwing (e.g. a future server refactor renaming `applyMigrations`,
 * `SessionCore`, or `sqliteSessionSql` — design.md Risks "Docs build
 * coupled to server internals"). Letting that propagate uncaught crashes
 * docs:check loudly with the real stack trace, rather than silently
 * skipping ER extraction. Returns the raw `ERSchema`s too (table/FK counts
 * feed the diagram-validity budget check, task 6.3) alongside the emitted
 * diagram strings (the atlas's `er` field).
 */
function runErExtraction(): {
  catalogSchema: ERSchema;
  sessionSchema: ERSchema;
  catalogDiagram: string;
  sessionDiagram: string;
} {
  const catalogSchema = buildCatalogSchema(CATALOG_MIGRATIONS_DIR);
  const sessionSchema = buildSessionSchema();
  return {
    catalogSchema,
    sessionSchema,
    catalogDiagram: emitErDiagram(catalogSchema, { title: 'catalog' }),
    sessionDiagram: emitErDiagram(sessionSchema, { title: 'session' }),
  };
}

/** Every path named by any component's `authoredDiagrams`, read once (sorted, deduplicated) — shared between atlas assembly and the diagram-validity gate. `undefined` for a path that could not be read (missing file — the gate below is what fails the build on that, not this reader). */
function readAuthoredDiagramSources(
  root: string,
  componentModel: ComponentModel,
): Record<string, string | undefined> {
  const diagramPaths = new Set<string>();
  for (const component of componentModel.components) {
    for (const diagramPath of component.authoredDiagrams) diagramPaths.add(diagramPath);
  }
  const sources: Record<string, string | undefined> = {};
  for (const diagramPath of [...diagramPaths].sort()) {
    try {
      sources[diagramPath] = readFileSync(path.join(root, diagramPath), 'utf8');
    } catch {
      sources[diagramPath] = undefined;
    }
  }
  return sources;
}

function formatDiagramIssues(name: string, issues: DiagramValidityIssue[]): string[] {
  return issues.map((issue) => `[diagram-validity:${issue.kind}] ${name}: ${issue.message}`);
}

/**
 * Diagram validity gate (task 6.3; design.md D9; spec "Diagram validity
 * gates use a DOM-bootstrapped parser and size budgets", "Authored state
 * diagrams are attached, structurally validated, and labeled"). Three
 * independent layers per diagram, all hard failures:
 *   1. structural (model/diagramValidity.ts) — non-empty node set /
 *      states+transitions, dangling nav ids, size budgets. Pure, fast,
 *      catches what mermaid's own parser does NOT (it accepts
 *      structurally-garbage stateDiagrams — measured).
 *   2. real mermaid parse (src/lib/mermaidValidate.ts) — DOM-shimmed,
 *      catches genuine syntax errors structural checks can't see.
 * Every generated diagram (every L0 toggle variant, every component's every
 * L1 variant, both ER diagrams) and every authored diagram gets both layers.
 */
async function runDiagramValidityGate(
  atlas: Atlas,
  catalogSchema: ERSchema,
  sessionSchema: ERSchema,
  authoredDiagramSources: Record<string, string | undefined>,
): Promise<string[]> {
  const issues: string[] = [];

  async function validateGenerated(
    name: string,
    source: string,
    nodeCount: number,
    budget: typeof L0_DIAGRAM_BUDGET,
    edgeCountOverride?: number,
  ): Promise<void> {
    const edgeCount = edgeCountOverride ?? countMermaidArrowLines(source);
    issues.push(...formatDiagramIssues(name, checkNonEmptyDiagram(name, nodeCount)));
    issues.push(
      ...formatDiagramIssues(name, checkDiagramBudget(name, nodeCount, edgeCount, budget)),
    );
    const parseResult = await parseMermaidSource(source);
    issues.push(...formatDiagramIssues(name, checkMermaidParseResult(name, parseResult)));
  }

  for (const [variantName, diagram] of Object.entries(atlas.l0)) {
    const name = `L0 (${variantName})`;
    await validateGenerated(name, diagram.source, diagram.navIds.length, L0_DIAGRAM_BUDGET);
    issues.push(...formatDiagramIssues(name, checkDanglingNavIds(diagram.navIds, atlas.model)));
  }

  for (const [componentName, variants] of Object.entries(atlas.l1)) {
    for (const [variantName, diagram] of Object.entries(variants)) {
      const name = `L1 ${componentName} (${variantName})`;
      await validateGenerated(name, diagram.source, diagram.nodeCount, L1_DIAGRAM_BUDGET);
    }
  }

  await validateGenerated(
    'ER catalog',
    atlas.er.catalog,
    catalogSchema.tables.length,
    ER_DIAGRAM_BUDGET,
    catalogSchema.foreignKeys.length,
  );
  await validateGenerated(
    'ER session',
    atlas.er.session,
    sessionSchema.tables.length,
    ER_DIAGRAM_BUDGET,
    sessionSchema.foreignKeys.length,
  );

  const validatedAuthoredPaths = new Set<string>();
  for (const component of atlas.model.components) {
    for (const diagramPath of component.authoredDiagrams) {
      if (validatedAuthoredPaths.has(diagramPath)) continue;
      validatedAuthoredPaths.add(diagramPath);
      const source = authoredDiagramSources[diagramPath];
      issues.push(
        ...formatDiagramIssues(diagramPath, checkAuthoredDiagramStructure(diagramPath, source)),
      );
      if (source === undefined) continue;
      const parseResult = await parseMermaidSource(source);
      issues.push(
        ...formatDiagramIssues(diagramPath, checkMermaidParseResult(diagramPath, parseResult)),
      );
      const { states, transitionCount } = extractStateDiagramStructure(source);
      issues.push(
        ...formatDiagramIssues(
          diagramPath,
          checkDiagramBudget(diagramPath, states.size, transitionCount, AUTHORED_DIAGRAM_BUDGET),
        ),
      );
    }
  }

  return issues;
}

/**
 * Runs the full gate battery against the live working tree exactly once,
 * sharing every expensive step (the `ts.Program`-based extraction, the ER
 * in-memory DB builds, the active-changes overlay) between the gates that
 * need it AND atlas assembly — never re-derived per gate. Returns both the
 * collected issues and the assembled `Atlas`, so callers (`docs:check`,
 * `npm run build -w web-docs`'s prebuild step, `npm run dev -w web-docs`'s
 * predev step) can write `atlas.json` regardless of gate outcome while
 * still treating a non-empty `issues` array as a hard failure where that's
 * required (spec "Live-repo drift gates run at build and via docs:check").
 */
export async function runAllGates(): Promise<{ issues: string[]; atlas: Atlas }> {
  const root = repoRoot();
  const trackedTsFiles = listTrackedFiles({ extensions: ['.ts', '.tsx'] });
  const allTrackedFiles = listTrackedFiles();
  const coverageIssues = checkCoverage(trackedTsFiles, model);
  const baselineCapabilities = listBaselineCapabilities(allTrackedFiles);

  const overlay = buildLiveOverlay(root, allTrackedFiles);
  const er = runErExtraction();

  const mapped = mappedFiles(trackedTsFiles, model);
  const extraction = extractFileImports({
    files: mapped,
    repoRoot: root,
    isKnown: (file) => isMappedOrExcluded(file, model),
  });
  const snapshot = loadSnapshot(root);
  const authoredDiagramSources = readAuthoredDiagramSources(root, model);
  const { pending, issues: capabilityIssues } = runCapabilityAccountingGate(
    allTrackedFiles,
    baselineCapabilities,
  );
  const { trees: specTrees, issues: specIssues } = runSpecParserGate(root, baselineCapabilities);

  const atlas = buildAtlas({
    model,
    snapshot,
    overlay,
    mappedFiles: mapped,
    imports: extraction.imports,
    dynamicWarnings: extraction.dynamicWarnings,
    catalogErDiagram: er.catalogDiagram,
    sessionErDiagram: er.sessionDiagram,
    authoredDiagramSources,
    specTrees,
    baselineCapabilities,
    pendingCapabilities: pending,
  });

  const diagramValidityIssues = await runDiagramValidityGate(
    atlas,
    er.catalogSchema,
    er.sessionSchema,
    authoredDiagramSources,
  );

  const issues = [
    ...coverageIssues.map((issue) => `[coverage:${issue.kind}] ${issue.message}`),
    ...runEdgeSnapshotGate(extraction, snapshot),
    ...runRelationshipEvidenceGate(root),
    ...capabilityIssues,
    ...specIssues,
    ...runL0RendererAssertionGate(atlas, snapshot),
    ...diagramValidityIssues,
  ];

  return { issues, atlas };
}

/** Writes `atlas.json` (git-ignored — spec "regenerated by every build and dev-server start"), pretty-printed with a trailing newline (matching `scripts/snapshot.ts`'s own convention). */
export function writeAtlasFile(root: string, atlas: Atlas): void {
  writeFileSync(path.join(root, ATLAS_PATH), `${JSON.stringify(atlas, null, 2)}\n`, 'utf8');
}

function isDirectRun(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const { issues, atlas } = await runAllGates();
  writeAtlasFile(repoRoot(), atlas);
  if (issues.length > 0) {
    console.error(`docs:check failed with ${issues.length} violation(s):\n`);
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    process.exit(1);
  }
  console.log(`docs:check passed (${formatPassMessage()})`);
  process.exit(0);
}
