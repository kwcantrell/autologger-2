// Studio profiles, categories, palette helpers — ported from src/autologger/studio.py.
// Pure functions + built-in constants only. The DB-backed studio *registry* merge
// (built-ins + studio_definitions rows) lives in db/catalog.ts.

/** Thrown by validators on bad input; routers map this to HTTP 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export type CategoryKind = 'BUTTON' | 'DROPDOWN' | 'TEXT' | 'ON_OFF';

/** Live category as exposed to the browser (studio_to_api_dict shape). */
export interface CategoryDef {
  id: string;
  label: string;
  color: string;
  kind: CategoryKind;
  dropdown_options: string[];
  on_label: string;
  off_label: string;
}

export interface StudioProfile {
  id: string;
  name: string;
  categories: CategoryDef[];
  show_title_format: string;
  default_frame_rate: number;
}

/** Stored/normalized dropdown option (validate_categories_list output shape). */
export interface DropdownOptionRecord {
  label: string;
  needs_context: boolean;
  /** Optional per-option generation instruction (trimmed; omitted when empty). */
  auto_instruction?: string;
}

/** Stored/normalized category record (validate_categories_list output shape). */
export interface CategoryRecord {
  id: string;
  name: string;
  color: string;
  type: CategoryKind;
  dropdown_options: DropdownOptionRecord[];
  on_label: string;
  off_label: string;
  /** Optional generation instruction (trimmed; omitted when empty; never on ON_OFF). */
  auto_instruction?: string;
}

export interface SettingsBlob {
  categories: CategoryRecord[];
  show_title_format: string;
  default_frame_rate: number;
}

export const SETTING_ACTIVE_STUDIO = 'active_studio_id';
export const SETTING_ACTIVE_SHOW = 'active_show_id';
export const STUDIO_CONFIG_PREFIX = 'studio_config:';

// Built-in teams shipped with the product (always present; merged with DB-defined teams).
export const BUILTIN_STUDIO_ORDER: readonly string[] = ['test-studios', 'test-studio-2'];
export const BUILTIN_STUDIO_NAMES: Record<string, string> = {
  'test-studios': 'Test Studio',
  'test-studio-2': 'Test Studio 2',
};
export const DEFAULT_STUDIO_ID = 'test-studios';

export const LEGACY_STUDIO_MAP: Record<string, string> = {
  'test-studios-admin': 'test-studios',
  'docu-field': 'test-studios',
  'stream-ops': 'test-studio-2',
};

const COLOR_HEX = /^#[0-9A-Fa-f]{6}$/;

const DEFAULT_EVENT_PALETTE: readonly string[] = [
  '#64748b',
  '#e53935',
  '#fb8c00',
  '#fdd835',
  '#43a047',
  '#00acc1',
  '#1e88e5',
  '#8e24aa',
  '#ec407a',
];

const EVENT_PALETTE_PRESET_KEYS = new Set(['custom', 'default', 'neon', 'desert', 'aqua']);

function newId(): string {
  return crypto.randomUUID();
}

function normalizeDropdownOptionEntry(
  item: unknown,
  catName: string,
  idx: number,
): DropdownOptionRecord {
  if (typeof item === 'string') {
    const lab = item.trim();
    if (!lab)
      throw new ValidationError(`Category “${catName}”: dropdown option ${idx + 1} is empty.`);
    return { label: lab, needs_context: false };
  }
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    const lab = String(o.label ?? o.name ?? '').trim();
    if (!lab)
      throw new ValidationError(`Category “${catName}”: dropdown option ${idx + 1} needs a label.`);
    const instr = String(o.auto_instruction ?? '').trim();
    return {
      label: lab,
      needs_context: Boolean(o.needs_context ?? false),
      ...(instr ? { auto_instruction: instr } : {}),
    };
  }
  throw new ValidationError(`Category “${catName}”: dropdown option ${idx + 1} is invalid.`);
}

/** Up to 9 #RRGGBB colors for per-show event button defaults. Throws ValidationError. */
export function validateEventPalette(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [...DEFAULT_EVENT_PALETTE];
  if (!Array.isArray(raw)) throw new ValidationError('Event palette must be a list of colors.');
  const out: string[] = [];
  raw.slice(0, 9).forEach((x, i) => {
    const hx = String(x).trim();
    if (!COLOR_HEX.test(hx))
      throw new ValidationError(`Event palette color ${i + 1} must be #RRGGBB.`);
    out.push(hx.toLowerCase());
  });
  if (out.length === 0) return [...DEFAULT_EVENT_PALETTE];
  return out;
}

export function validateEventPalettePreset(raw: unknown): string {
  const v = String(raw ?? 'custom')
    .trim()
    .toLowerCase();
  return EVENT_PALETTE_PRESET_KEYS.has(v) ? v : 'custom';
}

/** Exactly nine #RRGGBB colors; pads from defaults when needed. */
export function normalizeEventPaletteNine(raw: unknown): string[] {
  const base = validateEventPalette(raw);
  const out = base.slice(0, 9);
  let i = 0;
  while (out.length < 9) {
    out.push(DEFAULT_EVENT_PALETTE[i % DEFAULT_EVENT_PALETTE.length]);
    i += 1;
  }
  return out.slice(0, 9);
}

export function studioConfigKey(studioId: string): string {
  return `${STUDIO_CONFIG_PREFIX}${studioId}`;
}

function defaultCategoriesForNewStudio(studioId: string): CategoryRecord[] {
  if (studioId === 'test-studio-2') {
    return [
      {
        id: newId(),
        name: 'Note',
        color: '#7cb7ff',
        type: 'TEXT',
        dropdown_options: [],
        on_label: '',
        off_label: '',
      },
      {
        id: newId(),
        name: 'Mark',
        color: '#f4a82e',
        type: 'BUTTON',
        dropdown_options: [],
        on_label: '',
        off_label: '',
      },
    ];
  }
  return [
    {
      id: newId(),
      name: 'Scene',
      color: '#4a9fd4',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
    },
    {
      id: newId(),
      name: 'Audio issue',
      color: '#a86bdc',
      type: 'DROPDOWN',
      dropdown_options: [
        { label: 'Lav', needs_context: false },
        { label: 'Boom', needs_context: false },
      ],
      on_label: '',
      off_label: '',
    },
    {
      id: newId(),
      name: 'Note',
      color: '#6bcf7a',
      type: 'TEXT',
      dropdown_options: [],
      on_label: '',
      off_label: '',
    },
  ];
}

export function defaultSettingsBlob(studioId: string): SettingsBlob {
  return {
    categories: defaultCategoriesForNewStudio(studioId),
    show_title_format: '',
    default_frame_rate: 24.0,
  };
}

/** Validate a log category list (same rules as studio settings). Throws ValidationError. */
export function validateCategoriesList(catsRaw: unknown): CategoryRecord[] {
  if (!Array.isArray(catsRaw) || catsRaw.length === 0) {
    throw new ValidationError('Add at least one log category.');
  }
  const categories: CategoryRecord[] = [];
  const seenIds = new Set<string>();
  catsRaw.forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new ValidationError(`Category ${i + 1} is invalid.`);
    }
    const rec = c as Record<string, unknown>;
    let cid = String(rec.id ?? '').trim();
    if (!cid) cid = newId();
    if (seenIds.has(cid)) throw new ValidationError('Duplicate category id.');
    seenIds.add(cid);
    const name = String(rec.name ?? '').trim();
    if (!name) throw new ValidationError('Each category needs a name.');
    if (name.length > 200) throw new ValidationError('Category name is too long.');
    const color = String(rec.color ?? '#7cb7ff').trim();
    if (!COLOR_HEX.test(color))
      throw new ValidationError(`Category “${name}”: color must be #RRGGBB.`);

    const rawType = rec.type;
    let kind: CategoryKind;
    if (
      rawType === null ||
      rawType === undefined ||
      (typeof rawType === 'string' && !rawType.trim())
    ) {
      kind = 'BUTTON';
    } else {
      const k = String(rawType).toUpperCase().trim();
      kind = (['BUTTON', 'DROPDOWN', 'TEXT', 'ON_OFF'] as const).includes(k as CategoryKind)
        ? (k as CategoryKind)
        : 'BUTTON';
    }

    const optsRaw = rec.dropdown_options ?? [];
    let onL = '';
    let offL = '';
    let opts: DropdownOptionRecord[] = [];
    if (kind === 'DROPDOWN') {
      if (!Array.isArray(optsRaw))
        throw new ValidationError(`Category “${name}”: dropdown needs a list of options.`);
      const objs = optsRaw.map((o, j) => {
        const ent = normalizeDropdownOptionEntry(o, name, j);
        if (ent.label.length > 200) throw new ValidationError('Dropdown option text is too long.');
        if ((ent.auto_instruction?.length ?? 0) > 2000)
          throw new ValidationError('Dropdown option instruction is too long.');
        return ent;
      });
      if (objs.length < 2)
        throw new ValidationError(`Category “${name}”: DROPDOWN needs at least two options.`);
      opts = objs;
    } else if (kind === 'ON_OFF') {
      onL = String(rec.on_label ?? '').trim();
      offL = String(rec.off_label ?? '').trim();
      if (!onL || !offL)
        throw new ValidationError(`Category “${name}”: ON / OFF needs both ON and OFF labels.`);
      if (onL.length > 200 || offL.length > 200)
        throw new ValidationError('ON / OFF label text is too long.');
    }

    // Generation instruction: trimmed, ≤ 2000; empty ⇒ omitted; ON_OFF never
    // carries one (a value arriving on one is dropped, not an error).
    const instr = kind === 'ON_OFF' ? '' : String(rec.auto_instruction ?? '').trim();
    if (instr.length > 2000) throw new ValidationError('Category instruction is too long.');

    categories.push({
      id: cid,
      name,
      color,
      type: kind,
      dropdown_options: opts,
      on_label: kind === 'ON_OFF' ? onL : '',
      off_label: kind === 'ON_OFF' ? offL : '',
      ...(instr ? { auto_instruction: instr } : {}),
    });
  });
  return categories;
}

/** The single "instruction-bearing" definition (auto-event-generation spec):
 *  the category's own auto_instruction is non-empty, OR — DROPDOWN only — any
 *  dropdown option's is. ON_OFF categories never participate, and option
 *  instructions lingering on a non-DROPDOWN type (stale raw JSON after a type
 *  switch) do not count. Accepts normalized CategoryRecords or loosely-typed
 *  parsed categories JSON. */
export function categoryIsInstructionBearing(cat: unknown): boolean {
  if (!cat || typeof cat !== 'object' || Array.isArray(cat)) return false;
  const rec = cat as Record<string, unknown>;
  const type = String(rec.type ?? '')
    .toUpperCase()
    .trim();
  if (type === 'ON_OFF') return false;
  if (typeof rec.auto_instruction === 'string' && rec.auto_instruction.trim()) return true;
  if (type !== 'DROPDOWN') return false;
  const opts = Array.isArray(rec.dropdown_options) ? rec.dropdown_options : [];
  return opts.some((o) => {
    if (!o || typeof o !== 'object') return false;
    const instr = (o as Record<string, unknown>).auto_instruction;
    return typeof instr === 'string' && instr.trim() !== '';
  });
}

/** Return a copy of each category dict with a new id (seeding/cloning shows). */
export function freshCategoryIds(cats: CategoryRecord[]): CategoryRecord[] {
  return cats.map((c) => ({ ...c, id: newId() }));
}

/** Validate + normalize a studio settings blob. Throws ValidationError. isKnownStudio gates the id. */
export function validateSettingsBlob(
  blob: Record<string, unknown>,
  studioId: string,
  isKnownStudio: (id: string) => boolean,
): SettingsBlob {
  if (!isKnownStudio(studioId)) throw new ValidationError('Unknown studio id.');
  const categories = validateCategoriesList(blob.categories);
  let titleFmt = blob.show_title_format;
  if (titleFmt === null || titleFmt === undefined) titleFmt = '';
  const titleStr = String(titleFmt).trim();
  if (titleStr.length > 500) throw new ValidationError('Show title format is too long.');
  const fr = blob.default_frame_rate ?? 24.0;
  const frameRate = Number(fr);
  if (!Number.isFinite(frameRate)) throw new ValidationError('Frame rate must be a number.');
  if (frameRate < 1.0 || frameRate > 120.0)
    throw new ValidationError('Frame rate must be between 1 and 120.');
  return { categories, show_title_format: titleStr, default_frame_rate: frameRate };
}

/** Build a 9-color event palette from category colors, padded with the default slate. */
export function paletteFromCategories(cats: CategoryRecord[]): string[] {
  const palette: string[] = [];
  for (const c of cats.slice(0, 20)) {
    const col = String(c.color ?? '').trim();
    if (col && !palette.includes(col)) palette.push(col);
    if (palette.length >= 9) break;
  }
  while (palette.length < 9) palette.push('#64748b');
  return palette.slice(0, 9);
}

/** Convert a stored settings blob into a live StudioProfile (browser shape source). */
export function blobToProfile(studioId: string, name: string, blob: SettingsBlob): StudioProfile {
  const cats: CategoryDef[] = [];
  for (const c of blob.categories ?? []) {
    if (!c || typeof c !== 'object') continue;
    const optsRaw = Array.isArray(c.dropdown_options) ? c.dropdown_options : [];
    let kind = String(c.type ?? 'BUTTON').toUpperCase() as CategoryKind;
    if (!(['BUTTON', 'DROPDOWN', 'TEXT', 'ON_OFF'] as const).includes(kind)) kind = 'BUTTON';
    const onL = kind === 'ON_OFF' ? String(c.on_label ?? '') : '';
    const offL = kind === 'ON_OFF' ? String(c.off_label ?? '') : '';
    const optLabels: string[] = [];
    for (const x of optsRaw) {
      const t = typeof x === 'object' && x ? String(x.label ?? '').trim() : String(x).trim();
      if (t) optLabels.push(t);
    }
    cats.push({
      id: String(c.id ?? ''),
      label: String(c.name ?? '—'),
      color: String(c.color ?? '#7cb7ff'),
      kind,
      dropdown_options: optLabels,
      on_label: onL,
      off_label: offL,
    });
  }
  return {
    id: studioId,
    name,
    categories: cats,
    show_title_format: String(blob.show_title_format ?? ''),
    default_frame_rate: Number(blob.default_frame_rate ?? 24.0),
  };
}

export function newSessionTitlePrefix(showTitleFormat: string): string {
  const fmt = String(showTitleFormat ?? '').trim();
  return fmt ? `${fmt} - Episode ` : 'Episode ';
}

/** studio_to_api_dict — the active_studio shape the React app consumes. */
export function studioToApiDict(profile: StudioProfile): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    categories: profile.categories.map((c) => ({
      id: c.id,
      label: c.label,
      color: c.color,
      type: c.kind,
      dropdown_options: [...c.dropdown_options],
      on_label: c.on_label,
      off_label: c.off_label,
    })),
  };
}

export function emptyActiveStudioApiDict(): Record<string, unknown> {
  return { id: '', name: '', categories: [] };
}

/** _suggested_show_code — initials from the show name, fallback "SHOW". */
export function suggestedShowCode(name: string): string {
  const parts = (name ?? '').trim().match(/[A-Za-z0-9]+/g) ?? [];
  if (parts.length === 0) return 'SHOW';
  const frag = parts
    .map((p) => (p ? p[0].toUpperCase() : ''))
    .join('')
    .slice(0, 12);
  return frag || 'SHOW';
}

// ── Event enrichment + UI snapshots (ported from studio.py) ──────────────────

/** session_deck_display_title — `Show Code - Episode` when a show is linked, else stored title. */
export function sessionDeckDisplayTitle(opts: {
  showCode?: string | null;
  episode?: string | null;
  storedTitle?: string;
}): string {
  const sc = String(opts.showCode ?? '').trim();
  const ep = String(opts.episode ?? '').trim();
  if (sc) return `${sc} - ${ep || '1'}`;
  const t = String(opts.storedTitle ?? '').trim();
  return t || '—';
}

// Persisted on log rows for the orphan UI (button removed); relink matches on label.
export const UI_SNAPSHOT_LABEL_KEY = 'al_category_label_snapshot';
export const UI_SNAPSHOT_COLOR_KEY = 'al_category_color_snapshot';

export function normalizeEventButtonNameForRelink(name: string): string {
  // casefold ≈ toLowerCase for our (Latin) button names.
  return String(name ?? '')
    .trim()
    .toLowerCase();
}

/** Copy metadata and set snapshot keys from the live category (hex color normalized). */
export function mergeCategoryUiSnapshotsIntoMetadata(
  metadata: Record<string, unknown>,
  cat: CategoryDef | null,
): Record<string, unknown> {
  const out = { ...(metadata ?? {}) };
  if (cat === null) return out;
  out[UI_SNAPSHOT_LABEL_KEY] = cat.label;
  const hx = String(cat.color ?? '').trim();
  out[UI_SNAPSHOT_COLOR_KEY] = COLOR_HEX.test(hx) ? hx.toLowerCase() : hx;
  return out;
}

export function stripCategoryUiSnapshots(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...(metadata ?? {}) };
  delete out[UI_SNAPSHOT_LABEL_KEY];
  delete out[UI_SNAPSHOT_COLOR_KEY];
  return out;
}

/** The event shape the session hub returns over RPC. Metadata crosses as a
 *  JSON *string* (metadata_json) — the hub stores it as text, and a plain
 *  string keeps the RPC shape structurally simple. */
export interface EventRpc {
  event_id: string;
  wall_time_utc: string;
  timecode: string | null;
  frame_rate: number | null;
  timecode_total_frames: number | null;
  category: string;
  message: string;
  metadata_json: string;
}

/** enrich_event_for_session output: an EventRpc with metadata parsed + label/color. */
export function enrichEventRpc(ev: EventRpc, profile: StudioProfile): Record<string, unknown> {
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(ev.metadata_json || '{}');
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const d: Record<string, unknown> = {
    event_id: ev.event_id,
    wall_time_utc: ev.wall_time_utc,
    timecode: ev.timecode,
    frame_rate: ev.frame_rate,
    timecode_total_frames: ev.timecode_total_frames,
    category: ev.category,
    message: ev.message,
    metadata: meta,
  };
  const cat = profile.categories.find((c) => c.id === ev.category) ?? null;
  if (String(ev.category).toLowerCase() === 'internal') {
    d.category_label = 'Internal';
    d.category_color = 'var(--muted)';
  } else if (cat !== null) {
    d.category_label = cat.label;
    d.category_color = cat.color;
  } else {
    const labSnap = String(meta[UI_SNAPSHOT_LABEL_KEY] ?? '').trim();
    const colRaw = meta[UI_SNAPSHOT_COLOR_KEY];
    let colSnap: string | null = null;
    if (typeof colRaw === 'string') {
      const hx = colRaw.trim();
      if (COLOR_HEX.test(hx)) colSnap = hx.toLowerCase();
    }
    d.category_label = labSnap || String(ev.category);
    d.category_color = colSnap;
  }
  return d;
}
