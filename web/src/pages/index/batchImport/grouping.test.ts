import { describe, expect, it } from 'vitest';
import {
  type BatchAudioFileEntry,
  discoverAudioFiles,
  groupAudioFiles,
  isSupportedAudioFileName,
} from './grouping';

function entry(name: string): BatchAudioFileEntry {
  return { name, file: new File([''], name, { type: 'audio/mpeg' }) };
}

function folderFile(name: string, relPath: string): File {
  const file = new File([''], name, { type: 'audio/mpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relPath, configurable: true });
  return file;
}

describe('isSupportedAudioFileName', () => {
  it.each([
    'mp3',
    'MP3',
    'wav',
    'aiff',
    'aif',
    'm4a',
    'mp4',
    'ogg',
    'webm',
  ])('accepts .%s', (ext) => {
    expect(isSupportedAudioFileName(`clip.${ext}`)).toBe(true);
  });

  it('rejects non-audio extensions', () => {
    expect(isSupportedAudioFileName('notes.txt')).toBe(false);
  });
});

describe('discoverAudioFiles', () => {
  it('filters to supported audio from a FileList-like folder pick', () => {
    const files = [
      folderFile('YMH_001-1.mp3', 'Batch/YMH_001-1.mp3'),
      folderFile('notes.txt', 'Batch/notes.txt'),
      folderFile('YMH_001-2.mp3', 'Batch/YMH_001-2.mp3'),
    ];
    const discovered = discoverAudioFiles(files);
    expect(discovered.map((e) => e.name)).toEqual(['YMH_001-1.mp3', 'YMH_001-2.mp3']);
  });
});

describe('groupAudioFiles', () => {
  it('groups YMH_001-1 and YMH_001-2 into one stem ordered by segment suffix', () => {
    const groups = groupAudioFiles([entry('YMH_001-2.mp3'), entry('YMH_001-1.mp3')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].baseName).toBe('YMH_001');
    expect(groups[0].segments.map((s) => s.name)).toEqual(['YMH_001-1.mp3', 'YMH_001-2.mp3']);
  });

  it('ignores notes.txt', () => {
    const groups = groupAudioFiles([
      entry('YMH_001-1.mp3'),
      entry('notes.txt'),
      entry('YMH_001-2.mp3'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].segments).toHaveLength(2);
  });

  it('treats YMH_001.mp3 as a single-file group', () => {
    const groups = groupAudioFiles([entry('YMH_001.mp3')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].baseName).toBe('YMH_001');
    expect(groups[0].segments.map((s) => s.name)).toEqual(['YMH_001.mp3']);
  });

  it('keeps date-stamped files as separate recordings (suffixes not starting at 1)', () => {
    const groups = groupAudioFiles([entry('2026-08-03.mp3'), entry('2026-08-04.mp3')]);
    expect(groups.map((g) => g.baseName)).toEqual(['2026-08-03', '2026-08-04']);
    expect(groups.every((g) => g.segments.length === 1)).toBe(true);
  });

  it('splits a non-contiguous suffix run into single-file groups keyed by full stem', () => {
    const groups = groupAudioFiles([entry('X-1.mp3'), entry('X-3.mp3')]);
    expect(groups.map((g) => g.baseName)).toEqual(['X-1', 'X-3']);
    expect(groups.every((g) => g.segments.length === 1)).toBe(true);
  });

  it('merges a contiguous run starting at 1 across three parts', () => {
    const groups = groupAudioFiles([entry('X-3.mp3'), entry('X-1.mp3'), entry('X-2.mp3')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].baseName).toBe('X');
    expect(groups[0].segments.map((s) => s.name)).toEqual(['X-1.mp3', 'X-2.mp3', 'X-3.mp3']);
  });

  it('never merges same-named files across subfolders', () => {
    const groups = groupAudioFiles([
      { name: 'Y-1.mp3', file: folderFile('Y-1.mp3', 'Batch/A/Y-1.mp3') },
      { name: 'Y-2.mp3', file: folderFile('Y-2.mp3', 'Batch/A/Y-2.mp3') },
      { name: 'Y-1.mp3', file: folderFile('Y-1.mp3', 'Batch/B/Y-1.mp3') },
      { name: 'Y-2.mp3', file: folderFile('Y-2.mp3', 'Batch/B/Y-2.mp3') },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.baseName)).toEqual(['Y', 'Y']);
    for (const group of groups) {
      expect(group.segments.map((s) => s.name)).toEqual(['Y-1.mp3', 'Y-2.mp3']);
      const dirs = new Set(
        group.segments.map((s) =>
          (s.file as File & { webkitRelativePath?: string }).webkitRelativePath
            ?.split('/')
            .slice(0, -1)
            .join('/'),
        ),
      );
      expect(dirs.size).toBe(1);
    }
  });
});
