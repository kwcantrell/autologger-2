// ai-v2-dashboards — in-process MCP aggregate tools (design D4, spec
// "Session-scoped aggregate toolset"). Task 2.4.
//
// Per-turn factory: `buildAggregateMcpServer(sessionId, registry)` builds a
// FRESH `createSdkMcpServer()` instance bound to exactly one session.
// `sessionId` is captured in this function's closure and is NEVER accepted
// as a tool parameter (spec: "The session SHALL be bound by the turn and
// SHALL NOT be accepted as a tool parameter") — no schema below declares a
// session-id field, so an agent has no argument through which to address a
// different session.
//
// Call this once PER DESIGN TURN (Unit C, tasks 2.5/2.6 wire the result into
// the SDK's `mcpServers` option). Never memoize or hoist the returned server
// to module scope: two concurrent turns on different sessions must each get
// their own server instance, closed over their own `sessionId`, or the
// closures would cross and one turn's tools could read another session's
// data.
//
// Each tool handler resolves the hub via `registry.get(sessionId)` AT CALL
// TIME, inside the handler body, and never holds the handle across an
// `await` — the idle-eviction sweeper can close a hub between calls on a
// long-running turn. This mirrors the identical invariant already shipped
// in `../ai-runtime/aiMcpServer.ts` (`buildSessionMcpServer`) for the AI chat's
// loopback MCP tools; the SDK's in-process `createSdkMcpServer` is a
// different transport (no HTTP hop, no bearer token) but the same hub-
// resolution discipline applies because the SAME idle-eviction sweeper can
// fire underneath either one.
//
// Tools expose the Phase-1 aggregates (./aggregates.ts) computed over hub
// rows read through SessionHub's SYNCHRONOUS read RPCs — never raw table
// dumps (design D4: "a designer agent needs shape ... not 12,000 word
// rows"). `transcript_excerpt` is the one tool that still returns a list; it
// is offset/limit-bounded, clamping any requested limit to the hard cap
// rather than trusting agent input, and states its own truncation, per spec:
// "any tool returning a list SHALL be bounded ... a truncated result SHALL
// state its truncation".
//
// Degraded-data honesty (design D2a/D2b, spec "Data unavailability is a
// rendered state, never a zero") is NOT re-derived here — every tool below
// passes through the `available`/`reason`/`null` shape `./aggregates.ts`
// already computes, verbatim, rather than re-deciding availability itself.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { DashboardConfig } from '@autologger/contract';
import { validateDashboardConfig } from '@autologger/contract';
import type { SessionHubRegistryFacade } from '@autologger/session-core';
import { z } from 'zod';
import {
  computeEventCounts,
  computeEventDensity,
  computeFillerStats,
  computeSessionDuration,
  computeTalkTimeBySpeaker,
  computeTopicTimeline,
  computeUtteranceStats,
} from './aggregates';

/** MCP server name for the per-turn aggregate toolset. Deliberately distinct
 * from `aiMcpServer.ts`'s `'autologger'` (the AI chat's loopback listener,
 * a different transport entirely) so the two agent features' tool
 * namespaces never collide in logs/traces/wire names. */
export const AGGREGATE_MCP_SERVER_NAME = 'autologger-aggregates';

/** The five tool short names exposed to a design turn. Wire names are
 * `mcp__${AGGREGATE_MCP_SERVER_NAME}__<tool>`. Exported for Unit C's
 * closed-world characterization test (task 2.3) and turn wiring (2.5/2.6). */
export const AGGREGATE_TOOL_NAMES = [
  'speaker_stats',
  'utterance_stats',
  'topic_timeline',
  'event_stats',
  'transcript_excerpt',
  'propose_dashboard',
] as const;

/** Hard cap on `topic_timeline`'s returned entries (spec: bounded list). */
const MAX_TOPIC_ENTRIES = 200;
/** Hard cap on `transcript_excerpt`'s page size, enforced by CLAMPING any
 * requested `limit` rather than trusting agent input (spec: bounded list). */
const MAX_EXCERPT_WORDS = 200;
const DEFAULT_EXCERPT_WORDS = 100;

/**
 * Task 5.4 (design D10): dependencies for the `propose_dashboard` tool below.
 * Optional so every existing caller/test that only needs the five read-only
 * aggregate tools (task 2.4) is unaffected.
 */
export interface BuildAggregateMcpServerDeps {
  /**
   * Invoked with the ALREADY-VALIDATED `DashboardConfig` when a proposal is
   * accepted — never invoked for a rejected one, and never invoked with raw/
   * unvalidated agent input. `aiV2.ts` wires this to a direct
   * `stream.writeSSE({ event: 'dashboard', ... })` on the design turn's own
   * stream (mirroring the `question` event's `onQuestion` callback, task
   * 3.1/3.2) — this module has no knowledge of SSE, HTTP, or persistence; it
   * only hands back a value that already passed the same whole-config
   * validator a user write is held to.
   */
  onProposeDashboard?: (config: DashboardConfig) => void | Promise<void>;
}

/**
 * Build a FRESH per-turn MCP server exposing session-scoped aggregate tools
 * plus (task 5.4) `propose_dashboard`, the single commit point for a design
 * turn's proposed dashboard. See the module header for the closure/call-time/
 * per-turn invariants this function exists to satisfy.
 */
export function buildAggregateMcpServer(
  sessionId: string,
  registry: SessionHubRegistryFacade,
  deps: BuildAggregateMcpServerDeps = {},
) {
  const speakerStats = tool(
    'speaker_stats',
    "Per-speaker talk time and the session's total duration, derived from " +
      'word timings. Speaker ids are diarization indices (e.g. "0", "1"), ' +
      'not resolved display names. Unavailable — never reported as zero — ' +
      'when the transcript has no words or no word timings (manually ' +
      'entered, or not anchored to recorded audio); check `available` ' +
      'before reading `durationSec`/`bySpeaker`.',
    {},
    async () => {
      // Hub resolved AT CALL TIME — never held across an await.
      const words = registry.get(sessionId).listTranscriptWords();
      const duration = computeSessionDuration(words);
      const talkTime = computeTalkTimeBySpeaker(words);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              available: talkTime.available,
              reason: talkTime.reason,
              durationSec: duration.durationSec,
              bySpeaker: talkTime.bySpeaker,
            }),
          },
        ],
      };
    },
  );

  const utteranceStats = tool(
    'utterance_stats',
    'Utterance/question counts (from persisted DeepGram paragraph ' +
      'boundaries) and filler-word counts (from raw transcript words). The ' +
      'two sub-objects have INDEPENDENT availability: paragraph counts ' +
      'require a DeepGram-generated transcript; filler counts only require ' +
      "the transcript to be non-empty. Check each sub-object's own " +
      '`available` before reading its numeric fields — never treat a ' +
      'missing value as zero.',
    {},
    async () => {
      const hub = registry.get(sessionId);
      const words = hub.listTranscriptWords();
      const { paragraphs } = hub.listTranscriptEnrichment();
      const utterances = computeUtteranceStats(paragraphs);
      const fillers = computeFillerStats(words);
      return { content: [{ type: 'text', text: JSON.stringify({ utterances, fillers }) }] };
    },
  );

  const topicTimeline = tool(
    'topic_timeline',
    'Session topics in chronological order (raw session_time strings, ' +
      'passed through verbatim — no invented numeric precision). Always ' +
      'available: an empty list is a real, measured empty session, not an ' +
      `unavailable state. Bounded to ${MAX_TOPIC_ENTRIES} entries; a ` +
      '`truncated: true` result means more topics exist than were returned ' +
      '— never treat the returned entries as the complete set.',
    {},
    async () => {
      const topics = registry.get(sessionId).listTopics();
      const timeline = computeTopicTimeline(topics);
      const truncated = timeline.entries.length > MAX_TOPIC_ENTRIES;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              entries: timeline.entries.slice(0, MAX_TOPIC_ENTRIES),
              truncated,
            }),
          },
        ],
      };
    },
  );

  const eventStats = tool(
    'event_stats',
    'Event counts by category id (the id is opaque — display LABELS live ' +
      "in the catalog DB, outside this tool's scope) and events-per-minute " +
      'density. Density is unavailable — never reported as zero — when ' +
      'session duration cannot be derived from word timings; check ' +
      '`density.available` before reading `density.eventsPerMinute`.',
    {},
    async () => {
      const hub = registry.get(sessionId);
      const words = hub.listTranscriptWords();
      const events = hub.exportEvents();
      const duration = computeSessionDuration(words);
      const counts = computeEventCounts(events);
      const density = computeEventDensity(events, duration.durationSec);
      return { content: [{ type: 'text', text: JSON.stringify({ counts, density }) }] };
    },
  );

  const transcriptExcerpt = tool(
    'transcript_excerpt',
    'A bounded, offset-paginated window of raw transcript words — use this ' +
      'for verbatim wording; use speaker_stats/utterance_stats for shape. ' +
      `Returns at most ${MAX_EXCERPT_WORDS} words per call regardless of ` +
      'the requested `limit` (larger requests are clamped). A ' +
      '`truncated: true` result means the transcript continues past this ' +
      'window — call again with a larger `offset` for more, and never ' +
      'treat one excerpt as the whole transcript.',
    {
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Zero-based word index to start from (default 0).'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          `Words to return, clamped to ${MAX_EXCERPT_WORDS} max (default ${DEFAULT_EXCERPT_WORDS}).`,
        ),
    },
    async (args) => {
      // Hub resolved AT CALL TIME — never held across an await.
      const words = registry.get(sessionId).listTranscriptWords();
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      const limit = Math.min(
        MAX_EXCERPT_WORDS,
        Math.max(1, Math.trunc(args.limit ?? DEFAULT_EXCERPT_WORDS)),
      );
      const page = words.slice(offset, offset + limit);
      const truncated = offset + page.length < words.length;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              words: page.map((w) => ({
                speaker: w.speaker,
                word: w.word,
                session_time: w.session_time,
              })),
              offset,
              returned: page.length,
              totalWords: words.length,
              truncated,
            }),
          },
        ],
      };
    },
  );

  // ── Task 5.4 — propose_dashboard (design D10, spec "Dashboards are edited
  // directly" + "Dashboard persistence"). The SINGLE commit point for a
  // design turn's proposed dashboard: it validates the WHOLE config against
  // the SAME Phase-1 catalog/layout schema a user write is held to
  // (`validateDashboardConfig`, imported from ./catalog — never re-derived
  // here), so agent-authored config (attacker-influenced: transcript content
  // can steer the agent) cannot bypass a single constraint a user write is
  // subject to. `sessionId` is not accepted as an input field — this tool
  // does not read or write session data itself, only hands a validated value
  // to `deps.onProposeDashboard` for the caller (aiV2.ts) to stream and,
  // later, persist through the existing Phase-5 store.
  //
  // Input schema is DELIBERATELY loose (each widget/interaction is an
  // untyped record) — the authoritative check is `validateDashboardConfig`
  // in the handler body, not this tool's own JSON-schema shape, so there is
  // exactly ONE place the accept/reject decision is made and it is the same
  // function every other entry point (the persistence PUT route, task 5.2)
  // already calls.
  const proposeDashboard = tool(
    'propose_dashboard',
    'Commit your proposed starting dashboard for this session. The WHOLE ' +
      'configuration is validated against the widget catalog and layout ' +
      'vocabulary before it ever reaches the user — an unknown widget type, ' +
      'a duplicate widget id, a dangling interaction reference, or a title ' +
      'containing markup/URL/code content is rejected and NOTHING is shown ' +
      'or saved. On rejection, fix the reported issues and call this tool ' +
      'again; on acceptance the user sees your proposal immediately and can ' +
      'keep or discard it themselves. Provide `widgets` (each an object with ' +
      'id, type — one of the catalog widget types — title, x, y, w, h) and ' +
      'optionally `interactions` (each an object with kind — ' +
      'highlight_speaker | filter_by_topic | scroll_to_time — sourceWidgetId, ' +
      'targetWidgetId).',
    {
      widgets: z
        .array(z.record(z.unknown()))
        .describe('Widget instances: id, type, title, x, y, w, h.'),
      interactions: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('Optional cross-widget interactions: kind, sourceWidgetId, targetWidgetId.'),
    },
    async (args) => {
      const result = validateDashboardConfig({
        widgets: args.widgets,
        interactions: args.interactions ?? [],
      });
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                accepted: false,
                errors: result.error.issues.map((issue) => issue.message),
              }),
            },
          ],
          isError: true,
        };
      }
      // Only the VALIDATED, typed value is ever handed onward — never the
      // raw agent-supplied `args`.
      await deps.onProposeDashboard?.(result.data);
      return { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] };
    },
  );

  return createSdkMcpServer({
    name: AGGREGATE_MCP_SERVER_NAME,
    version: '0.1.0',
    tools: [
      speakerStats,
      utteranceStats,
      topicTimeline,
      eventStats,
      transcriptExcerpt,
      proposeDashboard,
    ],
  });
}
