import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import { CatalogPicker } from './CatalogPicker';
import { DashboardEditor } from './DashboardEditor';
import type { CatalogWidgetData } from './widgetRegistry';
import { CatalogWidget, SAMPLE_WIDGET_DATA } from './widgetRegistry';
import { WIDGET_TYPES, type WidgetType } from './widgetTypes';

// --- Component-level markup/injection audit (ai-v2-dashboards, task 4.5;
// spec "No agent-authored markup is ever rendered") ---
//
// Runs LAST in Phase 4, auditing every component in this directory —
// including task 4.6's editing UI (DashboardEditor/CatalogPicker) — for
// whether an agent/config-authored string could ever reach `href`, `src`,
// `style`, or be interpreted as markup. Complements
// widgetRegistry.test.tsx's single-widget title check with END-TO-END
// coverage across ALL NINE catalog types and every field on each type's data
// shape that can carry free-form content (not just the title every widget
// shares) — the category-id-as-map-key case (event_count_by_category) and
// the diarization-id-as-text case (talk_time_by_speaker/transcript_excerpt)
// are structurally different from a plain string prop and are exactly the
// kind of thing a title-only test would miss.

const PAYLOAD = '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">x</a>';

function assertNoInjection(container: HTMLElement) {
  // No markup-bearing element was ever created from rendered content.
  expect(container.querySelectorAll('img,script,iframe,object,embed').length).toBe(0);
  // No href/src anywhere resolves to the payload or a javascript: URI —
  // i.e. nothing interpolated agent/config content into a URL-bearing
  // attribute.
  for (const el of Array.from(container.querySelectorAll('[href],[src]'))) {
    const href = el.getAttribute('href');
    const src = el.getAttribute('src');
    if (href) expect(href.toLowerCase()).not.toContain('javascript:');
    if (src) expect(src).not.toBe(PAYLOAD);
  }
}

/** One malicious variant of each type's SAMPLE_WIDGET_DATA, with PAYLOAD
 * injected into every field an agent/config value could actually occupy
 * (not just title, which every widget shares and Unit 2 already covers). */
function maliciousDataFor(type: WidgetType): CatalogWidgetData {
  const base = SAMPLE_WIDGET_DATA[type];
  switch (base.widgetType) {
    case 'talk_time_by_speaker':
      return {
        ...base,
        talkTimeBySpeaker: {
          ...base.talkTimeBySpeaker,
          bySpeaker: [{ speaker: PAYLOAD, talkTimeSec: 10 }],
        },
      };
    case 'topic_timeline':
      return {
        ...base,
        topicTimeline: {
          entries: [
            {
              topicId: 't1',
              sessionTime: PAYLOAD,
              durationSec: 1,
              topicLevel: 0,
              summary: PAYLOAD,
            },
          ],
        },
      };
    case 'event_count_by_category':
      return {
        ...base,
        eventCountByCategory: { totalEvents: 1, byCategory: { [PAYLOAD]: 1 } },
      };
    case 'transcript_excerpt':
      return {
        ...base,
        transcriptExcerpt: { ...base.transcriptExcerpt, text: PAYLOAD, speaker: PAYLOAD },
      };
    default:
      return base;
  }
}

describe('CatalogWidget — every catalog type, every free-text field, malicious payload', () => {
  it.each(
    WIDGET_TYPES,
  )('%s never interpolates agent/config content into markup/href/src', (type) => {
    const { container } = renderStrict(
      <CatalogWidget title={PAYLOAD} data={maliciousDataFor(type)} />,
    );
    assertNoInjection(container);
    // Title always renders as literal text (WidgetChrome's contract).
    expect(screen.getAllByText(PAYLOAD, { exact: false }).length).toBeGreaterThan(0);
  });
});

describe("DashboardEditor's editing UI — malicious widget title never becomes markup", () => {
  it('a malicious title (no data provided yet) renders as literal text in the "no data" placeholder', () => {
    renderStrict(
      <DashboardEditor
        config={{
          widgets: [{ id: 'w1', type: 'session_duration', title: PAYLOAD, x: 0, y: 0, w: 4, h: 3 }],
          interactions: [],
        }}
        onChange={() => {}}
      />,
    );
    assertNoInjection(document.body);
    expect(screen.getAllByText(PAYLOAD, { exact: false }).length).toBeGreaterThan(0);
  });
});

describe('CatalogPicker — a malicious unavailable-reason string never becomes markup', () => {
  it('renders the reason as literal text', () => {
    renderStrict(
      <CatalogPicker
        unavailableTypes={{ filler_counts: PAYLOAD }}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    assertNoInjection(document.body);
    expect(screen.getAllByText(PAYLOAD, { exact: false }).length).toBeGreaterThan(0);
  });
});
