// ai-v2-dashboards — real widget data for the renderer (task 5.6; design
// D11; spec "Data unavailability is a rendered state" + "Session-scoped
// aggregate toolset"). Replaces the Phase-4 `widgetData={{}}` placeholder in
// `AiV2Panel.tsx` with the session's REAL data, computed client-side from
// the same hooks the Transcript/Topics/Events tabs already use — no new
// HTTP route (D11).
//
// Aggregates are computed ONCE per render (memoized on the four hooks'
// `data`) and then fanned out to every widget of the matching type — talk
// time, session duration, etc. are session-level facts, not per-widget-
// instance facts, so two `event_density` widgets on the same dashboard get
// the identical computed value, never two independently-drifting copies.
//
// `utterance_counts`/`question_counts` always receive `[]` paragraphs — the
// web has no route for persisted DeepGram paragraphs (`persist-deepgram-
// enrichment` shipped that as an in-process hub read, agent-only, no HTTP
// surface; D11 forbids adding one here). `computeUtteranceStats([])` always
// returns the honest unavailable state, so these two widget types render
// "unavailable" in the CLIENT-rendered dashboard even on sessions whose
// transcript DOES have persisted paragraphs — a known, accepted consequence
// of "no new HTTP route", not a bug (see clientAggregates.ts's own comment).

import { useMemo, useRef } from 'react';
import { useEvents } from '../../../../api/hooks/useEvents';
import { useShowCategories } from '../../../../api/hooks/useShowCategories';
import { useTopics } from '../../../../api/hooks/useTopics';
import { useTranscriptWords } from '../../../../api/hooks/useTranscriptWords';
import type { Category } from '../../../../api/types';
import {
  useDashboardsTabActive,
  useTranscriptWordsGate,
} from '../../hooks/TranscriptWordsGateContext';
import {
  computeEventCounts,
  computeEventDensity,
  computeFillerStats,
  computeSessionDuration,
  computeTalkTimeBySpeaker,
  computeTopicTimeline,
  computeTranscriptExcerpt,
  computeUtteranceStats,
} from './clientAggregates';
import type { CatalogWidgetData } from './widgetRegistry';
import type { WidgetLayout, WidgetType } from './widgetTypes';

/** Bounded, matching the server's own clamp on this route
 * (`server/src/routers/events.ts`'s `clampInt(..., 200, 1, 2000)`) — the
 * client-rendered dashboard's event-derived widgets (`event_count_by_category`/
 * `event_density`) reflect at most the first 2000 events, same as any other
 * caller of this frozen endpoint would; there is no unbounded "export all
 * events" path this renderer is allowed to use (D11: existing endpoints only). */
const EVENTS_LIMIT = 2000;

/** Well-known system category (D2a): every existing tab treats
 * `category === 'internal'` (case-insensitively) as a real, recognized
 * category — never an agent/user-authored one — matching
 * `server/src/studio.ts`'s `enrichEventRpc` special case. Resolving it here
 * is NOT fabricating a label; it is the same constant the rest of the app
 * already uses (`EventLogRow.tsx`, `Timeline.tsx`, `MarkerNav.tsx`, etc.). */
const INTERNAL_CATEGORY_LABEL = 'Internal';

/** Category id -> display label, built from the web's existing
 * `useShowCategories` source (the same one `CategoryButtonStrip` uses) plus
 * the `internal` special case. Always returns a defined object (never
 * `undefined`) — even before `categories` has loaded — so
 * `EventCountByCategoryWidget` always sees "a resolution was attempted" and
 * never falls back to rendering a bare opaque id (D2a). */
/** Widget types whose data is derived from the transcript word list (perf plan
 * B4) — exactly the `switch` cases below that gate on `wordsLoading`, including
 * `event_density`, which needs the word-derived duration as well as the events.
 * A SHOWN dashboard containing ANY of these needs the multi-MB words payload
 * even when the user never opens a words-dependent TAB, so this set — ANDed
 * with the Dashboards tab being active, see the hook body — is the second
 * (dashboards-side) trigger for the deferred fetch. Keep it in step with the
 * `switch`: a words-derived case added there without an entry here would render
 * permanently empty on a session whose gate never opened. */
const WORDS_WIDGET_TYPES: ReadonlySet<WidgetType> = new Set<WidgetType>([
  'session_duration',
  'talk_time_by_speaker',
  'filler_counts',
  'event_density',
  'transcript_excerpt',
]);

function buildCategoryLabelMap(categories: Category[] | undefined): Record<string, string> {
  const map: Record<string, string> = { internal: INTERNAL_CATEGORY_LABEL };
  for (const c of categories ?? []) map[c.id] = c.label;
  return map;
}

/**
 * Computes every catalog aggregate for `sessionId` and maps the result onto
 * `widgets` by their configured `type`, keyed by widget instance id — the
 * exact shape `DashboardGrid`/`DashboardEditor`'s `widgetData` prop expects.
 * A widget whose type has no matching case here is simply omitted (the
 * grid/editor already render their own "no data provided" placeholder for a
 * missing entry — this never happens for a config that passed catalog
 * validation, since every registered `WidgetType` is handled below).
 */
export function useAiV2WidgetData(
  sessionId: string | null,
  widgets: WidgetLayout[],
): Record<string, CatalogWidgetData> {
  // --- Deferred transcript-words fetch (perf plan B4) ---
  //
  // This hook is the dashboards-side words consumer, and it has its OWN
  // trigger on top of the workspace tab latch: a config containing a
  // words-derived widget needs the payload even though the Dashboards tab
  // itself is not a words-dependent tab.
  //
  // That trigger is ANDed with the tab actually being SHOWN (review fix). The
  // config half alone was not enough of a condition: `AiV2Panel` is one of the
  // six always-mounted panels and loads the persisted dashboard in a mount
  // effect, so `widgets` is populated on session mount — a user whose saved
  // dashboard happens to contain any of the five words widgets pulled the
  // multi-MB payload on every session mount while sitting on the Events tab,
  // which is precisely what the deferral exists to prevent. Nothing is lost:
  // the widgets cannot render before their tab is shown.
  //
  // Sticky, for the same reason the workspace latch is: leaving the tab, or
  // editing a words widget out of the config, must not cancel the fetch its
  // siblings may still need. The stickiness lives HERE and only here — the
  // published `dashboardsTabActive` is a plain "showing right now", so there is
  // no second sticky latch (and no second reset mechanism) to keep in step.
  // `AiV2Panel` mounts this with `key={sessionId}`, so a session change
  // remounts the panel and this ref starts over — no `prevSessionIdRef` compare
  // needed here.
  const gateOpen = useTranscriptWordsGate();
  const dashboardsTabActive = useDashboardsTabActive();
  const wordsNeeded =
    gateOpen || (dashboardsTabActive && widgets.some((w) => WORDS_WIDGET_TYPES.has(w.type)));
  const wordsEnabledRef = useRef(false);
  if (wordsNeeded) wordsEnabledRef.current = true;
  const wordsEnabled = wordsEnabledRef.current;

  const wordsQuery = useTranscriptWords(sessionId, { enabled: wordsEnabled });
  const topicsQuery = useTopics(sessionId);
  const eventsQuery = useEvents(sessionId, { limit: EVENTS_LIMIT });
  const categoriesQuery = useShowCategories(sessionId);

  const words = wordsQuery.data;
  const topics = topicsQuery.data;
  const events = eventsQuery.data?.events;
  const categories = categoriesQuery.data?.categories;

  // Whole-branch audit fix wave (Fix 5): "still loading" and "genuinely
  // empty" are different facts that the old `words ?? []`/`topics ?? []`/
  // `events ?? []` coalescing collapsed into one — during the FIRST fetch
  // (no cached data yet) a widget would briefly render its real "No X
  // recorded"/unavailable text, as though the session had been measured and
  // found empty, rather than "the fetch hasn't returned yet". `isLoading`
  // (react-query v5: no data AND actively fetching) is the honest per-source
  // signal; once a query has EVER resolved, `isLoading` stays `false` even
  // during a later background refetch, so an already-loaded widget's real
  // data (including a genuinely empty result) is never withheld.
  //
  // Perf plan B4 amends the WORDS signal only, because words are now the one
  // source that can be pending WITHOUT being fetched. `isLoading` is
  // react-query v5's `isPending && isFetching`, so it answers "no data yet AND
  // a request is in flight" — for an always-on query those are the same
  // question, but for a gated one they are not.
  //
  // Measured, not assumed: on the render where `enabled` flips true,
  // react-query's optimistic result ALREADY reports `isFetching` (it knows it
  // is about to fetch), so `isLoading` is true there too — the enable-flip
  // "empty flash" this change was expected to fix does not reproduce on v5.
  // What DOES diverge is a pending query that is not fetching: `enabled` false
  // (the shut gate), and a query PAUSED because the browser is offline. In
  // both, `isLoading` is `false` with `data === undefined`, so reading it would
  // publish `words ?? []` — the settled "This session has no transcript words
  // yet." answer — for a session that has never been measured at all. That is
  // exactly the zeros-as-data claim Fix 5 removed, so the words signal reads
  // `isPending && wordsEnabled` instead: "enabled, and no data yet". No
  // withhold is reintroduced on background refetches — once a query has
  // resolved, `isPending` stays `false` forever, just like `isLoading`. The
  // shut-gate case resolves to `false` here and the `?? []` defaults apply, but
  // no words widget can be on screen in that state: a words widget in the
  // config of a SHOWN Dashboards tab is itself what opens the gate, and a
  // hidden panel's widgets are not rendered.
  const wordsLoading = wordsEnabled && wordsQuery.isPending;
  const topicsLoading = topicsQuery.isLoading;
  const eventsLoading = eventsQuery.isLoading;

  return useMemo(() => {
    const wordsSafe = words ?? [];
    const topicsSafe = topics ?? [];
    const eventsSafe = events ?? [];

    const duration = computeSessionDuration(wordsSafe);
    const talkTime = computeTalkTimeBySpeaker(wordsSafe);
    // No paragraph source client-side (see module header) — always [].
    const utterance = computeUtteranceStats([]);
    const filler = computeFillerStats(wordsSafe);
    const topicTimeline = computeTopicTimeline(topicsSafe);
    const eventCounts = computeEventCounts(eventsSafe);
    const eventDensity = computeEventDensity(eventsSafe, duration.durationSec);
    const excerpt = computeTranscriptExcerpt(wordsSafe);
    const categoryLabels = buildCategoryLabelMap(categories);

    const out: Record<string, CatalogWidgetData> = {};
    for (const w of widgets) {
      switch (w.type) {
        case 'session_duration':
          if (wordsLoading) break;
          out[w.id] = { widgetType: 'session_duration', sessionDuration: duration };
          break;
        case 'talk_time_by_speaker':
          if (wordsLoading) break;
          out[w.id] = { widgetType: 'talk_time_by_speaker', talkTimeBySpeaker: talkTime };
          break;
        case 'utterance_counts':
          // No live fetch backs this (see module header — always `[]`), so
          // there is no "loading" window to distinguish from "unavailable".
          out[w.id] = { widgetType: 'utterance_counts', utteranceCounts: utterance };
          break;
        case 'question_counts':
          out[w.id] = { widgetType: 'question_counts', questionCounts: utterance };
          break;
        case 'filler_counts':
          if (wordsLoading) break;
          out[w.id] = { widgetType: 'filler_counts', fillerCounts: filler };
          break;
        case 'topic_timeline':
          if (topicsLoading) break;
          out[w.id] = { widgetType: 'topic_timeline', topicTimeline };
          break;
        case 'event_count_by_category':
          if (eventsLoading) break;
          out[w.id] = {
            widgetType: 'event_count_by_category',
            eventCountByCategory: eventCounts,
            categoryLabels,
          };
          break;
        case 'event_density':
          // Depends on both the event count AND the word-derived duration.
          if (eventsLoading || wordsLoading) break;
          out[w.id] = { widgetType: 'event_density', eventDensity };
          break;
        case 'transcript_excerpt':
          if (wordsLoading) break;
          out[w.id] = { widgetType: 'transcript_excerpt', transcriptExcerpt: excerpt };
          break;
        default:
          // Exhaustiveness guard: every registered WidgetType is handled
          // above. An unrecognized type can only reach here via a config
          // that bypassed catalog validation — DashboardGrid/DashboardEditor
          // already render "no data provided" for a missing entry.
          break;
      }
    }
    return out;
  }, [widgets, words, topics, events, categories, wordsLoading, topicsLoading, eventsLoading]);
}
