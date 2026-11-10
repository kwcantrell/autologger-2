import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { showAccessFrom } from '../../../api/hooks/useShowAccess';
import type { ProfilePayload, YoutubePlaylistResponse } from '../../../api/types';
import { Button, TOUCH_TARGET } from '../../../shared/components/ui/button';
import { Field, FieldLabel } from '../../../shared/components/ui/field';
import { Dialog, DialogActions } from '../../../shared/ui/Dialog';
import { useTextPrompt } from '../../../shared/ui/PromptDialog';
import { playlistSessionNames } from '../batchImport/playlistNames';
import { listPlaylistEntries, runPlaylistImport } from '../batchImport/playlistRunner';
import {
  type BatchImportProgressState,
  formatErrorDetail,
  isAbortError,
  runBatchImport,
} from '../batchImport/runner';
import { PlaylistPicker, type PlaylistSelection } from './PlaylistPicker';
import { Select } from './Select';

interface Props {
  profile: ProfilePayload | undefined;
  onClose: () => void;
}

function folderNameFromFiles(files: FileList | null): string | null {
  const first = files?.[0];
  if (!first) return null;
  const rel = (first as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (!rel) return null;
  const top = rel.split('/')[0];
  return top || null;
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded bg-[rgba(255,255,255,0.08)]"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-primary [transition:width_0.15s_ease]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** Upload up-arrow icon (D8): rail `#v6-btn-batch-import` + modal header (lucide `Upload`). */
function BatchImportIcon() {
  return <Upload className="size-5 shrink-0 text-[rgba(229,238,252,0.72)]" aria-hidden="true" />;
}

const EMPTY_PROGRESS: BatchImportProgressState = { current: null, percent: 0, lines: [] };
const NO_SELECTION: PlaylistSelection = { indexes: [], usePublishDate: true };

export function BatchImportModal({ profile, onClose }: Props) {
  // show-grants D13: the picker lists the active team's shows the user can access.
  const shows = showAccessFrom(profile).accessibleShows(profile?.active_studio_id);
  const activeShowId = profile?.active_show_id ?? '';
  const { requestText, promptElement } = useTextPrompt();
  const defaultShowId = shows.some((s) => s.id === activeShowId) ? activeShowId : '';
  const queryClient = useQueryClient();

  const [showId, setShowId] = useState(defaultShowId || (shows[0]?.id ?? ''));
  const [folderName, setFolderName] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [logsUrl, setLogsUrl] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgressState] = useState<BatchImportProgressState>(EMPTY_PROGRESS);
  // youtube-playlist-import D5: the loaded listing, its load state and the picker's selection.
  const [playlist, setPlaylist] = useState<YoutubePlaylistResponse | null>(null);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [playlistSelection, setPlaylistSelection] = useState<PlaylistSelection>(NO_SELECTION);

  const dirInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listingAbortRef = useRef<AbortController | null>(null);
  // The latest progress, so a later part starts from the earlier parts' lines (`runBatchImport`
  // and `runPlaylistImport` report whole states).
  const progressRef = useRef<BatchImportProgressState>(EMPTY_PROGRESS);
  const setProgress = (
    next: BatchImportProgressState | ((prev: BatchImportProgressState) => BatchImportProgressState),
  ) => {
    if (typeof next !== 'function') {
      // Runners report whole states: keep the ref current synchronously for the next part.
      progressRef.current = next;
      setProgressState(next);
      return;
    }
    setProgressState((prev) => {
      const value = next(prev);
      progressRef.current = value;
      return value;
    });
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      listingAbortRef.current?.abort();
    };
  }, []);

  const hasAudio = Boolean(folderName && selectedFiles && selectedFiles.length > 0);
  const hasLogs = Boolean(logsUrl?.trim());
  const hasPlaylist = Boolean(playlist && playlistSelection.indexes.length > 0);
  const canStart = Boolean(showId && (hasAudio || hasPlaylist || hasLogs) && !isImporting);

  const handleClose = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    listingAbortRef.current?.abort();
    listingAbortRef.current = null;
    onClose();
  };

  // Themed text prompt, then the listing (batch-audio-import "YouTube playlist selection"). A new
  // link replaces the loaded playlist; a refused or failed one leaves none, with the detail.
  const handleImportPlaylist = async () => {
    const raw = await requestText({
      title: 'Import YouTube playlist',
      label: 'YouTube playlist link (public or unlisted)',
      placeholder: 'https://www.youtube.com/playlist?list=…',
      submitLabel: 'Load playlist',
    });
    if (raw === null) return;
    const url = raw.trim();
    if (!url) return;
    listingAbortRef.current?.abort();
    const controller = new AbortController();
    listingAbortRef.current = controller;
    setPlaylist(null);
    setPlaylistSelection(NO_SELECTION);
    setPlaylistError(null);
    setPlaylistLoading(true);
    try {
      const listing = await listPlaylistEntries(url, controller.signal);
      if (listingAbortRef.current !== controller) return;
      setPlaylist(listing);
    } catch (err) {
      if (isAbortError(err) || listingAbortRef.current !== controller) return;
      setPlaylistError(formatErrorDetail(err, 'Failed to list the playlist.'));
    } finally {
      if (listingAbortRef.current === controller) {
        listingAbortRef.current = null;
        setPlaylistLoading(false);
      }
    }
  };

  const handleImportAudio = () => {
    dirInputRef.current?.click();
  };

  // Themed text prompt (shadcn-shared-wrappers D3b), not browser chrome.
  const handleImportLogs = async () => {
    const raw = await requestText({
      title: 'Import logs',
      label: 'Public Google Sheets URL (anyone with the link can view)',
      placeholder: 'https://docs.google.com/spreadsheets/d/…',
      submitLabel: 'Use URL',
    });
    if (raw === null) return;
    const trimmed = raw.trim();
    setLogsUrl(trimmed || null);
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    setSelectedFiles(files);
    setFolderName(folderNameFromFiles(files));
  };

  const handleStartImport = async () => {
    if (!profile || !showId) return;
    if (!hasAudio && !hasPlaylist && !hasLogs) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsImporting(true);
    progressRef.current = EMPTY_PROGRESS;
    setProgress(EMPTY_PROGRESS);
    const invalidateSessions = () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    };

    const mergeLines = (extra: string[]) => {
      setProgress((prev) => ({
        ...prev,
        lines: [...prev.lines, ...extra],
      }));
    };

    try {
      if (hasAudio && selectedFiles) {
        await runBatchImport({
          showId,
          files: selectedFiles,
          profile,
          signal: controller.signal,
          onProgress: setProgress,
          onSessionCreated: invalidateSessions,
        });
      }

      // Folder, then playlist, then logs: logs can match sessions the audio parts created.
      if (hasPlaylist && playlist) {
        const checked = new Set(playlistSelection.indexes);
        await runPlaylistImport({
          showId,
          entries: playlist.entries.filter((e) => checked.has(e.index)),
          names: playlistSessionNames(playlist.entries),
          usePublishDate: playlistSelection.usePublishDate,
          profile,
          signal: controller.signal,
          initialLines: progressRef.current.lines,
          onProgress: setProgress,
          onSessionCreated: invalidateSessions,
        });
      }

      if (hasLogs && logsUrl) {
        const { startLogImport, pollLogImportJob } = await import('../batchImport/logImportClient');
        setProgress((prev) => ({
          ...prev,
          current: 'Importing logs…',
          percent: hasAudio || hasPlaylist ? Math.max(prev.percent, 90) : 10,
        }));
        const jobId = await startLogImport(showId, logsUrl, controller.signal);
        const job = await pollLogImportJob(jobId, controller.signal, (j) => {
          setProgress((prev) => ({
            ...prev,
            current: j.status === 'running' || j.status === 'queued' ? 'Importing logs…' : null,
            percent: j.status === 'completed' || j.status === 'failed' ? 100 : prev.percent,
            lines: [
              ...prev.lines.filter((l) => !l.startsWith('[logs] ')),
              ...j.lines.map((l) => `[logs] ${l}`),
            ],
          }));
        });
        if (job.status === 'failed') {
          mergeLines([`Failed logs: ${job.error ?? 'Log import failed'}`]);
        }
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      const detail = err instanceof Error ? err.message : 'Import failed';
      const status =
        err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
          ? err.status
          : null;
      // A job 404 means its record expired or never existed (shared-request-state D1).
      const hint =
        status === 404
          ? ' (The import job was not found. It may have expired; start the import again.)'
          : '';
      setProgress((prev) => ({
        ...prev,
        current: null,
        lines: [...prev.lines, `Failed: ${status ? `HTTP ${status} — ` : ''}${detail}${hint}`],
      }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsImporting(false);
      setProgress((prev) => ({ ...prev, current: null, percent: 100 }));
    }
  };

  const showProgress =
    isImporting || progress.current !== null || progress.lines.length > 0 || progress.percent > 0;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && handleClose()}
      className="md:![transform:translate(calc(-50%+8.125rem),-50%)]"
      hideTitle
      title="Batch Import"
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="flex items-center gap-(--v6-rail-gap)">
          <BatchImportIcon />
          <h2 className="m-0 text-[1rem] font-semibold tracking-[0.06em] uppercase text-v5-text">
            Batch Import
          </h2>
        </div>
        <Button
          variant="outline"
          size="icon"
          className={clsx('text-v5-muted hover:text-v5-text', TOUCH_TARGET)}
          aria-label="Close"
          onClick={handleClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="bi-show">Show</FieldLabel>
          <Select
            id="bi-show"
            ariaLabel="Show"
            value={showId}
            onChange={setShowId}
            options={
              shows.length === 0
                ? [{ value: '', label: 'No shows linked to this team', disabled: true }]
                : shows.map((sh) => ({ value: sh.id, label: `${sh.name} (${sh.show_code})` }))
            }
            disabled={shows.length === 0 || isImporting}
          />
        </Field>

        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className={clsx('self-start', TOUCH_TARGET)}
            id="bi-import-audio"
            onClick={handleImportAudio}
            disabled={isImporting}
          >
            Import Audio
          </Button>
          <input
            ref={dirInputRef}
            type="file"
            data-testid="batch-import-dir-input"
            className="hidden"
            multiple
            // Non-standard directory picker (D9).
            {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
            onChange={handleFolderChange}
          />
          {folderName ? (
            <span className="text-[0.85rem] text-v5-muted" data-testid="batch-import-folder-name">
              {folderName}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className={clsx('self-start', TOUCH_TARGET)}
            id="bi-import-playlist"
            onClick={() => void handleImportPlaylist()}
            disabled={isImporting}
          >
            Import YouTube Playlist
          </Button>
          {playlistLoading ? (
            <span
              className="text-[0.85rem] text-v5-muted"
              data-testid="batch-import-playlist-status"
            >
              Loading playlist…
            </span>
          ) : null}
          {playlistError ? (
            <span
              className="text-[0.85rem] text-destructive"
              role="alert"
              data-testid="batch-import-playlist-error"
            >
              {playlistError}
            </span>
          ) : null}
          {playlist ? (
            <PlaylistPicker
              listing={playlist}
              disabled={isImporting}
              onChange={setPlaylistSelection}
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className={clsx('self-start', TOUCH_TARGET)}
            id="bi-import-logs"
            onClick={handleImportLogs}
            disabled={isImporting}
          >
            Import Logs
          </Button>
          {logsUrl ? (
            <span
              className="truncate text-[0.85rem] text-v5-muted"
              data-testid="batch-import-logs-url"
            >
              {logsUrl}
            </span>
          ) : null}
        </div>

        <DialogActions>
          <Button
            className={TOUCH_TARGET}
            id="bi-start-import"
            disabled={!canStart}
            onClick={() => void handleStartImport()}
          >
            {isImporting ? 'Importing…' : 'Start Import'}
          </Button>
        </DialogActions>

        <div
          id="batch-import-progress"
          className="flex min-h-0 flex-col gap-2"
          data-testid="batch-import-progress"
          aria-live="polite"
        >
          {showProgress ? (
            <>
              {progress.current ? (
                <div className="flex flex-col gap-1" data-testid="batch-import-current">
                  <span className="text-[0.85rem] text-v5-text">
                    {progress.current} ({progress.percent}%)
                  </span>
                  <ProgressBar percent={progress.percent} />
                </div>
              ) : null}
              {progress.lines.length > 0 ? (
                <ul
                  className="m-0 list-none space-y-0.5 p-0 text-[0.85rem] text-v5-muted"
                  data-testid="batch-import-lines"
                >
                  {progress.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {promptElement}
    </Dialog>
  );
}
