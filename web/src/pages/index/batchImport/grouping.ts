const SUPPORTED_EXTENSIONS = new Set(['mp3', 'wav', 'aiff', 'aif', 'm4a', 'mp4', 'ogg', 'webm']);

const AUDIO_EXT_RE = /\.(mp3|wav|aiff|aif|m4a|mp4|ogg|webm)$/i;
const SEGMENT_SUFFIX_RE = /-(\d+)$/;

export interface BatchAudioFileEntry {
  name: string;
  file: File;
}

export interface AudioFileGroup {
  baseName: string;
  segments: BatchAudioFileEntry[];
}

export function isSupportedAudioFileName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return SUPPORTED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function discoverAudioFiles(files: FileList | readonly File[]): BatchAudioFileEntry[] {
  const list = Array.from(files);
  const entries: BatchAudioFileEntry[] = [];
  for (const file of list) {
    if (!isSupportedAudioFileName(file.name)) continue;
    entries.push({ name: file.name, file });
  }
  return entries;
}

/** Relative directory from the folder picker's `webkitRelativePath` ('' when absent). */
function relativeDir(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '';
}

interface SuffixedCandidate {
  suffix: number;
  stemFull: string;
  entry: BatchAudioFileEntry;
}

/**
 * Grouping rule:
 *
 * - The stem is the file name minus its audio extension.
 * - Files only ever group within the same relative directory
 *   (`webkitRelativePath` parent); same-named files in different subfolders
 *   never merge.
 * - Stems ending in `-<digits>` are segment *candidates*: candidates sharing a
 *   directory and base (stem minus the suffix) merge into ONE multi-segment
 *   group only when their numeric suffixes form a contiguous run starting at 1
 *   (`-1`, or `-1`/`-2`, or `-1`/`-2`/`-3`, ...). Otherwise each candidate
 *   stands alone as a single-file group keyed by its FULL stem including the
 *   suffix — so date-stamped files like `2026-08-03.mp3` + `2026-08-04.mp3`
 *   stay two recordings instead of merging into a bogus `2026-08`.
 * - Stems without a suffix are always their own single-file group.
 */
export function groupAudioFiles(entries: readonly BatchAudioFileEntry[]): AudioFileGroup[] {
  const groups: AudioFileGroup[] = [];
  const suffixed = new Map<string, SuffixedCandidate[]>();

  for (const entry of entries) {
    if (!isSupportedAudioFileName(entry.name)) continue;
    const stemFull = entry.name.replace(AUDIO_EXT_RE, '');
    const match = SEGMENT_SUFFIX_RE.exec(stemFull);
    const base = match ? stemFull.slice(0, match.index) : '';
    if (match && base !== '') {
      // Delimit dir/base with a NUL, which cannot appear in either part.
      const key = `${relativeDir(entry.file)}\u0000${base}`;
      const bucket = suffixed.get(key) ?? [];
      bucket.push({ suffix: Number.parseInt(match[1], 10), stemFull, entry });
      suffixed.set(key, bucket);
    } else {
      groups.push({ baseName: stemFull, segments: [entry] });
    }
  }

  for (const [key, members] of suffixed) {
    members.sort((a, b) => a.suffix - b.suffix);
    const contiguousFromOne = members.every((m, i) => m.suffix === i + 1);
    if (contiguousFromOne) {
      groups.push({
        baseName: key.slice(key.indexOf('\u0000') + 1),
        segments: members.map((m) => m.entry),
      });
    } else {
      for (const m of members) {
        groups.push({ baseName: m.stemFull, segments: [m.entry] });
      }
    }
  }

  groups.sort((a, b) => a.baseName.localeCompare(b.baseName));
  return groups;
}
