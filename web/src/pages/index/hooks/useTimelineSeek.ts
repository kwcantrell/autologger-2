import { useCallback } from 'react';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { normalizeTargetSec, resolvePlayPosition } from '../components/AudioPlayer';
import { useAudioClipsContext } from './AudioClipsContext';

/**
 * Published by `SessionWorkspace` → `AudioPlayer` (feed-row-seek phase 4,
 * design D1; landed) — the play-capable counterpart to the existing
 * `AutoLogger_seekAudio` (non-playing; declared in AppShell.tsx and used by
 * marker navigation only). TypeScript merges `declare global` blocks across
 * files, same pattern as the other AutoLogger_* globals.
 *
 * Every call is optional-chained: while SessionWorkspace is unmounted this is
 * a silent no-op, never a throw.
 */
declare global {
  interface Window {
    AutoLogger_seekAudioAndPlay?: (sec: number) => void;
  }
}

export interface UseTimelineSeekResult {
  /**
   * Whether a feed's jump controls should render as UNAVAILABLE right now:
   * session status hasn't RESOLVED, reports rolling, or the feed is in
   * batch-edit mode (design D5). The SAME value applies to every row in the
   * feed — pass it straight through as each row's `unavailable`/seekable prop
   * so `memo`-wrapped rows re-render on the transition (design D7).
   *
   * An unresolved status (`data` still `undefined`) reads as UNAVAILABLE, not
   * as "not rolling" — `!status?.is_rolling` would fail open on first paint.
   *
   * Every consumer, prop, and the button itself (`unavailable` on
   * `JumpToTimeButton`) speak the negative — this hook used to speak only the
   * positive `available`, forcing every one of the three feeds to invert it
   * locally with `const jumpUnavailable = !jumpAvailable;` (quality fix wave,
   * FIX 6b). Speaking only the negative here (re-review Minor 4) keeps that
   * single mirrored derivation off the hook's public surface entirely.
   */
  unavailable: boolean;
  /**
   * Jump to a timeline-absolute second. Referentially STABLE across renders
   * that don't change the gate or the clip layout (`useCallback`) — safe to
   * hand to `memo`-wrapped, virtualized rows without defeating memoization
   * (design D7).
   *
   * Gated: a no-op (no scrub, no scroll, no audio, no playback) while
   * `unavailable` is true. When available, it always moves the playhead and
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

/**
 * True when `resolvePlayPosition` — the SAME resolution `AudioPlayer` itself
 * runs — would land on a clip that actually CONTAINS `sec`, not on a clip it
 * only fell forward/backward to (design D6). Whole-branch audit fix wave,
 * finding M4: this used to be a separately-maintained `clips.some(...)`
 * predicate that could drift from `resolvePlayPosition`'s actual behavior —
 * in particular, with overlapping clips, `some()` could report "covered"
 * from playable clip B while `resolvePlayPosition` picks an earlier,
 * unplayable clip A and forwards PAST B to some other clip entirely.
 * Delegating to `resolvePlayPosition` and then checking containment on the
 * clip it actually returns makes this predicate structurally unable to
 * disagree with the player about what "covered" means.
 */
function isCoveredByPlayableClip(sec: number, clips: readonly AudioClipLite[]): boolean {
  const target = normalizeTargetSec(sec);
  const resolved = resolvePlayPosition(sec, clips);
  if (!resolved) return false;
  const clip = clips[resolved.clipIdx];
  return target >= clip.startSec && target < clip.endSec;
}

/**
 * The feed-facing timeline-seek hook (design D5, D6, D7, D8): the shared home
 * for the gate, the clip-coverage check, and playback that the Event,
 * Transcript, and Topics feeds all consume. Each feed calls this ONCE and
 * passes the returned `jump` (stable) and `unavailable` (a real prop) down to
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
export function useTimelineSeek(sessionId: string, batchEditMode: boolean): UseTimelineSeekResult {
  const { data: status } = useSessionStatus(sessionId || null);
  // Whole-branch audit fix wave, finding C1: read the SAME clip layout the
  // player uses (`SessionWorkspace` publishes it via `AudioClipsProvider`)
  // instead of calling `useAudioClips` here with this feed's own,
  // differently-limited `events` — see AudioClipsContext.tsx for why that
  // mismatch was a wrong-recording-playback hazard.
  const clips = useAudioClipsContext();

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

  return { unavailable: !available, jump };
}
