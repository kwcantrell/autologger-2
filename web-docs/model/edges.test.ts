import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFileImports } from '../src/lib/extractImports';
import type { Component, ComponentModel } from './components';
import { diffEdgeSnapshot, type EdgeSnapshot, projectComponentEdges } from './edges';

function baseModel(overrides: Partial<ComponentModel> = {}): ComponentModel {
  return { components: [], relationships: [], capabilityScopes: [], exclusions: [], ...overrides };
}

function component(overrides: Partial<Component> & Pick<Component, 'name' | 'globs'>): Component {
  return {
    kind: 'runtime',
    description: '',
    capabilities: [],
    authoredDiagrams: [],
    ...overrides,
  };
}

describe('projectComponentEdges — pure classification (synthetic fixtures)', () => {
  it('drops intra-component imports (not a cross-component edge)', () => {
    const model = baseModel({
      components: [component({ name: 'alpha', globs: ['alpha/**'] })],
    });
    const { edges } = projectComponentEdges(
      [
        {
          fromFile: 'alpha/a.ts',
          toFile: 'alpha/b.ts',
          kind: 'static',
          isTypeOnly: false,
          line: 1,
        },
      ],
      model,
    );
    expect(edges).toEqual([]);
  });

  it('drops an import whose target belongs to no component (excluded — no edge to draw)', () => {
    const model = baseModel({
      components: [component({ name: 'alpha', globs: ['alpha/**'] })],
    });
    const { edges } = projectComponentEdges(
      [
        {
          fromFile: 'alpha/a.ts',
          toFile: 'tooling/config.ts',
          kind: 'static',
          isTypeOnly: false,
          line: 1,
        },
      ],
      model,
    );
    expect(edges).toEqual([]);
  });

  it('classifies an edge production when the importing file is a non-test file in a runtime component', () => {
    const model = baseModel({
      components: [
        component({ name: 'alpha', globs: ['alpha/**'] }),
        component({ name: 'beta', globs: ['beta/**'] }),
      ],
    });
    const { edges } = projectComponentEdges(
      [{ fromFile: 'alpha/a.ts', toFile: 'beta/b.ts', kind: 'static', isTypeOnly: false, line: 1 }],
      model,
    );
    expect(edges).toEqual([{ from: 'alpha', to: 'beta', kind: 'production' }]);
  });

  it('classifies an edge test when the importing file is a *.test.ts file', () => {
    const model = baseModel({
      components: [
        component({ name: 'alpha', globs: ['alpha/**'] }),
        component({ name: 'beta', globs: ['beta/**'] }),
      ],
    });
    const { edges } = projectComponentEdges(
      [
        {
          fromFile: 'alpha/a.test.ts',
          toFile: 'beta/b.ts',
          kind: 'static',
          isTypeOnly: false,
          line: 1,
        },
      ],
      model,
    );
    expect(edges).toEqual([{ from: 'alpha', to: 'beta', kind: 'test' }]);
  });

  it('classifies an edge test when the importing file belongs to a test-harness component, even with a non-test filename', () => {
    const model = baseModel({
      components: [
        component({ name: 'harness', kind: 'test-harness', globs: ['harness/**'] }),
        component({ name: 'beta', globs: ['beta/**'] }),
      ],
    });
    const { edges } = projectComponentEdges(
      [
        {
          fromFile: 'harness/util.ts',
          toFile: 'beta/b.ts',
          kind: 'static',
          isTypeOnly: false,
          line: 1,
        },
      ],
      model,
    );
    expect(edges).toEqual([{ from: 'harness', to: 'beta', kind: 'test' }]);
  });

  it('classifies an edge production when ANY underlying import is non-test, even if others are test (the "every" rule)', () => {
    const model = baseModel({
      components: [
        component({ name: 'alpha', globs: ['alpha/**'] }),
        component({ name: 'beta', globs: ['beta/**'] }),
      ],
    });
    const { edges, underlying } = projectComponentEdges(
      [
        { fromFile: 'alpha/a.ts', toFile: 'beta/b.ts', kind: 'static', isTypeOnly: false, line: 1 },
        {
          fromFile: 'alpha/a.test.ts',
          toFile: 'beta/b.ts',
          kind: 'static',
          isTypeOnly: false,
          line: 1,
        },
      ],
      model,
    );
    expect(edges).toEqual([{ from: 'alpha', to: 'beta', kind: 'production' }]);
    expect(underlying.get('alpha→beta→production')).toHaveLength(2);
  });
});

describe('projectComponentEdges — end-to-end fixture-tree characterization (task 3.2)', () => {
  // The extraction fixture tree at src/lib/__fixtures__/extract-imports/classification/
  // has three real components: compA (runtime, with a production file and a
  // *.test.ts file), compB (runtime, the shared import target), compC
  // (test-harness, a non-test-named file). This mirrors the live repo's
  // characterization case (web → packages/ai-runtime/src/aggregates.ts, test-only)
  // by proving the SAME rule end to end through real extraction, not just
  // synthetic records.
  const FIXTURES_ROOT = fileURLToPath(
    new URL('../src/lib/__fixtures__/extract-imports', import.meta.url),
  );

  const classificationModel = baseModel({
    components: [
      component({ name: 'compA', globs: ['classification/compA/**'] }),
      component({ name: 'compB', globs: ['classification/compB/**'] }),
      component({ name: 'compC', kind: 'test-harness', globs: ['classification/compC/**'] }),
    ],
  });

  it('compA→compB is production (compA/index.ts, a non-test file, imports it)', () => {
    const extraction = extractFileImports({
      files: [
        'classification/compA/index.ts',
        'classification/compA/index.test.ts',
        'classification/compB/util.ts',
      ],
      repoRoot: FIXTURES_ROOT,
      isKnown: () => true,
      regimes: [
        {
          name: 'classification',
          dir: 'classification',
          tsconfigPath: 'classification/tsconfig.json',
        },
      ],
    });
    const { edges } = projectComponentEdges(extraction.imports, classificationModel);
    expect(edges).toContainEqual({ from: 'compA', to: 'compB', kind: 'production' });
  });

  it('compC→compB is test-only (compC is a test-harness component, no non-test importer exists)', () => {
    const extraction = extractFileImports({
      files: ['classification/compC/harness.ts', 'classification/compB/util.ts'],
      repoRoot: FIXTURES_ROOT,
      isKnown: () => true,
      regimes: [
        {
          name: 'classification',
          dir: 'classification',
          tsconfigPath: 'classification/tsconfig.json',
        },
      ],
    });
    const { edges } = projectComponentEdges(extraction.imports, classificationModel);
    expect(edges).toEqual([{ from: 'compC', to: 'compB', kind: 'test' }]);
  });
});

describe('diffEdgeSnapshot — new and vanished edges', () => {
  it('is clean when the derived set exactly matches the snapshot', () => {
    const derived = {
      edges: [{ from: 'a', to: 'b', kind: 'production' as const }],
      underlying: new Map(),
    };
    const snapshot: EdgeSnapshot = [{ from: 'a', to: 'b', kind: 'production' }];
    expect(diffEdgeSnapshot(derived, snapshot)).toEqual([]);
  });

  it('fails naming a new edge not present in the snapshot, with underlying imports and the regeneration command', () => {
    const underlying = new Map([
      [
        'a→b→production',
        [
          {
            fromFile: 'a/x.ts',
            toFile: 'b/y.ts',
            kind: 'static' as const,
            isTypeOnly: false,
            line: 1,
          },
        ],
      ],
    ]);
    const derived = { edges: [{ from: 'a', to: 'b', kind: 'production' as const }], underlying };
    const issues = diffEdgeSnapshot(derived, []);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('new-edge');
    expect(issues[0].message).toContain('a → b');
    expect(issues[0].message).toContain('a/x.ts');
    expect(issues[0].message).toContain('b/y.ts');
    expect(issues[0].message).toContain('npm run snapshot -w web-docs');
  });

  it('fails naming a vanished edge still in the snapshot but absent from the derived set', () => {
    const derived = { edges: [], underlying: new Map() };
    const snapshot: EdgeSnapshot = [{ from: 'a', to: 'b', kind: 'production' }];
    const issues = diffEdgeSnapshot(derived, snapshot);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('vanished-edge');
    expect(issues[0].message).toContain('a → b');
    expect(issues[0].message).toContain('npm run snapshot -w web-docs');
  });

  it('a kind change (production -> test) between derived and snapshot is both a new edge and a vanished edge', () => {
    const derived = {
      edges: [{ from: 'a', to: 'b', kind: 'test' as const }],
      underlying: new Map(),
    };
    const snapshot: EdgeSnapshot = [{ from: 'a', to: 'b', kind: 'production' }];
    const issues = diffEdgeSnapshot(derived, snapshot);
    expect(issues.map((i) => i.kind).sort()).toEqual(['new-edge', 'vanished-edge']);
  });
});
