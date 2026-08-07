import { describe, expect, it } from 'vitest';
import type { Component, ComponentModel, Relationship } from './components';
import type { EdgeSnapshot } from './edges';
import {
  assertL0CoversSnapshotAndRelationships,
  generateL0,
  productionEdgeLine,
  relationshipLine,
  testEdgeLine,
} from './generateL0';
import type { OverlayResult } from './overlay';

function component(overrides: Partial<Component> & Pick<Component, 'name' | 'kind'>): Component {
  return { description: '', globs: [], capabilities: [], authoredDiagrams: [], ...overrides };
}

function baseModel(overrides: Partial<ComponentModel> = {}): ComponentModel {
  return { components: [], relationships: [], capabilityScopes: [], exclusions: [], ...overrides };
}

const FULL: { showTest: boolean; showTooling: boolean } = { showTest: true, showTooling: true };
const DEFAULT_OPTIONS: { showTest: boolean; showTooling: boolean } = {
  showTest: false,
  showTooling: false,
};

describe('generateL0 — node rendering and kind styling', () => {
  const model = baseModel({
    components: [
      component({ name: 'web-app', kind: 'runtime' }),
      component({ name: 'catalog-database', kind: 'datastore' }),
      component({ name: 'deepgram', kind: 'external' }),
      component({ name: 'web-docs', kind: 'tooling' }),
      component({ name: 'server-test-harness', kind: 'test-harness' }),
    ],
  });

  it('renders every runtime/datastore/external node by default, styled with its kind class', () => {
    const { source } = generateL0(model, [], undefined, DEFAULT_OPTIONS);
    expect(source).toContain('web_app["web-app"]:::runtime');
    expect(source).toContain('catalog_database["catalog-database"]:::datastore');
    expect(source).toContain('deepgram["deepgram"]:::external');
  });

  it('hides tooling and test-harness nodes by default', () => {
    const { source } = generateL0(model, [], undefined, DEFAULT_OPTIONS);
    expect(source).not.toContain('web_docs[');
    expect(source).not.toContain('server_test_harness[');
  });

  it('shows tooling and test-harness nodes, kind-styled, when showTooling is toggled on', () => {
    const { source } = generateL0(model, [], undefined, { showTest: false, showTooling: true });
    expect(source).toContain('web_docs["web-docs"]:::tooling');
    expect(source).toContain('server_test_harness["server-test-harness"]:::testHarness');
  });

  it('declares a classDef for every component kind used by the model', () => {
    const { source } = generateL0(model, [], undefined, FULL);
    expect(source).toMatch(/classDef runtime/);
    expect(source).toMatch(/classDef datastore/);
    expect(source).toMatch(/classDef external/);
    expect(source).toMatch(/classDef tooling/);
    expect(source).toMatch(/classDef testHarness/);
  });
});

describe('generateL0 — production/test edge inclusion', () => {
  const model = baseModel({
    components: [
      component({ name: 'alpha', kind: 'runtime' }),
      component({ name: 'beta', kind: 'runtime' }),
    ],
  });
  const snapshot: EdgeSnapshot = [
    { from: 'alpha', to: 'beta', kind: 'production' },
    { from: 'beta', to: 'alpha', kind: 'test' },
  ];

  it('always renders production edges from the snapshot', () => {
    const { source } = generateL0(model, snapshot, undefined, DEFAULT_OPTIONS);
    expect(source).toContain(productionEdgeLine('alpha', 'beta'));
  });

  it('hides test edges by default', () => {
    const { source } = generateL0(model, snapshot, undefined, DEFAULT_OPTIONS);
    expect(source).not.toContain(testEdgeLine('beta', 'alpha'));
  });

  it('shows test edges when showTest is toggled on', () => {
    const { source } = generateL0(model, snapshot, undefined, {
      showTest: true,
      showTooling: false,
    });
    expect(source).toContain(testEdgeLine('beta', 'alpha'));
  });

  it('drops an edge whose endpoint component no longer exists in the model (defensive, does not crash)', () => {
    const staleSnapshot: EdgeSnapshot = [{ from: 'alpha', to: 'ghost', kind: 'production' }];
    const { source } = generateL0(model, staleSnapshot, undefined, FULL);
    expect(source).not.toContain('ghost');
  });
});

describe('generateL0 — relationships render distinctly from import edges', () => {
  const model = baseModel({
    components: [
      component({ name: 'web-api', kind: 'runtime' }),
      component({ name: 'routers', kind: 'runtime' }),
      component({ name: 'e2e', kind: 'test-harness' }),
    ],
    relationships: [
      {
        id: 'web-api-to-routers',
        from: 'web-api',
        to: 'routers',
        label: 'HTTP fetch + WebSocket',
        evidence: [],
      },
      {
        id: 'e2e-to-routers',
        from: 'e2e',
        to: 'routers',
        label: 'spawns the server process',
        evidence: [],
      },
    ],
  });

  it('renders a relationship with a distinct arrow style from a plain edge, carrying its escaped label', () => {
    const { source } = generateL0(model, [], undefined, DEFAULT_OPTIONS);
    expect(source).toContain(relationshipLine(model.relationships[0]));
    expect(source).toContain('==>');
  });

  it('hides a relationship whose endpoint is a hidden-kind node until that node is toggled visible', () => {
    const hidden = generateL0(model, [], undefined, DEFAULT_OPTIONS);
    expect(hidden.source).not.toContain(relationshipLine(model.relationships[1]));

    const shown = generateL0(model, [], undefined, { showTest: false, showTooling: true });
    expect(shown.source).toContain(relationshipLine(model.relationships[1]));
  });
});

describe('generateL0 — escaping of hostile disk-derived strings', () => {
  it('escapes a hostile component name in its node label without breaking the mermaid source shape', () => {
    const model = baseModel({
      components: [component({ name: 'weird"name', kind: 'runtime' })],
    });
    const { source } = generateL0(model, [], undefined, FULL);
    expect(source).not.toMatch(/weird"name/);
    expect(source).toContain('#quot;');
  });

  it('escapes a hostile relationship label', () => {
    const model = baseModel({
      components: [
        component({ name: 'a', kind: 'runtime' }),
        component({ name: 'b', kind: 'runtime' }),
      ],
      relationships: [
        {
          id: 'a-to-b',
          from: 'a',
          to: 'b',
          label: 'evil "label" | with pipe',
          evidence: [],
        },
      ],
    });
    const { source } = generateL0(model, [], undefined, FULL);
    expect(source).not.toContain('evil "label" | with pipe');
    expect(source).toContain('#quot;label#quot;');
  });
});

describe('generateL0 — navigation ids', () => {
  const model = baseModel({
    components: [
      component({ name: 'web-app', kind: 'runtime' }),
      component({ name: 'web-docs', kind: 'tooling' }),
    ],
  });

  it('emits a navId entry for every VISIBLE component under the current toggle state', () => {
    const { navIds } = generateL0(model, [], undefined, DEFAULT_OPTIONS);
    expect(navIds.map((entry) => entry.componentName)).toEqual(['web-app']);
  });

  it('includes hidden-kind components in navIds once toggled visible', () => {
    const { navIds } = generateL0(model, [], undefined, { showTest: false, showTooling: true });
    expect(navIds.map((entry) => entry.componentName).sort()).toEqual(['web-app', 'web-docs']);
  });

  it('is deterministic across repeated calls with the same inputs', () => {
    const first = generateL0(model, [], undefined, FULL);
    const second = generateL0(model, [], undefined, FULL);
    expect(first).toEqual(second);
  });
});

describe('generateL0 — overlay tints', () => {
  const model = baseModel({
    components: [
      component({ name: 'web-app', kind: 'runtime' }),
      component({ name: 'routers', kind: 'runtime' }),
    ],
  });

  it('applies the tinted class to a component tinted by an active change', () => {
    const overlay: OverlayResult = {
      changes: [
        {
          name: 'some-change',
          proposalPath: 'openspec/changes/some-change/proposal.md',
          capabilities: [],
          tintedComponents: ['web-app'],
        },
      ],
      warnings: [],
    };
    const { source } = generateL0(model, [], overlay, FULL);
    expect(source).toMatch(/class web_app tinted;/);
    expect(source).not.toMatch(/class routers tinted;/);
  });

  it('produces no tint class statement when nothing is tinted', () => {
    const { source } = generateL0(model, [], undefined, FULL);
    expect(source).not.toContain('tinted;');
  });
});

describe('assertL0CoversSnapshotAndRelationships — the renderer assertion', () => {
  const relationships: Relationship[] = [
    { id: 'a-to-b', from: 'a', to: 'b', label: 'relationship', evidence: [] },
  ];
  const snapshot: EdgeSnapshot = [
    { from: 'a', to: 'b', kind: 'production' },
    { from: 'b', to: 'a', kind: 'test' },
  ];

  it('passes (no issues) when the source contains every production edge and every relationship', () => {
    const source = [productionEdgeLine('a', 'b'), relationshipLine(relationships[0])].join('\n');
    expect(assertL0CoversSnapshotAndRelationships(source, snapshot, relationships)).toEqual([]);
  });

  it('does not require test edges to be present (only production edges + relationships)', () => {
    const source = [productionEdgeLine('a', 'b'), relationshipLine(relationships[0])].join('\n');
    // testEdgeLine('b', 'a') deliberately absent — assertion should still pass.
    expect(assertL0CoversSnapshotAndRelationships(source, snapshot, relationships)).toEqual([]);
  });

  it('fails naming a missing production edge', () => {
    const source = relationshipLine(relationships[0]);
    const issues = assertL0CoversSnapshotAndRelationships(source, snapshot, relationships);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('missing-production-edge');
    expect(issues[0].message).toContain('a → b');
  });

  it('fails naming a missing declared relationship', () => {
    const source = productionEdgeLine('a', 'b');
    const issues = assertL0CoversSnapshotAndRelationships(source, snapshot, relationships);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('missing-relationship');
    expect(issues[0].message).toContain('a-to-b');
  });
});
