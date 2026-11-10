// youtube-playlist-import (design D4, task 3.2) — map yt-dlp's flat-playlist object to the
// contract's `200` body (api-contract-freeze "YouTube playlist listing endpoint"), so the
// client never sees yt-dlp's schema. Pure. The types mirror `@autologger/contract`'s
// `YoutubePlaylistResponse` structurally: this package imports no workspace package
// (design D1 of feature-service-packages), and the route assigns one to the other, so a
// drift fails `tsc` there.

import { MAX_DURATION_SECONDS } from './ytdlp';
import { PLAYLIST_MAX_ENTRIES } from './ytdlpPlaylist';

export type PlaylistEntryReason = 'unavailable' | 'live' | 'upcoming' | 'too_long';

export interface ProjectedPlaylistEntry {
  index: number;
  video_id: string;
  url: string;
  title: string | null;
  duration_s: number | null;
  importable: boolean;
  reason: PlaylistEntryReason | null;
}

export interface ProjectedPlaylist {
  playlist: { id: string; title: string; url: string };
  entries: ProjectedPlaylistEntry[];
  truncated: boolean;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// C0, DEL and C1 (U+0000–U+001F, U+007F–U+009F).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const MAX_TITLE_UNITS = 500;
const UNAVAILABLE_TITLES: ReadonlySet<string> = new Set(['[Private video]', '[Deleted video]']);

/** Cut to at most `max` UTF-16 units without leaving half a surrogate pair. */
function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return cutUnits(raw.replace(CONTROL_CHARS, ''), MAX_TITLE_UNITS);
}

function durationOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

function reasonFor(
  title: string | null,
  liveStatus: unknown,
  duration: number | null,
): PlaylistEntryReason | null {
  if (title === null || UNAVAILABLE_TITLES.has(title)) return 'unavailable';
  if (liveStatus === 'is_live') return 'live';
  if (liveStatus === 'is_upcoming') return 'upcoming';
  // The import's download filter is `duration < 14400`, so exactly 4 hours is refused too.
  if (duration !== null && duration >= MAX_DURATION_SECONDS) return 'too_long';
  return null;
}

/** Project yt-dlp's `--flat-playlist --dump-single-json` object for list `listId`. */
export function projectPlaylist(raw: Record<string, unknown>, listId: string): ProjectedPlaylist {
  const rawEntries = Array.isArray(raw.entries) ? raw.entries.slice(0, PLAYLIST_MAX_ENTRIES) : [];
  const entries: ProjectedPlaylistEntry[] = [];
  rawEntries.forEach((item: unknown, i: number) => {
    if (item === null || typeof item !== 'object') return;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !VIDEO_ID.test(e.id)) return;
    const title = cleanTitle(e.title);
    const duration = durationOf(e.duration);
    const reason = reasonFor(title, e.live_status, duration);
    entries.push({
      index: i + 1,
      video_id: e.id,
      url: `https://www.youtube.com/watch?v=${e.id}`,
      title,
      duration_s: duration,
      importable: reason === null,
      reason,
    });
  });
  const count = typeof raw.playlist_count === 'number' ? raw.playlist_count : 0;
  return {
    playlist: {
      id: listId,
      title: typeof raw.title === 'string' ? raw.title : '',
      url: `https://www.youtube.com/playlist?list=${listId}`,
    },
    entries,
    truncated: rawEntries.length === PLAYLIST_MAX_ENTRIES && count > PLAYLIST_MAX_ENTRIES,
  };
}
