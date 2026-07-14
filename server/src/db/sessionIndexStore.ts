// Catalog sessions index + the live projection mirrored from the session hub, plus
// session→studio profile resolution. Moved verbatim out of catalog.ts (Catalog),
// with the cross-store calls rewritten to the injected studios/shows stores.

import type { CatalogDb } from '../node/catalogStore';
import { blobToProfile, ValidationError } from '../studio';
import type { SettingsBlob, StudioProfile } from '../studio';
import type { Row } from './shared';
import type { ShowsStore } from './showsStore';
import type { StudioRegistry } from './studioRegistry';

export class SessionIndexStore {
  constructor(
    private db: CatalogDb,
    private studios: StudioRegistry,
    private shows: ShowsStore,
  ) {}

  async getSessionStudioId(sessionId: string): Promise<string | null> {
    const r = await this.db
      .prepare(
        `SELECT sh.studio_id AS studio_id FROM sessions s
         LEFT JOIN shows sh ON sh.id = s.show_id WHERE s.id = ?`,
      )
      .bind(sessionId)
      .first<Row>();
    if (r === null) return null;
    const sid = String(r.studio_id ?? '').trim();
    return sid || null;
  }

  async getSessionIndexRow(
    sessionId: string,
    opts: { includeHidden?: boolean } = {},
  ): Promise<Row | null> {
    let q = 'SELECT * FROM sessions WHERE id = ?';
    if (!opts.includeHidden) q += ' AND COALESCE(ui_hidden, 0) = 0';
    return this.db.prepare(q).bind(sessionId).first<Row>();
  }

  /** Joined index row carrying show_code / show_name for deck titles. */
  async getSessionJoinedRow(
    sessionId: string,
    opts: { includeHidden?: boolean } = {},
  ): Promise<Row | null> {
    let q = `SELECT s.*, sh.show_code AS show_code, sh.name AS show_name
             FROM sessions s LEFT JOIN shows sh ON sh.id = s.show_id WHERE s.id = ?`;
    if (!opts.includeHidden) q += ' AND COALESCE(s.ui_hidden, 0) = 0';
    return this.db.prepare(q).bind(sessionId).first<Row>();
  }

  async listSessionsForShow(showId: string): Promise<Row[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.*, sh.show_code AS show_code, sh.name AS show_name
         FROM sessions s LEFT JOIN shows sh ON sh.id = s.show_id
         WHERE s.show_id = ? AND COALESCE(s.ui_hidden, 0) = 0
         ORDER BY s.created_at_utc DESC`,
      )
      .bind(showId)
      .all<Row>();
    return results ?? [];
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
    await this.db
      .prepare(
        `INSERT INTO sessions
           (id, show_id, title, archived, ui_hidden, frame_rate, start_offset_frames,
            episode, notes, started_at_utc, created_at_utc,
            event_count, is_rolling, current_take, transport_elapsed_frames)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
      )
      .bind(
        id,
        opts.showId,
        opts.title,
        opts.frameRate,
        opts.startOffsetFrames,
        opts.episode,
        opts.notes,
        opts.startedAtUtc,
        opts.createdAtUtc,
      )
      .run();
    await this.bumpShowNextEpisodeFromEpisodeString(opts.showId, opts.episode);
    return id;
  }

  /** _bump_show_next_episode_from_episode_string. */
  async bumpShowNextEpisodeFromEpisodeString(showId: string, episode: string): Promise<void> {
    const ep = (episode || '').trim().toUpperCase();
    if (ep.startsWith('BONUS')) return;
    const m = /^(\d+)$/.exec(ep);
    if (!m) return;
    const n = Number(m[1]);
    if (n > 10000) return;
    await this.db
      .prepare('UPDATE shows SET next_episode = MAX(COALESCE(next_episode, 1), ?) WHERE id = ?')
      .bind(n + 1, showId)
      .run();
  }

  /** update_session — title + start_offset_frames. Throws ValidationError on empty title. */
  async updateSessionIndex(
    sessionId: string,
    fields: { title?: string; startOffsetFrames?: number },
  ): Promise<Row | null> {
    const row = await this.getSessionIndexRow(sessionId, { includeHidden: true });
    if (row === null) return null;
    const newTitle = fields.title !== undefined ? fields.title.trim() : String(row.title);
    if (!newTitle) throw new ValidationError('title must not be empty');
    const newOffset =
      fields.startOffsetFrames !== undefined
        ? fields.startOffsetFrames
        : Number(row.start_offset_frames ?? 0);
    if (newOffset < 0) throw new ValidationError('start_offset_frames must be >= 0');
    await this.db
      .prepare('UPDATE sessions SET title = ?, start_offset_frames = ? WHERE id = ?')
      .bind(newTitle, newOffset, sessionId)
      .run();
    return this.getSessionIndexRow(sessionId, { includeHidden: true });
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<boolean> {
    const res = await this.db
      .prepare('UPDATE sessions SET archived = ? WHERE id = ?')
      .bind(archived ? 1 : 0, sessionId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async setSessionUiHidden(sessionId: string, hidden: boolean): Promise<boolean> {
    const res = await this.db
      .prepare('UPDATE sessions SET ui_hidden = ? WHERE id = ?')
      .bind(hidden ? 1 : 0, sessionId)
      .run();
    return (res.meta.changes ?? 0) > 0;
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
    await this.db
      .prepare(
        `UPDATE sessions SET event_count = ?, max_timecode_total_frames = ?,
           is_rolling = ?, current_take = ?, transport_elapsed_frames = ?, roll_started_at_utc = ?
         WHERE id = ?`,
      )
      .bind(
        p.event_count,
        p.max_timecode_total_frames,
        p.is_rolling ? 1 : 0,
        p.current_take,
        p.transport_elapsed_frames,
        p.roll_started_at_utc,
        sessionId,
      )
      .run();
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

  /** studio_profile_for_session — categories from the session's show, else active studio. */
  async studioProfileForSession(sessionId: string): Promise<StudioProfile> {
    const raw = await this.getSessionShowCategories(sessionId);
    let stu = await this.getSessionStudioId(sessionId);
    if (!stu || !this.studios.isKnownStudio(stu)) stu = (await this.studios.resolveActiveStudio()).id;
    if (raw === null) return this.studios.loadStudioProfile(stu);
    const name = this.studios.studioNamesDict()[stu] ?? stu;
    return blobToProfile(stu, name, {
      categories: raw.categories,
      show_title_format: '',
      default_frame_rate: 24.0,
    } as unknown as SettingsBlob);
  }
}
