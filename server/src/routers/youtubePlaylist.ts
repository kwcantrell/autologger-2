// YouTube playlist listing (youtube-playlist-import D1, D2, D3; api-contract-freeze "YouTube
// playlist listing endpoint"). `POST /api/youtube/playlist-entries {url}` lists one public or
// unlisted playlist's entries (flat metadata, no downloads) so the Batch Import modal can create
// sessions and call the unchanged `youtube-import` per video. Stateless: not scoped to a session
// or show, no catalog or blob writes, no cookies.
//
// Order (each later step only when no earlier one answers):
// - 401: not signed in (the `/api/*` login middleware).
// - 503: no yt-dlp (`youtube-import`'s own unavailable detail).
// - 403: not an approved user (run-status-and-sweeper D9; the seventh run-feature route).
// - 422: the body is not JSON or not `{url: string 1–2048}` (zod issues, the frozen convention).
// - 400: the URL is not a playlist link, or is a Mix/radio (`RD…`) list.
// - 503: two listings already running in this process.
// - 502: private-or-nonexistent / timed out / any other failure (fixed details, stderr never
//   echoed); 200 otherwise.
// No refusal before the busy 503 (inclusive) spawns anything or makes an outbound request.

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validateYoutubePlaylistUrl,
  type YoutubePlaylistResponse,
  youtubePlaylistBodySchema,
} from '@autologger/contract';
import {
  listYoutubePlaylist,
  PLAYLIST_ERROR_DETAILS,
  PLAYLIST_TIMEOUT_MS,
  playlistListingGuard,
  projectPlaylist,
  YOUTUBE_IMPORT_TMP_PREFIX,
  YtDlpError,
} from '@autologger/media-import';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { ytDlpConfigured } from '../env';
import { ApiError } from '../httpError';
import { requireRunFeature, requireUser } from './_helpers';
import { YOUTUBE_IMPORT_NOT_CONFIGURED_DETAIL } from './sessions';

const NOT_PLAYLIST_DETAIL =
  'url must be a YouTube playlist link: youtube.com/playlist?list=… or youtube.com/watch?v=…&list=….';
const MIX_DETAIL = "Mix and radio lists can't be imported; use a regular playlist link.";
const BUSY_DETAIL = 'Playlist listing is busy; try again.';

/** The per-request temp dir prefix. It starts with `youtube-import-`, so the startup sweep of
 * stale import dirs (`sweepStaleYoutubeImportTempDirs`) covers it (design D3, A15). */
const PLAYLIST_TMP_PREFIX = `${YOUTUBE_IMPORT_TMP_PREFIX}playlist-`;

/** The listing's wall-clock bound. Test-only seam: integration tests lower it to exercise the
 * timed-out `502` without waiting a minute; never written on a request path. */
export const playlistListingLimits = { timeoutMs: PLAYLIST_TIMEOUT_MS };

export const youtubePlaylistRouter = new Hono<AppEnv>();

youtubePlaylistRouter.post('/api/youtube/playlist-entries', async (c) => {
  requireUser(c);
  const binaryPath = c.env.config.YTDLP_RESOLVED_PATH;
  if (!ytDlpConfigured(c.env.config) || !binaryPath) {
    throw new ApiError(503, YOUTUBE_IMPORT_NOT_CONFIGURED_DETAIL);
  }
  requireRunFeature(c);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    // Not JSON: parsing `undefined` gives the one zod issue at path [] the contract names.
    raw = undefined;
  }
  // A ZodError answers the frozen `422 {detail: [issues]}` through the app's error handler.
  const body = youtubePlaylistBodySchema.parse(raw);
  const url = validateYoutubePlaylistUrl(body.url);
  if (!url.ok) throw new ApiError(400, url.reason === 'mix' ? MIX_DETAIL : NOT_PLAYLIST_DETAIL);

  const lease = playlistListingGuard.tryAcquire();
  if (!lease) throw new ApiError(503, BUSY_DETAIL);
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(c.env.ports.audio.scratchRoot(), PLAYLIST_TMP_PREFIX));
    const listed = await listYoutubePlaylist({
      listId: url.listId,
      href: url.href,
      tempDir,
      binaryPath,
      timeoutMs: playlistListingLimits.timeoutMs,
    });
    const response: YoutubePlaylistResponse = projectPlaylist(listed, url.listId);
    return c.json(response);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      502,
      err instanceof YtDlpError ? err.message : PLAYLIST_ERROR_DETAILS.generic,
    );
  } finally {
    lease.release();
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
