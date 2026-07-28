// Shared "meta line" date formatter for session cards/rows (extracted from
// the verbatim-duplicated `fmtDateOnly` in HomeRoute.tsx and
// RecentSessionsList.tsx — youtube-audio-import, task 4.2; design D4).
//
// Two input shapes hit this function, and they need DIFFERENT treatment:
//
//   1. A bare date-only `episode_date` — `YYYY-MM-DD`, no time component
//      (server: catalog `sessions.episode_date`, an un-shifted calendar day
//      per D4). This represents a calendar day, not an instant, so it must
//      render on its literal Y/M/D regardless of the viewer's timezone.
//   2. A full-timestamp `created_at_utc` fallback (used when `episode_date`
//      is null) — a real instant, correctly rendered by converting UTC to
//      the viewer's local zone (unchanged behavior).
//
// The bug this fixes: `new Date("2024-01-15")` parses as UTC midnight per
// the ES spec's date-time string format, and `toLocaleDateString` then
// renders that instant in the viewer's local zone — for any negative-UTC-offset
// viewer (the Americas), UTC midnight Jan 15 is still Jan 14 locally, so the
// episode date silently shifts back a day.
//
// Fix: for the bare-date shape, construct the `Date` from the individual
// year/month/day components instead of parsing the ISO string. The
// component-args `Date` constructor interprets its inputs as LOCAL time (no
// UTC anchor), so the resulting instant's calendar day is the literal
// Y/M/D regardless of the viewer's offset — while still routing through
// `toLocaleDateString` with the same options as the timestamp path, so both
// shapes keep identical, locale-aware output formatting.
const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DATE_FORMAT_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
};

/**
 * Format a session-card meta-line date. Accepts either a bare `YYYY-MM-DD`
 * (rendered on its literal calendar day, no timezone shift) or a full ISO
 * timestamp (rendered as a local-zone instant, same as before). Returns `''`
 * for an empty/nullish input and echoes back anything unparseable.
 *
 * `null` is in the parameter type because both callers pass
 * `episode_date ?? created_at_utc` and **both** of those are nullable on the
 * wire (web-api-shape-conformance audit CW-9 corrected `created_at_utc`, which
 * the client had declared `string`). The empty-input branch already handled
 * this at runtime — the signature now says so, rather than a caller inventing
 * a placeholder date to satisfy the old type.
 */
export function fmtDateOnly(iso: string | null | undefined): string {
  if (!iso) return '';

  const bareMatch = BARE_DATE_RE.exec(iso);
  if (bareMatch) {
    const [, y, m, d] = bareMatch;
    // Local-time construction (NOT `new Date(iso)`) — see module header.
    const local = new Date(Number(y), Number(m) - 1, Number(d));
    if (Number.isNaN(local.getTime())) return iso;
    return local.toLocaleDateString(undefined, DATE_FORMAT_OPTS);
  }

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, DATE_FORMAT_OPTS);
}
