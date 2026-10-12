// Lossless concatenation of recorded audio segments into per-codec-family
// container files via mediabunny (pure TS, no ffmpeg/WebCodecs). Packets are
// copied — never decoded or re-encoded. Each segment is probed by bytes
// (never trusted by mime_type/extension) and classified into one of four
// families: Opus, AAC, PCM, FLAC, MP3. Segments are grouped in input order; a family
// or stream-parameter (sample rate / channel count) change starts a new
// sub-group rather than failing the run. Unreadable/unparseable/unsupported
// segments are skipped, not fatal. Opus groups write WebM, AAC groups write
// MP4, PCM groups write WAVE, FLAC groups write FLAC (the lossless storage
// format WAV blobs are converted to) — one packet loop shared by those four, spooled
// through temp files (FilePathSource/FilePathTarget) — no BufferTarget, so
// callers never hold a whole session's audio in memory. MP3 cannot be
// packet-concatenated here (no container remux target); each MP3 segment is
// passed through as its own group pointing at the source file for DeepGram.
//
// Consumed by scripts/merge-session-audio.ts and (transcript generation) the
// transcribe router; not part of the HTTP surface itself.

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ALL_FORMATS,
  type AudioCodec,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  FilePathSource,
  FilePathTarget,
  FlacOutputFormat,
  Input,
  type InputAudioTrack,
  Mp4OutputFormat,
  Output,
  type OutputFormat,
  PCM_AUDIO_CODECS,
  WavOutputFormat,
  WebMOutputFormat,
} from 'mediabunny';
import { parseFlacFrameHeader, renumberFlacFrame } from './flacFrames';

export type CodecFamily = 'opus' | 'aac' | 'pcm' | 'flac' | 'mp3';

/** One input segment's position within its group's output file. */
export interface SegmentOffset {
  path: string;
  offsetSeconds: number;
  durationSeconds: number;
}

/** One packet-copied (or MP3 pass-through) output: segments share codec + stream params. */
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

/** mp3 is deliberately absent: MP3 runs pass through unmerged (passThroughMp3Group). */
const FAMILY_CONTAINER: Record<
  Exclude<CodecFamily, 'mp3'>,
  { ext: string; makeFormat: () => OutputFormat }
> = {
  opus: { ext: 'webm', makeFormat: () => new WebMOutputFormat() },
  aac: { ext: 'mp4', makeFormat: () => new Mp4OutputFormat() },
  pcm: { ext: 'wav', makeFormat: () => new WavOutputFormat() },
  flac: { ext: 'flac', makeFormat: () => new FlacOutputFormat() },
};

function classifyFamily(codec: AudioCodec): CodecFamily | null {
  if (codec === 'opus') return 'opus';
  if (codec === 'aac') return 'aac';
  if (codec === 'mp3') return 'mp3';
  if (codec === 'flac') return 'flac';
  if (PCM_CODECS.includes(codec)) return 'pcm';
  return null;
}

interface ProbedSegment {
  path: string;
  codec: AudioCodec;
  family: CodecFamily;
  config: DecoderConfig;
  /** FLAC only (from STREAMINFO), else null. */
  bitsPerSample: number | null;
  /** FLAC only: STREAMINFO total samples (0 = unknown), else null. */
  totalSamples: number | null;
}

/** Sample numbers in a FLAC frame header must stay below 2^31 (see ./flacFrames.ts). */
export const FLAC_MAX_GROUP_SAMPLES = 2 ** 31 - 1;

function descriptionBytes(config: DecoderConfig): Uint8Array | null {
  const d = config.description;
  if (!d) return null;
  return ArrayBuffer.isView(d)
    ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
    : new Uint8Array(d);
}

/** FLAC STREAMINFO total samples (36 bits after the bit depth), 0 when unknown. */
function flacTotalSamples(config: DecoderConfig): number | null {
  const bytes = descriptionBytes(config);
  if (!bytes || bytes.length < 26) return null;
  return (
    (bytes[21] & 0x0f) * 2 ** 32 +
    ((bytes[22] << 24) >>> 0) +
    (bytes[23] << 16) +
    (bytes[24] << 8) +
    bytes[25]
  );
}

/** FLAC bits per sample from the decoder config's STREAMINFO description (`fLaC`, block
 * header, then STREAMINFO: 167 bits precede the 5-bit field), or null when absent. The codec
 * string is `flac` for every bit depth, so the run partition compares this too. */
function flacBitsPerSample(config: DecoderConfig): number | null {
  const bytes = descriptionBytes(config);
  if (!bytes || bytes.length < 22) return null;
  // Bits 167..171: the low bit of byte 20 and the top 4 bits of byte 21.
  return (((bytes[20] & 0x01) << 4) | (bytes[21] >> 4)) + 1;
}

/** Probe one file's primary audio track. Returns null (with a skip reason
 * pushed to `skipped`) for anything unreadable, unparseable, trackless, or
 * outside the supported families — the caller's mime_type/extension is
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
    const isFlac = family === 'flac';
    return {
      path,
      codec: track.codec,
      family,
      config,
      bitsPerSample: isFlac ? flacBitsPerSample(config) : null,
      totalSamples: isFlac ? flacTotalSamples(config) : null,
    };
  } catch (err) {
    skipped.push({ path, reason: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    input.dispose();
  }
}

/** Partition probed segments into contiguous runs (input order preserved)
 * sharing family + codec + sample rate + channel count (+ FLAC bit depth). A
 * change in any of those starts a new sub-group instead of failing the run, as
 * does a FLAC run that would reach {@link FLAC_MAX_GROUP_SAMPLES}. Exported for tests. */
export function partitionRuns(probed: ProbedSegment[]): ProbedSegment[][] {
  const runs: ProbedSegment[][] = [];
  let flacSamples = 0;
  for (const seg of probed) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    const sameParams =
      last &&
      last.family === seg.family &&
      last.codec === seg.codec &&
      last.config.sampleRate === seg.config.sampleRate &&
      last.config.numberOfChannels === seg.config.numberOfChannels &&
      (seg.family !== 'flac' ||
        (last.bitsPerSample === seg.bitsPerSample &&
          flacSamples + (seg.totalSamples ?? 0) <= FLAC_MAX_GROUP_SAMPLES));
    if (run && sameParams) run.push(seg);
    else {
      runs.push([seg]);
      flacSamples = 0;
    }
    flacSamples += seg.totalSamples ?? 0;
  }
  return runs;
}

/** Packet-copy one param-homogeneous run into a single output file. The
 * decoder config is attached on the first packet of THIS group's output
 * track only (a counter scoped to this call, not shared across groups) —
 * every group's output track needs its own config attached exactly once. */
async function mergeGroup(
  run: ProbedSegment[],
  family: Exclude<CodecFamily, 'mp3'>,
  outPath: string,
  skipped: SkippedSegment[],
): Promise<MergedGroup | null> {
  const { makeFormat } = FAMILY_CONTAINER[family];
  const output = new Output({ format: makeFormat(), target: new FilePathTarget(outPath) });
  const source = new EncodedAudioPacketSource(run[0].codec);
  output.addAudioTrack(source);

  const segments: SegmentOffset[] = [];
  let packets = 0;
  let offset = 0;
  let firstPacketOfGroup = true;
  // FLAC frames carry their stream position; see ./flacFrames.ts.
  let flacSampleNumber = 0;

  try {
    await output.start();
    for (const seg of run) {
      const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(seg.path) });
      try {
        const packetsBefore = packets;
        const segmentStart = offset;
        let end = offset;
        try {
          const track = await input.getPrimaryAudioTrack();
          if (!track) throw new Error('no audio track found on merge pass');
          const sink = new EncodedPacketSink(track);
          let firstTimestamp: number | null = null;
          for await (const packet of sink.packets()) {
            firstTimestamp ??= packet.timestamp;
            const timestamp = packet.timestamp - firstTimestamp + offset;
            let data: Uint8Array | undefined;
            if (family === 'flac') {
              data = renumberFlacFrame(packet.data, flacSampleNumber);
              flacSampleNumber += parseFlacFrameHeader(packet.data).blockSize;
            }
            await source.add(
              packet.clone(data ? { timestamp, data } : { timestamp }),
              firstPacketOfGroup ? { decoderConfig: run[0].config } : undefined,
            );
            firstPacketOfGroup = false;
            end = Math.max(end, timestamp + packet.duration);
            packets += 1;
          }
        } catch (err) {
          // Nothing of this segment written yet: skip it like any unreadable segment. Once
          // some of its packets are in the output it cannot be taken back: fail the group
          // (mergeAudioSegments then retries its segments one by one).
          if (packets !== packetsBefore) throw err;
          skipped.push({
            path: seg.path,
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (packets === packetsBefore) {
          // e.g. mediabunny 1.50.8 misreads the FLAC "rate in kHz" frame-header code (12, 64 kHz)
          skipped.push({ path: seg.path, reason: 'no audio packets could be read' });
          continue;
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
    if (packets === 0) {
      await output.cancel();
      await rm(outPath, { force: true });
      return null;
    }
    source.close();
    await output.finalize();
  } catch (err) {
    await output.cancel();
    await rm(outPath, { force: true });
    throw err;
  }

  return { family, outPath, packets, durationSeconds: offset, segments };
}

/** Stream the source MP3 bytes as-is (DeepGram accepts audio/mpeg). One
 * segment per group — we do not remux/concat MP3 without ffmpeg. */
async function passThroughMp3Group(seg: ProbedSegment): Promise<MergedGroup> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(seg.path) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error(`${seg.path}: no audio track found on MP3 pass-through.`);
    const durationSeconds = await track.computeDuration();
    return {
      family: 'mp3',
      outPath: seg.path,
      packets: 0,
      durationSeconds,
      segments: [{ path: seg.path, offsetSeconds: 0, durationSeconds }],
    };
  } finally {
    input.dispose();
  }
}

/** Probe, classify, and packet-copy-concatenate `inputPaths` (in ordinal
 * order) into one output file per codec-family+params run, written under
 * `outDir` as `group-<index>-<family>.<ext>` (webm/mp4/wav/flac). MP3 segments
 * pass through as one group per file (source path). Unreadable or
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
  const needsScratch = runs.some((run) => run[0].family !== 'mp3');
  if (needsScratch) await mkdir(outDir, { recursive: true });
  const groups: MergedGroup[] = [];
  let mergeIndex = 0;
  for (const run of runs) {
    const family = run[0].family;
    if (family === 'mp3') {
      for (const seg of run) {
        groups.push(await passThroughMp3Group(seg));
      }
      continue;
    }
    const outPath = join(outDir, `group-${mergeIndex}-${family}.${FAMILY_CONTAINER[family].ext}`);
    mergeIndex += 1;
    const runSkipped: SkippedSegment[] = [];
    try {
      const group = await mergeGroup(run, family, outPath, runSkipped);
      if (group) groups.push(group);
      skipped.push(...runSkipped);
    } catch (err) {
      if (run.length === 1) {
        skipped.push({
          path: run[0].path,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // A segment failed part-way: merge each segment of the run on its own instead.
      for (const seg of run) {
        const one = join(outDir, `group-${mergeIndex}-${family}.${FAMILY_CONTAINER[family].ext}`);
        mergeIndex += 1;
        const oneSkipped: SkippedSegment[] = [];
        try {
          const group = await mergeGroup([seg], family, one, oneSkipped);
          if (group) groups.push(group);
          skipped.push(...oneSkipped);
        } catch (e) {
          skipped.push({ path: seg.path, reason: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  return { groups, skipped };
}
