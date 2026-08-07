import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { ProfilePayload } from '../../../api/types';
import { BTN_PRIMARY_SKY } from '../../../shared/theme/classnames';
import { Dialog } from '../../../shared/ui/Dialog';
import { type BatchImportProgressState, runBatchImport } from '../batchImport/runner';
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
        className="h-full bg-sky-400 [transition:width_0.15s_ease]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** Upload up-arrow icon (D8): rail `#v6-btn-batch-import` + modal header. */
function BatchImportIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-[rgba(229,238,252,0.72)]"
    >
      <path d="M12 3V15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M7 8L12 3L17 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 19H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

const EMPTY_PROGRESS: BatchImportProgressState = { current: null, percent: 0, lines: [] };

export function BatchImportModal({ profile, onClose }: Props) {
  const shows = profile?.shows ?? [];
  const defaultShowId = profile?.active_show_id ?? '';
  const queryClient = useQueryClient();

  const [showId, setShowId] = useState(defaultShowId || (shows[0]?.id ?? ''));
  const [folderName, setFolderName] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [logsUrl, setLogsUrl] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<BatchImportProgressState>(EMPTY_PROGRESS);

  const dirInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const hasAudio = Boolean(folderName && selectedFiles && selectedFiles.length > 0);
  const hasLogs = Boolean(logsUrl?.trim());
  const canStart = Boolean(showId && (hasAudio || hasLogs) && !isImporting);

  const handleClose = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    onClose();
  };

  const handleImportAudio = () => {
    dirInputRef.current?.click();
  };

  const handleImportLogs = () => {
    const raw = window.prompt('Paste a public Google Sheets URL (anyone with the link can view):');
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
    if (!hasAudio && !hasLogs) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsImporting(true);
    setProgress(EMPTY_PROGRESS);

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
          onSessionCreated: () => {
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          },
        });
      }

      if (hasLogs && logsUrl) {
        const { startLogImport, pollLogImportJob } = await import('../batchImport/logImportClient');
        setProgress((prev) => ({
          ...prev,
          current: 'Importing logs…',
          percent: hasAudio ? Math.max(prev.percent, 90) : 10,
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
      const hint =
        status === 404
          ? ' (API route missing — restart the Node server on the sheets-log-import branch, then retry)'
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
        <button
          type="button"
          className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-v5-sm border border-v5-border bg-[rgba(255,255,255,0.04)] text-[1.25rem] leading-none text-v5-muted [transition:background_0.12s_ease,color_0.12s_ease,border-color_0.12s_ease] hover-always:border-v5-border-strong hover-always:text-v5-text"
          aria-label="Close"
          onClick={handleClose}
        >
          &times;
        </button>
      </div>

      <div className="batch-import-form flex flex-col gap-3">
        <label className="field" htmlFor="bi-show">
          <span>Show</span>
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
        </label>

        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="btn self-start"
            id="bi-import-audio"
            onClick={handleImportAudio}
            disabled={isImporting}
          >
            Import Audio
          </button>
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
          <button
            type="button"
            className="btn self-start"
            id="bi-import-logs"
            onClick={handleImportLogs}
            disabled={isImporting}
          >
            Import Logs
          </button>
          {logsUrl ? (
            <span
              className="truncate text-[0.85rem] text-v5-muted"
              data-testid="batch-import-logs-url"
            >
              {logsUrl}
            </span>
          ) : null}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className={clsx('btn primary', BTN_PRIMARY_SKY)}
            id="bi-start-import"
            disabled={!canStart}
            onClick={() => void handleStartImport()}
          >
            {isImporting ? 'Importing…' : 'Start Import'}
          </button>
        </div>

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
    </Dialog>
  );
}
