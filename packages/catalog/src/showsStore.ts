// Shows CRUD + the pure per-show / per-category shaping functions the React
// app's api/types.ts expects. Moved verbatim out of catalog.ts (Catalog).

import type { Row } from '@autologger/domain';
import { normalizeEventPaletteNine, nowIso, validateEventPalettePreset } from '@autologger/domain';
import type { CatalogDb } from '@autologger/ports';

function categoriesListFromShowRow(r: Row): unknown[] {
  try {
    const raw = JSON.parse(String(r.categories_json ?? '[]'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function hexColorsFromJson(rawJson: unknown, maxCount = 9): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(String(rawJson ?? '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw.slice(0, maxCount)) {
    const s = String(x).trim();
    if (s.length === 7 && s.startsWith('#')) out.push(s.toLowerCase());
  }
  return out;
}

/** Raw `shows.title_suffix` column value → the wire's two-value enum; anything
 * other than exactly `'episode'` is treated as `'date'` (mirrors the same
 * normalization the create-path router applies — session-title-suffix D7). */
function titleSuffixApiValue(raw: unknown): 'date' | 'episode' {
  return String(raw ?? 'date')
    .trim()
    .toLowerCase() === 'episode'
    ? 'episode'
    : 'date';
}

/** _show_api_dict — the per-show shape the React app's api/types.ts expects.
 * session-title-suffix (design D1/D7, api-contract-freeze delta): emits
 * `title_suffix` and OMITS `next_episode` — the column is soft-retained in
 * SQLite but no longer a live product field (see `createShow`/
 * `updateShowFields` below and `0005_show_title_suffix.sql`). */
export function showApiDict(r: Row): Record<string, unknown> {
  const pal = normalizeEventPaletteNine(hexColorsFromJson(r.event_palette_json));
  const presetRaw = String(r.event_palette_preset ?? '')
    .trim()
    .toLowerCase();
  const preset = validateEventPalettePreset(presetRaw || 'custom');
  const customRaw = hexColorsFromJson(r.event_palette_custom_json);
  const custom = customRaw.length === 0 ? [...pal] : normalizeEventPaletteNine(customRaw);
  return {
    id: String(r.id),
    studio_id: String(r.studio_id),
    name: String(r.name),
    show_code: String(r.show_code),
    title_suffix: titleSuffixApiValue(r.title_suffix),
    categories: categoriesListFromShowRow(r),
    event_palette: pal,
    event_palette_preset: preset,
    event_palette_custom: custom,
  };
}

/** The SLIM per-show shape `/api/profile` emits for every show in every studio
 * the caller can reach (profile-shows-slimming): identity plus the only field
 * an always-loaded surface branches on. `title_suffix` is REQUIRED here —
 * NewSessionModal decides whether to ask for an episode number the moment a
 * show is selected, with no further fetch.
 *
 * Everything else `showApiDict` emits (categories + the three palette fields)
 * is per-show configuration read only by modals, and is now fetched on demand
 * from `GET /api/shows?studio_id=…` / `GET /api/shows/:showId`, both of which
 * still emit the full `showApiDict` shape. */
export function showBriefApiDict(r: Row): Record<string, unknown> {
  return {
    id: String(r.id),
    studio_id: String(r.studio_id),
    name: String(r.name),
    show_code: String(r.show_code),
    title_suffix: titleSuffixApiValue(r.title_suffix),
  };
}

/** _dropdown_options_api_shape. */
function dropdownOptionsApiShape(raw: unknown): Array<{ label: string; needs_context: boolean }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; needs_context: boolean }> = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const lab = item.trim();
      if (lab) out.push({ label: lab, needs_context: false });
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const lab = String(o.label ?? o.name ?? '').trim();
      if (lab) out.push({ label: lab, needs_context: Boolean(o.needs_context ?? false) });
    }
  }
  return out;
}

/** _show_categories_api_shape — label/color/type/dropdown_options/on-off for the browser. */
export function showCategoriesApiShape(rawCategories: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rawCategories)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const c of rawCategories) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const lab = String(o.label ?? o.name ?? '').trim() || '—';
    const type = String(o.type ?? 'BUTTON').toUpperCase();
    out.push({
      id: String(o.id ?? ''),
      label: lab,
      color: String(o.color ?? '#7cb7ff'),
      type,
      dropdown_options: type === 'DROPDOWN' ? dropdownOptionsApiShape(o.dropdown_options) : [],
      on_label: String(o.on_label ?? ''),
      off_label: String(o.off_label ?? ''),
    });
  }
  return out;
}

/** Consumption-based facade surface (persistence-package-extraction design D3 /
 * spec "Persistence facades are consumed through package-exported interfaces"):
 * exactly the four members reached externally via `catalog.shows.x()` in
 * `server/src` (routers + `test/helpers.ts`). Property-style function types so
 * `strictFunctionTypes` checks members contravariantly — a concrete signature
 * that drifts (e.g. a narrowed parameter type) fails `tsc --noEmit`. */
export interface ShowsStoreFacade {
  getShowRow: (showId: string) => Row | null;
  listShowsForStudio: (studioId: string) => Row[];
  createShow: (opts: {
    studioId: string;
    name: string;
    showCode: string;
    categoriesJson: string;
    paletteJson: string;
    paletteCustomJson: string;
  }) => string;
  updateShowFields: (
    showId: string,
    fields: {
      name?: string;
      show_code?: string;
      next_episode?: number;
      /** session-title-suffix (design D1/D7): 'date' | 'episode'. Any other
       * value normalizes to 'date' (matches `titleSuffixApiValue`). */
      title_suffix?: string;
      categories_json?: string;
      event_palette_json?: string;
      event_palette_preset?: string;
      event_palette_custom_json?: string;
    },
  ) => boolean;
}

export class ShowsStore implements ShowsStoreFacade {
  constructor(private db: CatalogDb) {}

  getShowRow(showId: string): Row | null {
    return this.db.first<Row>('SELECT * FROM shows WHERE id = ?', showId);
  }

  listShowsForStudio(studioId: string): Row[] {
    return this.db.all<Row>(
      'SELECT * FROM shows WHERE studio_id = ? ORDER BY name COLLATE NOCASE ASC',
      studioId,
    );
  }

  createShow(opts: {
    studioId: string;
    name: string;
    showCode: string;
    categoriesJson: string;
    paletteJson: string;
    paletteCustomJson: string;
  }): string {
    const sid = crypto.randomUUID();
    // next_episode is soft-retained but UNUSED as of session-title-suffix
    // (design D1, gate ruling 2026-08-02) — left at its column default (1)
    // and never bumped (see sessionIndexStore.ts createSessionIndex). The
    // INSERT omits title_suffix so newly created shows pick up the column
    // default 'date' (0005_show_title_suffix.sql, design D7).
    this.db.run(
      `INSERT INTO shows
         (id, studio_id, name, show_code, next_episode, categories_json,
          event_palette_json, event_palette_preset, event_palette_custom_json, created_at_utc)
       VALUES (?, ?, ?, ?, 1, ?, ?, 'custom', ?, ?)`,
      sid,
      opts.studioId,
      opts.name.trim(),
      opts.showCode.trim().toUpperCase(),
      opts.categoriesJson,
      opts.paletteJson,
      opts.paletteCustomJson,
      nowIso(),
    );
    return sid;
  }

  updateShowFields(
    showId: string,
    fields: {
      name?: string;
      show_code?: string;
      next_episode?: number;
      /** session-title-suffix (design D1/D7): 'date' | 'episode'. Any other
       * value normalizes to 'date' (matches `titleSuffixApiValue` above /
       * the create-path router). */
      title_suffix?: string;
      categories_json?: string;
      event_palette_json?: string;
      event_palette_preset?: string;
      event_palette_custom_json?: string;
    },
  ): boolean {
    // Read-modify-write: the merge reads the current row, so the pair runs in
    // one transaction (CatalogDb.tx nests as a savepoint under outer tx()).
    return this.db.tx(() => {
      const row = this.getShowRow(showId);
      if (row === null) return false;
      // fields.next_episode (below) is soft-retained but UNUSED as of
      // session-title-suffix (design D1, gate ruling 2026-08-02) — the
      // column stays writable here for rollback safety; product code no
      // longer treats it as a live counter (no create-path bump; see
      // sessionIndexStore.ts). The profile router (profile.ts) no longer
      // reads a wire `next_episode` into this field — legacy clients that
      // still send it are ignored/stripped at the schema boundary (D8).
      const nm = fields.name !== undefined ? fields.name.trim() : String(row.name);
      const sc =
        fields.show_code !== undefined
          ? fields.show_code.trim().toUpperCase()
          : String(row.show_code ?? '')
              .trim()
              .toUpperCase();
      const ne =
        fields.next_episode !== undefined ? fields.next_episode : Number(row.next_episode) || 1;
      const ts =
        fields.title_suffix !== undefined
          ? titleSuffixApiValue(fields.title_suffix)
          : titleSuffixApiValue(row.title_suffix);
      const cj = fields.categories_json ?? String(row.categories_json ?? '[]');
      const pj = fields.event_palette_json ?? String(row.event_palette_json ?? '[]');
      const pp =
        fields.event_palette_preset !== undefined
          ? fields.event_palette_preset.trim().toLowerCase()
          : String(row.event_palette_preset ?? 'custom')
              .trim()
              .toLowerCase() || 'custom';
      const pcj = fields.event_palette_custom_json ?? String(row.event_palette_custom_json ?? '[]');
      this.db.run(
        `UPDATE shows
           SET name = ?, show_code = ?, next_episode = ?, title_suffix = ?, categories_json = ?,
               event_palette_json = ?, event_palette_preset = ?, event_palette_custom_json = ?
         WHERE id = ?`,
        nm,
        sc,
        ne,
        ts,
        cj,
        pj,
        pp,
        pcj,
        showId,
      );
      return true;
    });
  }
}
