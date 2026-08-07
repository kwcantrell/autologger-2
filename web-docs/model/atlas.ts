// Atlas assembly (task 6.3; design.md D1's atlas description: "a single
// generated, git-ignored artifact `atlas.json` (component graph, module
// graphs, mermaid diagram sources, mermaid client config, spec tree,
// overlay data)"; spec "web-docs is a static workspace with zero server
// involvement"). ONE pure function, `buildAtlas`, producing the full typed
// atlas the phase-7 SPA renders every page from — SEAM (declared at phase 2
// partition, carried through every subsequent phase): every field a site
// page renders must exist here, with every path repo-relative.
//
// Zero I/O: `buildAtlas` takes only already-extracted/already-generated
// data (a `ComponentModel`, an `EdgeSnapshot`, a built `OverlayResult`,
// already-read authored-diagram sources, already-run ER diagram strings,
// already-parsed spec trees) and touches no filesystem, no `child_process`,
// no database — mirroring every other model/*.ts module's pure-logic split
// (spec "Builds are deterministic and offline" — "no reads of git-ignored
// artifacts" is trivially true of a function with zero I/O by construction;
// model/atlas.test.ts also spies on the real `node:fs` functions to catch a
// future regression). The live-repo wiring (real extraction, real in-memory
// migration runs, real DOM-shimmed mermaid parse) lives in scripts/check.ts.
//
// Determinism (spec "Builds are deterministic and offline" — "all
// collection iteration sorted"): every array in the returned `Atlas` is
// freshly sorted here, regardless of input order, and the `l1` record's
// keys are inserted in sorted componentName order (JS preserves string-key
// insertion order, and so does `JSON.stringify` — verified by the
// byte-identical-twice test) rather than relying on any caller's ordering.

import type { DynamicImportWarning, FileImport } from '../src/lib/extractImports';
import { matchesAnyGlob } from '../src/lib/repo';
import type { ComponentModel } from './components';
import type { EdgeSnapshot } from './edges';
import { generateL0, type L0Diagram } from './generateL0';
import {
  DEFAULT_L1_GROUP_THRESHOLD,
  generateL1,
  type L1Diagram,
  type ModuleImportEdge,
} from './generateL1';
import { MERMAID_CLIENT_CONFIG, type MermaidClientConfig } from './mermaidConfig';
import { buildNavIndex, type NavIdEntry } from './navigation';
import type { OverlayResult } from './overlay';
import type { CapabilitySpecTree } from './specParser';

export interface L0Variants {
  default: L0Diagram;
  withTest: L0Diagram;
  withTooling: L0Diagram;
  full: L0Diagram;
}

export interface L1Variants {
  default: L1Diagram;
  withTests: L1Diagram;
}

export interface AuthoredDiagramEntry {
  path: string;
  componentName: string;
  label: 'authored';
  source: string;
}

export interface AtlasWarnings {
  dynamicImports: DynamicImportWarning[];
  /** Same array as `overlay.warnings` — duplicated at the top level so the SPA's warnings panel has one place to look, without knowing to reach into `overlay`. */
  overlay: string[];
}

export interface Atlas {
  model: ComponentModel;
  /** id<->route mapping over EVERY model component (not just those visible in any one L0 variant) — the phase-7 SPA's route table. */
  navigation: NavIdEntry[];
  l0: L0Variants;
  /** Keyed by componentName; present only for glob-bearing components (runtime/tooling/test-harness — datastore/external components have no TS files to graph). */
  l1: Record<string, L1Variants>;
  er: { catalog: string; session: string };
  authoredDiagrams: AuthoredDiagramEntry[];
  specTree: CapabilitySpecTree[];
  overlay: OverlayResult;
  capabilities: { baseline: string[]; pending: string[] };
  mermaidConfig: MermaidClientConfig;
  warnings: AtlasWarnings;
}

export interface BuildAtlasParams {
  model: ComponentModel;
  /** The reviewed, committed edge snapshot — L0 draws this, never a freshly re-derived set (design.md D4). */
  snapshot: EdgeSnapshot;
  overlay: OverlayResult;
  /** Every tracked file mapped to a glob-bearing component (coverage.ts's `mappedFiles`). */
  mappedFiles: string[];
  /** Full file-level import graph (extraction's `imports`) — filtered down to each component's intra-component pairs internally. */
  imports: FileImport[];
  dynamicWarnings: DynamicImportWarning[];
  catalogErDiagram: string;
  sessionErDiagram: string;
  /** Path -> already-read file content, for every path any component's `authoredDiagrams` names. A path missing from this map is omitted from the atlas (the diagram-validity gate is what fails the build on a missing file, not atlas assembly — spec "Broken or empty authored diagram fails"). */
  authoredDiagramSources: Record<string, string | undefined>;
  specTrees: CapabilitySpecTree[];
  baselineCapabilities: string[];
  pendingCapabilities: string[];
}

function sortedComponentModel(model: ComponentModel): ComponentModel {
  return {
    components: [...model.components].sort((a, b) => a.name.localeCompare(b.name)),
    relationships: [...model.relationships].sort((a, b) => a.id.localeCompare(b.id)),
    capabilityScopes: [...model.capabilityScopes].sort((a, b) =>
      a.capability.localeCompare(b.capability),
    ),
    exclusions: [...model.exclusions].sort((a, b) => a.file.localeCompare(b.file)),
  };
}

function buildL0Variants(
  model: ComponentModel,
  snapshot: EdgeSnapshot,
  overlay: OverlayResult,
): L0Variants {
  return {
    default: generateL0(model, snapshot, overlay, { showTest: false, showTooling: false }),
    withTest: generateL0(model, snapshot, overlay, { showTest: true, showTooling: false }),
    withTooling: generateL0(model, snapshot, overlay, { showTest: false, showTooling: true }),
    full: generateL0(model, snapshot, overlay, { showTest: true, showTooling: true }),
  };
}

/** Every mapped file belonging to `componentName`, sorted. */
function filesForComponent(
  componentName: string,
  model: ComponentModel,
  mappedFiles: string[],
): string[] {
  const component = model.components.find((c) => c.name === componentName);
  if (!component) return [];
  return [...mappedFiles].filter((file) => matchesAnyGlob(file, component.globs)).sort();
}

/** Intra-component file-level import edges (both endpoints in `files`). */
function moduleEdgesFor(files: string[], imports: FileImport[]): ModuleImportEdge[] {
  const fileSet = new Set(files);
  return imports
    .filter((imp) => fileSet.has(imp.fromFile) && fileSet.has(imp.toFile))
    .map((imp) => ({ from: imp.fromFile, to: imp.toFile }));
}

function buildL1Record(
  model: ComponentModel,
  mappedFiles: string[],
  imports: FileImport[],
): Record<string, L1Variants> {
  const globBearing = [...model.components]
    .filter((component) => component.globs.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const entries: [string, L1Variants][] = [];
  for (const component of globBearing) {
    const files = filesForComponent(component.name, model, mappedFiles);
    if (files.length === 0) continue;
    const moduleEdges = moduleEdgesFor(files, imports);
    entries.push([
      component.name,
      {
        default: generateL1(component.name, files, moduleEdges, {
          showTestFiles: false,
          groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
        }),
        withTests: generateL1(component.name, files, moduleEdges, {
          showTestFiles: true,
          groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
        }),
      },
    ]);
  }
  // Object.fromEntries preserves insertion order for string keys — entries
  // were pushed in sorted componentName order above, so JSON.stringify's
  // key order is deterministic without any further sorting here.
  return Object.fromEntries(entries);
}

function buildAuthoredDiagrams(
  model: ComponentModel,
  authoredDiagramSources: Record<string, string | undefined>,
): AuthoredDiagramEntry[] {
  const entries: AuthoredDiagramEntry[] = [];
  for (const component of model.components) {
    for (const path of component.authoredDiagrams) {
      const source = authoredDiagramSources[path];
      if (source === undefined) continue;
      entries.push({ path, componentName: component.name, label: 'authored', source });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function buildAtlas(params: BuildAtlasParams): Atlas {
  const model = sortedComponentModel(params.model);

  return {
    model,
    navigation: buildNavIndex(model.components.map((c) => c.name)),
    l0: buildL0Variants(model, params.snapshot, params.overlay),
    l1: buildL1Record(model, params.mappedFiles, params.imports),
    er: { catalog: params.catalogErDiagram, session: params.sessionErDiagram },
    authoredDiagrams: buildAuthoredDiagrams(model, params.authoredDiagramSources),
    specTree: [...params.specTrees].sort((a, b) => a.capability.localeCompare(b.capability)),
    overlay: params.overlay,
    capabilities: {
      baseline: [...params.baselineCapabilities].sort(),
      pending: [...params.pendingCapabilities].sort(),
    },
    mermaidConfig: MERMAID_CLIENT_CONFIG,
    warnings: {
      dynamicImports: [...params.dynamicWarnings].sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
      ),
      overlay: params.overlay.warnings,
    },
  };
}
