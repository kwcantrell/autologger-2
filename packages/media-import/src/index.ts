// @autologger/media-import package entry (feature-service-packages task
// 3.1). The YouTube audio import service — ytdlp.ts (the yt-dlp spawn +
// lockdown + bounds module), youtubeImportGuard.ts (the per-session +
// global concurrency guard), youtubeImportScratch.ts (the startup sweep of
// stale per-request temp dirs) — moved verbatim from server/src/node/.
// Imports no `@autologger/*` workspace package at all (Node stdlib only) —
// this package sits at L2 by role, not by need (design D1).
//
// `resolveYtDlpPath` deliberately stays in `server/src/env.ts` (gate ruling
// E2): probing the host's `PATH` at boot is the composition root's job — a
// service receives its configuration rather than discovering it from the
// deployment environment.

export * from './fixturesDir';
export * from './youtubeImportGuard';
export * from './youtubeImportScratch';
export * from './ytdlp';
