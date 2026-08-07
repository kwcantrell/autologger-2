// TDD for the structural half of diagram validity (task 6.3; design.md D9;
// spec "Diagram validity gates use a DOM-bootstrapped parser and size
// budgets", "Authored state diagrams are attached, structurally validated,
// and labeled"). Pure logic — no mermaid, no disk; the DOM-shimmed mermaid
// *parse* half lives in src/lib/mermaidValidate.ts (a separate module,
// because mermaid.parse() ACCEPTS structurally-garbage stateDiagrams —
// measured — so these structural checks are the layer that actually catches
// it, independent of whatever mermaid's parser does or doesn't accept).
import { describe, expect, it } from 'vitest';
import type { ComponentModel } from './components';
import {
  AUTHORED_DIAGRAM_BUDGET,
  checkAuthoredDiagramStructure,
  checkDanglingNavIds,
  checkDiagramBudget,
  checkMermaidParseResult,
  checkNonEmptyDiagram,
  countMermaidArrowLines,
  ER_DIAGRAM_BUDGET,
  extractStateDiagramStructure,
  L0_DIAGRAM_BUDGET,
  L1_DIAGRAM_BUDGET,
} from './diagramValidity';
import type { NavIdEntry } from './navigation';

function fixtureModel(componentNames: string[]): ComponentModel {
  return {
    components: componentNames.map((name) => ({
      name,
      kind: 'runtime',
      description: '',
      globs: [`${name}/**`],
      capabilities: [],
      authoredDiagrams: [],
    })),
    relationships: [],
    capabilityScopes: [],
    exclusions: [],
  };
}

describe('extractStateDiagramStructure', () => {
  it('extracts every state named in a transition line and counts transitions', () => {
    const source = [
      'stateDiagram-v2',
      '    [*] --> Free',
      '    Free --> Held: grant',
      '    Held --> Held: refresh',
      '    Held --> Free: release',
    ].join('\n');
    const { states, transitionCount } = extractStateDiagramStructure(source);
    expect([...states].sort()).toEqual(['[*]', 'Free', 'Held'].sort());
    expect(transitionCount).toBe(4);
  });

  it('ignores the leading %% comment header and blank lines', () => {
    const source = [
      '%% AUTHORED diagram — derived from a code read.',
      '%% second comment line',
      'stateDiagram-v2',
      '',
      '    [*] --> Absent',
      '    Absent --> Active: constructed',
    ].join('\n');
    const { states, transitionCount } = extractStateDiagramStructure(source);
    expect(states.has('Absent')).toBe(true);
    expect(states.has('Active')).toBe(true);
    expect(transitionCount).toBe(2);
  });

  it('returns zero states and zero transitions for a diagram with no transition lines', () => {
    const source = 'stateDiagram-v2\n';
    const result = extractStateDiagramStructure(source);
    expect(result.states.size).toBe(0);
    expect(result.transitionCount).toBe(0);
  });

  it('does not count a mermaid note/comment pseudo-line as a transition (mermaid.parse accepts this — measured — but it has no real state or transition)', () => {
    const source = 'stateDiagram-v2\n  note left of X: hello\n';
    const result = extractStateDiagramStructure(source);
    expect(result.transitionCount).toBe(0);
  });
});

describe('checkAuthoredDiagramStructure', () => {
  it('passes a real authored diagram with states and transitions', () => {
    const source = 'stateDiagram-v2\n    [*] --> Free\n    Free --> Held: grant\n';
    expect(checkAuthoredDiagramStructure('web-docs/diagrams/x.mmd', source)).toEqual([]);
  });

  it('fails a diagram with zero transitions, naming the file (gate-intent demo (a): all transitions removed)', () => {
    const source = 'stateDiagram-v2\n';
    const issues = checkAuthoredDiagramStructure('web-docs/diagrams/x.mmd', source);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('structurally-empty');
    expect(issues[0]?.message).toContain('web-docs/diagrams/x.mmd');
  });

  it('fails a missing diagram file, naming the file', () => {
    const issues = checkAuthoredDiagramStructure('web-docs/diagrams/missing.mmd', undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('missing-diagram-file');
    expect(issues[0]?.message).toContain('web-docs/diagrams/missing.mmd');
  });

  it('demonstrates why the mermaid-parse layer alone is insufficient: mermaid.parse() ACCEPTS a bogus stateDiagram (a bare note, no real transition) that this structural check catches', () => {
    // gate-intent demo (c): a diagram mermaid's own parser considers
    // structurally valid (measured empirically against mermaid 11.16.1 —
    // see task-6.3-report.md) but which has no real lifecycle to show.
    const bogus = 'stateDiagram-v2\n  note left of X: this parses fine but says nothing\n';
    const issues = checkAuthoredDiagramStructure('web-docs/diagrams/bogus.mmd', bogus);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('structurally-empty');
  });
});

describe('checkNonEmptyDiagram', () => {
  it('passes a diagram with at least one node', () => {
    expect(checkNonEmptyDiagram('L0', 1)).toEqual([]);
  });

  it('fails a diagram with zero nodes, naming the diagram', () => {
    const issues = checkNonEmptyDiagram('L0', 0);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('structurally-empty');
    expect(issues[0]?.message).toContain('L0');
  });
});

describe('checkDiagramBudget', () => {
  it('passes when both node and edge counts are within budget', () => {
    expect(checkDiagramBudget('L0', 10, 20, { maxNodes: 60, maxEdges: 160 })).toEqual([]);
  });

  it('fails naming the diagram and the exceeded node budget', () => {
    const issues = checkDiagramBudget('L0', 61, 20, { maxNodes: 60, maxEdges: 160 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('budget-exceeded');
    expect(issues[0]?.message).toContain('L0');
    expect(issues[0]?.message).toContain('61');
    expect(issues[0]?.message).toContain('60');
  });

  it('fails naming the diagram and the exceeded edge budget, independently of the node budget', () => {
    const issues = checkDiagramBudget('L0', 10, 161, { maxNodes: 60, maxEdges: 160 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('budget-exceeded');
    expect(issues[0]?.message).toContain('161');
    expect(issues[0]?.message).toContain('160');
  });

  it('reports both violations when both budgets are exceeded', () => {
    const issues = checkDiagramBudget('L0', 61, 161, { maxNodes: 60, maxEdges: 160 });
    expect(issues).toHaveLength(2);
  });

  it('the four chosen budgets each carry real headroom over live sizes measured on the live tree (see task-6.3-report.md)', () => {
    // Live tree, measured 2026-08-07: L0 full variant 30 nodes / 79 edges;
    // L1 max (routers, withTests) 64 nodes / 82 edges; ER catalog 9
    // tables / 3 FKs, session 9 tables / 0 FKs; authored diagrams ~3
    // states / 6-8 transitions each.
    expect(L0_DIAGRAM_BUDGET.maxNodes).toBeGreaterThan(30);
    expect(L0_DIAGRAM_BUDGET.maxEdges).toBeGreaterThan(79);
    expect(L1_DIAGRAM_BUDGET.maxNodes).toBeGreaterThan(64);
    expect(L1_DIAGRAM_BUDGET.maxEdges).toBeGreaterThan(82);
    expect(ER_DIAGRAM_BUDGET.maxNodes).toBeGreaterThan(9);
    expect(ER_DIAGRAM_BUDGET.maxEdges).toBeGreaterThan(3);
    expect(AUTHORED_DIAGRAM_BUDGET.maxNodes).toBeGreaterThan(3);
    expect(AUTHORED_DIAGRAM_BUDGET.maxEdges).toBeGreaterThan(8);
  });
});

describe('checkDanglingNavIds', () => {
  const model = fixtureModel(['alpha', 'beta']);

  it('passes a nav id whose id/route correctly resolve to a real component', () => {
    const navIds: NavIdEntry[] = [
      { id: 'alpha', componentName: 'alpha', route: '/component/alpha' },
    ];
    expect(checkDanglingNavIds(navIds, model)).toEqual([]);
  });

  it('fails a nav id naming a component absent from the model', () => {
    const navIds: NavIdEntry[] = [
      { id: 'ghost', componentName: 'ghost', route: '/component/ghost' },
    ];
    const issues = checkDanglingNavIds(navIds, model);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('dangling-nav-id');
    expect(issues[0]?.message).toContain('ghost');
  });

  it('fails a nav id whose route does not match the canonical route for its component (a drifted/hand-edited entry)', () => {
    const navIds: NavIdEntry[] = [
      { id: 'alpha', componentName: 'alpha', route: '/wrong-route/alpha' },
    ];
    const issues = checkDanglingNavIds(navIds, model);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('dangling-nav-id');
  });

  it('fails a nav id whose id does not match the canonical slug for its component', () => {
    const navIds: NavIdEntry[] = [
      { id: 'not-the-real-slug', componentName: 'alpha', route: '/component/alpha' },
    ];
    const issues = checkDanglingNavIds(navIds, model);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('dangling-nav-id');
  });
});

describe('countMermaidArrowLines', () => {
  it('counts flowchart production (-->), test (-.->), and relationship (==>) arrow lines', () => {
    const source = [
      'flowchart TD',
      '  a["A"]',
      '  b["B"]',
      '  a --> b',
      '  a -.->|"test"| b',
      '  a ==>|"rel"| b',
    ].join('\n');
    expect(countMermaidArrowLines(source)).toBe(3);
  });

  it('does not count node-declaration lines', () => {
    expect(countMermaidArrowLines('flowchart TD\n  a["A"]\n  b["B"]')).toBe(0);
  });
});

describe('checkMermaidParseResult', () => {
  it('passes a valid parse result', () => {
    expect(checkMermaidParseResult('L0', { valid: true })).toEqual([]);
  });

  it('fails an invalid parse result, naming the diagram and quoting the parser error (gate-intent demo (b))', () => {
    const issues = checkMermaidParseResult('L0', { valid: false, error: 'Parse error on line 2' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('unparseable');
    expect(issues[0]?.message).toContain('L0');
    expect(issues[0]?.message).toContain('Parse error on line 2');
  });
});
