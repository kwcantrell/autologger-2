// Transport domain — the session's session_transport row: rolling state, take
// counter, elapsed frames, and the live timecode snapshot. Moved verbatim out
// of the original single-file session spine.

import {
  formatSmpte,
  isoZ,
  parseUtcMs,
  toTotalFrames,
  transportTimecode,
} from '@autologger/domain';
import type { SessionCore, SessionProjection, TimecodeCtx, TransportState } from './sessionCore';

export class TransportStore {
  constructor(private core: SessionCore) {}

  private async transportStateDict(ctx: TimecodeCtx): Promise<TransportState> {
    const tr = await this.core.transportRow();
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

  transportSnapshot(ctx: TimecodeCtx): Promise<TransportState> {
    return this.transportStateDict(ctx);
  }

  async startTake(
    ctx: TimecodeCtx,
  ): Promise<{ state: TransportState; projection: SessionProjection }> {
    const tr = await this.core.transportRow();
    if (tr.is_rolling) {
      return {
        state: { ...(await this.transportStateDict(ctx)), started: false },
        projection: await this.core.projection(),
      };
    }
    const nextTake = tr.current_take + 1;
    await this.core.db.run(
      'UPDATE session_transport SET is_rolling = 1, current_take = ?, roll_started_at_utc = ? WHERE session_id = ?',
      nextTake,
      isoZ(new Date(this.core.now())),
      this.core.sessionId,
    );
    this.core.broadcast({ type: 'transport.changed', is_rolling: true, current_take: nextTake });
    const st = await this.transportStateDict(ctx);
    return { state: { ...st, started: true }, projection: await this.core.projection() };
  }

  async stopTake(
    ctx: TimecodeCtx,
  ): Promise<{ state: TransportState; projection: SessionProjection }> {
    const tr = await this.core.transportRow();
    if (!tr.is_rolling) {
      return {
        state: { ...(await this.transportStateDict(ctx)), stopped: false },
        projection: await this.core.projection(),
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
    await this.core.db.run(
      'UPDATE session_transport SET is_rolling = 0, roll_started_at_utc = NULL, elapsed_frames = ? WHERE session_id = ?',
      totalElapsed,
      this.core.sessionId,
    );
    this.core.broadcast({
      type: 'transport.changed',
      is_rolling: false,
      current_take: tr.current_take,
    });
    const st = await this.transportStateDict(ctx);
    return { state: { ...st, stopped: true }, projection: await this.core.projection() };
  }

  /** Advance the transport by an exact duration and mark it stopped (YouTube
   * import path). Unconditional: it never checks `is_rolling` — elapsed_frames
   * is bumped and is_rolling forced to 0 whatever the prior state. The sole
   * production caller (`SessionHub.anchorImportedTake`) invokes it when the
   * transport is NOT rolling, to account an imported take's duration.
   * `suppressBroadcast` (youtube-audio-import Phase-9 fix-wave, finding 1;
   * rationale updated by code-health-consolidation D1): atomicity is now owned
   * by the post-commit broadcast queue (`SessionHub.inTxn` +
   * `SessionCore.withBroadcastsHeld`); this flag is RETAINED for a different
   * job — SUPPRESSION, i.e. the composite's frame-count contract. Used ONLY by
   * `SessionHub.anchorImportedTake`, whose call here would otherwise enqueue an
   * extra `transport.changed` that the queue would faithfully flush post-commit
   * alongside the composite's own manual pair; the composite broadcasts once
   * itself, after the transaction commits. Every other caller omits it
   * (default false), preserving the existing broadcast behavior. */
  async stopTakeWithDuration(input: {
    durationS: number;
    ctx: TimecodeCtx;
    suppressBroadcast?: boolean;
  }): Promise<SessionProjection> {
    const tr = await this.core.transportRow();
    const extra = Math.max(0, Math.trunc(input.durationS * input.ctx.frameRate));
    await this.core.db.run(
      'UPDATE session_transport SET is_rolling = 0, roll_started_at_utc = NULL, elapsed_frames = ? WHERE session_id = ?',
      tr.elapsed_frames + extra,
      this.core.sessionId,
    );
    // Matches stopTake's exact emitted shape (design D11) — stopTakeWithDuration
    // previously broadcast nothing, which was a gap masked by having zero
    // non-test callers until the youtube-import anchor composite.
    if (!input.suppressBroadcast) {
      this.core.broadcast({
        type: 'transport.changed',
        is_rolling: false,
        current_take: tr.current_take,
      });
    }
    return this.core.projection();
  }

  async statusLive(ctx: TimecodeCtx): Promise<{
    is_rolling: boolean;
    current_take: number;
    event_count: number;
    logged_event_count: number;
    events_stream_revision: number;
    session_timecode: string;
    session_timecode_total_frames: number;
  }> {
    const st = await this.transportStateDict(ctx);
    // Counts come from the core's single owner of the event-count SQL (D10) —
    // this store never reads the events table itself.
    const counts = await this.core.eventCounts();
    return {
      is_rolling: st.is_rolling,
      current_take: st.current_take,
      event_count: counts.total,
      logged_event_count: counts.logged,
      events_stream_revision: await this.core.revision(),
      session_timecode: st.timecode,
      session_timecode_total_frames: st.timecode_total_frames,
    };
  }
}
