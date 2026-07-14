// Lossless concatenation of recorded audio segments into one WebM file via
// mediabunny (pure TS, no ffmpeg). Packets are copied — never decoded or
// re-encoded — so every input must carry the same codec/sampleRate/channel
// layout (true for MediaRecorder WebM/Opus segments, this store's default).
// Consumed by scripts/merge-session-audio.ts; not part of the HTTP surface.

import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  FilePathSource,
  FilePathTarget,
  Input,
  type InputAudioTrack,
  Output,
  WebMOutputFormat,
} from 'mediabunny';

export interface MergeResult {
  files: number;
  packets: number;
  durationSeconds: number;
}

type DecoderConfig = NonNullable<Awaited<ReturnType<InputAudioTrack['getDecoderConfig']>>>;

/** Concatenate the audio tracks of `inputPaths` (in order, back-to-back) into
 * a single WebM at `outPath`. Timestamps are rebased so each file starts where
 * the previous one ended; gaps between recordings are not preserved. */
export async function mergeAudioFiles(inputPaths: string[], outPath: string): Promise<MergeResult> {
  if (inputPaths.length === 0) throw new Error('No input files to merge.');

  const output = new Output({
    format: new WebMOutputFormat(),
    target: new FilePathTarget(outPath),
  });

  let source: EncodedAudioPacketSource | null = null;
  let baseConfig: DecoderConfig | null = null;
  let baseCodec: string | null = null;
  let offset = 0;
  let packets = 0;

  try {
    for (const path of inputPaths) {
      const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) throw new Error(`${path}: no audio track found.`);
        const config = await track.getDecoderConfig();
        if (!config || !track.codec) throw new Error(`${path}: unsupported or unknown codec.`);

        if (!source) {
          baseConfig = config;
          baseCodec = track.codec;
          source = new EncodedAudioPacketSource(track.codec);
          output.addAudioTrack(source);
          await output.start();
        } else if (
          track.codec !== baseCodec ||
          config.sampleRate !== baseConfig?.sampleRate ||
          config.numberOfChannels !== baseConfig?.numberOfChannels
        ) {
          throw new Error(
            `${path}: codec mismatch (${track.codec} ${config.sampleRate}Hz ` +
              `${config.numberOfChannels}ch vs ${baseCodec} ${baseConfig?.sampleRate}Hz ` +
              `${baseConfig?.numberOfChannels}ch) — packet copy needs identical streams.`,
          );
        }

        const sink = new EncodedPacketSink(track);
        let firstTimestamp: number | null = null;
        let end = offset;
        for await (const packet of sink.packets()) {
          firstTimestamp ??= packet.timestamp;
          const timestamp = packet.timestamp - firstTimestamp + offset;
          await source.add(
            packet.clone({ timestamp }),
            packets === 0 && baseConfig ? { decoderConfig: baseConfig } : undefined,
          );
          end = Math.max(end, timestamp + packet.duration);
          packets += 1;
        }
        offset = end;
      } finally {
        input.dispose();
      }
    }

    if (packets === 0) throw new Error('Inputs contained no audio packets.');
    source?.close();
    await output.finalize();
  } catch (err) {
    await output.cancel();
    throw err;
  }

  return { files: inputPaths.length, packets, durationSeconds: offset };
}
