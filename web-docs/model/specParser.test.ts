import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listBaselineCapabilities } from '../src/lib/openspec';
import { listTrackedFiles, repoRoot } from '../src/lib/repo';
import { parseAllSpecs, parseCapabilitySpec } from './specParser';

const WELL_FORMED = `# some-capability

## Purpose

Does a thing.

## Requirements

### Requirement: First thing
The system SHALL do the first thing.

#### Scenario: Happy path
- **WHEN** the first thing happens
- **THEN** it works

#### Scenario: Sad path
- **WHEN** the first thing fails
- **THEN** it reports an error

### Requirement: Second thing
The system SHALL do the second thing.

#### Scenario: Only scenario
- **WHEN** the second thing happens
- **THEN** it works
`;

describe('parseCapabilitySpec — well-formed fixture', () => {
  it('builds a capability -> requirements -> scenarios tree matching the headings on disk', () => {
    const { tree, issues } = parseCapabilitySpec('some-capability', WELL_FORMED);
    expect(issues).toEqual([]);
    expect(tree.capability).toBe('some-capability');
    expect(tree.requirements).toHaveLength(2);
    expect(tree.requirements[0]?.name).toBe('First thing');
    expect(tree.requirements[0]?.scenarios.map((s) => s.name)).toEqual(['Happy path', 'Sad path']);
    expect(tree.requirements[1]?.name).toBe('Second thing');
    expect(tree.requirements[1]?.scenarios.map((s) => s.name)).toEqual(['Only scenario']);
  });

  it('captures each requirement/scenario body as the text between its heading and the next', () => {
    const { tree } = parseCapabilitySpec('some-capability', WELL_FORMED);
    expect(tree.requirements[0]?.body).toBe('The system SHALL do the first thing.');
    expect(tree.requirements[0]?.scenarios[0]?.body).toBe(
      '- **WHEN** the first thing happens\n- **THEN** it works',
    );
  });

  it('parsed counts equal the direct heading counts (the count-equality gate is clean)', () => {
    const { issues } = parseCapabilitySpec('some-capability', WELL_FORMED);
    expect(issues.filter((i) => i.kind === 'count-mismatch')).toEqual([]);
  });
});

describe('parseCapabilitySpec — unclassifiable heading inside a Requirements section fails', () => {
  it('fails naming the capability when a ### heading is not "### Requirement: "', () => {
    const markdown = `## Requirements

### Note: not a requirement
Some text.

### Requirement: Real one

#### Scenario: Real scenario
- **WHEN** x
- **THEN** y
`;
    const { issues } = parseCapabilitySpec('bad-capability', markdown);
    const unclassified = issues.filter((i) => i.kind === 'unclassified-heading');
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0]?.message).toContain('bad-capability');
    expect(unclassified[0]?.message).toContain('Note: not a requirement');
  });

  it('fails naming the capability when a #### heading is not "#### Scenario: "', () => {
    const markdown = `## Requirements

### Requirement: Real one

#### Detail: not a scenario
Some text.
`;
    const { issues } = parseCapabilitySpec('bad-capability-2', markdown);
    const unclassified = issues.filter((i) => i.kind === 'unclassified-heading');
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0]?.message).toContain('bad-capability-2');
    expect(unclassified[0]?.message).toContain('Detail: not a scenario');
  });

  it('does not classify headings outside the Requirements section', () => {
    const markdown = `## Purpose

### Not a requirement, this is Purpose prose with a heading

## Requirements

### Requirement: Real one

#### Scenario: Real scenario
- **WHEN** x
- **THEN** y
`;
    const { issues, tree } = parseCapabilitySpec('cap', markdown);
    expect(issues).toEqual([]);
    expect(tree.requirements).toHaveLength(1);
  });
});

describe('parseCapabilitySpec — count-equality gate catches headings outside the parsed section', () => {
  it('fails naming the capability when a Requirement heading exists outside the located Requirements section', () => {
    // A "### Requirement:" heading placed in the Purpose section (before
    // "## Requirements") is invisible to the section-scoped parser, so the
    // parsed count (0) differs from the direct whole-file grep count (1).
    const markdown = `## Purpose

### Requirement: Stray heading in Purpose

## Requirements

### Requirement: Real one

#### Scenario: Real scenario
- **WHEN** x
- **THEN** y
`;
    const { issues } = parseCapabilitySpec('stray-cap', markdown);
    const mismatches = issues.filter((i) => i.kind === 'count-mismatch');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.message).toContain('stray-cap');
  });

  it('fails when the file has no "## Requirements" heading at all but does have requirement headings', () => {
    const markdown = `## Purpose

### Requirement: Orphaned, no Requirements section
`;
    const { issues, tree } = parseCapabilitySpec('no-section-cap', markdown);
    expect(tree.requirements).toEqual([]);
    const mismatches = issues.filter((i) => i.kind === 'count-mismatch');
    expect(mismatches).toHaveLength(1);
  });

  it('is clean for a capability with a Requirements section but zero requirements', () => {
    const markdown = `## Purpose

Nothing here.

## Requirements
`;
    const { issues, tree } = parseCapabilitySpec('empty-cap', markdown);
    expect(issues).toEqual([]);
    expect(tree.requirements).toEqual([]);
  });
});

describe('parseAllSpecs — multiple capabilities', () => {
  it('parses every given capability and aggregates issues, sorted by capability name', () => {
    const files: Record<string, string> = {
      zeta: WELL_FORMED,
      alpha: WELL_FORMED,
    };
    const { trees, issues } = parseAllSpecs(['zeta', 'alpha'], (capability) => files[capability]);
    expect(issues).toEqual([]);
    expect(trees.map((t) => t.capability)).toEqual(['alpha', 'zeta']);
  });

  it('fails with a missing-file issue naming the capability when the spec file cannot be read', () => {
    const { issues, trees } = parseAllSpecs(['ghost'], () => undefined);
    expect(trees).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('missing-file');
    expect(issues[0]?.message).toContain('ghost');
  });
});

// Audit fix-now F2: this used to pin the live repo's current capability
// count and total requirement/scenario counts (17/156/424) — facts about
// the CURRENT baseline, not properties true of any valid repo state. Any
// spec.md edit anywhere in the repo (on an unrelated branch/change) would
// red root `npm test` here, which spec R2 / the gate ruling forbid ("root
// npm test runs fixture-based unit tests only"). Rewritten as a property
// that holds for however many capabilities/requirements/scenarios exist:
// every baseline capability parses with zero issues, at least one
// requirement, and its parsed requirement/scenario counts equal a direct
// heading count of ITS OWN file on disk — the same count-equality property
// `parseAllSpecs`'s gate enforces, checked per-capability against whatever
// the live tree currently contains rather than a fixed total.
describe('live-repo smoke — the real openspec/specs/ tree parses cleanly', () => {
  it('parses every baseline capability with zero issues, at least one requirement, and parsed counts matching each file’s own direct heading count', () => {
    const root = repoRoot();
    const trackedFiles = listTrackedFiles();
    const baselineCapabilities = listBaselineCapabilities(trackedFiles);
    expect(baselineCapabilities.length).toBeGreaterThan(0);

    const readSpecFile = (capability: string): string | undefined => {
      try {
        return readFileSync(path.join(root, 'openspec/specs', capability, 'spec.md'), 'utf8');
      } catch {
        return undefined;
      }
    };

    const { trees, issues } = parseAllSpecs(baselineCapabilities, readSpecFile);
    expect(issues).toEqual([]);
    expect(trees).toHaveLength(baselineCapabilities.length);

    for (const capability of baselineCapabilities) {
      const source = readSpecFile(capability);
      expect(source).toBeDefined();
      const directRequirementCount = (source?.match(/^### Requirement:/gm) ?? []).length;
      const directScenarioCount = (source?.match(/^#### Scenario:/gm) ?? []).length;

      const tree = trees.find((t) => t.capability === capability);
      expect(tree).toBeDefined();
      expect(tree?.requirements.length).toBeGreaterThan(0);
      expect(tree?.requirements.length).toBe(directRequirementCount);

      const scenarioCount = tree?.requirements.reduce((sum, r) => sum + r.scenarios.length, 0) ?? 0;
      expect(scenarioCount).toBe(directScenarioCount);
    }
  });
});
