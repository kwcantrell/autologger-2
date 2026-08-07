// session-title-suffix (design D2/D3/D4) — pure title-derivation helpers for
// POST /api/sessions. No DB/IO here: the DB-touching part (fetching the show's
// existing title inventory) lives in SessionIndexStore.createSessionForShow,
// the only caller that combines these with a live title read inside the
// create-path transaction.

const EPISODE_TOKEN_RE = /^\d+$/;
const EPISODE_PAD_WIDTH = 4;
const EPISODE_PAD_MAX = 9999;

/**
 * D4 — a pure digit string with integer value <= 9999 is left-padded with
 * zeros to width 4 (`1` -> `0001`, `00001` -> `0001` [evaluated by integer
 * value, then re-padded], `9999` -> `9999`). A non-numeric token, or a number
 * > 9999 (e.g. `10000`), is returned UNCHANGED (no reformatting). `token` is
 * assumed already trimmed by the caller.
 */
export function padEpisodeToken(token: string): string {
  if (!EPISODE_TOKEN_RE.test(token)) return token;
  const n = Number(token);
  if (!Number.isFinite(n) || n > EPISODE_PAD_MAX) return token;
  return String(n).padStart(EPISODE_PAD_WIDTH, '0');
}

/**
 * D2 — `{CODE}_{YYMMDD}` from the UTC calendar date of `clockMs`. `clockMs`
 * MUST be the same create-path clock read used for
 * `started_at_utc`/`created_at_utc` — callers must not take a second clock
 * read for this (a second read could straddle a UTC-midnight rollover and
 * derive a different date than the one just persisted).
 */
export function dateSuffixBase(showCode: string, clockMs: number): string {
  const d = new Date(clockMs);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${showCode}_${yy}${mm}${dd}`;
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * D3 — max-occupied-slot+1 collision numbering. `existingTitles` must be the
 * FULL title inventory for the show (including archived/`ui_hidden` rows —
 * scoping that is the caller's job; this function only matches). Slot
 * matching is literal: `base` alone occupies slot `1`; `base` + `_` + one or
 * more ASCII digits occupies that decimal slot. Matching happens here in JS
 * (never via SQL LIKE/GLOB) specifically so a `_`/`%` that may appear inside
 * a show's code can never act as a SQL wildcard.
 */
export function allocateTitleForBase(existingTitles: Iterable<string>, base: string): string {
  const suffixRe = new RegExp(`^${escapeRegExp(base)}_([0-9]+)$`);
  let maxSlot = 0;
  for (const title of existingTitles) {
    if (title === base) {
      if (maxSlot < 1) maxSlot = 1;
      continue;
    }
    const m = suffixRe.exec(title);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > maxSlot) maxSlot = n;
  }
  if (maxSlot === 0) return base;
  // padStart never truncates, so slots >= 1000 naturally keep their full
  // decimal width (D3: "values >= 1000 use their full decimal width").
  return `${base}_${String(maxSlot + 1).padStart(3, '0')}`;
}
