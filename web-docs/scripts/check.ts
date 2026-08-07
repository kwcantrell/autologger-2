// Root `docs:check` entry point (`npm run docs:check` → `npm run check -w
// web-docs` → this file under `tsx`). Runs every live-repo drift gate from
// design.md D4 against the current working tree, hard-failing (non-zero
// exit) on any violation — never a warning, never cached, never per-file
// exempted beyond the model's own exclusion list (spec "Live-repo drift
// gates run at build and via docs:check").
//
// Gate battery status:
//   - component coverage (task 2.1/2.2)        IMPLEMENTED below
//   - edge derivation + snapshot conformance    STUB — task 3.x
//   - relationship evidence                     STUB — task 4.1
//   - capability accounting                     STUB — task 4.2
//   - diagram validity (parse/structural/budget) STUB — task 6.3
// Each stub is a clearly marked no-op that exits 0 — it must be replaced
// with the real gate in its task, never left as a silent pass once that
// task lands.
import { fileURLToPath } from 'node:url';
import { checkCoverage } from '../model/coverage';
import { model } from '../model/components';
import { listTrackedFiles } from '../src/lib/repo';

export function gatesNotYetImplementedMessage(): string {
  return 'web-docs: gates not yet implemented — extraction pipeline lands in later phases.';
}

/** STUB — task 3.2: derive edges, classify production/test, diff against the committed snapshot. */
function runEdgeSnapshotGateStub(): string[] {
  return [];
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
    ...runEdgeSnapshotGateStub(),
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
