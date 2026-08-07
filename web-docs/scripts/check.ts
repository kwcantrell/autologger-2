// Root `docs:check` entry point (`npm run docs:check` → `npm run check -w
// web-docs` → this file under `tsx`). Runs every live-repo drift gate from
// design.md D4 against the current working tree, hard-failing (non-zero
// exit) on any violation — never a warning, never cached, never per-file
// exempted beyond the model's own exclusion list (spec "Live-repo drift
// gates run at build and via docs:check").
//
// Gate battery status:
//   - component coverage (task 2.1/2.2)        IMPLEMENTED below
//   - edge derivation + snapshot conformance    IMPLEMENTED below (task 3.1/3.2)
//   - relationship evidence                     STUB — task 4.1
//   - capability accounting                     STUB — task 4.2
//   - diagram validity (parse/structural/budget) STUB — task 6.3
// Each stub is a clearly marked no-op that exits 0 — it must be replaced
// with the real gate in its task, never left as a silent pass once that
// task lands.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { model } from '../model/components';
import { checkCoverage, isMappedOrExcluded } from '../model/coverage';
import { diffEdgeSnapshot, type EdgeSnapshot, projectComponentEdges } from '../model/edges';
import { extractFileImports } from '../src/lib/extractImports';
import { listTrackedFiles, matchesAnyGlob, repoRoot } from '../src/lib/repo';

export function gatesNotYetImplementedMessage(): string {
  return (
    'web-docs: relationship evidence, capability accounting, and diagram validity ' +
    'gates not yet implemented — land in later phases.'
  );
}

/** Tracked .ts/.tsx files assigned to a real (glob-bearing) component — the extractor's roots. */
function mappedFiles(trackedFiles: string[]): string[] {
  return trackedFiles.filter((file) =>
    model.components.some(
      (component) => component.globs.length > 0 && matchesAnyGlob(file, component.globs),
    ),
  );
}

const SNAPSHOT_PATH = 'web-docs/model/edges.snapshot.json';

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

/** Derives, classifies, and diffs cross-component edges against the committed snapshot (task 3.1/3.2). */
function runEdgeSnapshotGate(): string[] {
  const root = repoRoot();
  const trackedTsFiles = listTrackedFiles({ extensions: ['.ts', '.tsx'] });
  const extraction = extractFileImports({
    files: mappedFiles(trackedTsFiles),
    repoRoot: root,
    isKnown: (file) => isMappedOrExcluded(file, model),
  });

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
  const snapshot = loadSnapshot(root);
  for (const diffIssue of diffEdgeSnapshot(projected, snapshot)) {
    issues.push(`[edges:${diffIssue.kind}] ${diffIssue.message}`);
  }

  return issues;
}

/** STUB — task 4.1: check each declared relationship's evidence rule against the live tree. */
function runRelationshipEvidenceGateStub(): string[] {
  return [];
}

/** STUB — task 4.2: account for every baseline openspec/specs/ capability. */
function runCapabilityAccountingGateStub(): string[] {
  return [];
}

/** STUB — task 6.3: jsdom-bootstrapped mermaid parse + structural checks + size budgets. */
function runDiagramValidityGateStub(): string[] {
  return [];
}

export function runAllGates(): string[] {
  const trackedTsFiles = listTrackedFiles({ extensions: ['.ts', '.tsx'] });
  const coverageIssues = checkCoverage(trackedTsFiles, model);

  return [
    ...coverageIssues.map((issue) => `[coverage:${issue.kind}] ${issue.message}`),
    ...runEdgeSnapshotGate(),
    ...runRelationshipEvidenceGateStub(),
    ...runCapabilityAccountingGateStub(),
    ...runDiagramValidityGateStub(),
  ];
}

function isDirectRun(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const errors = runAllGates();
  if (errors.length > 0) {
    console.error(`docs:check failed with ${errors.length} violation(s):\n`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log(`docs:check passed (${gatesNotYetImplementedMessage()})`);
  process.exit(0);
}
