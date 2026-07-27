import clsx from 'clsx';
import { useRef, useState } from 'react';
import type { ProfilePayload } from '../../../api/types';
import { BTN_PRIMARY_SKY } from '../../../shared/theme/classnames';
import { Dialog } from '../../../shared/ui/Dialog';
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
      <title>Batch import</title>
      <path d="M12 3V15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M7 10L12 15L17 10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 19H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function BatchImportModal({ profile, onClose }: Props) {
  const shows = profile?.shows ?? [];
  const defaultShowId = profile?.active_show_id ?? '';

  const [showId, setShowId] = useState(defaultShowId || (shows[0]?.id ?? ''));
  const [folderName, setFolderName] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);

  const dirInputRef = useRef<HTMLInputElement>(null);

  const canStart = Boolean(showId && folderName && selectedFiles && selectedFiles.length > 0);

  const handleImportAudio = () => {
    dirInputRef.current?.click();
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    setSelectedFiles(files);
    setFolderName(folderNameFromFiles(files));
  };

  const handleStartImport = () => {
    // Phase 4 wires the client import runner here.
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
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
          onClick={onClose}
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
            disabled={shows.length === 0}
          />
        </label>

        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="btn self-start"
            id="bi-import-audio"
            onClick={handleImportAudio}
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
            <span
              className="text-[0.85rem] text-v5-muted"
              data-testid="batch-import-folder-name"
            >
              {folderName}
            </span>
          ) : null}
        </div>

        <button type="button" className="btn self-start" id="bi-import-logs">
          Import Logs
        </button>

        <div className="modal-actions">
          <button
            type="button"
            className={clsx('btn primary', BTN_PRIMARY_SKY)}
            id="bi-start-import"
            disabled={!canStart}
            onClick={handleStartImport}
          >
            Start Import
          </button>
        </div>

        <div
          id="batch-import-progress"
          className="min-h-0"
          data-testid="batch-import-progress"
          aria-live="polite"
        />
      </div>
    </Dialog>
  );
}
