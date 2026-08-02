import { apiFetch } from '../../../api/client';
import type { ProfilePayload, Session, SessionsResponse } from '../../../api/types';
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

async function deleteSession(sessionId: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await apiFetch(`sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    signal,
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

    const existing = findMatchingSession(sessions, stem);
    if (existing) {
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
      const segmentFiles = group.segments.map((s) => s.file);
      const stitched = await stitchAudioFiles(segmentFiles);
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

    let sessionId: string;
    try {
      const created = await createSessionForStem(showId, stem, profile, signal);
      sessionId = created.id;
      onSessionCreated?.();
      sessions = await fetchSessions(signal);
    } catch (err) {
      const detail = errorDetail(err, 'Create failed');
      state.lines.push(formatFailedLine(stem, detail));
      emit({
        current: null,
        percent: Math.round((clipIndex / total) * 100),
      });
      continue;
    }

    throwIfAborted(signal);
    emit({
      current: `Uploading ${stem}...`,
      percent: Math.round(((i + 0.5) / total) * 100),
    });

    try {
      await importLocalAudio(sessionId, blob, durationS, partDurationsS, signal, stem);
      state.lines.push(formatCompletedLine(stem));
    } catch (err) {
      const detail = errorDetail(err, 'Upload failed');
      state.lines.push(formatFailedLine(stem, detail));
      try {
        await deleteSession(sessionId, signal);
        sessions = await fetchSessions(signal);
      } catch {
        // Best-effort rollback; a leftover empty session would block retry via match.
      }
    }

    emit({
      current: null,
      percent: Math.round((clipIndex / total) * 100),
    });
  }

  emit({ current: null, percent: 100 });
}
