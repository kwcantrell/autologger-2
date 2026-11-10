import { ApiError, apiFetch } from '../../../api/client';
import type {
  AudioSegmentsResponse,
  OkResponse,
  ProfilePayload,
  YoutubePlaylistEntry,
  YoutubePlaylistResponse,
} from '../../../api/types';
import {
  findImportSession,
  forgetImportSession,
  rememberImportSession,
} from '../../../api/uploads';
import {
  alignActiveShow,
  type BatchImportProgressState,
  createSessionForStem,
  deleteSession,
  fetchSessions,
  findMatchingSession,
  formatCompletedLine,
  formatErrorDetail,
  formatFailedLine,
  formatSkippedLine,
  isAbortError,
  throwIfAborted,
} from './runner';

// youtube-playlist-import D5, D7 (batch-audio-import "YouTube playlist import run"): the browser
// loop over a playlist's checked entries. One entry at a time, in playlist order: re-check the
// active show and read a fresh session list, skip a same-named session of the run's show (unless
// it is this import's own empty one), else create a session and call the unchanged
// `youtube-import`. No entry starts while the previous one may still be importing on the server.

/** How often the runner reads the segments while an import's outcome is unknown. */
export const PLAYLIST_POLL_INTERVAL_MS = 15_000;
/** How long it waits: the import's two 15-minute spawn bounds plus 2 minutes for the blob
 * write and anchor (design D7). */
export const PLAYLIST_WAIT_LIMIT_MS = 32 * 60 * 1000;

/** The import-session memory key (design D5): the session this import created for a video. */
export function playlistImportKey(showId: string, videoId: string): string {
  return `youtube:${showId}:${videoId}`;
}

export function formatStillImportingLine(name: string): string {
  return `Still importing ${name} on the server; run the import again later to check it`;
}

export function formatUnconfirmedLine(name: string): string {
  return formatFailedLine(
    name,
    'the server did not confirm the import; run the import again to retry',
  );
}

export function formatNotAttemptedLine(count: number): string {
  return count === 1
    ? '1 checked video was not attempted.'
    : `${count} checked videos were not attempted.`;
}

/** `POST /api/youtube/playlist-entries` (api-contract-freeze "YouTube playlist listing endpoint"). */
export function listPlaylistEntries(
  url: string,
  signal?: AbortSignal,
): Promise<YoutubePlaylistResponse> {
  return apiFetch<YoutubePlaylistResponse>('youtube/playlist-entries', {
    method: 'POST',
    body: JSON.stringify({ url }),
    signal,
  });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function segmentCount(sessionId: string, signal: AbortSignal): Promise<number> {
  const { segments } = await apiFetch<AudioSegmentsResponse>(
    `sessions/${encodeURIComponent(sessionId)}/audio/segments`,
    { signal },
  );
  return segments.length;
}

async function startYoutubeImport(
  sessionId: string,
  entry: YoutubePlaylistEntry,
  usePublishDate: boolean,
  signal: AbortSignal,
): Promise<void> {
  await apiFetch<OkResponse>(`sessions/${encodeURIComponent(sessionId)}/youtube-import`, {
    method: 'POST',
    body: JSON.stringify({ url: entry.url, use_publish_date: usePublishDate }),
    signal,
  });
}

/** A JSON `{detail}` answer: the route rolled back on every such path, so the outcome is known. */
function isDefiniteFailure(err: unknown): err is ApiError {
  return err instanceof ApiError && err.body !== undefined;
}

/** Statuses after which every later entry would fail the same way. */
const RUN_ENDING_STATUSES: ReadonlySet<number> = new Set([401, 403, 503]);

export interface RunPlaylistImportOptions {
  showId: string;
  /** The checked entries, in playlist order. */
  entries: readonly YoutubePlaylistEntry[];
  /** `playlistSessionNames` over the whole listing. */
  names: ReadonlyMap<number, string>;
  usePublishDate: boolean;
  profile: ProfilePayload;
  signal: AbortSignal;
  /** Lines of the parts that ran before (the folder import), kept ahead of this part's. */
  initialLines?: readonly string[];
  onProgress: (state: BatchImportProgressState) => void;
  /** Called after each successful session create (for query invalidation). */
  onSessionCreated?: () => void;
  /** Injectable for tests (virtual time); rejects with `AbortError` on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type EntryOutcome = 'done' | 'end-run';

/** Run the playlist part of Start Import. Rejects with `AbortError` when `signal` aborts; the
 * session whose import was in flight is then kept and remembered (design D7). */
export async function runPlaylistImport(options: RunPlaylistImportOptions): Promise<void> {
  const { showId, names, usePublishDate, profile, signal, onProgress, onSessionCreated } = options;
  const sleep = options.sleep ?? abortableSleep;
  const entries = options.entries.filter((e) => names.has(e.index));
  const total = entries.length;

  const state: BatchImportProgressState = {
    current: null,
    percent: 0,
    lines: [...(options.initialLines ?? [])],
  };
  const emit = (patch: Partial<BatchImportProgressState>) => {
    Object.assign(state, patch);
    onProgress({ ...state, lines: [...state.lines] });
  };
  const log = (line: string) => state.lines.push(line);

  if (total === 0) {
    emit({ current: null, percent: 100 });
    return;
  }

  // The run's studio: the profile's at start, which the modal's show list belongs to.
  const runStudio = profile.active_studio_id;
  await alignActiveShow(profile, showId, signal);

  /** Wait for an import whose outcome is unknown (design D7): never re-send, never start the
   * next entry, until a segment appears or the wait limit passes. */
  const awaitOutcome = async (sessionId: string, name: string, key: string): Promise<void> => {
    emit({ current: `Waiting for the server to finish ${name}...` });
    for (let waited = 0; waited < PLAYLIST_WAIT_LIMIT_MS; waited += PLAYLIST_POLL_INTERVAL_MS) {
      await sleep(PLAYLIST_POLL_INTERVAL_MS, signal);
      throwIfAborted(signal);
      let count = 0;
      try {
        count = await segmentCount(sessionId, signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        continue; // A failed read is no answer; keep waiting.
      }
      if (count > 0) {
        await forgetImportSession(key);
        log(formatCompletedLine(name));
        return;
      }
    }
    // Kept and remembered: the next run retries into it (or skips it, if the audio landed).
    log(formatUnconfirmedLine(name));
  };

  const importEntry = async (entry: YoutubePlaylistEntry, name: string): Promise<EntryOutcome> => {
    const key = playlistImportKey(showId, entry.video_id);

    // Fresh check before deciding (design D5): the active show may have been switched in another
    // tab, and the list follows the active show; keep only the run's show either way.
    throwIfAborted(signal);
    const current = await apiFetch<ProfilePayload>('profile', { signal });
    if (current.active_show_id !== showId) {
      await alignActiveShow({ ...current, active_studio_id: runStudio }, showId, signal);
      log("The active show was changed elsewhere; switched back to this import's show");
    }
    const sessions = (await fetchSessions(signal)).filter((s) => s.show_id === showId);

    let sessionId: string | null = null;
    let retrying = false;
    const existing = findMatchingSession(sessions, name);
    if (existing) {
      if ((await findImportSession(key)) === existing.id) {
        throwIfAborted(signal);
        if ((await segmentCount(existing.id, signal)) === 0) {
          sessionId = existing.id;
          retrying = true;
        }
      }
      if (sessionId === null) {
        log(formatSkippedLine(name));
        return 'done';
      }
    }

    if (sessionId === null) {
      try {
        const created = await createSessionForStem(showId, name, profile, signal);
        sessionId = created.id;
      } catch (err) {
        if (isAbortError(err)) throw err;
        log(formatFailedLine(name, formatErrorDetail(err, 'Create failed')));
        return 'done';
      }
      await rememberImportSession(key, sessionId);
      onSessionCreated?.();
    }

    try {
      await startYoutubeImport(sessionId, entry, usePublishDate, signal);
    } catch (err) {
      // Abort: keep the in-flight session, remembered; the server finishes or fails on its own.
      if (isAbortError(err)) throw err;
      if (!isDefiniteFailure(err)) {
        await awaitOutcome(sessionId, name, key);
        return 'done';
      }
      if (retrying && err.status === 409) {
        // The server is still importing this session (its guard or run lease).
        log(formatStillImportingLine(name));
        return 'done';
      }
      try {
        await deleteSession(sessionId);
        await forgetImportSession(key);
      } catch {
        // Best effort: a leftover empty session stays remembered and is retried next run.
      }
      log(formatFailedLine(name, formatErrorDetail(err, 'Import failed')));
      return RUN_ENDING_STATUSES.has(err.status) ? 'end-run' : 'done';
    }
    await forgetImportSession(key);
    log(formatCompletedLine(name));
    return 'done';
  };

  for (let i = 0; i < total; i++) {
    throwIfAborted(signal);
    const entry = entries[i];
    const name = names.get(entry.index) as string;
    emit({
      current: `Importing ${name} (video ${i + 1} of ${total})...`,
      percent: Math.round((i / total) * 100),
    });
    const outcome = await importEntry(entry, name);
    if (outcome === 'end-run') {
      const left = total - (i + 1);
      if (left > 0) log(formatNotAttemptedLine(left));
      break;
    }
    emit({ current: null, percent: Math.round(((i + 1) / total) * 100) });
  }

  emit({ current: null, percent: 100 });
}
