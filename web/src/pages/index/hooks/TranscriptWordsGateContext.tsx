import { createContext, type ReactNode, useContext, useMemo } from 'react';

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

// SECOND FIELD — `dashboardsTabActive` (review fix): the Dashboards tab is not
// a words-dependent TAB (its panel needs the payload only when the displayed
// config contains a words-derived widget), so `useAiV2WidgetData` carries the
// config half of that condition itself. But it cannot see the tab, and
// `AiV2Panel` is one of the six always-mounted panels — it loads the persisted
// dashboard in a mount effect, so without the tab half a saved dashboard
// containing any words widget re-armed the fetch on EVERY session mount while
// the user sat on the Events tab, defeating the deferral this gate exists for.
// Publishing the tab's activity here (rather than latching a second sticky
// flag in the workspace) keeps ONE latch per consumer: this field is a plain
// "is the Dashboards tab showing right now", and the stickiness stays where it
// already lived, in `useAiV2WidgetData`'s own ref.
//
// Its default is `true` for the same fail-open reason as `wordsGateOpen`: no
// gate in scope ⇒ the config check alone decides, exactly as before this field
// existed.

interface TranscriptWordsGateValue {
  /** Sticky: a words-dependent TAB has been activated for this session. */
  readonly wordsGateOpen: boolean;
  /** Not sticky: the Dashboards tab is the currently selected tab. */
  readonly dashboardsTabActive: boolean;
}

const DEFAULT_VALUE: TranscriptWordsGateValue = {
  wordsGateOpen: true,
  dashboardsTabActive: true,
};

const TranscriptWordsGateContext = createContext<TranscriptWordsGateValue>(DEFAULT_VALUE);

export function TranscriptWordsGateProvider({
  enabled,
  dashboardsTabActive,
  children,
}: {
  enabled: boolean;
  dashboardsTabActive: boolean;
  children: ReactNode;
}) {
  const value = useMemo<TranscriptWordsGateValue>(
    () => ({ wordsGateOpen: enabled, dashboardsTabActive }),
    [enabled, dashboardsTabActive],
  );
  return (
    <TranscriptWordsGateContext.Provider value={value}>
      {children}
    </TranscriptWordsGateContext.Provider>
  );
}

/** Read the workspace's "transcript words are needed" latch. Outside a provider
 *  (e.g. a feed rendered standalone in a test) this reads `true` — the
 *  pre-gate, always-fetch behaviour. See the module header for why. */
export function useTranscriptWordsGate(): boolean {
  return useContext(TranscriptWordsGateContext).wordsGateOpen;
}

/** Read whether the Dashboards tab is currently the selected feed tab. The
 *  dashboards-side words trigger (`useAiV2WidgetData`) ANDs its config check
 *  with this, so a saved words widget cannot pull the payload for a panel the
 *  user has never shown. Outside a provider this reads `true` — see above. */
export function useDashboardsTabActive(): boolean {
  return useContext(TranscriptWordsGateContext).dashboardsTabActive;
}
