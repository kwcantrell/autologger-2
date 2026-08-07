// TDD for atlas assembly (task 6.3; design.md D1/D8; spec "web-docs is a
// static workspace ... `atlas.json` SHALL be a git-ignored artifact"). Pure
// logic over already-extracted/already-generated inputs — `buildAtlas`
// itself performs zero I/O (no `fs`, no `child_process`), which is asserted
// directly below rather than assumed, satisfying the "no reads of
// git-ignored artifacts" determinism property for this function by
// construction. The live-repo wiring (real extraction, real ER DB builds,
// real mermaid parse) lives in scripts/check.ts, mirroring every other
// model/*.ts module's pure-logic/live-wiring split.
import * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// Hoisted module mock (ESM module namespaces are not spy-configurable —
// `vi.spyOn` on a live binding throws "Module namespace is not
// configurable"), wrapping the REAL implementations in `vi.fn()` so the
// "zero filesystem reads" test below can assert call counts without
// changing fs's actual behavior for anything else in this file (nothing
// else here touches disk).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

import type { FileImport } from '../src/lib/extractImports';
import { type BuildAtlasParams, buildAtlas } from './atlas';
import type { Component, ComponentModel } from './components';
import { MERMAID_CLIENT_CONFIG } from './mermaidConfig';
import type { OverlayResult } from './overlay';

function component(overrides: Partial<Component> & Pick<Component, 'name' | 'globs'>): Component {
  return {
    kind: 'runtime',
    description: 'A test component.',
    capabilities: [],
    authoredDiagrams: [],
    ...overrides,
  };
}

function baseModel(overrides: Partial<ComponentModel> = {}): ComponentModel {
  return { components: [], relationships: [], capabilityScopes: [], exclusions: [], ...overrides };
}

function baseParams(overrides: Partial<BuildAtlasParams> = {}): BuildAtlasParams {
  const overlay: OverlayResult = { changes: [], warnings: [] };
  return {
    model: baseModel(),
    snapshot: [],
    overlay,
    mappedFiles: [],
    imports: [],
    dynamicWarnings: [],
    catalogErDiagram: 'erDiagram\n  %% catalog',
    sessionErDiagram: 'erDiagram\n  %% session',
    authoredDiagramSources: {},
    specTrees: [],
    baselineCapabilities: [],
    pendingCapabilities: [],
    ...overrides,
  };
}

describe('buildAtlas — determinism and I/O isolation', () => {
  it('performs zero filesystem reads — every input is already-extracted data (catches a future regression that sneaks a disk read into buildAtlas)', () => {
    buildAtlas(baseParams());
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('two calls with identical inputs produce byte-identical JSON', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({ name: 'beta', globs: ['beta/**'] }),
          component({ name: 'alpha', globs: ['alpha/**'] }),
        ],
      }),
      mappedFiles: ['beta/b.ts', 'alpha/a.ts', 'alpha/z.ts'],
    });
    const json1 = JSON.stringify(buildAtlas(params));
    const json2 = JSON.stringify(buildAtlas(params));
    expect(json1).toBe(json2);
  });

  it('sorts components in the atlas model regardless of input order', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({ name: 'zeta', globs: ['zeta/**'] }),
          component({ name: 'alpha', globs: ['alpha/**'] }),
        ],
      }),
    });
    const atlas = buildAtlas(params);
    expect(atlas.model.components.map((c) => c.name)).toEqual(['alpha', 'zeta']);
  });

  it('sorts the navigation id map by id, over every component regardless of visibility', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({ name: 'zeta', globs: ['zeta/**'] }),
          component({ name: 'alpha', globs: [], kind: 'datastore' }),
        ],
      }),
    });
    const atlas = buildAtlas(params);
    expect(atlas.navigation.map((n) => n.componentName)).toEqual(['alpha', 'zeta']);
  });

  it('keys the L1 record in sorted componentName order, only for glob-bearing components', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({ name: 'zeta', globs: ['zeta/**'] }),
          component({ name: 'alpha', globs: ['alpha/**'] }),
          component({ name: 'a-datastore', globs: [], kind: 'datastore' }),
        ],
      }),
      mappedFiles: ['zeta/z.ts', 'alpha/a.ts'],
    });
    const atlas = buildAtlas(params);
    expect(Object.keys(atlas.l1)).toEqual(['alpha', 'zeta']);
  });

  it('emits no absolute filesystem paths or hostnames anywhere in the serialized atlas, given repo-relative fixture inputs', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({
            name: 'alpha',
            globs: ['alpha/**'],
            description: 'Talks to DATA_DIR/blobs, never an absolute path.',
          }),
        ],
      }),
      mappedFiles: ['alpha/a.ts', 'alpha/b.ts'],
      imports: [
        {
          fromFile: 'alpha/a.ts',
          toFile: 'alpha/b.ts',
          kind: 'static',
          isTypeOnly: false,
          line: 1,
        },
      ] satisfies FileImport[],
    });
    const json = JSON.stringify(buildAtlas(params));
    expect(json).not.toMatch(/\/home\/|\/Users\/|[A-Za-z]:\\\\|https?:\/\//);
  });

  it('embeds the shared mermaid client config object verbatim', () => {
    const atlas = buildAtlas(baseParams());
    expect(atlas.mermaidConfig).toEqual(MERMAID_CLIENT_CONFIG);
  });
});

describe('buildAtlas — L0 variants', () => {
  it('emits all four toggle combinations, each containing the relevant nodes', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({ name: 'runtime-a', globs: ['a/**'] }),
          component({ name: 'tooling-a', globs: ['t/**'], kind: 'tooling' }),
        ],
      }),
    });
    const atlas = buildAtlas(params);
    expect(atlas.l0.default.source).toContain('runtime_a');
    expect(atlas.l0.default.source).not.toContain('tooling_a');
    expect(atlas.l0.withTooling.source).toContain('tooling_a');
    expect(atlas.l0.full.source).toContain('tooling_a');
  });
});

describe('buildAtlas — L1 module graphs', () => {
  it('filters mappedFiles and imports down to each component before generating its L1 diagram', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({ name: 'alpha', globs: ['alpha/**'] }),
          component({ name: 'beta', globs: ['beta/**'] }),
        ],
      }),
      mappedFiles: ['alpha/a.ts', 'alpha/b.ts', 'beta/c.ts'],
      imports: [
        {
          fromFile: 'alpha/a.ts',
          toFile: 'alpha/b.ts',
          kind: 'static',
          isTypeOnly: false,
          line: 1,
        },
        // Cross-component import: must not leak into either component's L1 module graph.
        { fromFile: 'alpha/a.ts', toFile: 'beta/c.ts', kind: 'static', isTypeOnly: false, line: 2 },
      ] satisfies FileImport[],
    });
    const atlas = buildAtlas(params);
    expect(atlas.l1.alpha?.withTests.nodeCount).toBe(2);
    expect(atlas.l1.beta?.withTests.nodeCount).toBe(1);
  });

  it('produces both a default (test files hidden) and withTests variant', () => {
    const params = baseParams({
      model: baseModel({
        components: [component({ name: 'alpha', globs: ['alpha/**'] })],
      }),
      mappedFiles: ['alpha/a.ts', 'alpha/a.test.ts'],
    });
    const atlas = buildAtlas(params);
    expect(atlas.l1.alpha?.default.elidedTestCount).toBe(1);
    expect(atlas.l1.alpha?.withTests.elidedTestCount).toBe(0);
  });
});

describe('buildAtlas — ER, authored diagrams, spec tree, overlay, capabilities', () => {
  it('carries the ER diagram sources through verbatim', () => {
    const atlas = buildAtlas(
      baseParams({
        catalogErDiagram: 'erDiagram\n  %% catalog X',
        sessionErDiagram: 'erDiagram\n  %% session Y',
      }),
    );
    expect(atlas.er.catalog).toBe('erDiagram\n  %% catalog X');
    expect(atlas.er.session).toBe('erDiagram\n  %% session Y');
  });

  it('attaches every authored diagram from the model, sorted by path, with its owning component and label', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({
            name: 'session',
            globs: ['session/**'],
            authoredDiagrams: ['web-docs/diagrams/b.mmd', 'web-docs/diagrams/a.mmd'],
          }),
        ],
      }),
      authoredDiagramSources: {
        'web-docs/diagrams/a.mmd': 'stateDiagram-v2\n  [*] --> X',
        'web-docs/diagrams/b.mmd': 'stateDiagram-v2\n  [*] --> Y',
      },
    });
    const atlas = buildAtlas(params);
    expect(atlas.authoredDiagrams.map((d) => d.path)).toEqual([
      'web-docs/diagrams/a.mmd',
      'web-docs/diagrams/b.mmd',
    ]);
    expect(atlas.authoredDiagrams[0]).toEqual({
      path: 'web-docs/diagrams/a.mmd',
      componentName: 'session',
      label: 'authored',
      source: 'stateDiagram-v2\n  [*] --> X',
    });
  });

  it('omits an authored diagram whose source could not be read (missing file — the diagram-validity gate is what fails the build in that case, not atlas assembly)', () => {
    const params = baseParams({
      model: baseModel({
        components: [
          component({
            name: 'session',
            globs: ['session/**'],
            authoredDiagrams: ['web-docs/diagrams/missing.mmd'],
          }),
        ],
      }),
      authoredDiagramSources: {},
    });
    const atlas = buildAtlas(params);
    expect(atlas.authoredDiagrams).toEqual([]);
  });

  it('carries the spec tree, baseline/pending capabilities, and overlay through', () => {
    const overlay: OverlayResult = {
      changes: [
        {
          name: 'x',
          proposalPath: 'openspec/changes/x/proposal.md',
          capabilities: [],
          tintedComponents: [],
        },
      ],
      warnings: ['a warning'],
    };
    const atlas = buildAtlas(
      baseParams({
        specTrees: [{ capability: 'foo', requirements: [] }],
        baselineCapabilities: ['foo', 'bar'],
        pendingCapabilities: ['baz'],
        overlay,
      }),
    );
    expect(atlas.specTree).toEqual([{ capability: 'foo', requirements: [] }]);
    expect(atlas.capabilities).toEqual({ baseline: ['bar', 'foo'], pending: ['baz'] });
    expect(atlas.overlay).toEqual(overlay);
    expect(atlas.warnings.overlay).toEqual(['a warning']);
  });

  it('sorts and carries non-literal dynamic-import warnings', () => {
    const atlas = buildAtlas(
      baseParams({
        dynamicWarnings: [
          { file: 'b.ts', line: 2, column: 1 },
          { file: 'a.ts', line: 1, column: 1 },
        ],
      }),
    );
    expect(atlas.warnings.dynamicImports.map((w) => w.file)).toEqual(['a.ts', 'b.ts']);
  });
});
