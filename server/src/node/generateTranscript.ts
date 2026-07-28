// Shared DeepGram transcript generation used by the HTTP generate route and
// sheets-log-import (auto-generate when timed words are missing).

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { deepgramConfigured, deepgramModel } from '../env';
import type { SessionHub } from '../session/SessionHub';
import type { TranscriptWord } from '../session/transcriptStore';
import type { TimecodeCtx } from '../session/sessionCore';
import type { Bindings, Config } from '../types';
import { mergeAudioSegments } from './audioMerge';
import type { TranscribeGroupResult } from './deepgram';
import { DeepgramUpstreamError, transcribeGroup } from './deepgram';
import type { EnrichmentGroup, SegmentAnchorInfo } from './transcriptRemap';
import {
  recordingStartAnchors,
  remapTranscriptEnrichment,
  remapTranscriptWords,
} from './transcriptRemap';

export const DEEPGRAM_MAX_GROUP_BYTES = 2_000_000_000;

export const TRANSCRIPT_UNAVAILABLE = 'Transcription is unavailable on this deployment.';
export const GENERATION_IN_FLIGHT_DETAIL =
  'A transcript generation run is already in progress on this deployment; try again once it completes.';
export const NO_AUDIO_DETAIL = 'This session has no recorded audio to transcribe.';
export const ALL_UNREADABLE_DETAIL =
  "None of this session's recorded audio segments could be read for transcription.";
export const NO_SPEECH_DETAIL =
  "DeepGram detected no speech in this session's audio; the existing transcript was left unchanged.";
export const UPSTREAM_FAILURE_DETAIL = 'DeepGram transcription failed or timed out.';

export class TranscriptGenerateError extends Error {
  constructor(
    readonly code:
      | 'unavailable'
      | 'in_flight'
      | 'no_audio'
      | 'unreadable'
      | 'no_speech'
      | 'upstream'
      | 'oversize',
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptGenerateError';
  }
}

function sizeLimitDetail(bytes: number): string {
  return `Combined audio for one codec group is ${bytes} bytes, over DeepGram's ${DEEPGRAM_MAX_GROUP_BYTES}-byte (2 GB) upload limit.`;
}

export function exceedsGroupSizeLimit(bytes: number): boolean {
  return bytes > DEEPGRAM_MAX_GROUP_BYTES;
}

/** Process-wide slot (design D9) — shared by HTTP generate and log-import. */
let generationInFlight = false;

export function isTranscriptGenerationInFlight(): boolean {
  return generationInFlight;
}

export interface GenerateTranscriptDeps {
  config: Config;
  audio: Bindings['ports']['audio'];
  getHub: () => SessionHub;
  ctx: TimecodeCtx;
  sessionId: string;
  /** Optional abort before the provider call starts. */
  signal?: AbortSignal | null;
}

/** Run DeepGram transcription and atomically replace session words. */
export async function generateTranscriptWords(
  deps: GenerateTranscriptDeps,
): Promise<TranscriptWord[]> {
  if (!deepgramConfigured(deps.config)) {
    throw new TranscriptGenerateError('unavailable', TRANSCRIPT_UNAVAILABLE);
  }
  if (generationInFlight) {
    throw new TranscriptGenerateError('in_flight', GENERATION_IN_FLIGHT_DETAIL);
  }
  generationInFlight = true;

  const blobStore = deps.audio;
  let scratchDir: string | null = null;
  try {
    const segments = deps.getHub().listAudioSegments();
    if (segments.length === 0) {
      throw new TranscriptGenerateError('no_audio', NO_AUDIO_DETAIL);
    }

    scratchDir = await mkdtemp(join(blobStore.scratchRoot(), `${deps.sessionId}-`));
    const inputPaths = segments.map((s) => blobStore.resolveKeyPath(s.r2_key));

    const { groups } = await mergeAudioSegments(inputPaths, scratchDir);
    if (groups.length === 0) {
      throw new TranscriptGenerateError('unreadable', ALL_UNREADABLE_DETAIL);
    }

    if (deps.signal?.aborted) {
      throw new TranscriptGenerateError(
        'unreadable',
        'Transcript generation request was aborted before transcription started; no provider request was made.',
      );
    }

    const apiKey = deps.config.DEEPGRAM_API_KEY;
    const model = deepgramModel(deps.config);
    const enrichmentGroups: EnrichmentGroup[] = [];
    for (const group of groups) {
      const { size } = await stat(group.outPath);
      if (exceedsGroupSizeLimit(size)) {
        throw new TranscriptGenerateError('oversize', sizeLimitDetail(size));
      }
      if (deps.signal?.aborted) {
        throw new TranscriptGenerateError(
          'unreadable',
          'Transcript generation request was aborted before transcription started; no provider request was made.',
        );
      }
      let result: TranscribeGroupResult;
      try {
        result = await transcribeGroup({
          outPath: group.outPath,
          family: group.family,
          apiKey,
          model,
        });
      } catch (err) {
        if (err instanceof DeepgramUpstreamError) {
          throw new TranscriptGenerateError('upstream', UPSTREAM_FAILURE_DETAIL);
        }
        throw err;
      }
      enrichmentGroups.push({
        segments: group.segments,
        words: result.words,
        paragraphs: result.paragraphs,
        sentiments: result.sentiments,
      });
    }

    const events = deps.getHub().exportEvents();
    const anchors = recordingStartAnchors(events);
    const segmentInfo: SegmentAnchorInfo[] = segments.map((s, i) => ({
      path: inputPaths[i],
      ordinal: s.ordinal,
      recordingOrdinal: s.recording_ordinal,
    }));
    const remappedWords = remapTranscriptWords(
      enrichmentGroups,
      segmentInfo,
      anchors,
      deps.ctx.frameRate,
    );

    if (remappedWords.length === 0) {
      throw new TranscriptGenerateError('no_speech', NO_SPEECH_DETAIL);
    }

    const remappedEnrichment = remapTranscriptEnrichment(enrichmentGroups, segmentInfo, anchors);
    return deps.getHub().replaceTranscriptWords(remappedWords, remappedEnrichment);
  } finally {
    generationInFlight = false;
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  }
}
