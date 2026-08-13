// Event log domain — events table CRUD, the export feed, and the one-shot
// orphan-relink pass. Moved verbatim out of the original single-file session spine.

import {
  type EventRpc,
  formatSmpte,
  fromTotalFrames,
  isoZ,
  parseUtcMs,
  timecodeForMark,
  toTotalFrames,
  UI_SNAPSHOT_COLOR_KEY,
  UI_SNAPSHOT_LABEL_KEY,
} from '@autologger/domain';
import type { Row, SessionCore, SessionProjection, TimecodeCtx } from './sessionCore';

/** rowToRpc — pure events-row → RPC mapper. */
export function eventRowToRpc(r: Row): EventRpc {
  const tf = r.timecode_total_frames;
  const fr = Number(r.frame_rate);
  const hasTf = tf !== null && tf !== undefined;
  return {
    event_id: String(r.id),
    wall_time_utc: String(r.wall_time_utc),
    timecode: hasTf ? formatSmpte(fromTotalFrames(Number(tf), fr)) : null,
    frame_rate: hasTf ? fr : null,
    timecode_total_frames: hasTf ? Number(tf) : null,
    category: String(r.category),
    message: String(r.message),
    metadata_json: String(r.metadata_json ?? '{}'),
  };
}

export class EventStore {
  constructor(private core: SessionCore) {}

  addEvent(input: {
    category: string;
    message: string;
    metadataJson: string;
    markedAtUtc: string | null;
    ctx: TimecodeCtx;
    /** auto-generate-event-logs D4 — ONE insert path for generated events:
     * when present, the `timecodeForMark` transport derivation is bypassed
     * entirely — the given total frames and `wall_time_utc` are stored
     * verbatim (frame_rate still derives from `ctx` exactly as the manual
     * path stores it). Transaction, broadcast, and metadata handling are
     * identical to the manual path. When absent, behavior is byte-identical
     * to the manual path (pinned in eventStore.test.ts). */
    explicitAnchor?: { timecodeTotalFrames: number; wallTimeUtc: string };
    /** chunked-live-recording D9 — decouples the STORED wall time from the
     * wall time used to derive the timecode. Only consulted in the
     * non-`explicitAnchor` branch: `markMs` (from `markedAtUtc` or a fresh
     * `now()`) still drives `timecodeForMark`'s transport-position derivation
     * exactly as before (the event anchors at the session's transport
     * position AT CALL TIME, per the `youtube-audio-import` spec's
     * `timecode_total_frames` pin), but when present this value is stored as
     * the event's `wall_time_utc` instead of `isoZ(new Date(markMs))`. Used
     * ONLY by `SessionHub.anchorImportedTake` to stamp the synthesized
     * `Recording N Started` event with the take's own `startedAtUtc` (the
     * value already stored on the segment) rather than the moment
     * `anchorImportedTake` happens to run — making the transcript-anchor
     * delta-0 identity (E-A) hold by construction for future imports, same as
     * the live recorder. Every other caller omits this (default undefined),
     * preserving existing wall-time-equals-mark-time behavior. */
    storedWallTimeUtc?: string;
    /** youtube-audio-import Phase-9 fix-wave (finding 1); rationale updated by
     * code-health-consolidation D1: transaction/broadcast ATOMICITY is now owned
     * by the post-commit broadcast queue (`SessionHub.inTxn` +
     * `SessionCore.withBroadcastsHeld`), not by this flag. The flag is RETAINED
     * because it does a different job — SUPPRESSION: it owns the composite's
     * frame-count/payload contract. Used ONLY by
     * `SessionHub.anchorImportedTake`, whose two addEvent calls would otherwise
     * enqueue two `event.changed` frames (including an intermediate revision no
     * client has ever observed) that the queue would faithfully flush
     * post-commit; the composite instead broadcasts once, itself, after `inTxn`
     * returns. Every other caller omits this (default false), preserving the
     * existing per-write broadcast behavior. */
    suppressBroadcast?: boolean;
  }): { event: EventRpc; projection: SessionProjection } {
    let wallIso: string;
    let frameRate: number;
    let totalFrames: number;
    if (input.explicitAnchor) {
      totalFrames = input.explicitAnchor.timecodeTotalFrames;
      // Same frame_rate derivation the manual path stores (fromTotalFrames'
      // millidecimal rounding of ctx.frameRate).
      frameRate = fromTotalFrames(totalFrames, input.ctx.frameRate).frame_rate;
      wallIso = input.explicitAnchor.wallTimeUtc;
    } else {
      const markMs = input.markedAtUtc ? parseUtcMs(input.markedAtUtc) : this.core.now();
      const wallMs = Number.isNaN(markMs) ? this.core.now() : markMs;
      const tr = this.core.transportRow();
      const tc = timecodeForMark(input.ctx.frameRate, input.ctx.startOffsetFrames, tr, wallMs);
      totalFrames = toTotalFrames(tc);
      frameRate = tc.frame_rate;
      wallIso = input.storedWallTimeUtc ?? isoZ(new Date(wallMs));
    }
    const id = crypto.randomUUID();
    const metaJson = input.metadataJson || '{}';
    this.core.db.run(
      `INSERT INTO events (id, wall_time_utc, frame_rate, timecode_total_frames, category, message, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      wallIso,
      frameRate,
      totalFrames,
      input.category,
      input.message,
      metaJson,
    );
    this.core.bumpRevision();
    if (!input.suppressBroadcast) {
      this.core.broadcast({ type: 'event.changed', revision: this.core.revision() });
    }
    const r = this.core.first('SELECT * FROM events WHERE id = ?', id);
    return { event: eventRowToRpc(r as Row), projection: this.core.projection() };
  }

  /** sheets-log-import: place an event at an explicit session timecode (total frames). */
  addEventAtTotalFrames(input: {
    category: string;
    message: string;
    metadataJson: string;
    timecodeTotalFrames: number;
    ctx: TimecodeCtx;
  }): { event: EventRpc; projection: SessionProjection } {
    return this.addEvent({
      category: input.category,
      message: input.message,
      metadataJson: input.metadataJson,
      markedAtUtc: null,
      ctx: input.ctx,
      explicitAnchor: {
        timecodeTotalFrames: Math.max(0, Math.trunc(input.timecodeTotalFrames)),
        wallTimeUtc: isoZ(new Date(this.core.now())),
      },
    });
  }

  listEvents(input: { limit: number; offset: number }): {
    events: EventRpc[];
    total: number;
    loggedTotal: number;
    revision: number;
  } {
    const rows = this.core.all(
      'SELECT * FROM events ORDER BY wall_time_utc ASC, id ASC LIMIT ? OFFSET ?',
      Math.trunc(input.limit),
      Math.trunc(input.offset),
    );
    const counts = this.core.eventCounts();
    return {
      events: rows.map((r) => eventRowToRpc(r)),
      total: counts.total,
      loggedTotal: counts.logged,
      revision: this.core.revision(),
    };
  }

  getEvent(eventId: string): EventRpc | null {
    const r = this.core.first('SELECT * FROM events WHERE id = ?', eventId);
    return r ? eventRowToRpc(r) : null;
  }

  /** All events (unpaged) for CSV/JSONL export; the router layer sorts + enriches. */
  exportEvents(): EventRpc[] {
    return this.core.all('SELECT * FROM events').map((r) => eventRowToRpc(r));
  }

  updateEvent(input: {
    eventId: string;
    category: string;
    message: string;
    wallTimeUtc: string;
    timecodeTotalFrames: number;
    metadataJson: string;
  }): { event: EventRpc; projection: SessionProjection } | null {
    const old = this.core.first('SELECT * FROM events WHERE id = ?', input.eventId);
    if (old === null) return null;
    this.core.db.run(
      `UPDATE events SET category = ?, message = ?, wall_time_utc = ?,
         timecode_total_frames = ?, metadata_json = ? WHERE id = ?`,
      input.category,
      input.message,
      input.wallTimeUtc,
      input.timecodeTotalFrames,
      input.metadataJson || '{}',
      input.eventId,
    );
    this.core.bumpRevision();
    this.core.broadcast({ type: 'event.changed', revision: this.core.revision() });
    const r = this.core.first('SELECT * FROM events WHERE id = ?', input.eventId);
    return { event: eventRowToRpc(r as Row), projection: this.core.projection() };
  }

  deleteEvent(eventId: string): { ok: boolean; projection: SessionProjection } {
    const existed = this.core.first('SELECT 1 AS x FROM events WHERE id = ?', eventId) !== null;
    if (existed) {
      this.core.db.run('DELETE FROM events WHERE id = ?', eventId);
      this.core.bumpRevision();
      this.core.broadcast({ type: 'event.changed', revision: this.core.revision() });
    }
    return { ok: existed, projection: this.core.projection() };
  }

  /** event-generate-hardening D6 — replaces `deleteAutoGeneratedEvents()`:
   * deletes an EXPLICIT id set (the route's pre-spawn auto-row snapshot, gate
   * ruling E3), not a predicate scan — the route computes membership, this
   * method just removes rows. Chunked at <=500 ids per `DELETE ... WHERE id
   * IN (...)` statement, all chunks inside the ONE caller transaction
   * (`SessionHub.inTxn`): better-sqlite3's bind-variable ceiling is 32,766, so
   * an unbounded snapshot must not 500 an otherwise-successful run. ONE
   * `event.changed` broadcast when the TOTAL deleted count across every chunk
   * is > 0 (parity with the old predicate delete's `changes > 0` guard — WS
   * emission semantics stay frozen), none otherwise. Returns the total
   * deleted count (ids no longer present, e.g. already manually deleted,
   * simply don't count). */
  deleteEventsByIds(ids: string[]): number {
    const CHUNK_SIZE = 500;
    let total = 0;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const { changes } = this.core.db.run(
        `DELETE FROM events WHERE id IN (${placeholders})`,
        ...chunk,
      );
      total += changes;
    }
    if (total > 0) {
      this.core.bumpRevision();
      this.core.broadcast({ type: 'event.changed', revision: this.core.revision() });
    }
    return total;
  }

  /** event-generate-hardening D1 — whole-session EXISTS check over the SAME
   * SQL predicate `deleteEventsByIds`'s caller (the route) uses to compute the
   * id snapshot (json_valid + json_type '$.auto_generated' = 'true'),
   * independent of any list page/window. Read-only: no revision bump, no
   * broadcast. */
  hasAutoGeneratedEvents(): boolean {
    const row = this.core.first(
      `SELECT 1 AS x FROM events
       WHERE CASE
         WHEN json_valid(metadata_json)
         THEN json_type(metadata_json, '$.auto_generated') = 'true'
         ELSE 0
       END
       LIMIT 1`,
    );
    return row !== null;
  }

  /** Relink orphan events to a category id when the snapshot label matches exactly one button.
   *  Guarded to run at most once per events_stream_revision (the only inputs are events +
   *  the show categories the router passes in, both of which bump the revision). */
  maybeRelinkOrphans(input: { validIds: string[]; labelToIds: Record<string, string[]> }): number {
    const rev = this.core.revision();
    const lastRaw = this.core.first("SELECT value FROM meta WHERE key = 'relink_checked_rev'");
    if (lastRaw !== null && Number(lastRaw.value) === rev) return 0;
    this.core.db.run(
      "INSERT INTO meta (key, value) VALUES ('relink_checked_rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(rev),
    );
    const hasSnap =
      this.core.first(
        'SELECT 1 AS x FROM events WHERE json_extract(metadata_json, ?) IS NOT NULL LIMIT 1',
        `$.${UI_SNAPSHOT_LABEL_KEY}`,
      ) !== null;
    if (!hasSnap) return 0;

    const valid = new Set(input.validIds);
    const rows = this.core.all('SELECT * FROM events ORDER BY wall_time_utc ASC, id ASC');
    let n = 0;
    for (const row of rows) {
      const catId = String(row.category);
      if (catId.toLowerCase() === 'internal' || valid.has(catId)) continue;
      let meta: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(row.metadata_json ?? '{}'));
        if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const snap = meta[UI_SNAPSHOT_LABEL_KEY];
      if (typeof snap !== 'string') continue;
      const key = snap.trim().toLowerCase();
      const candidates = input.labelToIds[key] ?? [];
      if (candidates.length !== 1) continue;
      delete meta[UI_SNAPSHOT_LABEL_KEY];
      delete meta[UI_SNAPSHOT_COLOR_KEY];
      this.core.db.run(
        'UPDATE events SET category = ?, metadata_json = ? WHERE id = ?',
        candidates[0],
        JSON.stringify(meta),
        String(row.id),
      );
      n += 1;
    }
    if (n) this.core.bumpRevision();
    return n;
  }
}
