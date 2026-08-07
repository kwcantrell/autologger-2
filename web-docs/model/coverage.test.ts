import { describe, expect, it } from 'vitest';
import type { ComponentModel } from './components';
import { checkCoverage, validateModelStructure } from './coverage';

function baseModel(overrides: Partial<ComponentModel> = {}): ComponentModel {
  return {
    components: [],
    relationships: [],
    capabilityScopes: [],
    exclusions: [],
    ...overrides,
  };
}

describe('checkCoverage — orphan files', () => {
  it('is clean when every tracked file matches exactly one component', () => {
    const model = baseModel({
      components: [
        {
          name: 'alpha',
          kind: 'runtime',
          description: 'a',
          globs: ['src/alpha/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
        {
          name: 'beta',
          kind: 'runtime',
          description: 'b',
          globs: ['src/beta/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
    });
    const files = ['src/alpha/a.ts', 'src/alpha/nested/b.ts', 'src/beta/c.ts'];
    expect(checkCoverage(files, model)).toEqual([]);
  });

  it('fails naming the orphan file and the nearest matching component', () => {
    const model = baseModel({
      components: [
        {
          name: 'near-bar',
          kind: 'runtime',
          description: 'covers src/bar',
          globs: ['src/bar/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
        {
          name: 'near-bazillion',
          kind: 'runtime',
          description: 'covers src/bazillion',
          globs: ['src/bazillion/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
    });
    // 'src/baz/orphan.ts' matches neither glob. Its longest shared path
    // prefix is with 'src/bazillion/**' ("src/baz" = 7 chars) rather than
    // 'src/bar/**' ("src/ba" = 6 chars), so that's the expected "nearest".
    const files = ['src/bar/x.ts', 'src/bazillion/y.ts', 'src/baz/orphan.ts'];
    const issues = checkCoverage(files, model);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('orphan');
    expect(issues[0].message).toContain('src/baz/orphan.ts');
    expect(issues[0].message).toContain('near-bazillion');
  });
});

describe('checkCoverage — overlapping globs', () => {
  it('fails naming the file and both overlapping components', () => {
    const model = baseModel({
      components: [
        {
          name: 'shared-wide',
          kind: 'runtime',
          description: 'covers all of src/shared',
          globs: ['src/shared/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
        {
          name: 'shared-utils',
          kind: 'runtime',
          description: 'also (wrongly) covers src/shared/utils',
          globs: ['src/shared/utils/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
    });
    const files = ['src/shared/utils/foo.ts'];
    const issues = checkCoverage(files, model);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('overlap');
    expect(issues[0].message).toContain('src/shared/utils/foo.ts');
    expect(issues[0].message).toContain('shared-wide');
    expect(issues[0].message).toContain('shared-utils');
  });
});

describe('checkCoverage — exclusions', () => {
  it('treats an excluded file as covered even when no component globs match it', () => {
    const model = baseModel({
      components: [
        {
          name: 'alpha',
          kind: 'runtime',
          description: 'a',
          globs: ['src/alpha/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
      exclusions: [{ file: 'tooling/vite.config.ts', reason: 'build tool config' }],
    });
    const files = ['src/alpha/a.ts', 'tooling/vite.config.ts'];
    expect(checkCoverage(files, model)).toEqual([]);
  });
});

describe('checkCoverage — datastore/external (glob-less) components', () => {
  it('ignores glob-less components for coverage purposes without erroring', () => {
    const model = baseModel({
      components: [
        {
          name: 'alpha',
          kind: 'runtime',
          description: 'a',
          globs: ['src/alpha/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
        {
          name: 'catalog-database',
          kind: 'datastore',
          description: 'the catalog DB file',
          globs: [],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
    });
    const files = ['src/alpha/a.ts'];
    expect(checkCoverage(files, model)).toEqual([]);
  });
});

describe('validateModelStructure — bare workspace source root globs', () => {
  it.each([
    'server/src/**',
    'web/src/**',
    'companion/src/**',
  ])('rejects %s as a component glob', (bareRoot) => {
    const model = baseModel({
      components: [
        {
          name: 'too-coarse',
          kind: 'runtime',
          description: 'the whole workspace in one component',
          globs: [bareRoot],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
    });
    const issues = validateModelStructure(model);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('bare-root');
    expect(issues[0].message).toContain(bareRoot);
    expect(issues[0].message).toContain('too-coarse');
  });

  it('accepts a subdirectory-level glob under a workspace root', () => {
    const model = baseModel({
      components: [
        {
          name: 'routers',
          kind: 'runtime',
          description: 'router modules',
          globs: ['server/src/routers/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
    });
    expect(validateModelStructure(model)).toEqual([]);
  });

  it('is folded into checkCoverage results too', () => {
    const model = baseModel({
      components: [
        {
          name: 'too-coarse',
          kind: 'runtime',
          description: 'the whole workspace in one component',
          globs: ['web/src/**'],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
    });
    const issues = checkCoverage(['web/src/anything.ts'], model);
    expect(issues.some((issue) => issue.kind === 'bare-root')).toBe(true);
  });
});
