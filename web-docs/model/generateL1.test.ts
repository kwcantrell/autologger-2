import { describe, expect, it } from 'vitest';
import { DEFAULT_L1_GROUP_THRESHOLD, generateL1 } from './generateL1';

describe('generateL1 — every mapped file appears as a node or inside a named group', () => {
  it('renders every non-test file as its own node when the component is under the grouping threshold', () => {
    const files = ['server/src/auth/oauth_google.ts', 'server/src/auth/verifyIdToken.ts'];
    const { source, nodeCount, groupedFileCount } = generateL1('auth', files, [], {
      showTestFiles: false,
      groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
    });
    expect(source).toContain('"oauth_google.ts"');
    expect(source).toContain('"verifyIdToken.ts"');
    expect(nodeCount).toBe(2);
    expect(groupedFileCount).toBe(0);
  });

  it('elides *.test.ts files by default and reports the elided count', () => {
    const files = ['server/src/auth/oauth_google.ts', 'server/src/auth/oauth_google.test.ts'];
    const { source, elidedTestCount } = generateL1('auth', files, [], {
      showTestFiles: false,
      groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
    });
    expect(source).not.toContain('oauth_google.test.ts');
    expect(elidedTestCount).toBe(1);
  });

  it('shows test files (no elision, elidedTestCount 0) when showTestFiles is on', () => {
    const files = ['server/src/auth/oauth_google.ts', 'server/src/auth/oauth_google.test.ts'];
    const { source, elidedTestCount } = generateL1('auth', files, [], {
      showTestFiles: true,
      groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
    });
    expect(source).toContain('oauth_google.test.ts');
    expect(elidedTestCount).toBe(0);
  });

  it('groups files by subdirectory once the visible file count exceeds the threshold, naming each group with its count', () => {
    const files = Array.from(
      { length: 5 },
      (_, i) => `server/src/routers/groupA/file${i}.ts`,
    ).concat(Array.from({ length: 5 }, (_, i) => `server/src/routers/groupB/file${i}.ts`));
    const { source, groupedFileCount } = generateL1('routers', files, [], {
      showTestFiles: false,
      groupThreshold: 5, // 10 visible files > 5
    });
    expect(source).toContain('"groupA/ (5 files)"');
    expect(source).toContain('"groupB/ (5 files)"');
    expect(source).not.toContain('file0.ts');
    expect(groupedFileCount).toBe(10);
  });

  it('does not group when the visible file count is at or under the threshold', () => {
    // Two sibling directories, so the common-prefix algorithm has real
    // subdirectory structure to (not) group — a single-directory fixture
    // would absorb "groupA" into the common prefix itself and prove nothing.
    const files = [
      'server/src/routers/groupA/file0.ts',
      'server/src/routers/groupA/file1.ts',
      'server/src/routers/groupB/file0.ts',
    ];
    const { source, groupedFileCount } = generateL1('routers', files, [], {
      showTestFiles: false,
      groupThreshold: 5,
    });
    expect(source).toContain('"groupA/file0.ts"');
    expect(groupedFileCount).toBe(0);
  });

  it('leaves a root-level file (no subdirectory) as its own node even when grouping is active', () => {
    const files = Array.from(
      { length: 6 },
      (_, i) => `server/src/routers/groupA/file${i}.ts`,
    ).concat('server/src/routers/index.ts');
    const { source } = generateL1('routers', files, [], {
      showTestFiles: false,
      groupThreshold: 5,
    });
    expect(source).toContain('"index.ts"');
    expect(source).toContain('"groupA/ (6 files)"');
  });
});

describe('generateL1 — intra-component module edges', () => {
  it('renders an edge between two ungrouped file nodes', () => {
    const files = ['server/src/auth/a.ts', 'server/src/auth/b.ts'];
    const edges = [{ from: 'server/src/auth/a.ts', to: 'server/src/auth/b.ts' }];
    const { source } = generateL1('auth', files, edges, {
      showTestFiles: false,
      groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
    });
    expect(source).toMatch(/-->/);
  });

  it('collapses an edge whose endpoint is grouped to the group node, and drops it if both endpoints collapse to the same group (no self-loop)', () => {
    // A sibling groupZ file gives commonDirPrefix real subdirectory
    // structure to group by (a single-directory fixture would absorb
    // "groupA" into the common prefix and never activate grouping).
    const files = Array.from(
      { length: 6 },
      (_, i) => `server/src/routers/groupA/file${i}.ts`,
    ).concat('server/src/routers/groupZ/other.ts');
    const edges = [
      { from: 'server/src/routers/groupA/file0.ts', to: 'server/src/routers/groupA/file1.ts' },
    ];
    const { source } = generateL1('routers', files, edges, {
      showTestFiles: false,
      groupThreshold: 5,
    });
    // Both endpoints collapse into the same groupA group node — no self-loop edge line.
    expect(source).not.toMatch(/-->/);
    expect(source).toContain('"groupA/ (6 files)"');
  });

  it('drops an edge whose endpoint is an elided test file', () => {
    const files = ['server/src/auth/a.ts', 'server/src/auth/a.test.ts'];
    const edges = [{ from: 'server/src/auth/a.test.ts', to: 'server/src/auth/a.ts' }];
    const { source } = generateL1('auth', files, edges, {
      showTestFiles: false,
      groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
    });
    expect(source).not.toMatch(/-->/);
  });
});

describe('generateL1 — escaping of hostile file names', () => {
  it('escapes a hostile file basename in its node label', () => {
    const files = ['server/src/auth/weird"file.ts'];
    const { source } = generateL1('auth', files, [], {
      showTestFiles: false,
      groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
    });
    expect(source).not.toMatch(/weird"file/);
    expect(source).toContain('#quot;');
  });
});

describe('generateL1 — determinism', () => {
  it('produces byte-identical output across repeated calls with the same inputs', () => {
    const files = ['server/src/auth/b.ts', 'server/src/auth/a.ts'];
    const first = generateL1('auth', files, [], {
      showTestFiles: false,
      groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
    });
    const second = generateL1('auth', files, [], {
      showTestFiles: false,
      groupThreshold: DEFAULT_L1_GROUP_THRESHOLD,
    });
    expect(first).toEqual(second);
  });
});
