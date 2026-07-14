// Transport domain — the single session_transport row: rolling state, take
// counter, elapsed frames, and the live timecode snapshot. Moved verbatim out
// of the original single-file session spine.

import { formatSmpte, isoZ, parseUtcMs, toTotalFrames, transportTimecode } from '../timecode';
import type { SessionCore, SessionProjection, TimecodeCtx, TransportState } from './sessionCore';

export class TransportStore {
  constructor(private core: SessionCore) {}

  private transportStateDict(ctx: TimecodeCtx): TransportState {
    const tr = this.core.transportRow();
    const tc = transportTimecode(ctx.frameRate, ctx.startOffsetFrames, tr, this.core.now());
    return {
      is_rolling: tr.is_rolling,
      current_take: tr.current_take,
      roll_started_at_utc: tr.roll_started_at_utc,
      elapsed_frames: tr.elapsed_frames,
      timecode: formatSmpte(tc),
      timecode_total_frames: toTotalFrames(tc),
    };
  }

  transportSnapshot(ctx: TimecodeCtx): TransportState {
    return this.transportStateDict(ctx);
  }

  startTake(ctx: TimecodeCtx): { state: TransportState; projection: SessionProjection } {
    const tr = this.core.transportRow();
    if (tr.is_rolling) {
      return {
        state: { ...this.transportStateDict(ctx), started: false },
        projection: this.core.projection(),
      };
    }
    const nextTake = tr.current_take + 1;
    this.core.db.run(
      'UPDATE session_transport SET is_rolling = 1, current_take = ?, roll_started_at_utc = ? WHERE id = 1',
      nextTake,
      isoZ(new Date(this.core.now())),
    );
    this.core.broadcast({ type: 'transport.changed', is_rolling: true, current_take: nextTake });
    const st = this.transportStateDict(ctx);
    return { state: { ...st, started: true }, projection: this.core.projection() };
  }

  stopTake(ctx: TimecodeCtx): { state: TransportState; projection: SessionProjection } {
    const tr = this.core.transportRow();
    if (!tr.is_rolling) {
      return {
        state: { ...this.transportStateDict(ctx), stopped: false },
        projection: this.core.projection(),
      };
    }
    let extra = 0;
    if (tr.roll_started_at_utc) {
      const started = parseUtcMs(tr.roll_started_at_utc);
      if (!Number.isNaN(started)) {
        extra = Math.max(0, Math.trunc(((this.core.now() - started) / 1000) * ctx.frameRate));
      }
    }
    const totalElapsed = tr.elapsed_frames + extra;
    this.core.db.run(
      'UPDATE session_transport SET is_rolling = 0, roll_started_at_utc = NULL, elapsed_frames = ? WHERE id = 1',
      totalElapsed,
    );
    this.core.broadcast({
      type: 'transport.changed',
      is_rolling: false,
      current_take: tr.current_take,
    });
    const st = this.transportStateDict(ctx);
    return { state: { ...st, stopped: true }, projection: this.core.projection() };
  }

  /** Finalize an in-progress take with an exact duration (YouTube import path). */
  stopTakeWithDuration(input: { durationS: number; ctx: TimecodeCtx }): SessionProjection {
    const tr = this.core.transportRow();
    const extra = Math.max(0, Math.trunc(input.durationS * input.ctx.frameRate));
    this.core.db.run(
      'UPDATE session_transport SET is_rolling = 0, roll_started_at_utc = NULL, elapsed_frames = ? WHERE id = 1',
      tr.elapsed_frames + extra,
    );
    return this.core.projection();
  }

  statusLive(ctx: TimecodeCtx): {
    is_rolling: boolean;
    current_take: number;
    event_count: number;
    logged_event_count: number;
    events_stream_revision: number;
    session_timecode: string;
    session_timecode_total_frames: number;
  } {
    const st = this.transportStateDict(ctx);
    const total = Number(this.core.first('SELECT COUNT(*) AS c FROM events')?.c ?? 0);
    const logged = Number(
      this.core.first("SELECT COUNT(*) AS c FROM events WHERE lower(trim(category)) != 'internal'")
        ?.c ?? 0,
    );
    return {
      is_rolling: st.is_rolling,
      current_take: st.current_take,
      event_count: total,
      logged_event_count: logged,
      events_stream_revision: this.core.revision(),
      session_timecode: st.timecode,
      session_timecode_total_frames: st.timecode_total_frames,
    };
  }
}
