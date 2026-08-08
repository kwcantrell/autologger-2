// @autologger/transcription package entry (feature-service-packages task
// 4.1). DeepGram transcription service — deepgram.ts (the provider HTTP
// client), audioMerge.ts (mediabunny packet-copy concat of recorded audio
// segments into per-codec-family container files), transcriptRemap.ts
// (timeline remap of DeepGram words + paragraph/sentiment enrichment onto
// the session's SMPTE timeline), transcriptGenerationLock.ts (the
// process-wide generation lock), generateTranscript.ts (the orchestrating
// entry point both the HTTP generate route and sheets-log-import's
// ensure-timed-transcript coordinator call), deepgramConfig.ts
// (deepgramConfigured/deepgramModel, moved out of server/src/env.ts —
// design D5, the two Config predicates generateTranscript.ts itself reads)
// — moved verbatim from server/src/node/. Depends on @autologger/domain,
// @autologger/ports, and @autologger/session-core — never
// @autologger/contract, which no file in this service imports (design D1).

export * from './audioMerge';
export * from './deepgram';
export * from './deepgramConfig';
export * from './fixturesDir';
export * from './generateTranscript';
export * from './transcriptGenerationLock';
export * from './transcriptRemap';
