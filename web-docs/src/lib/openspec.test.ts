import { describe, expect, it } from 'vitest';
import {
  listActiveChangeNames,
  listAllActiveDeltaCapabilities,
  listBaselineCapabilities,
  listChangeDeltaCapabilities,
} from './openspec';
import { listTrackedFiles } from './repo';

describe('listBaselineCapabilities — fixture tracked-file list', () => {
  it('returns sorted, deduplicated capability names from openspec/specs/*/spec.md', () => {
    const files = [
      'openspec/specs/zeta/spec.md',
      'openspec/specs/alpha/spec.md',
      'openspec/specs/alpha/design-notes.md', // not spec.md — ignored
      'README.md',
    ];
    expect(listBaselineCapabilities(files)).toEqual(['alpha', 'zeta']);
  });

  it('ignores a directory with tracked files but no spec.md', () => {
    const files = ['openspec/specs/incomplete/tasks.md'];
    expect(listBaselineCapabilities(files)).toEqual([]);
  });
});

describe('listActiveChangeNames — fixture tracked-file list', () => {
  it('returns change directory names with a tracked proposal.md, excluding archive/', () => {
    const files = [
      'openspec/changes/my-change/proposal.md',
      'openspec/changes/my-change/tasks.md',
      'openspec/changes/archive/old-change/proposal.md',
      'openspec/changes/partial-scaffold/tasks.md', // no proposal.md
    ];
    expect(listActiveChangeNames(files)).toEqual(['my-change']);
  });

  it('returns an empty list when no change has a tracked proposal.md', () => {
    expect(listActiveChangeNames(['openspec/changes/x/tasks.md'])).toEqual([]);
  });
});

describe('listChangeDeltaCapabilities — fixture tracked-file list', () => {
  it('returns capability names under a specific change`s specs/ directory', () => {
    const files = [
      'openspec/changes/my-change/proposal.md',
      'openspec/changes/my-change/specs/cap-a/spec.md',
      'openspec/changes/my-change/specs/cap-b/spec.md',
      'openspec/changes/other-change/specs/cap-c/spec.md',
    ];
    expect(listChangeDeltaCapabilities(files, 'my-change')).toEqual(['cap-a', 'cap-b']);
  });

  it('returns an empty list for a delta-less change (no specs/ directory)', () => {
    const files = ['openspec/changes/my-change/proposal.md'];
    expect(listChangeDeltaCapabilities(files, 'my-change')).toEqual([]);
  });
});

describe('listAllActiveDeltaCapabilities — fixture tracked-file list', () => {
  it('unions delta capabilities across every active (tracked-proposal) change, deduplicated', () => {
    const files = [
      'openspec/changes/change-one/proposal.md',
      'openspec/changes/change-one/specs/cap-a/spec.md',
      'openspec/changes/change-two/proposal.md',
      'openspec/changes/change-two/specs/cap-a/spec.md',
      'openspec/changes/change-two/specs/cap-b/spec.md',
      'openspec/changes/archive/old/proposal.md',
      'openspec/changes/archive/old/specs/cap-z/spec.md',
    ];
    expect(listAllActiveDeltaCapabilities(files)).toEqual(['cap-a', 'cap-b']);
  });

  it('the live repo currently surfaces web-docs-site as an active delta capability', () => {
    // Smoke test against the real repo tracked tree — this branch's own
    // proposal.md + specs/web-docs-site/spec.md are git-tracked right now.
    const all = listTrackedFiles();
    expect(listAllActiveDeltaCapabilities(all)).toContain('web-docs-site');
  });
});
