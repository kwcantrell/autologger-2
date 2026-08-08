// Structural diagram-validity checks (task 6.3; design.md D9; spec
// "Diagram validity gates use a DOM-bootstrapped parser and size budgets",
// "Authored state diagrams are attached, structurally validated, and
// labeled"). Pure logic — no mermaid, no disk. This module is the
// *independent* layer the panel required: mermaid's own `parse()` (the
// DOM-shimmed half, src/lib/mermaidValidate.ts) ACCEPTS structurally-garbage
// stateDiagrams — measured empirically against mermaid 11.16.1 under a jsdom
// bootstrap (a bare `note` line, or an empty `stateDiagram-v2` with zero
// transitions, both parse successfully) — so a real gate needs a second,
// differently-derived check that actually looks at what a diagram contains,
// not just whether mermaid's grammar accepts it (task-6.3-report.md's
// gate-intent demo (c) reproduces this).
//
// Live-repo wiring (scripts/check.ts) drives this against real generated/
// authored sources; every function here is fixture-testable without disk or
// mermaid.

// Type-only import from src/lib (impure file, since it drives the real
// mermaid parser) — mirrors model/edges.ts importing `FileImport`'s type
// from src/lib/extractImports.ts: types are erased at compile time, so this
// carries no I/O into this module.
import type { MermaidParseResult } from '../src/lib/mermaidValidate';
import type { ComponentModel } from './components';
import { type NavIdEntry, routeForComponent, slugifyComponentId } from './navigation';

export interface DiagramValidityIssue {
  kind:
    | 'structurally-empty'
    | 'missing-diagram-file'
    | 'budget-exceeded'
    | 'dangling-nav-id'
    | 'unparseable';
  message: string;
}

export interface DiagramBudget {
  maxNodes: number;
  maxEdges: number;
}

// Budgets, chosen with headroom over live-tree sizes measured 2026-08-07
// (task-6.3-report.md quotes the measurement method for the original
// numbers this budget was set against). L0 full variant: 30 nodes / 79
// edges+relationships. L1 max by NODE count (routers component, `withTests`
// variant — server/src/routers/ is a genuinely flat directory with no
// subdirectory structure, so generateL1's grouping cannot collapse it):
// re-measured 2026-08-07 after `router-directory-decomposition` moved the
// AI runtime out of `routers/` into its own `server/src/ai-runtime/`
// component (task 2.9) at 43 nodes / 20 edges — down from the pre-move
// 64 nodes / 82 edges task-6.1-6.2-report.md flagged as untested against
// the live tree. Edge count is no longer routers' own high-water mark: L1
// max by EDGE count is now session-core's `withTests` variant at 26 nodes /
// 60 edges. ER: catalog 9 tables / 3 FKs, session 9 tables / 0 FKs.
// Authored: ~3 states / 6-8 transitions each. These are hard failures
// (design.md D4 invariant: no per-diagram exemption, no warning downgrade)
// — headroom exists so ordinary growth doesn't red the build, not so the
// budget stops meaning anything.
export const L0_DIAGRAM_BUDGET: DiagramBudget = { maxNodes: 60, maxEdges: 160 };
export const L1_DIAGRAM_BUDGET: DiagramBudget = { maxNodes: 100, maxEdges: 150 };
export const ER_DIAGRAM_BUDGET: DiagramBudget = { maxNodes: 30, maxEdges: 20 };
export const AUTHORED_DIAGRAM_BUDGET: DiagramBudget = { maxNodes: 20, maxEdges: 30 };

export interface StateDiagramStructure {
  states: Set<string>;
  transitionCount: number;
}

// A stateDiagram-v2 transition line: `A --> B` or `A --> B: label`. `[*]`
// (mermaid's start/end pseudostate) counts as a state like any other — it's
// a real node in the rendered diagram. Deliberately does NOT match `note
// ... : ...` lines (mermaid accepts these as valid diagram content, but
// they are annotations, not states or transitions — the very case
// mermaid.parse() alone cannot distinguish, per this module's header).
const TRANSITION_LINE = /^([^\s]+)\s*-->\s*([^\s:]+)(?::.*)?$/;

/**
 * Extracts the state set and transition count from stateDiagram-v2 text by
 * reading the transition lines directly — never via mermaid's parser, which
 * accepts near-garbage state diagrams (module header). Ignores blank lines
 * and `%%` comment lines (authored diagrams carry a multi-line `%%` header
 * quoting their code-read provenance — task 6.2).
 */
export function extractStateDiagramStructure(source: string): StateDiagramStructure {
  const states = new Set<string>();
  let transitionCount = 0;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('%%')) continue;
    const match = line.match(TRANSITION_LINE);
    if (!match) continue;
    const [, from, to] = match;
    if (from) states.add(from);
    if (to) states.add(to);
    transitionCount++;
  }
  return { states, transitionCount };
}

/**
 * Authored-diagram structural gate (spec "The gate SHALL fail if an
 * attached diagram file is missing, fails mermaid parsing, or is
 * structurally empty (no states or no transitions)" — this function covers
 * the missing-file and structurally-empty halves; mermaid parsing is
 * src/lib/mermaidValidate.ts's job). `source` is `undefined` when the live
 * wiring's file read failed (missing file), never a thrown exception —
 * callers pass the read result straight through.
 */
export function checkAuthoredDiagramStructure(
  path: string,
  source: string | undefined,
): DiagramValidityIssue[] {
  if (source === undefined) {
    return [
      {
        kind: 'missing-diagram-file',
        message: `Authored diagram "${path}" is attached in the model but the file could not be read.`,
      },
    ];
  }
  const { states, transitionCount } = extractStateDiagramStructure(source);
  if (states.size === 0 || transitionCount === 0) {
    return [
      {
        kind: 'structurally-empty',
        message:
          `Authored diagram "${path}" is structurally empty (${states.size} state(s), ` +
          `${transitionCount} transition(s)) — mermaid may still parse it, but it shows no ` +
          'real lifecycle.',
      },
    ];
  }
  return [];
}

/** Generated-diagram (L0/L1/ER) non-empty check: at least one node. */
export function checkNonEmptyDiagram(name: string, nodeCount: number): DiagramValidityIssue[] {
  if (nodeCount === 0) {
    return [{ kind: 'structurally-empty', message: `Generated diagram "${name}" has zero nodes.` }];
  }
  return [];
}

/**
 * Per-diagram size budget (spec "Oversized diagram fails"). Node and edge
 * violations are reported independently — a diagram can exceed one budget
 * without exceeding the other.
 */
export function checkDiagramBudget(
  name: string,
  nodeCount: number,
  edgeCount: number,
  budget: DiagramBudget,
): DiagramValidityIssue[] {
  const issues: DiagramValidityIssue[] = [];
  if (nodeCount > budget.maxNodes) {
    issues.push({
      kind: 'budget-exceeded',
      message: `Diagram "${name}" has ${nodeCount} nodes, exceeding its budget of ${budget.maxNodes}.`,
    });
  }
  if (edgeCount > budget.maxEdges) {
    issues.push({
      kind: 'budget-exceeded',
      message: `Diagram "${name}" has ${edgeCount} edges, exceeding its budget of ${budget.maxEdges}.`,
    });
  }
  return issues;
}

/**
 * Dangling-navigation-id check (spec "Dangling navigation id fails" —
 * "every navigation id resolving to a real component route"). A `NavIdEntry`
 * is valid only when its `componentName` names a real model component AND
 * its `id`/`route` are exactly what `slugifyComponentId`/`routeForComponent`
 * (navigation.ts — THE canonical derivation, per that module's own header)
 * would produce for that name — catching both a reference to an unknown
 * component and a hand-drifted id/route that no longer matches the
 * canonical derivation.
 */
export function checkDanglingNavIds(
  navIds: NavIdEntry[],
  model: ComponentModel,
): DiagramValidityIssue[] {
  const componentNames = new Set(model.components.map((component) => component.name));
  const issues: DiagramValidityIssue[] = [];
  for (const navId of navIds) {
    const valid =
      componentNames.has(navId.componentName) &&
      navId.id === slugifyComponentId(navId.componentName) &&
      navId.route === routeForComponent(navId.componentName);
    if (!valid) {
      issues.push({
        kind: 'dangling-nav-id',
        message:
          `Navigation id "${navId.id}" (component "${navId.componentName}", route ` +
          `"${navId.route}") does not resolve to a real component route.`,
      });
    }
  }
  return issues.sort((a, b) => a.message.localeCompare(b.message));
}

/**
 * Counts mermaid edge lines (flowchart `-->`/`==>`/`-.->` — the three arrow
 * forms generateL0.ts/generateL1.ts emit) in an already-generated source, as
 * the edge-count half of the size-budget check for L0/L1 diagrams. Text-
 * based, not a mermaid-AST walk — deliberately: the generators already
 * computed and are responsible for exactly what they emit, so counting the
 * emitted lines is a faithful, independently-derived measure of diagram
 * size, matching the same "read the actual output text" discipline the L0
 * renderer assertion (generateL0.ts) uses.
 */
export function countMermaidArrowLines(source: string): number {
  return source.split('\n').filter((line) => /-->|==>|-\.->/.test(line)).length;
}

/**
 * Formats a `MermaidParseResult` (src/lib/mermaidValidate.ts — the
 * DOM-shimmed real parse) into a gate issue. Kept as a pure formatting
 * function, separate from the async parse call itself, so the message shape
 * is fixture-testable without mermaid/jsdom in the loop.
 */
export function checkMermaidParseResult(
  name: string,
  result: MermaidParseResult,
): DiagramValidityIssue[] {
  if (result.valid) return [];
  return [
    { kind: 'unparseable', message: `Diagram "${name}" failed mermaid parsing: ${result.error}` },
  ];
}
