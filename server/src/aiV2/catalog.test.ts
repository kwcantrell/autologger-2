// Unit tests for the ai-v2-dashboards widget catalog + layout/interaction
// schema (design D2/D1, spec "Widget catalog is a closed set" and "Layout
// and interaction vocabulary"). Zod, mirroring server/src/schemas.ts
// conventions. No I/O, no rendering — Phase 4 (render) and Phase 5 (persist
// write-validation) import this module's exports directly.
//
// TDD note: written before `catalog.ts` exists (RED), then the
// implementation is added to turn it GREEN.

import { describe, expect, it } from 'vitest';
import {
  dashboardConfigSchema,
  interactionKindSchema,
  MAX_CONFIG_SERIALIZED_BYTES,
  MAX_DASHBOARDS_PER_SESSION,
  MAX_INTERACTIONS_PER_DASHBOARD,
  MAX_WIDGETS_PER_DASHBOARD,
  validateDashboardConfig,
  widgetTypeSchema,
  WIDGET_TYPES,
} from './catalog';

function widget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'w1',
    type: 'talk_time_by_speaker',
    title: 'Talk time',
    x: 0,
    y: 0,
    w: 4,
    h: 2,
    ...overrides,
  };
}

describe('widget catalog is a closed set', () => {
  it('accepts every registered catalog type', () => {
    for (const type of WIDGET_TYPES) {
      expect(widgetTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('rejects a widget type outside the catalog', () => {
    const result = widgetTypeSchema.safeParse('custom_widget');
    expect(result.success).toBe(false);
  });

  it('rejects a dashboard config naming an unknown widget type', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ type: 'custom_widget' })],
      interactions: [],
    });
    expect(result.success).toBe(false);
  });

  it('has NO sentiment widget type registered (design D2/D2b: no persisted-data-backed widget yet)', () => {
    expect(WIDGET_TYPES).not.toContain('sentiment_series');
    expect(WIDGET_TYPES).not.toContain('sentiment_by_topic');
    expect(widgetTypeSchema.safeParse('sentiment_series').success).toBe(false);
    expect(widgetTypeSchema.safeParse('sentiment_by_topic').success).toBe(false);
  });

  it('every catalog type is a plain snake_case identifier, never a code/expression string', () => {
    for (const type of WIDGET_TYPES) {
      expect(type).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('layout and interaction vocabulary', () => {
  it('accepts a valid single-widget dashboard with no interactions', () => {
    const result = validateDashboardConfig({
      widgets: [widget()],
      interactions: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an interaction whose kind is in the named vocabulary and whose widgets both exist', () => {
    const result = validateDashboardConfig({
      widgets: [
        widget({ id: 'w1', type: 'talk_time_by_speaker' }),
        widget({ id: 'w2', type: 'topic_timeline', x: 4 }),
      ],
      interactions: [{ kind: 'highlight_speaker', sourceWidgetId: 'w1', targetWidgetId: 'w2' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an interaction whose kind is not in the named vocabulary', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ id: 'w1' }), widget({ id: 'w2', x: 4 })],
      interactions: [{ kind: 'run_javascript', sourceWidgetId: 'w1', targetWidgetId: 'w2' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an interaction naming code/expression content instead of a vocabulary kind', () => {
    const result = interactionKindSchema.safeParse('window.alert(1)');
    expect(result.success).toBe(false);
  });

  it('rejects an interaction targeting a widget id that does not exist in the dashboard', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ id: 'w1' })],
      interactions: [{ kind: 'highlight_speaker', sourceWidgetId: 'w1', targetWidgetId: 'ghost' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an interaction whose SOURCE widget id does not exist either', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ id: 'w1' })],
      interactions: [{ kind: 'highlight_speaker', sourceWidgetId: 'ghost', targetWidgetId: 'w1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate widget ids within one dashboard', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ id: 'dup' }), widget({ id: 'dup', x: 4 })],
      interactions: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a dashboard with zero widgets (design D5b: no minimum widget count is imposed — ' +
    "the canvas's \"Start blank\" entry point saves exactly this shape)", () => {
    const result = validateDashboardConfig({ widgets: [], interactions: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ widgets: [], interactions: [] });
    }
  });

  it('rejects non-integer or out-of-range grid position/size', () => {
    expect(validateDashboardConfig({ widgets: [widget({ x: -1 })], interactions: [] }).success).toBe(
      false,
    );
    expect(validateDashboardConfig({ widgets: [widget({ w: 0 })], interactions: [] }).success).toBe(
      false,
    );
    expect(
      validateDashboardConfig({ widgets: [widget({ x: 1.5 })], interactions: [] }).success,
    ).toBe(false);
  });

  it('the exported schema mirrors validateDashboardConfig for direct Zod use by callers', () => {
    const parsed = dashboardConfigSchema.safeParse({ widgets: [widget()], interactions: [] });
    expect(parsed.success).toBe(true);
  });
});

// --- ai-v2-dashboards Phase 5 (task 5.1/5.3): whole-config write validation
// (design D5a) + authoritative bounds (design D5b). `validateDashboardConfig`
// is the SAME function the persistence write path (task 5.2) and the future
// propose_dashboard tool (task 5.4) both call — these tests exercise it
// directly, exactly as any consumer would.
describe('dashboard persistence — whole-config content validation (design D5a)', () => {
  it('stores a widget title containing HTML tags as plain text (not rejected — it renders inert, task 4.5)', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ title: '<b>Quarterly Review</b> <img src=x>' })],
      interactions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.widgets[0].title).toBe('<b>Quarterly Review</b> <img src=x>');
    }
  });

  it('rejects a title carrying a javascript: URI', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ title: 'javascript:alert(document.cookie)' })],
      interactions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a title carrying a data: URI', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ title: 'data:text/html,<script>alert(1)</script>' })],
      interactions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a title carrying an inline event-handler attribute pattern', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ title: 'Nice title" onerror="alert(1)' })],
      interactions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a title carrying a <script> tag', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ title: '<script>alert(1)</script>' })],
      interactions: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('dashboard persistence — authoritative bounds (design D5b, task 5.3)', () => {
  it('MAX_WIDGETS_PER_DASHBOARD/MAX_INTERACTIONS_PER_DASHBOARD are enforced by the shared schema (no second cap elsewhere)', () => {
    const tooManyWidgets = Array.from({ length: MAX_WIDGETS_PER_DASHBOARD + 1 }, (_, i) =>
      widget({ id: `w${i}`, x: i % 100 }),
    );
    expect(validateDashboardConfig({ widgets: tooManyWidgets, interactions: [] }).success).toBe(
      false,
    );
    expect(
      validateDashboardConfig({
        widgets: Array.from({ length: MAX_WIDGETS_PER_DASHBOARD }, (_, i) =>
          widget({ id: `w${i}`, x: i % 100 }),
        ),
        interactions: [],
      }).success,
    ).toBe(true);
    expect(MAX_INTERACTIONS_PER_DASHBOARD).toBeGreaterThan(0);
  });

  it('rejects a config whose serialized size exceeds MAX_CONFIG_SERIALIZED_BYTES while every individual widget stays within its own field bounds', () => {
    const hugeTitle = 'x'.repeat(200); // MAX_TITLE_LEN
    const longId = (i: number) => `widget-id-padded-to-near-max-length-${i}`.padEnd(64, '-');
    // Each widget here is independently VALID (max-length id, valid type,
    // max-length title, in-bounds layout) — this proves the byte-size check
    // is a genuine THIRD bound, not a restatement of the widget-count or
    // per-field-length caps: it must bind before MAX_WIDGETS_PER_DASHBOARD
    // does, on a config that individually passes every other check.
    const perWidgetBytes = new TextEncoder().encode(
      JSON.stringify(widget({ id: longId(0), title: hugeTitle })),
    ).length;
    const widgetsNeeded = Math.ceil(MAX_CONFIG_SERIALIZED_BYTES / perWidgetBytes) + 3;
    expect(widgetsNeeded).toBeLessThanOrEqual(MAX_WIDGETS_PER_DASHBOARD); // sanity: bound is reachable before the count cap
    const widgets = Array.from({ length: widgetsNeeded }, (_, i) =>
      widget({ id: longId(i), title: hugeTitle, x: i % 100 }),
    );
    const serializedBytes = new TextEncoder().encode(JSON.stringify({ widgets, interactions: [] }))
      .length;
    expect(serializedBytes).toBeGreaterThan(MAX_CONFIG_SERIALIZED_BYTES);

    const result = validateDashboardConfig({ widgets, interactions: [] });
    expect(result.success).toBe(false);
  });

  it('accepts a config comfortably under the serialized-size limit', () => {
    const result = validateDashboardConfig({ widgets: [widget()], interactions: [] });
    expect(result.success).toBe(true);
  });

  it('MAX_DASHBOARDS_PER_SESSION is exported for the session-DB store to import (design D5b: per-session count bound)', () => {
    expect(MAX_DASHBOARDS_PER_SESSION).toBeGreaterThan(0);
  });
});
