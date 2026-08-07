// L1 (per-component module graph) mermaid source generation (design.md D3;
// spec "L1 accounts for every mapped file"). Pure function over a
// component's mapped-file list plus its intra-component file-level import
// edges — 6.3's atlas assembly filters `ProjectedEdges`/`FileImport`s down
// to a single component's intra-component pairs and feeds them here; no
// disk access in this module.
//
// Grouping threshold: **15**. Below/at 15 visible files, every file renders
// as its own node — small enough that a flat list stays legible. Above 15,
// files are grouped by their first subdirectory segment (relative to the
// component's own root, i.e. the longest common directory prefix across
// its mapped files) into one node per subdirectory, labeled with its file
// count; a file with no subdirectory (sitting directly at the component
// root) still renders as its own node even while grouping is active — it
// has nothing to group into. 15 was picked as the point past which mermaid
// flowchart layouts visibly crowd for this kind of shallow module graph
// (task 6.1); 6.3's per-diagram size budgets are the enforced backstop, so
// this constant only has to be a reasonable default, not a proof.
//
// Test-file elision: `*.test.ts`/`*.test.tsx` files are hidden by default
// (`showTestFiles: false`) and folded into a returned `elidedTestCount`
// rather than a node in the diagram — the L1 PAGE (task 7.2) renders the
// count as surrounding UI text ("N test files elided [show]"), not as a
// disconnected mermaid node. An edge whose endpoint is an elided test file
// is dropped (no dangling reference to a hidden node); an edge whose two
// endpoints collapse into the SAME group (both files grouped together) is
// dropped as a self-loop, not rendered as `X --> X`.

import { escapeMermaidLabel } from '../src/lib/mermaidEscape';
import { slugifyComponentId } from './navigation';

export const DEFAULT_L1_GROUP_THRESHOLD = 15;

export interface ModuleImportEdge {
  /** Repo-relative file path, intra-component only (both endpoints belong to the same component). */
  from: string;
  to: string;
}

export interface L1GenerationOptions {
  showTestFiles: boolean;
  groupThreshold: number;
}

export interface L1Diagram {
  source: string;
  /** Count of rendered nodes (ungrouped files + group nodes) — not a raw file count once grouping is active. */
  nodeCount: number;
  /** Count of visible files that were folded into a subdirectory group node rather than rendered individually. */
  groupedFileCount: number;
  /** Count of *.test.ts(x) files hidden under the current showTestFiles setting. */
  elidedTestCount: number;
}

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

/** Longest common directory prefix (in path segments, directories only — the filename itself is excluded) across `files`. Empty string when there is none or `files` is empty. */
function commonDirPrefix(files: string[]): string {
  if (files.length === 0) return '';
  const dirParts = files.map((file) => file.split('/').slice(0, -1));
  let prefix = dirParts[0];
  for (const parts of dirParts.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.join('/');
}

function relativePath(file: string, prefix: string): string {
  return prefix.length > 0 ? file.slice(prefix.length + 1) : file;
}

/** The first path segment of `relative` when it contains a subdirectory, else undefined (a root-level file — nothing to group into). */
function groupOf(relative: string): string | undefined {
  const slashIndex = relative.indexOf('/');
  return slashIndex === -1 ? undefined : relative.slice(0, slashIndex);
}

/**
 * Generates the L1 module-graph flowchart source for one component.
 * `files` is every mapped file belonging to the component (any order —
 * sorted internally); `moduleEdges` is its intra-component file-level
 * imports (already filtered to same-component pairs by the caller).
 */
export function generateL1(
  componentName: string,
  files: string[],
  moduleEdges: ModuleImportEdge[],
  options: L1GenerationOptions,
): L1Diagram {
  const sortedFiles = [...files].sort();
  const testFiles = sortedFiles.filter(isTestFile);
  const nonTestFiles = sortedFiles.filter((file) => !isTestFile(file));
  const visibleFiles = options.showTestFiles ? sortedFiles : nonTestFiles;
  const elidedTestCount = options.showTestFiles ? 0 : testFiles.length;

  const prefix = commonDirPrefix(sortedFiles);
  const shouldGroup = visibleFiles.length > options.groupThreshold;

  const fileGroup = new Map<string, string | undefined>();
  for (const file of visibleFiles) {
    fileGroup.set(file, shouldGroup ? groupOf(relativePath(file, prefix)) : undefined);
  }

  const nodeIdForFile = (file: string): string =>
    slugifyComponentId(`${componentName}/${relativePath(file, prefix)}`);
  const nodeIdForGroup = (group: string): string => slugifyComponentId(`${componentName}/${group}`);

  /** The mermaid node id a file collapses to for rendering purposes, or undefined when the file is hidden (an elided test file — never a render endpoint). */
  const renderIdFor = (file: string): string | undefined => {
    if (!fileGroup.has(file)) return undefined;
    const group = fileGroup.get(file);
    return group ? nodeIdForGroup(group) : nodeIdForFile(file);
  };

  const groupCounts = new Map<string, number>();
  for (const file of visibleFiles) {
    const group = fileGroup.get(file);
    if (group) groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }
  const groupNames = [...groupCounts.keys()].sort();

  const lines: string[] = ['flowchart TD'];

  for (const group of groupNames) {
    const label = `${group}/ (${groupCounts.get(group)} files)`;
    lines.push(`  ${nodeIdForGroup(group)}["${escapeMermaidLabel(label)}"]`);
  }

  const ungroupedFiles = visibleFiles.filter((file) => !fileGroup.get(file));
  for (const file of ungroupedFiles) {
    const label = relativePath(file, prefix);
    lines.push(`  ${nodeIdForFile(file)}["${escapeMermaidLabel(label)}"]`);
  }

  const edgeLines = new Set<string>();
  for (const edge of moduleEdges) {
    const fromId = renderIdFor(edge.from);
    const toId = renderIdFor(edge.to);
    if (!fromId || !toId || fromId === toId) continue;
    edgeLines.add(`  ${fromId} --> ${toId}`);
  }
  lines.push(...[...edgeLines].sort());

  const groupedFileCount = visibleFiles.filter((file) => !!fileGroup.get(file)).length;

  return {
    source: lines.join('\n'),
    nodeCount: groupNames.length + ungroupedFiles.length,
    groupedFileCount,
    elidedTestCount,
  };
}
