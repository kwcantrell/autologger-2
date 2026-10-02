// Catalog sessions index + the live projection mirrored from the session hub, plus
// session→studio profile resolution. Moved verbatim out of catalog.ts (Catalog),
// with the cross-store calls rewritten to the injected studios/shows stores.

import type { Row, SettingsBlob, StudioProfile } from '@autologger/domain';
import { blobToProfile, defaultSettingsBlob, ValidationError } from '@autologger/domain';
import type { CatalogDb } from '@autologger/ports';
import { allocateTitleForBase, dateSuffixBase, padEpisodeToken } from './sessionTitleDerivation';
import type { ShowsStore } from './showsStore';
import type { StudioRegistry } from './studioRegistry';

const UPLOAD_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * yt-dlp's `--dump-json` `upload_date` field (`YYYYMMDD`) → the `YYYY-MM-DD`
 * form the catalog `sessions.episode_date` column stores. A null/blank/
 * malformed input is a no-op — returns `null` rather than throwing, since a
 * missing/unparseable publish date must never fail the import (design D4).
 */
export function normalizeUploadDate(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const m = UPLOAD_DATE_RE.exec(trimmed);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** Consumption-based facade surface (persistence-package-extraction design D3):
 * the 13 members reached externally via `catalog.sessions.x()` in
 * `server/src` (routers + `test/helpers.ts`). Property-style function types
 * (design D3 — contravariant `implements` checking under
 * `strictFunctionTypes`). */
export interface SessionIndexStoreFacade {
  getSessionStudioId: (sessionId: string) => Promise<string | null>;
  getSessionIndexRow: (sessionId: string, opts?: { includeHidden?: boolean }) => Promise<Row | null>;
  getSessionJoinedRow: (sessionId: string, opts?: { includeHidden?: boolean }) => Promise<Row | null>;
  listSessionsForShow: (showId: string) => Promise<Row[]>;
  createSessionIndex: (opts: {
    showId: string;
    title: string;
    frameRate: number;
    startOffsetFrames: number;
    episode: string;
    notes: string;
    startedAtUtc: string;
    createdAtUtc: string;
  }) => Promise<string>;
  createSessionForShow: (opts: {
    showId: string;
    showCode: string;
    titleSuffix: string;
    explicitTitle: string;
    rawEpisode: string;
    frameRate: number;
    startOffsetFrames: number;
    notes: string;
    startedAtUtc: string;
    createdAtUtc: string;
    nowMs: number;
  }) => Promise<{ id: string; title: string; episode: string }>;
  updateSessionIndex: (
    sessionId: string,
    fields: { title?: string; startOffsetFrames?: number },
  ) => Promise<Row | null>;
  setSessionArchived: (sessionId: string, archived: boolean) => Promise<boolean>;
  setSessionEpisodeDate: (sessionId: string, iso: string | null | undefined) => Promise<boolean>;
  setSessionUiHidden: (sessionId: string, hidden: boolean) => Promise<boolean>;
  projectSessionLive: (
    sessionId: string,
    p: {
      event_count: number;
      max_timecode_total_frames: number | null;
      is_rolling: boolean;
      current_take: number;
      transport_elapsed_frames: number;
      roll_started_at_utc: string | null;
    },
  ) => Promise<void>;
  getSessionShowCategories: (
    sessionId: string,
  ) => Promise<{ categories: unknown[]; showName: string; showCode: string } | null>;
  studioProfileForSession: (sessionId: string) => Promise<StudioProfile>;
}

export class SessionIndexStore implements SessionIndexStoreFacade {
  constructor(
    private db: CatalogDb,
    private studios: StudioRegistry,
    private shows: ShowsStore,
  ) {}

  /** The same store over another handle, with its studio and show dependencies rebound too, so
   * a transaction body never reaches the root handle (async-catalog-stores D3). */
  withDb(db: CatalogDb): SessionIndexStore {
    return new SessionIndexStore(db, this.studios.withDb(db), this.shows.withDb(db));
  }

  async getSessionStudioId(sessionId: string): Promise<string | null> {
    const r = await this.db.first<Row>(
      `SELECT sh.studio_id AS studio_id FROM sessions s
       LEFT JOIN shows sh ON sh.id = s.show_id WHERE s.id = ?`,
      sessionId,
    );
    if (r === null) return null;
    const sid = String(r.studio_id ?? '').trim();
    return sid || null;
  }

  async getSessionIndexRow(sessionId: string, opts: { includeHidden?: boolean } = {}): Promise<Row | null> {
    let q = 'SELECT * FROM sessions WHERE id = ?';
    if (!opts.includeHidden) q += ' AND COALESCE(ui_hidden, 0) = 0';
    return this.db.first<Row>(q, sessionId);
  }

  /** Joined index row carrying show_code / show_name for deck titles. */
  async getSessionJoinedRow(sessionId: string, opts: { includeHidden?: boolean } = {}): Promise<Row | null> {
    let q = `SELECT s.*, sh.show_code AS show_code, sh.name AS show_name
             FROM sessions s LEFT JOIN shows sh ON sh.id = s.show_id WHERE s.id = ?`;
    if (!opts.includeHidden) q += ' AND COALESCE(s.ui_hidden, 0) = 0';
    return this.db.first<Row>(q, sessionId);
  }

  async listSessionsForShow(showId: string): Promise<Row[]> {
    return this.db.all<Row>(
      `SELECT s.*, sh.show_code AS show_code, sh.name AS show_name
       FROM sessions s LEFT JOIN shows sh ON sh.id = s.show_id
       WHERE s.show_id = ? AND COALESCE(s.ui_hidden, 0) = 0
       ORDER BY s.created_at_utc DESC`,
      showId,
    );
  }

  async createSessionIndex(opts: {
    showId: string;
    title: string;
    frameRate: number;
    startOffsetFrames: number;
    episode: string;
    notes: string;
    startedAtUtc: string;
    createdAtUtc: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.tx(async (t) => {
      await t.run(
        `INSERT INTO sessions
           (id, show_id, title, archived, ui_hidden, frame_rate, start_offset_frames,
            episode, notes, started_at_utc, created_at_utc,
            event_count, is_rolling, current_take, transport_elapsed_frames)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
        id,
        opts.showId,
        opts.title,
        opts.frameRate,
        opts.startOffsetFrames,
        opts.episode,
        opts.notes,
        opts.startedAtUtc,
        opts.createdAtUtc,
      );
      // session-title-suffix (design D1, gate ruling 2026-08-02): creating a
      // session no longer bumps any per-show next-episode counter — the old
      // `_bump_show_next_episode_from_episode_string` step is REMOVED here,
      // not merely disabled. `shows.next_episode` is soft-retained (unused)
      // — see the 0005 migration + showsStore.ts.
    });
    return id;
  }

  /**
   * session-title-suffix (design D2/D3/D4/D6, task 1.3) — the create-path
   * title/episode derivation, run inside ONE catalog transaction so the
   * Date-mode collision read (existing titles for the show) and the session
   * INSERT can never observe/produce a duplicate title under concurrent
   * same-tick creates: both run inside one `CatalogDb.tx`, which is
   * SERIALIZABLE and retried on conflict (core-ports-architecture "The Postgres
   * catalog adapter"), so concurrent creates behave as if run one after the
   * other between the SELECT and the INSERT below. Throws `ValidationError` (mapped to `400` by the router)
   * for the two derivation-time rejections named in the spec: a blank
   * trimmed show code, and a blank episode under Episode-suffix derivation.
   */
  async createSessionForShow(opts: {
    showId: string;
    showCode: string;
    /** Raw `shows.title_suffix` column value; anything other than exactly
     * `'episode'` is treated as `'date'` (the only two persisted values). */
    titleSuffix: string;
    /** Trimmed `title` from the request body; `''` means "not supplied". */
    explicitTitle: string;
    /** Trimmed `episode` from the request body; `''` means blank/omitted. */
    rawEpisode: string;
    frameRate: number;
    startOffsetFrames: number;
    notes: string;
    startedAtUtc: string;
    createdAtUtc: string;
    /** The SAME create-path clock read used for startedAtUtc/createdAtUtc
     * (design D2) — callers must not take a second clock read for this. */
    nowMs: number;
  }): Promise<{ id: string; title: string; episode: string }> {
    return this.db.tx(async (t) => {
      const s = this.withDb(t);
      let title: string;
      let episode: string;
      if (opts.explicitTitle) {
        // An explicit non-blank title always wins over derivation (D6) —
        // stored as-is (already trimmed by the router); episode is stored
        // as sent, also already trimmed.
        title = opts.explicitTitle;
        episode = opts.rawEpisode;
      } else {
        const code = opts.showCode.trim();
        if (!code) {
          throw new ValidationError('Show code is required to derive a session title.');
        }
        if (opts.titleSuffix === 'episode') {
          if (!opts.rawEpisode) {
            throw new ValidationError(
              'episode is required for shows using the Episode Number suffix.',
            );
          }
          title = `${code}_${padEpisodeToken(opts.rawEpisode)}`;
          episode = opts.rawEpisode;
        } else {
          const base = dateSuffixBase(code, opts.nowMs);
          // Full inventory for the show, INCLUDING archived/ui_hidden rows
          // (D3) — never SQL LIKE/GLOB (see sessionTitleDerivation.ts for
          // why); matching happens in JS over the plain title strings.
          const existingTitles = (
            await t.all<Row>('SELECT title FROM sessions WHERE show_id = ?', opts.showId)
          ).map((r) => String(r.title ?? ''));
          title = allocateTitleForBase(existingTitles, base);
          // Under Date derivation the stored episode is ALWAYS '' — a
          // non-blank request episode is never retained as a fake episode
          // value (D6).
          episode = '';
        }
      }
      const id = await s.createSessionIndex({
        showId: opts.showId,
        title,
        frameRate: opts.frameRate,
        startOffsetFrames: opts.startOffsetFrames,
        episode,
        notes: opts.notes,
        startedAtUtc: opts.startedAtUtc,
        createdAtUtc: opts.createdAtUtc,
      });
      return { id, title, episode };
    });
  }

  /** update_session — title + start_offset_frames. Throws ValidationError on empty title. */
  async updateSessionIndex(
    sessionId: string,
    fields: { title?: string; startOffsetFrames?: number },
  ): Promise<Row | null> {
    // Read-merge-write in one transaction (async-catalog-stores D2).
    return this.db.tx(async (t) => {
      const s = this.withDb(t);
      const row = await s.getSessionIndexRow(sessionId, { includeHidden: true });
      if (row === null) return null;
      const newTitle = fields.title !== undefined ? fields.title.trim() : String(row.title);
      if (!newTitle) throw new ValidationError('title must not be empty');
      const newOffset =
        fields.startOffsetFrames !== undefined
          ? fields.startOffsetFrames
          : Number(row.start_offset_frames ?? 0);
      if (newOffset < 0) throw new ValidationError('start_offset_frames must be >= 0');
      await t.run(
        'UPDATE sessions SET title = ?, start_offset_frames = ? WHERE id = ?',
        newTitle,
        newOffset,
        sessionId,
      );
      return s.getSessionIndexRow(sessionId, { includeHidden: true });
    });
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<boolean> {
    const res = await this.db.run(
      'UPDATE sessions SET archived = ? WHERE id = ?',
      archived ? 1 : 0,
      sessionId,
    );
    return res.changes > 0;
  }

  /**
   * Catalog-layer writer for `episode_date` (design D4 — NOT a hub RPC;
   * `episode_date` is a catalog `sessions` column with no per-session-DB
   * counterpart). Sibling of `setSessionArchived`/`setSessionUiHidden`: a
   * single-column `UPDATE`. `iso` must already be normalized to `YYYY-MM-DD`
   * (see `normalizeUploadDate`) — a null/blank `iso` is a no-op (no `UPDATE`
   * runs, returns `false`) since a missing publish date must never fail the
   * import.
   */
  async setSessionEpisodeDate(sessionId: string, iso: string | null | undefined): Promise<boolean> {
    const value = (iso ?? '').trim();
    if (!value) return false;
    const res = await this.db.run('UPDATE sessions SET episode_date = ? WHERE id = ?', value, sessionId);
    return res.changes > 0;
  }

  async setSessionUiHidden(sessionId: string, hidden: boolean): Promise<boolean> {
    const res = await this.db.run(
      'UPDATE sessions SET ui_hidden = ? WHERE id = ?',
      hidden ? 1 : 0,
      sessionId,
    );
    return res.changes > 0;
  }

  /** Mirror the hub's live projection onto the catalog sessions row for cheap listing. */
  async projectSessionLive(
    sessionId: string,
    p: {
      event_count: number;
      max_timecode_total_frames: number | null;
      is_rolling: boolean;
      current_take: number;
      transport_elapsed_frames: number;
      roll_started_at_utc: string | null;
    },
  ): Promise<void> {
    await this.db.run(
      `UPDATE sessions SET event_count = ?, max_timecode_total_frames = ?,
         is_rolling = ?, current_take = ?, transport_elapsed_frames = ?, roll_started_at_utc = ?
       WHERE id = ?`,
      p.event_count,
      p.max_timecode_total_frames,
      p.is_rolling ? 1 : 0,
      p.current_take,
      p.transport_elapsed_frames,
      p.roll_started_at_utc,
      sessionId,
    );
  }

  /** get_session_show_categories — categories list + names from the session's show. */
  async getSessionShowCategories(
    sessionId: string,
  ): Promise<{ categories: unknown[]; showName: string; showCode: string } | null> {
    const row = await this.getSessionIndexRow(sessionId, { includeHidden: true });
    if (row === null) return null;
    const showId = String(row.show_id ?? '').trim();
    if (!showId) return null;
    const show = await this.shows.getShowRow(showId);
    if (show === null) return null;
    let cats: unknown[] = [];
    try {
      const parsed = JSON.parse(String(show.categories_json ?? '[]'));
      if (Array.isArray(parsed)) cats = parsed;
    } catch {
      cats = [];
    }
    return {
      categories: cats,
      showName: String(show.name ?? ''),
      showCode: String(show.show_code ?? ''),
    };
  }

  /** studio_profile_for_session — categories from the session's show. A session whose team is
   * empty or unknown gets a team-less profile: the show's categories, else the default ones
   * (owner-bootstrap D10; there is no global active studio). */
  async studioProfileForSession(sessionId: string): Promise<StudioProfile> {
    const raw = await this.getSessionShowCategories(sessionId);
    const stu = await this.getSessionStudioId(sessionId);
    if (!stu || !this.studios.isKnownStudio(stu)) {
      return blobToProfile('', '', {
        ...defaultSettingsBlob(''),
        ...(raw === null ? {} : { categories: raw.categories }),
      } as unknown as SettingsBlob);
    }
    if (raw === null) return this.studios.loadStudioProfile(stu);
    const name = this.studios.studioNamesDict()[stu] ?? stu;
    return blobToProfile(stu, name, {
      categories: raw.categories,
      show_title_format: '',
      default_frame_rate: 24.0,
    } as unknown as SettingsBlob);
  }
}
