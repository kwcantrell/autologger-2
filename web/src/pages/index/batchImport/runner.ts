import { apiFetch } from '../../../api/client';
import type {
  AudioSegmentsResponse,
  ProfilePayload,
  Session,
  SessionsResponse,
} from '../../../api/types';
import {
  fileGroupIdentity,
  findImportSession,
  findRememberedUpload,
  forgetImportSession,
  IMPORT_PARTS_THRESHOLD_BYTES,
  PartsUploadError,
  rememberImportSession,
  uploadInParts,
} from '../../../api/uploads';
import { discoverAudioFiles, groupAudioFiles } from './grouping';
import { stitchAudioFiles } from './stitch';

export interface BatchImportProgressState {
  /** Current status line, e.g. "Processing Clip 1 of 3..." */
  current: string | null;
  /** 0–100 */
  percent: number;
  /** Completed log lines (skipped / completed / failed) */
  lines: string[];
}

export function formatSkippedLine(stem: string): string {
  return `Skipped ${stem} (already in system)`;
}

export function formatCompletedLine(stem: string): string {
  return `Completed ${stem}`;
}

export function formatFailedLine(stem: string, detail: string): string {
  return `Failed ${stem}: ${detail}`;
}

export function sessionMatchesStem(session: Session, stem: string): boolean {
  return session.episode === stem || session.title === stem;
}

export function findMatchingSession(
  sessions: readonly Session[],
  stem: string,
): Session | undefined {
  return sessions.find((s) => sessionMatchesStem(s, stem));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function errorDetail(err: unknown, fallback: string): string {
  if (isAbortError(err)) throw err;
  return err instanceof Error ? err.message : fallback;
}

function allSessions(response: SessionsResponse): Session[] {
  return [...response.active, ...response.archived];
}

async function alignActiveShow(
  profile: ProfilePayload,
  showId: string,
  signal: AbortSignal,
): Promise<void> {
  const prevShow = profile.active_show_id ?? '';
  const studioId = profile.active_studio_id ?? '';
  if (studioId && showId && showId !== prevShow) {
    throwIfAborted(signal);
    await apiFetch('profile', {
      method: 'PUT',
      body: JSON.stringify({ active_studio_id: studioId, active_show_id: showId }),
      signal,
    });
  }
}

async function fetchSessions(signal: AbortSignal): Promise<Session[]> {
  throwIfAborted(signal);
  const response = await apiFetch<SessionsResponse>('sessions', { signal });
  return allSessions(response);
}

async function createSessionForStem(
  showId: string,
  stem: string,
  profile: ProfilePayload,
  signal: AbortSignal,
): Promise<Session> {
  throwIfAborted(signal);
  const frame_rate = profile.new_session_defaults?.default_frame_rate ?? 24;
  return apiFetch<Session>('sessions', {
    method: 'POST',
    body: JSON.stringify({
      show_id: showId,
      episode: stem,
      title: stem,
      frame_rate,
      start_offset_frames: 0,
    }),
    signal,
  });
}

/** Infer MIME when the browser leaves `File.type` empty (common for some OS picks). */
export function contentTypeForAudioBlob(blob: Blob, fallbackName: string): string {
  const trimmed = blob.type?.trim() ?? '';
  if (trimmed !== '') return trimmed;
  const lower = fallbackName.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.aiff') || lower.endsWith('.aif')) return 'audio/aiff';
  if (lower.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
}

async function importLocalAudio(
  sessionId: string,
  blob: Blob,
  durationS: number,
  partDurationsS: number[],
  signal: AbortSignal,
  fallbackName: string,
): Promise<void> {
  throwIfAborted(signal);
  const qs = `duration_s=${encodeURIComponent(String(durationS))}`;
  const seamParts = partDurationsS.map((duration_s) => ({ duration_s }));
  await apiFetch(`sessions/${encodeURIComponent(sessionId)}/local-audio-import?${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentTypeForAudioBlob(blob, fallbackName),
      'X-Audio-Seam-Parts': JSON.stringify(seamParts),
    },
    body: blob,
    signal,
  });
}

/**
 * media-worker D12: a blob over the parts threshold uploads through the resumable parts flow with
 * the same `duration_s` and seam parts as `local-audio-import`, remembered by the group's identity
 * so a re-run resumes it. `onPart` reports each part.
 */
async function importAudioInParts(
  sessionId: string,
  blob: Blob,
  durationS: number,
  partDurationsS: number[],
  signal: AbortSignal,
  fallbackName: string,
  resumeKey: string,
  onPart: (partsDone: number, partsTotal: number) => void,
): Promise<void> {
  throwIfAborted(signal);
  await uploadInParts({
    sessionId,
    blob,
    contentType: contentTypeForAudioBlob(blob, fallbackName),
    completion: {
      mode: 'import',
      durationS,
      seamParts: partDurationsS.map((duration_s) => ({ duration_s })),
    },
    resumeKey,
    signal,
    onProgress: ({ partsDone, partsTotal }) => onPart(partsDone, partsTotal),
  });
}

export function formatResumableFailedLine(stem: string, detail: string): string {
  return `${formatFailedLine(stem, detail)} (re-run the import to resume the upload)`;
}

/**
 * The matching session `sessionId` is this group's own interrupted import: its remembered upload
 * belongs to it, or (the upload memory expired) it is the session this import created for the
 * group and it still has no audio. Anything else — a session someone made by hand, or one that
 * already has audio — stays skipped.
 */
async function resumableSessionFor(
  sessionId: string,
  resumeKey: string,
  signal: AbortSignal,
): Promise<string | null> {
  if ((await findRememberedUpload(resumeKey))?.sessionId === sessionId) return sessionId;
  if ((await findImportSession(resumeKey)) !== sessionId) return null;
  throwIfAborted(signal);
  const { segments } = await apiFetch<AudioSegmentsResponse>(
    `sessions/${encodeURIComponent(sessionId)}/audio/segments`,
    { signal },
  );
  return segments.length === 0 ? sessionId : null;
}

/**
 * Roll back a created-but-audio-less session. Deliberately takes NO abort
 * signal: this must run even when the failure being cleaned up IS an abort
 * (modal close / unmount), otherwise the ghost session would match
 * `findMatchingSession` on the next run and the stem would be skipped forever.
 */
async function deleteSession(sessionId: string): Promise<void> {
  await apiFetch(`sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export interface RunBatchImportOptions {
  showId: string;
  files: FileList | readonly File[];
  profile: ProfilePayload;
  signal: AbortSignal;
  onProgress: (state: BatchImportProgressState) => void;
  /** Called after each successful session create (for query invalidation). */
  onSessionCreated?: () => void;
}

/** Discover, match/skip, stitch, create, and upload audio groups for the selected show. */
export async function runBatchImport(options: RunBatchImportOptions): Promise<void> {
  const { showId, files, profile, signal, onProgress, onSessionCreated } = options;

  const entries = discoverAudioFiles(files);
  const groups = groupAudioFiles(entries);
  const total = groups.length;

  const state: BatchImportProgressState = { current: null, percent: 0, lines: [] };
  const emit = (patch: Partial<BatchImportProgressState>) => {
    Object.assign(state, patch);
    onProgress({ ...state, lines: [...state.lines] });
  };

  if (total === 0) {
    emit({ current: null, percent: 100 });
    return;
  }

  await alignActiveShow(profile, showId, signal);
  let sessions = await fetchSessions(signal);

  for (let i = 0; i < total; i++) {
    throwIfAborted(signal);

    const group = groups[i];
    const stem = group.baseName;
    const clipIndex = i + 1;
    const basePercent = Math.round((i / total) * 100);

    emit({
      current: `Processing Clip ${clipIndex} of ${total}...`,
      percent: basePercent,
    });

    const groupFiles = group.segments.map((s) => s.file);
    const resumeKey = fileGroupIdentity(groupFiles);
    const existing = findMatchingSession(sessions, stem);
    // A session left by an interrupted parts upload of this very group is resumed, not skipped:
    // into its remembered upload while that lives (24 h), and after it expired with a fresh
    // upload, but only while the session this import created is still empty.
    const resumeInto = existing ? await resumableSessionFor(existing.id, resumeKey, signal) : null;
    if (existing && resumeInto === null) {
      state.lines.push(formatSkippedLine(stem));
      emit({
        current: null,
        percent: Math.round((clipIndex / total) * 100),
      });
      continue;
    }

    throwIfAborted(signal);

    let blob: Blob;
    let durationS: number;
    let partDurationsS: number[];
    try {
      const stitched = await stitchAudioFiles(groupFiles);
      blob = stitched.blob;
      durationS = stitched.durationS;
      partDurationsS = stitched.partDurationsS;
    } catch (err) {
      const detail = errorDetail(err, 'Stitch failed');
      state.lines.push(formatFailedLine(stem, detail));
      emit({
        current: null,
        percent: Math.round((clipIndex / total) * 100),
      });
      continue;
    }

    throwIfAborted(signal);

    // MIME sniffing needs the real file name (with extension) for single-file
    // pass-through blobs; stitched multi-file blobs are typed audio/wav anyway.
    const uploadName = group.segments.length === 1 ? group.segments[0].name : stem;

    // From session create until upload success, ANY failure — including abort —
    // must attempt the delete rollback, or the audio-less session would match
    // this stem on the next run and block it forever.
    const useParts = blob.size > IMPORT_PARTS_THRESHOLD_BYTES;
    let sessionId: string | null = resumeInto;
    try {
      if (sessionId === null) {
        const created = await createSessionForStem(showId, stem, profile, signal);
        sessionId = created.id;
        if (useParts) await rememberImportSession(resumeKey, sessionId);
        onSessionCreated?.();
        sessions = await fetchSessions(signal);
      }

      throwIfAborted(signal);
      emit({
        current: `Uploading ${stem}...`,
        percent: Math.round(((i + 0.5) / total) * 100),
      });

      if (useParts) {
        await importAudioInParts(
          sessionId,
          blob,
          durationS,
          partDurationsS,
          signal,
          uploadName,
          resumeKey,
          (partsDone, partsTotal) => {
            if (partsDone === 0) return;
            emit({
              current: `Uploading ${stem}: part ${partsDone} of ${partsTotal}...`,
              percent: Math.round(((i + 0.5 + (0.5 * partsDone) / partsTotal) / total) * 100),
            });
          },
        );
      } else {
        await importLocalAudio(sessionId, blob, durationS, partDurationsS, signal, uploadName);
      }
      if (useParts) await forgetImportSession(resumeKey);
      state.lines.push(formatCompletedLine(stem));
    } catch (err) {
      const aborted = isAbortError(err);
      // An interrupted parts upload stays remembered with its session: keep the session so a
      // re-run of this import resumes the upload into it (media-worker D12).
      const resumable =
        useParts &&
        sessionId !== null &&
        (err instanceof PartsUploadError
          ? err.resumable
          : aborted && (await findRememberedUpload(resumeKey))?.sessionId === sessionId);
      if (resumable) {
        if (aborted) throw err;
        const detail = err instanceof Error ? err.message : 'Upload failed';
        state.lines.push(formatResumableFailedLine(stem, detail));
        emit({ current: null, percent: Math.round((clipIndex / total) * 100) });
        continue;
      }
      if (sessionId !== null) {
        try {
          await deleteSession(sessionId);
          if (useParts) await forgetImportSession(resumeKey);
          if (!aborted) sessions = await fetchSessions(signal);
        } catch {
          // Best-effort rollback; a leftover empty session would block retry via match.
        }
      }
      // Abort still stops the whole run — but only after the cleanup above.
      if (aborted) throw err;
      const fallback = sessionId === null ? 'Create failed' : 'Upload failed';
      const detail = err instanceof Error ? err.message : fallback;
      state.lines.push(formatFailedLine(stem, detail));
    }

    emit({
      current: null,
      percent: Math.round((clipIndex / total) * 100),
    });
  }

  emit({ current: null, percent: 100 });
}
