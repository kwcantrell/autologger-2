import { createContext, type ReactNode, useContext } from 'react';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';

// --- Shared audio-clip layout (whole-branch audit fix wave, finding C1/I3) ---
//
// `SessionWorkspace` computes ONE `useAudioClips(sessionId, events)` layout —
// the same one `AudioPlayer` plays from — and publishes it here. Every
// feed-jump coverage check (`useTimelineSeek`) reads THIS context instead of
// calling `useAudioClips` a second (third, fourth...) time with its own,
// differently-limited `events` query.
//
// Why this must be structural, not a convention: before this fix, each of
// EventLogSheet/TranscribeFeed/TopicsFeed called `useAudioClips(sessionId,
// events)` with its OWN `useEvents` result (limit 200), while
// `SessionWorkspace` → `AudioPlayer` used a separate `useEvents(sessionId,
// { limit: 2000 })`. Different React Query cache keys (`limit` in the key) =
// separate fetches, separate data, no dedupe. Events are served `ORDER BY
// wall_time_utc ASC`, so a limit of 200 truncates the TAIL — and
// `rebuildAudioClips` pairs each audio segment to its `Recording N
// Started/Stopped` event; a segment whose pairing event falls outside a
// truncated window gets chained at a FABRICATED position instead of its real
// one. A coverage check run against that fabricated layout can disagree with
// the player's real layout — reporting a genuine inter-recording gap as
// "covered", or vice versa — and issuing the play-capable seek in that state
// cues a DIFFERENT recording than the one the playhead shows (design D6's
// hazard, amplified by D1: a wrong jump now plays audio). A single published
// layout makes "the coverage check and the player agree" true by
// construction rather than by two call sites independently choosing the same
// limit.
//
// Consumers that render outside a `SessionWorkspace` (most tests) get an
// empty layout by default — the same "no coverage" default the old
// `mockedUseAudioClips.mockReturnValue({ clips: [], ... })` pattern already
// established, so most existing tests need no changes.
//
// Publishes the array DIRECTLY (quality fix wave, FIX 3) — not `{ clips:
// AudioClipLite[] }`. The wrapper object was what made
// `<AudioClipsProvider value={{ clips: audioClips }}>` in `SessionWorkspace`
// structurally unable to be referentially stable: a fresh object literal every
// render, even when `audioClips` itself was unchanged, forcing every context
// consumer to re-render on every `SessionWorkspace` render (~60/s during
// playback, from the rAF-driven `audioPlaybackSec` tick). Publishing the array
// dissolves that residual with no compensating `useMemo` — `value={audioClips}`
// is stable exactly when `useAudioClips`'s memoized result is.

const EMPTY_CLIPS: readonly AudioClipLite[] = Object.freeze([]);

const AudioClipsContext = createContext<readonly AudioClipLite[]>(EMPTY_CLIPS);

export function AudioClipsProvider({
  clips,
  children,
}: {
  clips: readonly AudioClipLite[];
  children: ReactNode;
}) {
  return <AudioClipsContext.Provider value={clips}>{children}</AudioClipsContext.Provider>;
}

/** Read the session-wide audio-clip layout `SessionWorkspace` publishes. Outside a
 *  provider (e.g. a feed rendered standalone in a test) this reads as an empty
 *  layout — no clip covers anything, matching the old test-mock default (the
 *  fail-safe: no clips ⇒ no coverage ⇒ no playback). */
export function useAudioClipsContext(): readonly AudioClipLite[] {
  return useContext(AudioClipsContext);
}
