import { createContext, type ReactNode, useContext } from 'react';

// --- Deferred transcript-words fetch (perf plan B4) ---
//
// The transcript word list is the biggest payload the session workspace pulls
// (multi-MB on a long session), and until this gate existed it was pulled
// unconditionally on session mount: `SessionWorkspace` keeps ALL six feed
// panels mounted (hidden via the `hidden` attribute, never unmounted — design
// D9's mount discipline), so TranscribeFeed/TopicsFeed/ExportFeed and
// AiV2Panel's `useAiV2WidgetData` each called `useTranscriptWords` from the
// first render, whether or not the user ever opened those tabs.
//
// `SessionWorkspace` publishes ONE boolean here — "the words are needed now" —
// and those consumers pass it as `useTranscriptWords(sessionId, { enabled })`.
// The latch is STICKY (never flips back to false for a session) so switching
// away from Transcript can't cancel/re-issue the fetch, and it RESETS on
// session change (`SessionWorkspace` does not remount per session — see the
// `prevSessionIdRef` compare there) so session B never inherits session A's
// activation.
//
// Panel lifecycles are untouched: this changes only the `enabled` flag on a
// query, never what is mounted.
//
// WHY THE DEFAULT IS `true` — and why that is load-bearing, not a shrug:
// consumers rendered OUTSIDE a `SessionWorkspace` (every colocated feed test,
// and any future standalone mount) read this default. A default of `false`
// would silently disable the fetch for all of them, turning "no provider" into
// "no data" and rewriting the behaviour of tests that never opted into the
// gate. `true` means "no gate in scope ⇒ behave exactly as before the gate
// existed" — the fail-open direction is the correct one here, because the
// worst case is the old (already-shipped) unconditional fetch, whereas
// fail-closed would be a silent data regression. The same reasoning the
// colocated `AudioClipsContext` applies to ITS default, pointed the other way:
// there the safe default is the inert one (no clips ⇒ no coverage ⇒ no
// playback), here the safe default is the unchanged one.

const TranscriptWordsGateContext = createContext<boolean>(true);

export function TranscriptWordsGateProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <TranscriptWordsGateContext.Provider value={enabled}>
      {children}
    </TranscriptWordsGateContext.Provider>
  );
}

/** Read the workspace's "transcript words are needed" latch. Outside a provider
 *  (e.g. a feed rendered standalone in a test) this reads `true` — the
 *  pre-gate, always-fetch behaviour. See the module header for why. */
export function useTranscriptWordsGate(): boolean {
  return useContext(TranscriptWordsGateContext);
}
