// ai-v2-dashboards — widget catalog + layout/interaction schema (design
// D1/D2/D3, spec "Widget catalog is a closed set" and "Layout and
// interaction vocabulary"). Zod, mirroring server/src/schemas.ts conventions
// (bounded strings, explicit enums, no free-form/executable content). No
// I/O, no rendering, no persistence here — Phase 4 (render) and Phase 5
// (persist write-validation, design D5a whole-config validation) import
// `WIDGET_TYPES`, the schemas, and `validateDashboardConfig` from this
// module rather than re-deriving the catalog.
//
// Closed-set invariant (design D2): a widget type is registered here ONLY
// when the data it displays is derivable from stored session data. There is
// NO `sentiment_series`/`sentiment_by_topic` entry — DeepGram sentiment now
// persists (`persist-deepgram-enrichment`), but the widget is deliberately
// NOT registered in v1 (the spec bars it until a widget is actually wired to
// that data). Adding a type here is the only way to make it choosable; an
// agent or a hand-authored config naming anything else is rejected before it
// is ever stored or rendered.
//
// Interaction vocabulary (design D1): interactions are a NAMED vocabulary,
// never executable code or a free-form expression — `interactionKindSchema`
// is a closed `z.enum`, not a string accepting arbitrary content.

import { z } from 'zod';

// -- widget catalog (closed set) -------------------------------------------------

/** The full v1 widget catalog (design D2's table, minus the two sentiment
 * rows it marks "no persisted data" / the spec's "SHALL NOT be registered").
 * Each entry has a one-to-one aggregate producer in `./aggregates.ts`:
 *   talk_time_by_speaker      -> computeTalkTimeBySpeaker
 *   session_duration          -> computeSessionDuration
 *   utterance_counts          -> computeUtteranceStats (utteranceCount)
 *   question_counts           -> computeUtteranceStats (questionCount)
 *   filler_counts             -> computeFillerStats
 *   topic_timeline            -> computeTopicTimeline
 *   event_count_by_category   -> computeEventCounts
 *   event_density             -> computeEventDensity
 *   transcript_excerpt        -> (raw, bounded transcript window; Phase 2.4)
 * Adding a widget type means adding both a catalog entry here AND a producer
 * that can supply it from stored session data — never one without the other. */
export const WIDGET_TYPES = [
  'talk_time_by_speaker',
  'session_duration',
  'utterance_counts',
  'question_counts',
  'filler_counts',
  'topic_timeline',
  'event_count_by_category',
  'event_density',
  'transcript_excerpt',
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Unknown type -> rejected (spec: "An unknown widget type is rejected"). */
export const widgetTypeSchema = z.enum(WIDGET_TYPES);

// -- layout (grid position + size) -----------------------------------------------

/** Generous but bounded grid extents. `MAX_WIDGETS_PER_DASHBOARD` and
 * `MAX_INTERACTIONS_PER_DASHBOARD` are the AUTHORITATIVE per-dashboard bounds
 * (design D5b, task 5.3 — these replaced an earlier "structural sanity bound
 * only" framing; Phase 5's persistence write path enforces them by calling
 * `validateDashboardConfig`, the same function this module already exports,
 * rather than re-checking counts itself). `MAX_DASHBOARDS_PER_SESSION` and
 * `MAX_CONFIG_SERIALIZED_BYTES` round out D5b's three bounds
 * ("per-session dashboard count, per-dashboard widget count, and the
 * serialized size of a configuration SHALL each be bounded"); the
 * serialized-size check lives in this same schema's `.superRefine` below (a
 * config-content property, checkable with no session context), while the
 * per-session count is necessarily enforced by the session-DB store
 * (server/src/session/dashboardStore.ts), which needs to know how many
 * dashboards already exist for the session — these constants are exported so
 * that store imports the SAME numbers rather than re-deriving them,
 * preserving this module as the single source of truth for every ai-v2
 * bound. */
const GRID_MAX_COORD = 1000;
const GRID_MAX_EXTENT = 1000;
export const MAX_WIDGETS_PER_DASHBOARD = 64;
export const MAX_INTERACTIONS_PER_DASHBOARD = 128;
const MAX_WIDGET_ID_LEN = 64;
const MAX_TITLE_LEN = 200;

/** Design D5b: "the serialized size of a configuration SHALL each be
 * bounded". Deliberately set BELOW the theoretical maximum a fully-populated
 * config could reach under the widget/interaction/id/title bounds above
 * (~48KB at 64 max-length widgets + 128 max-length interactions) — a size
 * cap that could never bind before those structural caps do would be dead
 * code, not an independent bound. 12KB is generous for realistic dashboards
 * (a dozen widgets with normal-length titles is a couple KB) while still
 * catching a maximal-shape-valid-but-bloated config, and bounding a
 * `restart_supported: false` deployment's exposure to a scripted write loop. */
export const MAX_CONFIG_SERIALIZED_BYTES = 12_000;

/** Design D5b: "the number of dashboards per session... SHALL be bounded".
 * Enforced in server/src/session/dashboardStore.ts, which imports this
 * constant rather than defining its own. */
export const MAX_DASHBOARDS_PER_SESSION = 20;

/** Design D5a: "no field of a stored dashboard is ever interpolated into
 * HTML, a URL, a style, or an event handler — text only, everywhere." This is
 * a defense-in-depth content check, NOT a markup filter: plain HTML tags in a
 * title (e.g. "<b>Q3 Review</b>") are NOT rejected here — this app never
 * interprets a title as anything but a JSX text child (spec "No
 * agent-authored markup is ever rendered", enforced by the repo-wide
 * dangerouslySetInnerHTML audit, task 4.5), so an HTML-bearing title is
 * simply stored as literal text and renders inert (spec scenario: "A widget
 * title containing markup renders as inert text"). What this DOES reject is
 * content that would be dangerous specifically IF a future consumer ever
 * interpolated it into an href/src/style/event-handler attribute — the
 * categories the spec names ("a URL, or code"): a `javascript:`/`data:`/
 * `vbscript:` URI scheme, an inline event-handler attribute pattern
 * (`onerror=`, `onclick=`, ...), a CSS `expression(...)`/`@import` construct,
 * or a `<script>` tag. Applied to every free-text string field a widget
 * carries (currently just `title`). */
const DANGEROUS_CONTENT_RE =
  /javascript:|data:text\/html|vbscript:|on\w+\s*=|expression\s*\(|@import\b|<script\b/i;

function rejectDangerousContent(
  value: string,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (DANGEROUS_CONTENT_RE.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Field contains content that would be interpreted as a URL, an event handler, or code ' +
        '(e.g. a javascript: URI, an inline event-handler attribute, or a <script> tag) and is rejected.',
      path,
    });
  }
}

export const widgetLayoutSchema = z.object({
  /** Instance id, unique within one dashboard (checked in `dashboardConfigSchema`,
   * not expressible as a single-field Zod constraint). */
  id: z.string().min(1).max(MAX_WIDGET_ID_LEN),
  type: widgetTypeSchema,
  /** Agent- or user-authored display title. Rendered as TEXT ONLY by Phase 4
   * (spec: "No agent-authored markup is ever rendered") — this schema bounds
   * length/shape; it does not itself sanitize markup, since nothing here
   * ever interpolates it into HTML/URL/style. */
  title: z.string().min(1).max(MAX_TITLE_LEN),
  x: z.number().int().min(0).max(GRID_MAX_COORD),
  y: z.number().int().min(0).max(GRID_MAX_COORD),
  w: z.number().int().min(1).max(GRID_MAX_EXTENT),
  h: z.number().int().min(1).max(GRID_MAX_EXTENT),
});
export type WidgetLayout = z.infer<typeof widgetLayoutSchema>;

// -- interaction vocabulary (named, never executable) ----------------------------

/** The full named interaction vocabulary (design D1: "drawn from a named
 * vocabulary, never free-form callbacks"). Adding a new cross-widget
 * interaction means adding a name here AND the Phase 4 handler that
 * implements it — never accepting an arbitrary string as a stand-in for
 * either. */
export const INTERACTION_KINDS = [
  /** Selecting a speaker in one widget highlights that speaker's data in
   * another (e.g. talk-time legend -> transcript excerpt). */
  'highlight_speaker',
  /** Selecting a topic in one widget filters/scrolls another to that topic's
   * span. */
  'filter_by_topic',
  /** Selecting a point/segment in one widget scrolls a time-ordered widget
   * (e.g. transcript excerpt) to that session time. */
  'scroll_to_time',
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

/** Undefined interaction -> rejected (spec: "referencing an undefined
 * interaction... SHALL be rejected"). A closed `z.enum`, never a bare
 * string — there is no path from this schema to executing agent-authored
 * content. */
export const interactionKindSchema = z.enum(INTERACTION_KINDS);

export const dashboardInteractionSchema = z.object({
  kind: interactionKindSchema,
  sourceWidgetId: z.string().min(1).max(MAX_WIDGET_ID_LEN),
  targetWidgetId: z.string().min(1).max(MAX_WIDGET_ID_LEN),
});
export type DashboardInteraction = z.infer<typeof dashboardInteractionSchema>;

// -- whole dashboard config -------------------------------------------------------

/** A dashboard config: its widgets (each a catalog type + layout) plus any
 * cross-widget interactions. Cross-field checks a single Zod field can't
 * express — duplicate widget ids, and an interaction naming a widget id not
 * present in this same dashboard (spec: "A dangling interaction reference is
 * rejected") — are enforced in `.superRefine` below. */
export const dashboardConfigSchema = z
  .object({
    widgets: z.array(widgetLayoutSchema).min(1).max(MAX_WIDGETS_PER_DASHBOARD),
    interactions: z.array(dashboardInteractionSchema).max(MAX_INTERACTIONS_PER_DASHBOARD).default([]),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    const widgetIds = new Set<string>();
    cfg.widgets.forEach((w, i) => {
      if (seen.has(w.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate widget id "${w.id}"`,
          path: ['widgets', i, 'id'],
        });
      }
      seen.add(w.id);
      widgetIds.add(w.id);
      // Design D5a whole-config content check (task 5.1) — every free-text
      // field, not only type/shape. HTML in a title is allowed through (it
      // renders inert, see the constant's doc comment above); a dangerous
      // URL/handler/code pattern is rejected here, before anything is stored.
      rejectDangerousContent(w.title, ctx, ['widgets', i, 'title']);
    });

    cfg.interactions.forEach((interaction, i) => {
      if (!widgetIds.has(interaction.sourceWidgetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Interaction references unknown source widget id "${interaction.sourceWidgetId}"`,
          path: ['interactions', i, 'sourceWidgetId'],
        });
      }
      if (!widgetIds.has(interaction.targetWidgetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Interaction references unknown target widget id "${interaction.targetWidgetId}"`,
          path: ['interactions', i, 'targetWidgetId'],
        });
      }
    });

    // Design D5b: "the serialized size of a configuration SHALL... be
    // bounded". A config-content property (no session context needed), so it
    // lives in the shared schema rather than the store — checked on the
    // already-typed value, matching what the store will actually persist.
    const serializedBytes = new TextEncoder().encode(JSON.stringify(cfg)).length;
    if (serializedBytes > MAX_CONFIG_SERIALIZED_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Serialized dashboard configuration is ${serializedBytes} bytes, exceeding the ${MAX_CONFIG_SERIALIZED_BYTES}-byte limit.`,
        path: [],
      });
    }
  });
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;

/** Validate an arbitrary (untrusted) value as a dashboard config. This is
 * the single entry point Phase 5's persistence write path and Phase 2/4's
 * render path should both call — never re-deriving the catalog/vocabulary
 * checks inline. Returns the same discriminated `{success}` shape as
 * `dashboardConfigSchema.safeParse`. */
export function validateDashboardConfig(
  input: unknown,
): ReturnType<typeof dashboardConfigSchema.safeParse> {
  return dashboardConfigSchema.safeParse(input);
}
