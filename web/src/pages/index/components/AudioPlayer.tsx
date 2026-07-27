import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AudioSegment } from '../../../api/types';
import { toast } from '../../../shared/components/Toast';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { isTypingTarget } from './ShortcutsDialog';

/**
 * True when the event target is (or is inside) an element that consumes a
 * Space keypress itself — a focused button's native activation must win over
 * the global play/pause handler (ui-refresh D14 / spec "Global single-key
 * handlers yield to dialogs and interactive targets").
 */
function isKeyConsumingInteractiveTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof Element)) return false;
  return Boolean(el.closest('button, a[href], summary, [role="button"]'));
}

export interface AudioPlayerHandle {
  toggle: () => void;
  isPlaying: () => boolean;
  /** Seek to a timeline-absolute second. Maps to the corresponding audio segment + offset.
   * Non-playing: resumes ONLY if the player was already playing — MarkerNav's path
   * (feed-row-seek design D1, D8). Never starts playback from a paused player. */
  seekToTimelineSec: (sec: number) => void;
  /** Play-capable counterpart of `seekToTimelineSec` (feed-row-seek design D1): seeks to a
   * timeline-absolute second and ALWAYS ends up playing — starting playback on a paused
   * player, or continuing (not restarting) from the new position on a playing one. Reserved
   * for the feed jump path; MarkerNav must keep calling the non-playing method above. */
  seekToTimelineSecAndPlay: (sec: number) => void;
}

export interface AudioPlayerProps {
  segments: AudioSegment[];
  clips: AudioClipLite[];
  onPlayingChange?: (playing: boolean) => void;
  /** Fired with the timeline-absolute second on each rAF tick while playing, and `null` on pause/stop. */
  onPlaybackSecChange?: (sec: number | null) => void;
}

/** Clamp an arbitrary numeric target to a non-negative second — NaN or a
 *  negative value collapses to 0. Exported (quality fix wave, FIX 6a) so
 *  `useTimelineSeek`'s coverage check can normalize with the SAME expression
 *  `resolvePlayPosition` uses internally, instead of re-deriving it while
 *  passing the raw (un-normalized) `sec` through to `resolvePlayPosition` —
 *  the same mirrored-computation hazard the quality fix wave collapsed in
 *  TranscribeRow. `sec` is already typed `number`, so no `Number(sec)` cast
 *  is needed here or at either call site. */
export function normalizeTargetSec(sec: number): number {
  return Math.max(0, sec || 0);
}

/** Find the clip index containing `sec`, falling back to the next playable clip.
 *  Exported for `useTimelineSeek`'s coverage check (whole-branch audit fix wave,
 *  finding M4), which verifies the clip this function actually resolves to
 *  contains `sec` rather than maintaining a separately-drifting predicate. */
export function resolvePlayPosition(
  sec: number,
  clips: readonly AudioClipLite[],
): { clipIdx: number; offsetSec: number } | null {
  if (!clips.length) return null;
  const target = normalizeTargetSec(sec);
  const playable = (c: AudioClipLite) => Boolean(c.segmentId && c.url && !c.missingAudio);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (target >= c.startSec && target < c.endSec) {
      if (playable(c)) {
        return { clipIdx: i, offsetSec: Math.max(0, target - c.startSec) };
      }
      // Inside a missing-audio strip: jump to the next playable clip.
      for (let j = i + 1; j < clips.length; j++) {
        if (playable(clips[j])) return { clipIdx: j, offsetSec: 0 };
      }
      return null;
    }
  }
  // Past or before any clip: pick the next playable, else the last playable.
  for (let i = 0; i < clips.length; i++) {
    if (clips[i].startSec >= target && playable(clips[i])) return { clipIdx: i, offsetSec: 0 };
  }
  for (let i = clips.length - 1; i >= 0; i--) {
    if (playable(clips[i])) return { clipIdx: i, offsetSec: 0 };
  }
  return null;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(function AudioPlayer(
  { segments, clips, onPlayingChange, onPlaybackSecChange },
  ref,
) {
  const clipsRef = useRef<AudioClipLite[]>(clips);
  clipsRef.current = clips;
  const onPlaybackSecChangeRef = useRef(onPlaybackSecChange);
  onPlaybackSecChangeRef.current = onPlaybackSecChange;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const clipIndexRef = useRef(0);
  /** When set, the next play() should resume from this offset within clipIndexRef rather than 0. */
  const pendingOffsetRef = useRef<number | null>(null);

  const validSegments = useMemo(() => segments.filter((s) => Boolean(s.url)), [segments]);

  // Keep the current clip index in range when segments shrink (delete/replace mid-playback).
  useEffect(() => {
    if (clipIndexRef.current >= validSegments.length) {
      clipIndexRef.current = Math.max(0, validSegments.length - 1);
    }
  }, [validSegments]);

  const setPlayingState = useCallback(
    (val: boolean) => {
      playingRef.current = val;
      setPlaying(val);
      onPlayingChange?.(val);
    },
    [onPlayingChange],
  );

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'auto';
    }
    return audioRef.current;
  }, []);

  const playClip = useCallback(
    (idx: number) => {
      const seg = validSegments[idx];
      if (!seg) {
        setPlayingState(false);
        clipIndexRef.current = 0;
        return;
      }
      const el = ensureAudio();
      const sameSrc = el.src?.endsWith(seg.url);
      if (!sameSrc) {
        el.src = seg.url;
        el.load();
      }
      const pending = pendingOffsetRef.current;
      pendingOffsetRef.current = null;
      const applyOffset = () => {
        if (pending != null && Number.isFinite(pending) && pending > 0) {
          try {
            el.currentTime = pending;
          } catch {
            /* ignore */
          }
        } else if (!sameSrc) {
          try {
            el.currentTime = 0;
          } catch {
            /* ignore */
          }
        }
        el.play().catch(() => setPlayingState(false));
      };
      if (el.readyState >= 1 && sameSrc) {
        applyOffset();
      } else {
        const onMeta = () => {
          el.removeEventListener('loadedmetadata', onMeta);
          applyOffset();
        };
        el.addEventListener('loadedmetadata', onMeta, { once: true });
      }
      clipIndexRef.current = idx;
      setPlayingState(true);
    },
    [validSegments, ensureAudio, setPlayingState],
  );

  // Wire ended → advance to next clip
  useEffect(() => {
    const el = ensureAudio();
    const onEnded = () => {
      const next = clipIndexRef.current + 1;
      if (next < validSegments.length) {
        playClip(next);
      } else {
        setPlayingState(false);
        clipIndexRef.current = 0;
      }
    };
    const onPause = () => {
      if (playingRef.current) setPlayingState(false);
    };
    const onPlay = () => setPlayingState(true);
    const onError = () => {
      // src detach (session-switch reset) also surfaces here with no currentSrc; stay quiet.
      if (!el.currentSrc) return;
      if (playingRef.current) toast.error('Audio failed to load.');
      setPlayingState(false);
    };
    el.addEventListener('ended', onEnded);
    el.addEventListener('pause', onPause);
    el.addEventListener('play', onPlay);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('error', onError);
    };
  }, [ensureAudio, validSegments, playClip, setPlayingState]);

  // While playing, push the absolute timeline second to React state so the playhead
  // and timecode readout stay in sync.
  useEffect(() => {
    if (!playing) {
      onPlaybackSecChangeRef.current?.(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      const seg = validSegments[clipIndexRef.current];
      const clip = seg ? clipsRef.current.find((c) => c.segmentId === seg.id) : null;
      if (el && clip) {
        const sec = Math.max(0, clip.startSec + (Number(el.currentTime) || 0));
        onPlaybackSecChangeRef.current?.(sec);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      onPlaybackSecChangeRef.current?.(null);
    };
  }, [playing, validSegments]);

  const toggle = useCallback(() => {
    if (validSegments.length === 0) return;
    const el = ensureAudio();
    if (playingRef.current) {
      el.pause();
    } else {
      playClip(clipIndexRef.current < validSegments.length ? clipIndexRef.current : 0);
    }
  }, [validSegments, ensureAudio, playClip]);

  // Shared by seekToTimelineSec (non-playing: resumes only if wasPlaying) and
  // seekToTimelineSecAndPlay (feed-row-seek design D1: always ends up playing —
  // starts on a paused player, continues without restarting on a playing one).
  // `forcePlay` is the only behavioral difference between the two public methods.
  const seekToPosition = useCallback(
    (sec: number, forcePlay: boolean) => {
      const target = resolvePlayPosition(sec, clipsRef.current);
      if (!target) return;
      const clip = clipsRef.current[target.clipIdx];
      // Map the matching clip's segmentId back to validSegments index (skipping segments with no URL).
      const idx = validSegments.findIndex((s) => s.id === clip.segmentId);
      if (idx < 0) return;
      const wasPlaying = playingRef.current;
      const shouldPlay = forcePlay || wasPlaying;
      const el = ensureAudio();
      pendingOffsetRef.current = target.offsetSec;
      clipIndexRef.current = idx;
      // Reflect the playing state immediately when starting fresh playback (mirrors
      // playClip's synchronous UI feedback) — don't wait on the deferred applyOffset
      // below, which may not run until a loadedmetadata event fires.
      if (forcePlay && !wasPlaying) setPlayingState(true);
      const seg = validSegments[idx];
      const sameSrc = el.src?.endsWith(seg.url);
      if (!sameSrc) {
        el.src = seg.url;
        el.load();
      }
      const applyOffset = () => {
        try {
          el.currentTime = target.offsetSec;
        } catch {
          /* ignore */
        }
        if (shouldPlay) {
          pendingOffsetRef.current = null;
          // Autoplay policy: play() can reject (e.g. no user-gesture credit left);
          // fall back to reflecting the real paused state rather than an unhandled rejection.
          el.play().catch(() => setPlayingState(false));
        }
      };
      if (el.readyState >= 1 && sameSrc) {
        applyOffset();
      } else {
        const onMeta = () => {
          el.removeEventListener('loadedmetadata', onMeta);
          el.removeEventListener('error', onLoadError);
          applyOffset();
        };
        // Whole-branch audit fix wave, finding M5: the optimistic
        // `setPlayingState(true)` above fires before `el.load()` resolves.
        // If `loadedmetadata` never fires (bad codec, 404, aborted range),
        // nothing would otherwise reconcile the UI — `applyOffset`'s own
        // `play().catch()` never runs because `applyOffset` itself never
        // runs. This listener is that reconciliation, local to this seek
        // attempt; the shared top-level `error` handler (in the "Wire ended"
        // effect above) still separately owns the user-facing toast.
        const onLoadError = () => {
          el.removeEventListener('loadedmetadata', onMeta);
          el.removeEventListener('error', onLoadError);
          setPlayingState(false);
        };
        el.addEventListener('loadedmetadata', onMeta, { once: true });
        el.addEventListener('error', onLoadError, { once: true });
      }
    },
    [validSegments, ensureAudio, setPlayingState],
  );

  const seekToTimelineSec = useCallback(
    (sec: number) => seekToPosition(sec, false),
    [seekToPosition],
  );
  const seekToTimelineSecAndPlay = useCallback(
    (sec: number) => seekToPosition(sec, true),
    [seekToPosition],
  );

  useImperativeHandle(
    ref,
    () => ({
      toggle,
      isPlaying: () => playingRef.current,
      seekToTimelineSec,
      seekToTimelineSecAndPlay,
    }),
    [toggle, seekToTimelineSec, seekToTimelineSecAndPlay],
  );

  // Pause and reset when segments list changes (session switch).
  // segments identity changes on session switch even if length is the same.
  // biome-ignore lint/correctness/useExhaustiveDependencies: segments identity reset
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }
    pendingOffsetRef.current = null;
    setPlayingState(false);
    clipIndexRef.current = 0;
  }, [segments, setPlayingState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  // Space bar: play/pause (when not in a text input, no dialog open, and not
  // consumed by a focused interactive element — ui-refresh D14).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented) return;
      if (isTypingTarget(document.activeElement)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (isKeyConsumingInteractiveTarget(e.target)) return;
      if (validSegments.length === 0) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, validSegments]);

  // Keep unused var warnings away
  void playing;

  return null;
});
