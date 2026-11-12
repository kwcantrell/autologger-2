import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  autogenerateKeys,
  useAutogenerateJobs,
  useAutogeneratePreview,
} from '../../../api/hooks/useAutogenerateJobs';
import { useProviders } from '../../../api/hooks/useProviders';
import { showAccessFrom } from '../../../api/hooks/useShowAccess';
import type {
  AutogenerateBlocked,
  AutogenerateJobListResponse,
  AutogenerateScopeBody,
  AutogenerateStep,
  AutogenerateWikiMode,
  ProfilePayload,
  YoutubePlaylistResponse,
} from '../../../api/types';
import { Button, TOUCH_TARGET } from '../../../shared/components/ui/button';
import { Checkbox } from '../../../shared/components/ui/checkbox';
import { Field, FieldLabel } from '../../../shared/components/ui/field';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../../shared/ui/Dialog';
import { useTextPrompt } from '../../../shared/ui/PromptDialog';
import {
  autogenerateMayHaveStarted,
  startAutogenerateAfterImport,
} from '../batchImport/autogenerateAfterImport';
import { playlistSessionNames } from '../batchImport/playlistNames';
import {
  listPlaylistEntries,
  readProfile,
  readShowSessions,
  runPlaylistImport,
} from '../batchImport/playlistRunner';
import {
  type BatchImportProgressState,
  formatErrorDetail,
  isAbortError,
  runBatchImport,
} from '../batchImport/runner';
import {
  AutogenerateConfirmMessage,
  AutogenerateOptions,
} from './autogenerate/AutogenerateOptions';
import {
  BLOCKED_TEXT,
  blockedFromProviders,
  defaultAutogenerateSteps,
  maxRuns,
  orderedSteps,
  useDebounced,
} from './autogenerate/autogenerateModel';
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

// playlist-import-autogenerate (batch-audio-import "YouTube playlist import can autogenerate
// afterwards"): one batch job after the run over the sessions its playlist part brought in.
/** The job's session cap (`AUTOGENERATE_MAX_SESSIONS`). */
const AUTOGENERATE_MAX_VIDEOS = 1000;
/** How long the confirm waits for the team's job list before opening without the warning. */
const JOB_LIST_WAIT_MS = 5_000;
const RECHECK_SENTENCE = 'Your providers are checked again when the import ends.';
const LIVE_JOB_WARNING =
  'A batch job is already running for this team; autogenerate after this import will not start unless it has finished by then.';

/** The up-front check for the current selection (design D6). Only `block` stops Start Import;
 * `unknown` (the preview could not answer) falls back to a provider-derived warning. */
type AutogenerateVerdict =
  | { kind: 'off' }
  | { kind: 'pending' }
  | { kind: 'clear' }
  | { kind: 'block'; reason: AutogenerateBlocked }
  | { kind: 'unknown' };

/** Whether the team's job list (read just before the confirm) holds a live job; false when the
 * read fails or does not answer in time (owner decision 6: it only warns). */
async function hasLiveJob(
  refetch: () => Promise<{ status: string; data?: AutogenerateJobListResponse }>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), JOB_LIST_WAIT_MS);
  });
  try {
    const r = await Promise.race([refetch(), timeout]);
    if (r === null || r.status !== 'success') return false;
    return (r.data?.jobs ?? []).some((j) => j.status === 'queued' || j.status === 'running');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
  // The "Autogenerate after import" group (design D11): reset whenever the group is hidden.
  const [agTicked, setAgTicked] = useState(false);
  const [agSteps, setAgSteps] = useState<Set<AutogenerateStep>>(defaultAutogenerateSteps);
  const [agMode, setAgMode] = useState<AutogenerateWikiMode>('accept');
  const resetAutogenerate = () => {
    setAgTicked(false);
    setAgSteps(defaultAutogenerateSteps());
    setAgMode('accept');
  };
  const { confirm, confirmElement } = useConfirm();

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

  // Design D7: only an owner or admin of the modal's team (the active one) sees the group.
  const teamId = profile?.active_studio_id ?? '';
  const teamRole = profile?.auth?.user?.teams?.find((t) => t.id === teamId)?.role;
  const canAutogenerate = teamRole === 'owner' || teamRole === 'admin';
  const groupShown = canAutogenerate && playlist !== null;
  const armed = groupShown && agTicked && playlistSelection.indexes.length > 0;
  const runSteps = orderedSteps(agSteps);
  const checkedCount = playlistSelection.indexes.length;
  const tooMany = checkedCount > AUTOGENERATE_MAX_VIDEOS;

  // Up-front check (design D6): the preview over the run's show, debounced like Settings. Only
  // an answer for the current body counts; the hook's placeholder (previous) answer never does.
  const checkOn = armed && runSteps.length > 0 && !isImporting && showId !== '';
  const agBodyKey = checkOn ? JSON.stringify([showId, runSteps, agMode]) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the body's content
  const agBody = useMemo<AutogenerateScopeBody | null>(
    () => (checkOn ? { show_ids: [showId], steps: runSteps, wiki_mode: agMode } : null),
    [agBodyKey],
  );
  const agDebounced = useDebounced(agBody, 400);
  const agPreview = useAutogeneratePreview(teamId, agDebounced, checkOn);
  let verdict: AutogenerateVerdict = { kind: 'off' };
  if (checkOn) {
    if (agDebounced !== agBody || agPreview.isPlaceholderData) verdict = { kind: 'pending' };
    else if (agPreview.isSuccess) {
      const blocked = agPreview.data.blocked;
      verdict = blocked === null ? { kind: 'clear' } : { kind: 'block', reason: blocked };
    } else if (agPreview.isError) verdict = { kind: 'unknown' };
    else verdict = { kind: 'pending' };
  }
  const verdictRef = useRef(verdict);
  verdictRef.current = verdict;
  const providers = useProviders({ enabled: verdict.kind === 'unknown' });
  const warning =
    verdict.kind === 'unknown' && providers.data
      ? blockedFromProviders(runSteps, providers.data)
      : null;
  // The live-job warning's list (design D10): enabled only while armed, read again at Start.
  const jobList = useAutogenerateJobs(teamId, armed, false);

  const agReason = !armed
    ? null
    : runSteps.length === 0
      ? 'Pick at least one step.'
      : tooMany
        ? `Autogenerate after import covers at most ${AUTOGENERATE_MAX_VIDEOS} videos; check fewer videos or untick it.`
        : verdict.kind === 'pending'
          ? 'Checking your providers…'
          : verdict.kind === 'block'
            ? BLOCKED_TEXT[verdict.reason]
            : null;
  const agNote =
    agReason ?? (armed && warning ? `${BLOCKED_TEXT[warning]} ${RECHECK_SENTENCE}` : null);
  const canStart = Boolean(
    showId && (hasAudio || hasPlaylist || hasLogs) && !isImporting && agReason === null,
  );

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
    resetAutogenerate();
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

    // With autogenerate armed: the team's job list, then one confirm, then the current verdict
    // once more (design D6, D9, D10); the confirmed choice and user are fixed for the run (D12).
    let autogenerate: {
      teamId: string;
      steps: AutogenerateStep[];
      wikiMode: AutogenerateWikiMode;
      confirmedUserId: string;
      runStudio: string;
    } | null = null;
    if (armed) {
      const steps = runSteps;
      const wikiMode = agMode;
      const live = await hasLiveJob(() => jobList.refetch());
      const ok = await confirm({
        title: 'Import and autogenerate',
        message: (
          <AutogenerateConfirmMessage
            lead={[
              ...(live ? [LIVE_JOB_WARNING] : []),
              `Import ${checkedCount} videos, then autogenerate on up to ${checkedCount} sessions, at most ${maxRuns(checkedCount, steps)} runs.`,
              'Only videos this import brings in are included.',
            ]}
            trailing={[RECHECK_SENTENCE]}
            mode={wikiMode}
            wiki={steps.includes('wiki')}
          />
        ),
        confirmLabel: 'Start',
      });
      if (!ok) return;
      const now = verdictRef.current.kind;
      if (now === 'block' || now === 'pending') return;
      autogenerate = {
        teamId,
        steps,
        wikiMode,
        confirmedUserId: profile.auth?.user?.id ?? '',
        runStudio: profile.active_studio_id,
      };
    }
    const importedIds: string[] = [];

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
            ...(autogenerate ? { onSessionImported: (id: string) => importedIds.push(id) } : {}),
          });
        }

        if (hasLogs && logsUrl) {
          const { startLogImport, pollLogImportJob } = await import(
            '../batchImport/logImportClient'
          );
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
      }

      // Design D3: after the last part, also when a part ended with a Failed line; never after an
      // abort. Its lines follow every import line and never change them.
      if (autogenerate && !controller.signal.aborted) {
        const run = autogenerate;
        const lines = await startAutogenerateAfterImport({
          teamId: run.teamId,
          sessionIds: importedIds,
          steps: run.steps,
          wikiMode: run.wikiMode,
          confirmedUserId: run.confirmedUserId,
          readProfile,
          listShowSessionIds: async (signal) =>
            (await readShowSessions(showId, run.runStudio, signal)).sessions.map((s) => s.id),
          signal: controller.signal,
        });
        if (lines.length > 0 && !controller.signal.aborted) mergeLines(lines);
        if (autogenerateMayHaveStarted(lines)) {
          void queryClient.invalidateQueries({ queryKey: autogenerateKeys.all(run.teamId) });
        }
      }
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
      // Design D13: during a run, Escape and a click outside do not close (and abort) it; the
      // Close control still does.
      onOpenChange={(o) => {
        if (!o && !isImporting) handleClose();
      }}
      closeOnOverlayClick={!isImporting}
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
          {groupShown ? (
            <div className="flex flex-col gap-3 pt-1" data-testid="batch-import-autogenerate">
              <Field orientation="horizontal">
                <Checkbox
                  id="bi-autogenerate"
                  aria-label="Autogenerate after import"
                  checked={agTicked}
                  disabled={isImporting}
                  onCheckedChange={(next) => setAgTicked(next === true)}
                />
                <FieldLabel htmlFor="bi-autogenerate" className="font-normal">
                  Autogenerate after import
                </FieldLabel>
              </Field>
              {agTicked ? (
                <AutogenerateOptions
                  idPrefix="bi-autogenerate"
                  steps={agSteps}
                  onStepsChange={setAgSteps}
                  mode={agMode}
                  onModeChange={setAgMode}
                  disabled={isImporting}
                />
              ) : null}
              {agNote ? (
                <span
                  className="text-[0.85rem] text-v5-muted"
                  role="status"
                  data-testid="batch-import-autogenerate-note"
                >
                  {agNote}
                </span>
              ) : null}
            </div>
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
      {confirmElement}
    </Dialog>
  );
}
