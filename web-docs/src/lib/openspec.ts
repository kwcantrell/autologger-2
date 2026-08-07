// Shared OpenSpec enumeration helpers (orchestrator-preassigned home, phase 4):
// baseline capability directories under openspec/specs/, active tracked
// change directories under openspec/changes/ (archive excluded), and a
// change's delta capability directories. Pure functions over an
// already-listed tracked-file array — repo.ts's `listTrackedFiles()` does the
// git IO, matching the split model/coverage.ts and model/edges.ts already
// use (pure logic, fixture-testable; live wiring in scripts/check.ts).
//
// "A change counts only via git-TRACKED proposal.md" (spec "Active changes
// overlay from tracked artifacts"): a change/capability only exists here if
// its marker file (proposal.md / spec.md) is itself in the tracked-file list
// this module is given — an untracked or partial `openspec/changes/`
// scaffold contributes nothing, by construction (no filtering step needed
// beyond "was it in the list").
//
// Later phases (5.1 spec parsing, 5.3 overlay extraction) should import from
// here rather than re-deriving this enumeration.

const SPECS_PREFIX = 'openspec/specs/';
const CHANGES_PREFIX = 'openspec/changes/';
const ARCHIVE_PREFIX = 'openspec/changes/archive/';

/** The directory segment immediately after `prefix` in `file`, or undefined if `file` doesn't have one (i.e. `prefix` isn't followed by a `/`). */
function dirNameAfterPrefix(file: string, prefix: string): string | undefined {
  if (!file.startsWith(prefix)) return undefined;
  const rest = file.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? undefined : rest.slice(0, slash);
}

/** Baseline capability names: directories under openspec/specs/ with a tracked spec.md. */
export function listBaselineCapabilities(trackedFiles: string[]): string[] {
  const names = new Set<string>();
  for (const file of trackedFiles) {
    if (!file.endsWith('/spec.md')) continue;
    const name = dirNameAfterPrefix(file, SPECS_PREFIX);
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Active (non-archived) change directory names that have a git-tracked proposal.md. */
export function listActiveChangeNames(trackedFiles: string[]): string[] {
  const names = new Set<string>();
  for (const file of trackedFiles) {
    if (file.startsWith(ARCHIVE_PREFIX)) continue;
    if (!file.endsWith('/proposal.md')) continue;
    const name = dirNameAfterPrefix(file, CHANGES_PREFIX);
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Delta capability directory names under openspec/changes/<changeName>/specs/. */
export function listChangeDeltaCapabilities(trackedFiles: string[], changeName: string): string[] {
  const prefix = `${CHANGES_PREFIX}${changeName}/specs/`;
  const names = new Set<string>();
  for (const file of trackedFiles) {
    if (!file.startsWith(prefix) || !file.endsWith('/spec.md')) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) names.add(rest.slice(0, slash));
  }
  return [...names].sort();
}

/**
 * Every delta capability named by any active (tracked-proposal) change's
 * delta specs — the pending-grace candidate set (model/capabilities.ts).
 */
export function listAllActiveDeltaCapabilities(trackedFiles: string[]): string[] {
  const names = new Set<string>();
  for (const changeName of listActiveChangeNames(trackedFiles)) {
    for (const capability of listChangeDeltaCapabilities(trackedFiles, changeName)) {
      names.add(capability);
    }
  }
  return [...names].sort();
}
