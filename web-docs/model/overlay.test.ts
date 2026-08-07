import { describe, expect, it } from 'vitest';
import {
  listActiveChangeNames,
  listBaselineCapabilities,
  listChangeDeltaCapabilities,
  listChangeDirectoriesOnDisk,
} from '../src/lib/openspec';
import { listTrackedFiles, repoRoot } from '../src/lib/repo';
import type { CapabilityScope, ComponentModel } from './components';
import { model as realModel } from './components';
import { buildOverlay } from './overlay';

function withComponents(names: string[]): ComponentModel['components'] {
  return names.map((name) => ({
    name,
    kind: 'runtime' as const,
    description: '',
    globs: [],
    capabilities: [],
    authoredDiagrams: [],
  }));
}

function baseModel(overrides: Partial<ComponentModel> = {}): ComponentModel {
  return { components: [], relationships: [], capabilityScopes: [], exclusions: [], ...overrides };
}

const componentScopedScope: CapabilityScope = {
  type: 'component',
  capability: 'cap-component',
  components: ['alpha', 'beta'],
};
const crossCuttingScope: CapabilityScope = {
  type: 'cross-cutting',
  capability: 'cap-cross-cutting',
  components: ['alpha'],
};

describe('buildOverlay — capability partitioning per change', () => {
  it('tints components for a component-scoped delta capability', () => {
    const model = baseModel({
      components: withComponents(['alpha', 'beta']),
      capabilityScopes: [componentScopedScope],
    });
    const result = buildOverlay({
      model,
      changeDirectoriesOnDisk: ['my-change'],
      activeChangeNames: ['my-change'],
      baselineCapabilities: ['cap-component'],
      deltaCapabilitiesFor: () => ['cap-component'],
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    expect(change?.name).toBe('my-change');
    expect(change?.proposalPath).toBe('openspec/changes/my-change/proposal.md');
    expect(change?.capabilities).toEqual([
      { capability: 'cap-component', status: 'component-scoped', components: ['alpha', 'beta'] },
    ]);
    expect(change?.tintedComponents).toEqual(['alpha', 'beta']);
  });

  it('lists a cross-cutting delta capability on the change without tinting any component', () => {
    const model = baseModel({
      components: withComponents(['alpha']),
      capabilityScopes: [crossCuttingScope],
    });
    const result = buildOverlay({
      model,
      changeDirectoriesOnDisk: ['my-change'],
      activeChangeNames: ['my-change'],
      baselineCapabilities: ['cap-cross-cutting'],
      deltaCapabilitiesFor: () => ['cap-cross-cutting'],
    });
    const change = result.changes[0];
    expect(change?.capabilities).toEqual([
      { capability: 'cap-cross-cutting', status: 'cross-cutting', components: [] },
    ]);
    expect(change?.tintedComponents).toEqual([]);
  });

  it('renders a delta capability absent from the baseline as pending', () => {
    const model = baseModel({ components: withComponents(['alpha']) });
    const result = buildOverlay({
      model,
      changeDirectoriesOnDisk: ['my-change'],
      activeChangeNames: ['my-change'],
      baselineCapabilities: [],
      deltaCapabilitiesFor: () => ['brand-new-capability'],
    });
    const change = result.changes[0];
    expect(change?.capabilities).toEqual([
      { capability: 'brand-new-capability', status: 'pending', components: [] },
    ]);
    expect(change?.tintedComponents).toEqual([]);
  });

  it('lists a delta-less change with empty capabilities and no tinting', () => {
    const model = baseModel();
    const result = buildOverlay({
      model,
      changeDirectoriesOnDisk: ['delta-less-change'],
      activeChangeNames: ['delta-less-change'],
      baselineCapabilities: [],
      deltaCapabilitiesFor: () => [],
    });
    expect(result.changes).toEqual([
      {
        name: 'delta-less-change',
        proposalPath: 'openspec/changes/delta-less-change/proposal.md',
        capabilities: [],
        tintedComponents: [],
      },
    ]);
  });

  it('unions tinted components across multiple component-scoped deltas, deduplicated and sorted', () => {
    const model = baseModel({
      components: withComponents(['alpha', 'beta', 'gamma']),
      capabilityScopes: [
        { type: 'component', capability: 'cap-1', components: ['beta', 'alpha'] },
        { type: 'component', capability: 'cap-2', components: ['gamma', 'alpha'] },
      ],
    });
    const result = buildOverlay({
      model,
      changeDirectoriesOnDisk: ['my-change'],
      activeChangeNames: ['my-change'],
      baselineCapabilities: ['cap-1', 'cap-2'],
      deltaCapabilitiesFor: () => ['cap-1', 'cap-2'],
    });
    expect(result.changes[0]?.tintedComponents).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('buildOverlay — partial/untracked directories produce a warning, not a change', () => {
  it('warns naming a directory on disk with no tracked proposal.md, and excludes it from changes', () => {
    const model = baseModel();
    const result = buildOverlay({
      model,
      changeDirectoriesOnDisk: ['tracked-change', 'partial-scaffold'],
      activeChangeNames: ['tracked-change'],
      baselineCapabilities: [],
      deltaCapabilitiesFor: () => [],
    });
    expect(result.changes.map((c) => c.name)).toEqual(['tracked-change']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('partial-scaffold');
  });

  it('does not crash and produces no warning when every on-disk directory is tracked', () => {
    const model = baseModel();
    const result = buildOverlay({
      model,
      changeDirectoriesOnDisk: ['a', 'b'],
      activeChangeNames: ['a', 'b'],
      baselineCapabilities: [],
      deltaCapabilitiesFor: () => [],
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
  });
});

describe('buildOverlay — sorted, deterministic output', () => {
  it('sorts changes and their capabilities regardless of input order', () => {
    const model = baseModel({
      components: withComponents(['alpha']),
      capabilityScopes: [{ type: 'component', capability: 'cap-a', components: ['alpha'] }],
    });
    const result = buildOverlay({
      model,
      changeDirectoriesOnDisk: ['zeta-change', 'alpha-change'],
      activeChangeNames: ['zeta-change', 'alpha-change'],
      baselineCapabilities: ['cap-a'],
      deltaCapabilitiesFor: (name) => (name === 'zeta-change' ? ['cap-a'] : []),
    });
    expect(result.changes.map((c) => c.name)).toEqual(['alpha-change', 'zeta-change']);
  });
});

describe('buildOverlay — live-repo smoke', () => {
  it("surfaces this branch's own change with web-docs-site as pending, and excludes archive/", () => {
    const root = repoRoot();
    const trackedFiles = listTrackedFiles();
    const baselineCapabilities = listBaselineCapabilities(trackedFiles);
    const activeChangeNames = listActiveChangeNames(trackedFiles);
    const changeDirectoriesOnDisk = listChangeDirectoriesOnDisk(root);

    const result = buildOverlay({
      model: realModel,
      changeDirectoriesOnDisk,
      activeChangeNames,
      baselineCapabilities,
      deltaCapabilitiesFor: (name) => listChangeDeltaCapabilities(trackedFiles, name),
    });

    const ownChange = result.changes.find((change) => change.name === 'web-docs-architecture-viz');
    expect(ownChange).toBeDefined();
    expect(ownChange?.proposalPath).toBe('openspec/changes/web-docs-architecture-viz/proposal.md');
    expect(ownChange?.capabilities).toEqual([
      { capability: 'web-docs-site', status: 'pending', components: [] },
    ]);
    expect(ownChange?.tintedComponents).toEqual([]);

    // archive/ never contributes a change nor a warning.
    expect(result.changes.some((change) => change.name === 'archive')).toBe(false);
    expect(result.changes.some((change) => change.name.startsWith('archive/'))).toBe(false);
    expect(result.warnings.every((warning) => !warning.includes('archive/'))).toBe(true);

    // The real, currently-untracked recent-sessions-single-poll scaffold
    // produces a warning naming it, not a crash and not a change entry.
    expect(result.changes.some((change) => change.name === 'recent-sessions-single-poll')).toBe(
      false,
    );
    expect(result.warnings.some((warning) => warning.includes('recent-sessions-single-poll'))).toBe(
      true,
    );
  });
});
