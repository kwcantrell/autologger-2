// Lossless concatenation of recorded audio segments into per-codec-family
// container files via mediabunny (pure TS, no ffmpeg/WebCodecs). Packets are
// copied — never decoded or re-encoded. Each segment is probed by bytes
// (never trusted by mime_type/extension) and classified into one of three
// families: Opus, AAC, PCM. Segments are grouped in input order; a family or
// stream-parameter (sample rate / channel count) change starts a new
// sub-group rather than failing the run. Unreadable/unparseable/unsupported
// segments are skipped, not fatal. Opus groups write WebM, AAC groups write
// MP4, PCM groups write WAVE — one packet loop shared by all three, spooled
// through temp files (FilePathSource/FilePathTarget) — no BufferTarget, so
// callers never hold a whole session's audio in memory.
//
// Consumed by scripts/merge-session-audio.ts and (transcript generation) the
// transcribe router; not part of the HTTP surface itself.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ALL_FORMATS,
  type AudioCodec,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  FilePathSource,
  FilePathTarget,
  Input,
  type InputAudioTrack,
  Mp4OutputFormat,
  Output,
  type OutputFormat,
  PCM_AUDIO_CODECS,
  WavOutputFormat,
  WebMOutputFormat,
} from 'mediabunny';

export type CodecFamily = 'opus' | 'aac' | 'pcm';

/** One input segment's position within its group's output file. */
export interface SegmentOffset {
  path: string;
  offsetSeconds: number;
  durationSeconds: number;
}

/** One packet-copied output file: all its segments share codec + stream params. */
export interface MergedGroup {
  family: CodecFamily;
  outPath: string;
  packets: number;
  durationSeconds: number;
  segments: SegmentOffset[];
}

export interface SkippedSegment {
  path: string;
  reason: string;
}

export interface MergeAudioSegmentsResult {
  groups: MergedGroup[];
  skipped: SkippedSegment[];
}

type DecoderConfig = NonNullable<Awaited<ReturnType<InputAudioTrack['getDecoderConfig']>>>;

const PCM_CODECS: readonly string[] = PCM_AUDIO_CODECS;

const FAMILY_CONTAINER: Record<CodecFamily, { ext: string; makeFormat: () => OutputFormat }> = {
  opus: { ext: 'webm', makeFormat: () => new WebMOutputFormat() },
  aac: { ext: 'mp4', makeFormat: () => new Mp4OutputFormat() },
  pcm: { ext: 'wav', makeFormat: () => new WavOutputFormat() },
};

function classifyFamily(codec: AudioCodec): CodecFamily | null {
  if (codec === 'opus') return 'opus';
  if (codec === 'aac') return 'aac';
  if (PCM_CODECS.includes(codec)) return 'pcm';
  return null;
}

interface ProbedSegment {
  path: string;
  codec: AudioCodec;
  family: CodecFamily;
  config: DecoderConfig;
}

/** Probe one file's primary audio track. Returns null (with a skip reason
 * pushed to `skipped`) for anything unreadable, unparseable, trackless, or
 * outside the three supported families — the caller's mime_type/extension is
 * never trusted. */
async function probeSegment(
  path: string,
  skipped: SkippedSegment[],
): Promise<ProbedSegment | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      skipped.push({ path, reason: 'no audio track found' });
      return null;
    }
    const config = await track.getDecoderConfig();
    if (!config || !track.codec) {
      skipped.push({ path, reason: 'unsupported or unknown codec' });
      return null;
    }
    const family = classifyFamily(track.codec);
    if (!family) {
      skipped.push({ path, reason: `unsupported codec family (${track.codec})` });
      return null;
    }
    return { path, codec: track.codec, family, config };
  } catch (err) {
    skipped.push({ path, reason: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    input.dispose();
  }
}

/** Partition probed segments into contiguous runs (input order preserved)
 * sharing family + codec + sample rate + channel count. A change in any of
 * those starts a new sub-group instead of failing the run. */
function partitionRuns(probed: ProbedSegment[]): ProbedSegment[][] {
  const runs: ProbedSegment[][] = [];
  for (const seg of probed) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    const sameParams =
      last &&
      last.family === seg.family &&
      last.codec === seg.codec &&
      last.config.sampleRate === seg.config.sampleRate &&
      last.config.numberOfChannels === seg.config.numberOfChannels;
    if (run && sameParams) run.push(seg);
    else runs.push([seg]);
  }
  return runs;
}

/** Packet-copy one param-homogeneous run into a single output file. The
 * decoder config is attached on the first packet of THIS group's output
 * track only (a counter scoped to this call, not shared across groups) —
 * every group's output track needs its own config attached exactly once. */
async function mergeGroup(
  run: ProbedSegment[],
  family: CodecFamily,
  outPath: string,
): Promise<MergedGroup> {
  const { makeFormat } = FAMILY_CONTAINER[family];
  const output = new Output({ format: makeFormat(), target: new FilePathTarget(outPath) });
  const source = new EncodedAudioPacketSource(run[0].codec);
  output.addAudioTrack(source);

  const segments: SegmentOffset[] = [];
  let packets = 0;
  let offset = 0;
  let firstPacketOfGroup = true;

  try {
    await output.start();
    for (const seg of run) {
      const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(seg.path) });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) throw new Error(`${seg.path}: no audio track found on merge pass.`);
        const sink = new EncodedPacketSink(track);
        let firstTimestamp: number | null = null;
        const segmentStart = offset;
        let end = offset;
        for await (const packet of sink.packets()) {
          firstTimestamp ??= packet.timestamp;
          const timestamp = packet.timestamp - firstTimestamp + offset;
          await source.add(
            packet.clone({ timestamp }),
            firstPacketOfGroup ? { decoderConfig: run[0].config } : undefined,
          );
          firstPacketOfGroup = false;
          end = Math.max(end, timestamp + packet.duration);
          packets += 1;
        }
        segments.push({
          path: seg.path,
          offsetSeconds: segmentStart,
          durationSeconds: end - segmentStart,
        });
        offset = end;
      } finally {
        input.dispose();
      }
    }
    source.close();
    await output.finalize();
  } catch (err) {
    await output.cancel();
    throw err;
  }

  return { family, outPath, packets, durationSeconds: offset, segments };
}

/** Probe, classify, and packet-copy-concatenate `inputPaths` (in ordinal
 * order) into one output file per codec-family+params run, written under
 * `outDir` as `group-<index>-<family>.<ext>` (webm/mp4/wav). Unreadable or
 * unsupported segments are skipped rather than failing the run; a
 * stream-parameter change within a family starts a new group instead of
 * throwing. Returns the merged groups (each with per-segment cumulative
 * offsets) and the list of skipped segments with reasons. */
export async function mergeAudioSegments(
  inputPaths: string[],
  outDir: string,
): Promise<MergeAudioSegmentsResult> {
  const skipped: SkippedSegment[] = [];
  const probed: ProbedSegment[] = [];
  for (const path of inputPaths) {
    const segment = await probeSegment(path, skipped);
    if (segment) probed.push(segment);
  }

  const runs = partitionRuns(probed);
  if (runs.length > 0) await mkdir(outDir, { recursive: true });
  const groups: MergedGroup[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const family = run[0].family;
    const outPath = join(outDir, `group-${i}-${family}.${FAMILY_CONTAINER[family].ext}`);
    groups.push(await mergeGroup(run, family, outPath));
  }

  return { groups, skipped };
}
