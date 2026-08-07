// Sessions routes — ported from web/routers/sessions.py. Listing + metadata are
// pure catalog reads (no hub wake); create initializes the catalog index row
// and the session hub.
// YouTube import (youtube-audio-import, design D1/D2/D3/D6/D7/D8/D9, task 5.3):
// config-gated + open-network-refused (mirroring the AI chat/AI v2 outbound
// features), URL-allowlist-validated, per-session + global concurrency
// bounded, downloads via the operator-provided `yt-dlp` binary into a
// per-request scratch-root temp dir, and ingests through the SAME
// addAudioSegment → ports.audio.put → rollback-on-failure path the recorder
// (`audio.ts`) uses — see the handler body below for the full guard order.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Row } from '../db/catalog';
import { normalizeUploadDate } from '../db/sessionIndexStore';
import { oauthConfigured, youtubeImportOpenNetworkRefused, ytDlpConfigured } from '../env';
import { youtubeImportGuard } from '../node/youtubeImportGuard';
import { YOUTUBE_IMPORT_TMP_PREFIX } from '../node/youtubeImportScratch';
import { fetchYoutubeAudio, YtDlpError } from '../node/ytdlp';
import {
  newSessionBodySchema,
  sessionUpdateBodySchema,
  validateYoutubeImportUrl,
  youtubeImportBodySchema,
} from '../schemas';
import {
  AUDIO_SEAM_PARTS_HEADER,
  type AudioSeamPart,
  parseAudioSeamPartsHeader,
} from '../session/audioSeamParts';
import { SETTING_ACTIVE_SHOW, sessionDeckDisplayTitle, ValidationError } from '../studio';
import { formatRuntimeHms, formatSmpte, isoZ, toTotalFrames, transportTimecode } from '../timecode';
import type { AppEnv } from '../types';
import { ApiError, getSessionHub, requireSession, timecodeCtx } from './_helpers';
import { enforceLocalAudioImportByteLimit, readLocalAudioImportBody } from './audio';

export const sessionsRouter = new Hono<AppEnv>();

function sessionStatusUi(row: Row): string {
  if (Number(row.ui_hidden ?? 0)) return 'deleted';
  if (Number(row.archived ?? 0)) return 'archived';
  return 'active';
}

/** _list_runtime_total_frames — max of last logged timecode vs transport. */
function listRuntimeTotalFrames(row: Row, transportTotalFrames: number): number {
  const evMax = Math.max(0, Number(row.max_timecode_total_frames ?? 0));
  const trTf = Math.max(0, transportTotalFrames);
  if (Number(row.is_rolling ?? 0)) return Math.max(evMax, trTf);
  if (evMax > 0) return Math.max(evMax, trTf);
  return 0;
}

/** Serialize a joined session row (session cols + show_code/show_name from
 * `getSessionJoinedRow`/`listSessionsForShow`) into a list-entry-shaped JSON
 * object. The ONE place this shape is built — shared by `GET /api/sessions`
 * (list) and `GET /api/sessions/:sessionId` (detail), so the two responses
 * cannot drift (design D5/D7, api-contract-freeze delta). */
function serializeSessionEntry(c: Context<AppEnv>, s: Row): Record<string, unknown> {
  const frameRate = Number(s.frame_rate ?? 24.0);
  const startOffset = Number(s.start_offset_frames ?? 0);
  const isRolling = Boolean(Number(s.is_rolling ?? 0));
  const tc = transportTimecode(
    frameRate,
    startOffset,
    {
      is_rolling: isRolling,
      elapsed_frames: Number(s.transport_elapsed_frames ?? 0),
      roll_started_at_utc: (s.roll_started_at_utc as string | null) ?? null,
    },
    c.env.ports.clock.now(),
  );
  const trTotal = toTotalFrames(tc);
  const rtFrames = listRuntimeTotalFrames(s, trTotal);
  const ep = String(s.episode ?? '').trim();
  const archived = Boolean(Number(s.archived ?? 0));
  return {
    id: String(s.id),
    title: String(s.title ?? ''),
    deck_title: sessionDeckDisplayTitle({
      showCode: s.show_code as string | null,
      episode: ep,
      storedTitle: String(s.title ?? ''),
    }),
    show_id: (s.show_id as string | null) ?? null,
    show_code: (s.show_code as string | null) ?? null,
    show_name: (s.show_name as string | null) ?? null,
    episode: ep,
    notes: String(s.notes ?? ''),
    session_status: sessionStatusUi(s),
    frame_rate: frameRate,
    start_offset_frames: startOffset,
    created_at_utc: s.created_at_utc ? isoZ(new Date(String(s.created_at_utc))) : null,
    episode_date: (s.episode_date as string | null) ?? null,
    event_count: Number(s.event_count ?? 0),
    is_rolling: isRolling,
    current_take: Number(s.current_take ?? 0),
    rolling_timecode: formatSmpte(tc),
    total_runtime_hms: formatRuntimeHms(rtFrames, frameRate),
    archived,
  };
}

sessionsRouter.get('/api/sessions', async (c) => {
  const catalog = c.get('catalog');
  const user = c.get('user');
  const active = catalog.profile.getEffectiveStudioForUser(user, oauthConfigured(c.env.config));
  if (active === null) return c.json({ active: [], archived: [] });

  const shows = catalog.shows.listShowsForStudio(active.id);
  const validShowIds = new Set(shows.map((r) => String(r.id)));
  let rawActiveShow = '';
  if (user === null) {
    rawActiveShow = String(catalog.studios.getSetting(SETTING_ACTIVE_SHOW) ?? '').trim();
  } else {
    const prow = catalog.auth.authGetPrefs(user.id);
    rawActiveShow = prow ? String(prow.active_show_id ?? '').trim() : '';
  }
  let activeShowId = validShowIds.has(rawActiveShow) ? rawActiveShow : '';
  if (!activeShowId && shows.length) {
    activeShowId = String(shows[0].id);
    if (user === null) catalog.studios.setSetting(SETTING_ACTIVE_SHOW, activeShowId);
    else catalog.auth.authSetPrefs(user.id, active.id, activeShowId);
  }
  if (!activeShowId) return c.json({ active: [], archived: [] });

  const activeRows: Record<string, unknown>[] = [];
  const archivedRows: Record<string, unknown>[] = [];
  for (const s of catalog.sessions.listSessionsForShow(activeShowId)) {
    const row = serializeSessionEntry(c, s);
    if (row.archived) archivedRows.push(row);
    else activeRows.push(row);
  }
  return c.json({ active: activeRows, archived: archivedRows });
});

sessionsRouter.post('/api/sessions', async (c) => {
  const catalog = c.get('catalog');
  const user = c.get('user');
  const body = newSessionBodySchema.parse(await c.req.json());
  const active = catalog.profile.getEffectiveStudioForUser(user, oauthConfigured(c.env.config));
  if (active === null) throw new ApiError(403, 'No team access.');

  const showRow = catalog.shows.getShowRow(body.show_id.trim());
  if (showRow === null) throw new ApiError(400, 'Unknown show_id.');
  if (String(showRow.studio_id) !== active.id) {
    throw new ApiError(400, 'Show does not belong to the active team.');
  }

  const notes = (body.notes ?? '').trim();
  const showCode = String(showRow.show_code ?? '').trim();
  // Only 'episode' selects the Episode-suffix path; every other stored value
  // (including the column default 'date') derives under Date (design D7 —
  // the two persisted values are 'date' and 'episode').
  const titleSuffix =
    String(showRow.title_suffix ?? 'date')
      .trim()
      .toLowerCase() === 'episode'
      ? 'episode'
      : 'date';
  const explicitTitle = (body.title ?? '').trim();
  const rawEpisode = (body.episode ?? '').trim();
  const nowMs = c.env.ports.clock.now();
  const now = isoZ(new Date(nowMs));

  let created: { id: string; title: string; episode: string };
  try {
    created = catalog.sessions.createSessionForShow({
      showId: body.show_id.trim(),
      showCode,
      titleSuffix,
      explicitTitle,
      rawEpisode,
      frameRate: body.frame_rate,
      startOffsetFrames: body.start_offset_frames,
      notes,
      startedAtUtc: now,
      createdAtUtc: now,
      nowMs,
    });
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  // Instantiate the hub so its transport row exists.
  getSessionHub(c, created.id).ensure();
  return c.json({
    id: created.id,
    title: created.title,
    frame_rate: body.frame_rate,
    start_offset_frames: body.start_offset_frames,
    show_id: body.show_id.trim(),
    episode: created.episode,
    notes,
  });
});

// Session detail — deep-link resolution source (spec: api-contract-freeze
// delta, "Session detail endpoint"). Authorization matches the other
// per-session routes (studio membership via requireSession, masked 404);
// unlike the list, it resolves any authorized session regardless of the
// requester's active-show/active-studio prefs or archived state.
sessionsRouter.get('/api/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const row = c.get('catalog').sessions.getSessionJoinedRow(sessionId);
  if (row === null) throw new ApiError(404, 'Session not found');
  return c.json(serializeSessionEntry(c, row));
});

sessionsRouter.put('/api/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const body = sessionUpdateBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  let row: Row | null;
  try {
    row = catalog.sessions.updateSessionIndex(sessionId, {
      title: body.title,
      startOffsetFrames: body.start_offset_frames,
    });
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  if (row === null) throw new ApiError(404, 'Session not found');
  return c.json({
    id: String(row.id),
    title: String(row.title),
    frame_rate: Number(row.frame_rate),
    start_offset_frames: Number(row.start_offset_frames ?? 0),
  });
});

sessionsRouter.post('/api/sessions/:sessionId/archive', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  if (!c.get('catalog').sessions.setSessionArchived(sessionId, true)) {
    throw new ApiError(404, 'Session not found');
  }
  return c.json({ ok: true, archived: true });
});

sessionsRouter.post('/api/sessions/:sessionId/restore', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  if (!c.get('catalog').sessions.setSessionArchived(sessionId, false)) {
    throw new ApiError(404, 'Session not found');
  }
  return c.json({ ok: true, archived: false });
});

sessionsRouter.delete('/api/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId, { includeHidden: true });
  if (!c.get('catalog').sessions.setSessionUiHidden(sessionId, true)) {
    throw new ApiError(404, 'Session not found');
  }
  return c.json({ ok: true, hidden: true });
});

// YouTube import (design D1/D2/D3/D6/D7/D8/D9). Detail text kept IDENTICAL to
// the pre-pipeline stub's for the not-configured case (api-contract-freeze:
// "byte-for-byte unchanged" for deployments with no yt-dlp available).
const YOUTUBE_IMPORT_NOT_CONFIGURED_DETAIL = 'YouTube import is unavailable on this deployment.';
const YOUTUBE_IMPORT_OPEN_NETWORK_DETAIL =
  'YouTube import is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no IP_ALLOWLIST. ' +
  'Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before importing third-party audio.';
const YOUTUBE_IMPORT_BAD_BODY_DETAIL = 'Invalid youtube-import request body.';
const YOUTUBE_IMPORT_BAD_URL_DETAIL =
  'url must be an http(s) link to youtube.com, youtu.be, or music.youtube.com.';
const YOUTUBE_IMPORT_SESSION_BUSY_DETAIL = 'An import is already in progress for this session.';
const YOUTUBE_IMPORT_AT_CAPACITY_DETAIL =
  'The server is already running the maximum number of concurrent YouTube imports; try again shortly.';
const YOUTUBE_IMPORT_ROLLING_DETAIL =
  'YouTube import is refused while this session is actively recording; stop the recording and try again.';
const LOCAL_AUDIO_IMPORT_INVALID_DURATION_DETAIL = 'duration_s must be a positive finite number.';
/** batch-audio-import design D11 — upper bound keeps Date ISO timestamps and frame math representable. */
const LOCAL_AUDIO_IMPORT_MAX_DURATION_S = 86_400; // 24 hours
const LOCAL_AUDIO_IMPORT_DURATION_EXCEEDS_MAX_DETAIL = `duration_s exceeds the maximum supported duration of ${LOCAL_AUDIO_IMPORT_MAX_DURATION_S} seconds (24 hours).`;
const LOCAL_AUDIO_IMPORT_MISSING_CONTENT_TYPE_DETAIL =
  'Content-Type header is required and must be non-empty.';
const LOCAL_AUDIO_IMPORT_ROLLING_DETAIL =
  'Local audio import is refused while this session is actively recording; stop the recording and try again.';

// design D12: `Recording N Started`/`Stopped` internal-event message shape —
// parsed back out to compute the next collision-proof recording ordinal.
const RECORDING_EVENT_RE = /^Recording (\d+) (?:Started|Stopped)$/;

/** design D12 — `N = max(existing recording_ordinal over segments, existing
 * "Recording k" event numbers) + 1`. Deliberately NOT `segments.length + 1`
 * (the client's convention): that collides after a segment deletion. Reads
 * the FULL unpaged event set (`exportEvents`) so an ordinal used by an event
 * whose segment was later deleted still can't be reused.
 * Phase-9 fix-wave (finding 3): the event-message scan is restricted to
 * `category === 'internal'` — the real anchors this composite RPC ever
 * writes (`SessionHub.anchorImportedTake`, always `category: 'internal'`,
 * mirroring `recordingStartAnchors`' own `'internal'` filter) — so a
 * logged/user-authored event that merely happens to match the
 * `Recording <n> Started/Stopped` message text can't inflate N. */
function nextRecordingOrdinal(hub: ReturnType<typeof getSessionHub>): number {
  let maxOrdinal = 0;
  for (const seg of hub.listAudioSegments()) {
    if (seg.recording_ordinal !== null && seg.recording_ordinal > maxOrdinal) {
      maxOrdinal = seg.recording_ordinal;
    }
  }
  for (const ev of hub.exportEvents()) {
    if (String(ev.category).toLowerCase() !== 'internal') continue;
    const m = RECORDING_EVENT_RE.exec(ev.message);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxOrdinal) maxOrdinal = n;
    }
  }
  return maxOrdinal + 1;
}

/** batch-audio-import design D11 — positive finite `duration_s` query param. */
function parseLocalAudioImportDurationS(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    throw new ApiError(400, LOCAL_AUDIO_IMPORT_INVALID_DURATION_DETAIL);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError(400, LOCAL_AUDIO_IMPORT_INVALID_DURATION_DETAIL);
  }
  if (n > LOCAL_AUDIO_IMPORT_MAX_DURATION_S) {
    throw new ApiError(400, LOCAL_AUDIO_IMPORT_DURATION_EXCEEDS_MAX_DETAIL);
  }
  return n;
}

function requireLocalAudioImportContentType(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') {
    throw new ApiError(400, LOCAL_AUDIO_IMPORT_MISSING_CONTENT_TYPE_DETAIL);
  }
  return trimmed;
}

/** Post-put rollback for local-audio-import (PR-3 review fix): once
 * `ports.audio.put` has succeeded, undoing the import must remove BOTH the
 * metadata row and the blob bytes — a row-only delete strands up to
 * MAX_LOCAL_AUDIO_IMPORT_BYTES on disk, and `sync-from-disk` would resurrect
 * the orphaned blob as a fresh segment row. Ordering mirrors the
 * youtube-import handler's D7 posture ("never leave a metadata row pointing
 * at a missing blob"): row first (synchronous, transactional), then the blob;
 * the blob delete is best-effort (`.catch`) so rollback can never mask the
 * original failure — its residue is a plain orphan file, cleaned up by any
 * later successful rollback or operator sweep, never a dangling row. */
async function rollbackLocalAudioImportSegment(
  c: Context<AppEnv>,
  sessionId: string,
  seg: { id: string; r2_key: string },
): Promise<void> {
  getSessionHub(c, sessionId).deleteAudioSegment(seg.id);
  await c.env.ports.audio.delete(seg.r2_key).catch(() => {});
}

sessionsRouter.post('/api/sessions/:sessionId/local-audio-import', async (c) => {
  const sessionId = c.req.param('sessionId');
  const sessionRow = await requireSession(c, sessionId);
  const ctx = timecodeCtx(sessionRow);

  const durationS = parseLocalAudioImportDurationS(c.req.query('duration_s'));
  const mimeType = requireLocalAudioImportContentType(c.req.header('content-type'));
  let seamParts: AudioSeamPart[];
  try {
    seamParts = parseAudioSeamPartsHeader(c.req.header(AUDIO_SEAM_PARTS_HEADER), durationS);
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : 'Invalid X-Audio-Seam-Parts.');
  }

  const declared = c.req.header('content-length');
  enforceLocalAudioImportByteLimit(declared !== undefined ? Number(declared) : null);
  // Streaming read (PR-3 review fix): counts bytes and aborts with the SAME
  // 413 the pre-check uses — a chunked or lying-Content-Length request can no
  // longer buffer unbounded heap before the post-read backstop below.
  const payload = await readLocalAudioImportBody(c.req.raw.body);
  if (payload.byteLength === 0) throw new ApiError(400, 'Audio payload is empty.');
  enforceLocalAudioImportByteLimit(payload.byteLength);

  if (getSessionHub(c, sessionId).statusLive(ctx).is_rolling) {
    throw new ApiError(409, LOCAL_AUDIO_IMPORT_ROLLING_DETAIL);
  }

  const hub = getSessionHub(c, sessionId);
  const recordingOrdinal = nextRecordingOrdinal(hub);
  const nowMs = c.env.ports.clock.now();
  const startedAtUtc = isoZ(new Date(nowMs));
  const endedAtUtc = isoZ(new Date(nowMs + durationS * 1000));
  const seg = hub.addAudioSegment({
    sessionId,
    mimeType,
    startedAtUtc,
    endedAtUtc,
    recordingOrdinal,
  });
  try {
    await c.env.ports.audio.put(seg.r2_key, payload, { contentType: mimeType });
  } catch (err) {
    await getSessionHub(c, sessionId).deleteAudioSegment(seg.id);
    throw err;
  }

  if (getSessionHub(c, sessionId).statusLive(ctx).is_rolling) {
    await rollbackLocalAudioImportSegment(c, sessionId, seg);
    throw new ApiError(409, LOCAL_AUDIO_IMPORT_ROLLING_DETAIL);
  }

  try {
    getSessionHub(c, sessionId).anchorImportedTake({
      recordingOrdinal,
      durationS,
      ctx,
    });
    getSessionHub(c, sessionId).appendAudioSeamParts(seamParts);
  } catch (err) {
    await rollbackLocalAudioImportSegment(c, sessionId, seg);
    throw err;
  }

  return c.json({ ok: true });
});

sessionsRouter.post('/api/sessions/:sessionId/youtube-import', async (c) => {
  const sessionId = c.req.param('sessionId');
  const sessionRow = requireSession(c, sessionId);
  const ctx = timecodeCtx(sessionRow);

  // Configuration gate, THEN open-network refusal (matches the AI chat/AI v2
  // sibling ordering in ai.ts/aiV2.ts) — a deployment with no yt-dlp at all
  // stays byte-for-byte its pre-change 503, regardless of network config.
  const binaryPath = c.env.config.YTDLP_RESOLVED_PATH;
  if (!ytDlpConfigured(c.env.config) || !binaryPath) {
    throw new ApiError(503, YOUTUBE_IMPORT_NOT_CONFIGURED_DETAIL);
  }
  if (youtubeImportOpenNetworkRefused(c.env.config)) {
    throw new ApiError(503, YOUTUBE_IMPORT_OPEN_NETWORK_DETAIL);
  }

  // Body + URL validation (400) — before any concurrency claim or spawn.
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    throw new ApiError(400, YOUTUBE_IMPORT_BAD_BODY_DETAIL);
  }
  const parsedBody = youtubeImportBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    throw new ApiError(400, YOUTUBE_IMPORT_BAD_BODY_DETAIL);
  }
  const urlCheck = validateYoutubeImportUrl(parsedBody.data.url);
  if (!urlCheck.ok) {
    throw new ApiError(400, YOUTUBE_IMPORT_BAD_URL_DETAIL);
  }

  // Concurrency guards (design D8) — the single statement directly before
  // try{…}finally{release} (fidelity note: nothing throwable in between).
  const lease = youtubeImportGuard.tryAcquire(sessionId);
  if (!lease) {
    const detail = youtubeImportGuard.isSessionInFlight(sessionId)
      ? YOUTUBE_IMPORT_SESSION_BUSY_DETAIL
      : YOUTUBE_IMPORT_AT_CAPACITY_DETAIL;
    throw new ApiError(409, detail);
  }

  let tempDir: string | null = null;
  try {
    // Early rolling guard (design D13, fast-fail): refuse before any
    // download/spawn if a recording is already live on this session — no
    // point spending the download just to fail synthesis later. Re-checked
    // once more below, right before synthesis, to close the race where a
    // recording starts DURING the (multi-minute) download.
    if (getSessionHub(c, sessionId).statusLive(ctx).is_rolling) {
      throw new ApiError(409, YOUTUBE_IMPORT_ROLLING_DETAIL);
    }

    tempDir = await mkdtemp(
      join(c.env.ports.audio.scratchRoot(), `${YOUTUBE_IMPORT_TMP_PREFIX}${sessionId}-`),
    );

    // Long-running download — no hub reference is held across this await
    // (design D1: the idle-hub sweeper may close the session DB during a
    // multi-minute download); the hub is re-acquired via getSessionHub AFTER
    // this resolves, below.
    const fetched = await fetchYoutubeAudio({ url: urlCheck.href, tempDir, binaryPath });
    const bytes = await readFile(fetched.audioPath);

    // Re-acquire the hub post-download (D1). N is computed before the
    // segment is attached (design D12 — collision-proof, not
    // `segments.length + 1`), then the segment carries the SAME ordinal +
    // now/now+duration timestamps the composite anchor RPC below anchors to
    // (design D10), via the SAME addAudioSegment → ports.audio.put →
    // rollback-on-failure path the recorder (audio.ts) uses (D3/D7).
    const hub = getSessionHub(c, sessionId);
    const recordingOrdinal = nextRecordingOrdinal(hub);
    const nowMs = c.env.ports.clock.now();
    const startedAtUtc = isoZ(new Date(nowMs));
    const endedAtUtc = isoZ(new Date(nowMs + fetched.duration * 1000));
    const seg = hub.addAudioSegment({
      sessionId,
      mimeType: fetched.contentType,
      startedAtUtc,
      endedAtUtc,
      recordingOrdinal,
    });
    try {
      await c.env.ports.audio.put(seg.r2_key, bytes, { contentType: fetched.contentType });
    } catch (err) {
      // Atomic rollback (D7): a put failure must never leave a metadata row
      // pointing at a missing blob — mirrors audio.ts's own rollback.
      getSessionHub(c, sessionId).deleteAudioSegment(seg.id);
      throw err;
    }

    // Final rolling guard (design D13, race): re-read right before synthesis
    // — protects a live take that started DURING the download from being
    // clobbered by stopTakeWithDuration inside the composite RPC. Mirrors the
    // put-failure rollback shape above: the segment is already attached, so a
    // refusal here rolls it back rather than leaving an unanchored orphan.
    if (getSessionHub(c, sessionId).statusLive(ctx).is_rolling) {
      getSessionHub(c, sessionId).deleteAudioSegment(seg.id);
      throw new ApiError(409, YOUTUBE_IMPORT_ROLLING_DETAIL);
    }

    // Composite anchor RPC (design D10/D11): Recording N Started → transport
    // advance by the video's duration → Recording N Stopped, one atomic
    // txn broadcasting event.changed + transport.changed once. Runs AFTER
    // the successful blob put (D3's put-first ordering preserved) — on
    // throw, roll back the just-attached segment so failure leaves the
    // session byte-for-byte unchanged.
    try {
      getSessionHub(c, sessionId).anchorImportedTake({
        recordingOrdinal,
        durationS: fetched.duration,
        ctx,
      });
    } catch (err) {
      getSessionHub(c, sessionId).deleteAudioSegment(seg.id);
      throw err;
    }

    // Publish-date opt-in (D4) — catalog write, not a hub RPC; a missing/
    // unusable date is a no-op, never a failure. The catalog handle is
    // process-lifetime, so no re-acquire concern here (unlike the hub).
    if (parsedBody.data.use_publish_date) {
      const iso = normalizeUploadDate(fetched.uploadDate);
      if (iso) {
        c.get('catalog').sessions.setSessionEpisodeDate(sessionId, iso);
      }
    }

    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Every post-validation failure (download/extract, bound breach,
    // unsupported container, put failure) maps to a clean 502 {detail} — D7.
    // YtDlpError's `.message` is already a safe, non-sensitive summary; any
    // other thrown error (e.g. a disk-full ENOSPC from ports.audio.put, or a
    // readFile failure) falls back to a generic detail rather than leaking
    // an internals-shaped message.
    const detail = err instanceof YtDlpError ? err.message : 'Failed to import audio from YouTube.';
    throw new ApiError(502, detail);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    lease.release();
  }
});
