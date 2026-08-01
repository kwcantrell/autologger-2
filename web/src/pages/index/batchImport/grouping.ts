const SUPPORTED_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'aiff',
  'aif',
  'm4a',
  'mp4',
  'ogg',
  'webm',
]);

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

function parseStem(name: string): { baseName: string; segmentIndex: number } | null {
  if (!isSupportedAudioFileName(name)) return null;
  const withoutExt = name.replace(AUDIO_EXT_RE, '');
  const match = SEGMENT_SUFFIX_RE.exec(withoutExt);
  if (match) {
    return {
      baseName: withoutExt.slice(0, match.index),
      segmentIndex: Number.parseInt(match[1], 10),
    };
  }
  return { baseName: withoutExt, segmentIndex: 0 };
}

export function groupAudioFiles(entries: readonly BatchAudioFileEntry[]): AudioFileGroup[] {
  const byStem = new Map<string, { segmentIndex: number; entry: BatchAudioFileEntry }[]>();

  for (const entry of entries) {
    const parsed = parseStem(entry.name);
    if (!parsed) continue;
    const bucket = byStem.get(parsed.baseName) ?? [];
    bucket.push({ segmentIndex: parsed.segmentIndex, entry });
    byStem.set(parsed.baseName, bucket);
  }

  const groups: AudioFileGroup[] = [];
  for (const [baseName, members] of byStem) {
    members.sort((a, b) => a.segmentIndex - b.segmentIndex);
    groups.push({
      baseName,
      segments: members.map((m) => m.entry),
    });
  }

  groups.sort((a, b) => a.baseName.localeCompare(b.baseName));
  return groups;
}
