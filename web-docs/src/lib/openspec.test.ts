import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listActiveChangeNames,
  listAllActiveDeltaCapabilities,
  listBaselineCapabilities,
  listChangeDeltaCapabilities,
  listChangeDirectoriesOnDisk,
} from './openspec';
import { listTrackedFiles, repoRoot } from './repo';

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

  // Audit fix-now F2: this used to pin THIS branch's own capability name
  // ("web-docs-site") as an active delta — a fact about the live repo's
  // CURRENT, transient state (this very change), not a property true of any
  // valid repo state. It breaks the moment this change archives (the
  // capability joins the baseline and the delta disappears) and root `npm
  // test` must never depend on which changes happen to be active right now
  // (spec R2 / gate ruling). Rewritten as a property: every name this
  // function returns really is a delta-capability directory of some active,
  // tracked-proposal change — true regardless of which changes exist.
  it('every returned capability is really a delta-spec directory of some active (tracked-proposal) change', () => {
    const all = listTrackedFiles();
    const activeChangeNames = listActiveChangeNames(all);
    const allDeltaCapabilities = listAllActiveDeltaCapabilities(all);

    for (const capability of allDeltaCapabilities) {
      const owningChange = activeChangeNames.find((name) =>
        listChangeDeltaCapabilities(all, name).includes(capability),
      );
      expect(owningChange).toBeDefined();
    }
  });
});

describe('listChangeDirectoriesOnDisk — fixture directory tree', () => {
  function withTempChangesDir(
    setup: (changesDir: string) => void,
    run: (root: string) => void,
  ): void {
    const root = mkdtempSync(path.join(tmpdir(), 'web-docs-openspec-fixture-'));
    const changesDir = path.join(root, 'openspec', 'changes');
    mkdirSync(changesDir, { recursive: true });
    try {
      setup(changesDir);
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('lists every directory under openspec/changes/, including one with no proposal.md', () => {
    withTempChangesDir(
      (changesDir) => {
        mkdirSync(path.join(changesDir, 'has-proposal'));
        writeFileSync(path.join(changesDir, 'has-proposal', 'proposal.md'), 'x');
        mkdirSync(path.join(changesDir, 'partial-scaffold', '.apply'), { recursive: true });
        writeFileSync(path.join(changesDir, 'partial-scaffold', '.apply', 'notes.md'), 'x');
      },
      (root) => {
        expect(listChangeDirectoriesOnDisk(root)).toEqual(['has-proposal', 'partial-scaffold']);
      },
    );
  });

  it('excludes the archive directory', () => {
    withTempChangesDir(
      (changesDir) => {
        mkdirSync(path.join(changesDir, 'archive'));
        mkdirSync(path.join(changesDir, 'archive', 'old-change'));
        mkdirSync(path.join(changesDir, 'live-change'));
      },
      (root) => {
        expect(listChangeDirectoriesOnDisk(root)).toEqual(['live-change']);
      },
    );
  });

  it('ignores non-directory entries under openspec/changes/', () => {
    withTempChangesDir(
      (changesDir) => {
        writeFileSync(path.join(changesDir, 'README.md'), 'x');
        mkdirSync(path.join(changesDir, 'a-change'));
      },
      (root) => {
        expect(listChangeDirectoriesOnDisk(root)).toEqual(['a-change']);
      },
    );
  });

  it('returns an empty list when openspec/changes/ does not exist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'web-docs-openspec-empty-'));
    try {
      expect(listChangeDirectoriesOnDisk(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Audit fix-now F2: this used to pin the name of a specific real, currently-
// untracked scaffold directory ("recent-sessions-single-poll") — a fact
// about the live repo's CURRENT, transient state (a directory that doesn't
// exist on a fresh clone at all — F2 mutation check (i) proves this: root
// `npm test` must not depend on which untracked scaffolds happen to exist
// right now). Rewritten as the general property `listChangeDirectoriesOnDisk`
// exists to guarantee: every real on-disk directory is listed (whether or
// not it has a tracked proposal.md), `archive` never is, and every listed
// directory that is NOT an active (tracked-proposal) change is exactly the
// "untracked/partial" case this function was built for — true with zero
// such directories, with one, or with several.
describe('listChangeDirectoriesOnDisk — live-repo smoke', () => {
  it('lists every real on-disk change directory (tracked or not), excluding archive/, consistent with listActiveChangeNames', () => {
    const root = repoRoot();
    const trackedFiles = listTrackedFiles();
    const onDisk = listChangeDirectoriesOnDisk(root);
    const tracked = listActiveChangeNames(trackedFiles);

    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk).not.toContain('archive');
    expect(onDisk).toEqual([...onDisk].sort());

    // Every active (tracked-proposal) change name is a real directory on disk.
    for (const name of tracked) {
      expect(onDisk).toContain(name);
    }

    // Any on-disk directory NOT in the tracked set is exactly the
    // "untracked/partial scaffold" case — real per the filesystem, invisible
    // to the tracked-file-based enumerators.
    const untracked = onDisk.filter((name) => !tracked.includes(name));
    for (const name of untracked) {
      expect(listActiveChangeNames(trackedFiles)).not.toContain(name);
    }
  });
});
