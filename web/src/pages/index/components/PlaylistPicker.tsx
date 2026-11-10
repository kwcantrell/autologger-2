import clsx from 'clsx';
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  YoutubePlaylistEntry,
  YoutubePlaylistResponse,
  YoutubePlaylistUnavailableReason,
} from '../../../api/types';
import { Button } from '../../../shared/components/ui/button';
import { Input } from '../../../shared/components/ui/input';

// youtube-playlist-import D5 (batch-audio-import "YouTube playlist selection"): the loaded
// listing with checkboxes, Select all/none, a From/To range, the checked count, "Use publish
// date" and the truncated notice. Plain checkboxes in a scrollable list whose rows are
// `content-visibility: auto`, so a 5000-entry listing is not laid out off screen; the selection is
// one Set of positions, so Select all and the range are one state update.

export interface PlaylistSelection {
  /** Checked positions, in playlist order. */
  indexes: number[];
  usePublishDate: boolean;
}

interface Props {
  listing: YoutubePlaylistResponse;
  /** A run is in progress: every control is disabled. */
  disabled: boolean;
  onChange: (selection: PlaylistSelection) => void;
}

const REASON_LABEL: Record<YoutubePlaylistUnavailableReason, string> = {
  unavailable: 'unavailable',
  live: 'live now',
  upcoming: 'upcoming',
  too_long: 'over 4 hours',
};

export function formatPlaylistDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function importableIndexes(listing: YoutubePlaylistResponse): Set<number> {
  return new Set(listing.entries.filter((e) => e.importable).map((e) => e.index));
}

const PlaylistRow = memo(function PlaylistRow({
  entry,
  checked,
  disabled,
  onToggle,
}: {
  entry: YoutubePlaylistEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: (index: number) => void;
}) {
  const title = entry.title ?? 'Unavailable video';
  return (
    <li
      className={clsx(
        'flex items-center gap-2 px-1 py-0.5 text-[0.85rem]',
        entry.importable ? 'text-v5-text' : 'text-v5-muted opacity-60',
      )}
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 1.75rem' }}
      data-importable={entry.importable ? 'true' : 'false'}
    >
      <input
        type="checkbox"
        className="size-4 shrink-0 accent-primary"
        aria-label={`${entry.index}. ${title}`}
        data-position={entry.index}
        checked={checked}
        disabled={disabled || !entry.importable}
        onChange={() => {
          // A disabled box never toggles, even where a synthetic click reaches it (jsdom).
          if (!disabled && entry.importable) onToggle(entry.index);
        }}
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-v5-muted">{entry.index}.</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {entry.reason ? (
        <span className="shrink-0 text-[0.8rem] italic">{REASON_LABEL[entry.reason]}</span>
      ) : null}
      <span className="w-16 shrink-0 text-right tabular-nums text-v5-muted">
        {formatPlaylistDuration(entry.duration_s)}
      </span>
    </li>
  );
});

export function PlaylistPicker({ listing, disabled, onChange }: Props) {
  // A new listing replaces the rows and resets the selection to its importable entries.
  const [shownListing, setShownListing] = useState(listing);
  const [selected, setSelected] = useState<Set<number>>(() => importableIndexes(listing));
  if (shownListing !== listing) {
    setShownListing(listing);
    setSelected(importableIndexes(listing));
  }
  const [usePublishDate, setUsePublishDate] = useState(true);
  const fromId = useId();
  const toId = useId();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const indexes = shownListing.entries.filter((e) => selected.has(e.index)).map((e) => e.index);
    onChangeRef.current({ indexes, usePublishDate });
  }, [shownListing, selected, usePublishDate]);

  const toggle = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const applyRange = () => {
    const last = listing.entries.at(-1)?.index ?? 0;
    const lo = from.trim() === '' ? 1 : Number(from);
    const hi = to.trim() === '' ? last : Number(to);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    setSelected(
      new Set(
        listing.entries
          .filter((e) => e.importable && e.index >= lo && e.index <= hi)
          .map((e) => e.index),
      ),
    );
  };

  const count = listing.entries.length;
  return (
    <div className="flex flex-col gap-2" data-testid="playlist-picker">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold text-v5-text">{listing.playlist.title}</span>
        <span className="text-[0.85rem] text-v5-muted">
          {count === 1 ? '1 video' : `${count} videos`}
        </span>
      </div>
      {listing.truncated ? (
        <p className="m-0 text-[0.85rem] text-v5-muted" role="note">
          This playlist is longer: only the first 5000 videos are shown.
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setSelected(importableIndexes(listing))}
        >
          Select all
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setSelected(new Set())}
        >
          Select none
        </Button>
        <label htmlFor={fromId} className="flex items-center gap-1 text-[0.85rem] text-v5-muted">
          From
          <Input
            id={fromId}
            type="number"
            inputMode="numeric"
            min={1}
            className="w-20"
            value={from}
            disabled={disabled}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label htmlFor={toId} className="flex items-center gap-1 text-[0.85rem] text-v5-muted">
          To
          <Input
            id={toId}
            type="number"
            inputMode="numeric"
            min={1}
            className="w-20"
            value={to}
            disabled={disabled}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <Button variant="outline" size="sm" disabled={disabled} onClick={applyRange}>
          Apply range
        </Button>
      </div>
      <ul className="m-0 max-h-64 list-none overflow-y-auto p-0" aria-label="Playlist videos">
        {listing.entries.map((entry) => (
          <PlaylistRow
            key={entry.index}
            entry={entry}
            checked={selected.has(entry.index)}
            disabled={disabled}
            onToggle={toggle}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.85rem]">
        <span className="text-v5-muted" data-testid="playlist-selected-count">
          {selected.size} of {count} selected
        </span>
        <label className="flex items-center gap-2 text-v5-text">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={usePublishDate}
            disabled={disabled}
            onChange={(e) => setUsePublishDate(e.target.checked)}
          />
          Use publish date
        </label>
      </div>
    </div>
  );
}
