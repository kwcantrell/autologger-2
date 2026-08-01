import { describe, expect, it } from 'vitest';
import {
  discoverAudioFiles,
  groupAudioFiles,
  isSupportedAudioFileName,
  type BatchAudioFileEntry,
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
  it.each(['mp3', 'MP3', 'wav', 'aiff', 'aif', 'm4a', 'mp4', 'ogg', 'webm'])(
    'accepts .%s',
    (ext) => {
      expect(isSupportedAudioFileName(`clip.${ext}`)).toBe(true);
    },
  );

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
});
