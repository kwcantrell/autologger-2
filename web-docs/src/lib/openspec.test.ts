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

  it('the live repo currently surfaces web-docs-site as an active delta capability', () => {
    // Smoke test against the real repo tracked tree — this branch's own
    // proposal.md + specs/web-docs-site/spec.md are git-tracked right now.
    const all = listTrackedFiles();
    expect(listAllActiveDeltaCapabilities(all)).toContain('web-docs-site');
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

describe('listChangeDirectoriesOnDisk — live-repo smoke', () => {
  it('sees the real, currently-untracked recent-sessions-single-poll scaffold directory', () => {
    // A real instance of the "untracked change directory" case this
    // function exists for: its only contents are a gitignored `.apply/`,
    // so it has zero tracked files and is invisible to
    // listActiveChangeNames — but it is a real directory on disk.
    const root = repoRoot();
    const onDisk = listChangeDirectoriesOnDisk(root);
    expect(onDisk).toContain('recent-sessions-single-poll');
    expect(onDisk).not.toContain('archive');

    const tracked = listActiveChangeNames(listTrackedFiles());
    expect(tracked).not.toContain('recent-sessions-single-poll');
  });
});
