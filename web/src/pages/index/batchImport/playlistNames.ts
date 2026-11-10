import type { YoutubePlaylistEntry } from '../../../api/types';

// youtube-playlist-import D6 (batch-audio-import "YouTube playlist session naming"): one session
// name per titled entry, used as both `episode` and `title`. Lengths count UTF-16 code units, as
// the create schema's `episode: z.string().max(80)` does. Names are computed over the whole
// listing, so they never depend on the selection or on positions.

/** The create schema's `episode` limit, in UTF-16 code units. */
export const SESSION_NAME_MAX_UNITS = 80;
/** ` [<11-character video id>]`. */
const ID_SUFFIX_UNITS = 14;

// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing them is the point.
const CONTROL_OR_LINE_SEPARATOR = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/** Cut to at most `max` UTF-16 units, dropping a surrogate pair that would straddle the cut. */
function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Step 1: NFC, control characters and U+2028/U+2029 to spaces, whitespace collapsed, trimmed. */
function baseOf(title: string): string {
  return title.normalize('NFC').replace(CONTROL_OR_LINE_SEPARATOR, ' ').replace(/\s+/g, ' ').trim();
}

/** `Map<index, name>` for every entry with a title; untitled entries get no name. */
export function playlistSessionNames(
  entries: readonly YoutubePlaylistEntry[],
): Map<number, string> {
  const plain = new Map<number, { base: string; plain: string; videoId: string }>();
  const uses = new Map<string, number>();
  for (const e of entries) {
    if (e.title === null) continue;
    const base = baseOf(e.title);
    const name =
      base === '' ? `YouTube ${e.video_id}` : cutUnits(base, SESSION_NAME_MAX_UNITS).trimEnd();
    plain.set(e.index, { base, plain: name, videoId: e.video_id });
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  const names = new Map<number, string>();
  for (const [index, p] of plain) {
    if ((uses.get(p.plain) ?? 0) < 2) {
      names.set(index, p.plain);
      continue;
    }
    const head = cutUnits(p.base, SESSION_NAME_MAX_UNITS - ID_SUFFIX_UNITS).trimEnd();
    names.set(index, `${head} [${p.videoId}]`);
  }
  return names;
}
