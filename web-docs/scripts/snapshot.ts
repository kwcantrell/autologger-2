// Regenerates `web-docs/model/edges.snapshot.json` from the live working
// tree (spec "Cross-component edges are derived, classified, and checked
// against a reviewed snapshot" — "the regeneration command"). Never
// invoked implicitly by `build`/`check`/`docs:check` (design.md D4
// invariant: "the snapshot is regenerated only alongside review, never
// automatically in the build") — a human runs this, reads the diff, and
// commits it in the same change as whatever moved the edge.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { model } from '../model/components';
import { isMappedOrExcluded, mappedFiles } from '../model/coverage';
import { type EdgeSnapshot, projectComponentEdges } from '../model/edges';
import { extractFileImports } from '../src/lib/extractImports';
import { listTrackedFiles, repoRoot } from '../src/lib/repo';

const SNAPSHOT_PATH = 'web-docs/model/edges.snapshot.json';

export function buildSnapshot(root: string): EdgeSnapshot {
  const trackedTsFiles = listTrackedFiles({ extensions: ['.ts', '.tsx'], cwd: root });
  const extraction = extractFileImports({
    files: mappedFiles(trackedTsFiles, model),
    repoRoot: root,
    isKnown: (file) => isMappedOrExcluded(file, model),
  });

  if (extraction.unmappedImportErrors.length > 0) {
    const lines = extraction.unmappedImportErrors.map(
      (error) => `  - ${error.fromFile} imports ${error.toFile}`,
    );
    throw new Error(
      `Cannot regenerate the snapshot: ${extraction.unmappedImportErrors.length} import(s) ` +
        `resolve to an unmapped, unexcluded in-repo file:\n${lines.join('\n')}\n` +
        'Fix the component model first (add a component glob or an exclusion entry), then re-run.',
    );
  }

  const projected = projectComponentEdges(extraction.imports, model);
  return projected.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind }));
}

function isDirectRun(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const root = repoRoot();
  const snapshot = buildSnapshot(root);
  const snapshotFile = path.join(root, SNAPSHOT_PATH);
  writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${snapshot.length} edge(s) to ${SNAPSHOT_PATH}. Review the diff before committing.`,
  );
}
