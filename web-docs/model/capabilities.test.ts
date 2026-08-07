import { describe, expect, it } from 'vitest';
import { checkCapabilityAccounting, pendingCapabilities } from './capabilities';
import type { CapabilityScope, ComponentModel } from './components';

function baseModel(overrides: Partial<ComponentModel> = {}): ComponentModel {
  return { components: [], relationships: [], capabilityScopes: [], exclusions: [], ...overrides };
}

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

describe('checkCapabilityAccounting — accounted-for baselines', () => {
  it('is clean when every baseline capability is attached to a component', () => {
    const model = baseModel({
      components: withComponents(['alpha']),
      capabilityScopes: [{ type: 'component', capability: 'cap-a', components: ['alpha'] }],
    });
    expect(checkCapabilityAccounting(model, ['cap-a'], [])).toEqual([]);
  });

  it('is clean when a baseline capability is declared cross-cutting with an explicit component set', () => {
    const model = baseModel({
      components: withComponents(['alpha', 'beta']),
      capabilityScopes: [
        { type: 'cross-cutting', capability: 'cap-a', components: ['alpha', 'beta'] },
      ],
    });
    expect(checkCapabilityAccounting(model, ['cap-a'], [])).toEqual([]);
  });

  it('is clean when a baseline capability is declared process (no components)', () => {
    const model = baseModel({
      capabilityScopes: [{ type: 'process', capability: 'cap-a' }],
    });
    expect(checkCapabilityAccounting(model, ['cap-a'], [])).toEqual([]);
  });
});

describe('checkCapabilityAccounting — unaccounted baseline capability fails', () => {
  it('fails naming the capability when openspec/specs/ has one the model never mentions', () => {
    const model = baseModel({ capabilityScopes: [] });
    const issues = checkCapabilityAccounting(model, ['cap-a'], []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('unaccounted');
    expect(issues[0]?.message).toContain('cap-a');
  });
});

describe('checkCapabilityAccounting — dangling capability reference fails', () => {
  it('fails naming a model capability reference absent from both baseline and active-change deltas', () => {
    const model = baseModel({
      components: withComponents(['alpha']),
      capabilityScopes: [{ type: 'component', capability: 'cap-ghost', components: ['alpha'] }],
    });
    const issues = checkCapabilityAccounting(model, [], []);
    expect(issues.some((issue) => issue.kind === 'dangling-capability')).toBe(true);
    expect(issues.some((issue) => issue.message.includes('cap-ghost'))).toBe(true);
  });

  it('does NOT fail a model reference to a capability named only by an active change delta (pending-grace)', () => {
    const model = baseModel({
      components: withComponents(['alpha']),
      capabilityScopes: [{ type: 'component', capability: 'cap-new', components: ['alpha'] }],
    });
    // cap-new is not baseline, but IS an active change's delta capability.
    const issues = checkCapabilityAccounting(model, [], ['cap-new']);
    expect(issues.some((issue) => issue.kind === 'dangling-capability')).toBe(false);
  });
});

describe('checkCapabilityAccounting — dangling component reference fails', () => {
  it('fails naming a capabilityScopes entry that names a component absent from the model', () => {
    const model = baseModel({
      components: withComponents(['alpha']),
      capabilityScopes: [
        { type: 'component', capability: 'cap-a', components: ['alpha', 'ghost-component'] },
      ],
    });
    const issues = checkCapabilityAccounting(model, ['cap-a'], []);
    expect(issues.some((issue) => issue.kind === 'dangling-component')).toBe(true);
    expect(issues.some((issue) => issue.message.includes('ghost-component'))).toBe(true);
  });
});

describe('checkCapabilityAccounting — duplicate capabilityScopes entry fails', () => {
  it('fails naming a capability declared more than once', () => {
    const model = baseModel({
      components: withComponents(['alpha']),
      capabilityScopes: [
        { type: 'component', capability: 'cap-a', components: ['alpha'] },
        { type: 'process', capability: 'cap-a' },
      ],
    });
    const issues = checkCapabilityAccounting(model, ['cap-a'], []);
    expect(issues.some((issue) => issue.kind === 'duplicate')).toBe(true);
  });
});

describe('pendingCapabilities', () => {
  it('returns delta capabilities not present in baseline, sorted, deduplicated', () => {
    expect(pendingCapabilities(['cap-a'], ['cap-b', 'cap-a', 'cap-b', 'cap-c'])).toEqual([
      'cap-b',
      'cap-c',
    ]);
  });

  it('returns an empty list when every delta capability is already baseline', () => {
    expect(pendingCapabilities(['cap-a', 'cap-b'], ['cap-a'])).toEqual([]);
  });

  it('returns an empty list when there are no active-change deltas', () => {
    expect(pendingCapabilities(['cap-a'], [])).toEqual([]);
  });
});

describe('capability scope type narrows components correctly', () => {
  it('a process scope carries no components field at the type level', () => {
    const scope: CapabilityScope = { type: 'process', capability: 'cap-a' };
    expect('components' in scope).toBe(false);
  });
});
