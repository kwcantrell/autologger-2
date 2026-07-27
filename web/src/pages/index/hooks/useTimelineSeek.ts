import { useCallback } from 'react';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { LogEvent } from '../../../api/types';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { useAudioClips } from './useAudioClips';

/**
 * Published by `SessionWorkspace` → `AudioPlayer` in a later unit of this
 * change (phase 4, design D1) — the play-capable counterpart to the existing
 * `AutoLogger_seekAudio` (non-playing; declared in AppShell.tsx and used by
 * marker navigation only). Declared here, ahead of that phase landing, so this
 * hook — its first caller — type-checks; TypeScript merges `declare global`
 * blocks across files, same pattern as the other AutoLogger_* globals.
 *
 * Every call is optional-chained: until phase 4 lands (and after unmount) this
 * is a silent no-op, never a throw.
 */
declare global {
  interface Window {
    AutoLogger_seekAudioAndPlay?: (sec: number) => void;
  }
}

export interface UseTimelineSeekResult {
  /**
   * Whether a feed's jump controls should render as available right now:
   * session status has RESOLVED, reports not-rolling, and the feed is not in
   * batch-edit mode (design D5). The SAME value applies to every row in the
   * feed — pass it straight through as each row's `available`/seekable prop
   * so `memo`-wrapped rows re-render on the transition (design D7).
   *
   * An unresolved status (`data` still `undefined`) reads as UNAVAILABLE, not
   * as "not rolling" — `!status?.is_rolling` would fail open on first paint.
   */
  available: boolean;
  /**
   * Jump to a timeline-absolute second. Referentially STABLE across renders
   * that don't change the gate or the clip layout (`useCallback`) — safe to
   * hand to `memo`-wrapped, virtualized rows without defeating memoization
   * (design D7).
   *
   * Gated: a no-op (no scrub, no scroll, no audio, no playback) while
   * `available` is false. When available, it always moves the playhead and
   * scrolls the timeline to `sec`; it additionally starts playback via
   * `AutoLogger_seekAudioAndPlay` ONLY when a playable clip actually covers
   * `sec` (design D6) — never the non-playing `AutoLogger_seekAudio`, which
   * belongs to marker navigation (design D1, D8). An uncovered target still
   * moves the playhead but issues no audio call of either kind, because
   * `AudioPlayer.seekToTimelineSec`'s `resolvePlayPosition` does not no-op on
   * an uncovered target — it resolves forward to the next playable clip, then
   * backward to the last one, which would cue a different recording.
   */
  jump: (sec: number) => void;
}

/** Mirrors `AudioPlayer.resolvePlayPosition`'s `playable` predicate exactly. */
function isPlayableClip(clip: AudioClipLite): boolean {
  return Boolean(clip.segmentId && clip.url && !clip.missingAudio);
}

/** True when a playable clip actually contains `sec` — strict containment, not
 * `resolvePlayPosition`'s forgiving forward/backward fallback (design D6). */
function isCoveredByPlayableClip(sec: number, clips: readonly AudioClipLite[]): boolean {
  const target = Math.max(0, Number(sec) || 0);
  return clips.some(
    (clip) => target >= clip.startSec && target < clip.endSec && isPlayableClip(clip),
  );
}

/**
 * The feed-facing timeline-seek hook (design D5, D6, D7, D8): the shared home
 * for the gate, the clip-coverage check, and playback that the Event,
 * Transcript, and Topics feeds all consume. Each feed calls this ONCE and
 * passes the returned `jump` (stable) and `available` (a real prop) down to
 * its rows — rows must not call `useSessionStatus` or this hook themselves.
 *
 * Deliberately NOT layered on top of `timelineJump` (`jumpTimelineToSec`):
 * that module always issues all three calls, including the non-playing
 * `AutoLogger_seekAudio`, which neither branch here wants — the covered path
 * needs the play-capable global instead, and the uncovered path needs no
 * audio call at all. The scrub + scroll globals are therefore invoked
 * directly; `timelineJump` remains the ungated, uncoverage-checked,
 * non-playing bundle reserved for marker navigation (design D8).
 */
export function useTimelineSeek(
  sessionId: string,
  events: LogEvent[],
  batchEditMode: boolean,
): UseTimelineSeekResult {
  const { data: status } = useSessionStatus(sessionId || null);
  const { clips } = useAudioClips(sessionId, events);

  const available = status != null && status.is_rolling === false && !batchEditMode;

  const jump = useCallback(
    (sec: number) => {
      if (!available) return;
      window.AutoLogger_setManualScrubSec?.(sec);
      window.AutoLogger_scrollTimelineToSec?.(sec);
      if (isCoveredByPlayableClip(sec, clips)) {
        window.AutoLogger_seekAudioAndPlay?.(sec);
      }
    },
    [available, clips],
  );

  return { available, jump };
}
