// The 422 body under zod 4 (migrate-zod-4 D3; api-contract-freeze "Validation error bodies carry
// zod 4 issues").
//
// Clients rely only on an issue's `code`, `path` and `message`. These cases pin what must hold
// across the zod 3 → 4 move: (a) a missing field is a zod 4 `invalid_type` issue (no `received`, no
// `input`); (b) every message our code sets is returned verbatim at its path; (c) defaults,
// transforms and key stripping give the same outputs as before (the inputs and outputs recorded in
// task 1.2); (d) the one-argument-record fields still take any string-keyed object; (e) a
// non-finite number is refused (owner decision 6). (a) and (e) were red on zod 3.

import { describe, expect, it } from 'vitest';
import { validateDashboardConfig } from './aiV2Catalog';
import {
  aiV2AnswerRequestSchema,
  aiV2DesignRequestSchema,
  aiV2QuestionAnswerItemSchema,
  audioSegmentWaveformBodySchema,
  chatRequestSchema,
  companionPresenceBodySchema,
  deleteVersionQuerySchema,
  eventGenerateBodySchema,
  eventUpdateBodySchema,
  logBodySchema,
  MAX_METADATA_BYTES,
  newSessionBodySchema,
  profileUpdateBodySchema,
  sessionUpdateBodySchema,
  showUpdateEntrySchema,
  teamOwnerTransferBodySchema,
  topicCreateSchema,
  topicUpdateSchema,
  transcriptWordCreateSchema,
  transcriptWordUpdateSchema,
} from './schemas';

type Issue = { code: string; path: (string | number)[]; message: string } & Record<string, unknown>;

function issuesOf(r: { success: boolean; error?: { issues: unknown[] } }): Issue[] {
  expect(r.success).toBe(false);
  return (r.error?.issues ?? []) as Issue[];
}

function widget(id: string, title = 'T') {
  return { id, type: 'talk_time_by_speaker', title, x: 0, y: 0, w: 4, h: 3 };
}

describe('(a) a missing field is a zod 4 issue (migrate-zod-4 D3)', () => {
  it('carries code invalid_type, the path and a message, and no received or input', () => {
    const issues = issuesOf(newSessionBodySchema.safeParse({ episode: '1' }));
    const issue = issues.find((i) => i.path.join('.') === 'show_id');
    expect(issue).toBeDefined();
    expect(issue?.code).toBe('invalid_type');
    expect(issue?.path).toEqual(['show_id']);
    expect(typeof issue?.message).toBe('string');
    expect(issue?.message.length).toBeGreaterThan(0);
    expect(issue).not.toHaveProperty('received');
    expect(issue).not.toHaveProperty('input');
  });
});

describe('(b) messages our code sets are unchanged (migrate-zod-4 D3)', () => {
  const event = { category: 'c', message: 'm', wall_time_utc: 'x', timecode_hms: '00:00:01' };

  it.each([
    ['eventUpdateBodySchema', eventUpdateBodySchema, { ...event, overwrite: true }],
    ['transcriptWordUpdateSchema', transcriptWordUpdateSchema, { word: 'w', overwrite: true }],
    ['topicUpdateSchema', topicUpdateSchema, { summary: 's', overwrite: true }],
    ['deleteVersionQuerySchema', deleteVersionQuerySchema, { overwrite: '1' }],
  ] as const)('%s: overwrite requires version, at overwrite', (_name, schema, body) => {
    const issues = issuesOf(schema.safeParse(body));
    expect(issues.map((i) => [i.path, i.message])).toContainEqual([
      ['overwrite'],
      'overwrite requires version',
    ]);
  });

  it('eventGenerateBodySchema: regenerate cannot be combined with a selection, at the root', () => {
    const issues = issuesOf(
      eventGenerateBodySchema.safeParse({ regenerate: true, selection: [{ category_id: 'c' }] }),
    );
    expect(issues.map((i) => [i.path, i.message])).toContainEqual([
      [],
      'regenerate cannot be combined with a non-empty selection',
    ]);
  });

  it('deleteVersionQuerySchema: version is too large, at version', () => {
    const issues = issuesOf(deleteVersionQuerySchema.safeParse({ version: '9007199254740992' }));
    expect(issues.map((i) => [i.path, i.message])).toContainEqual([
      ['version'],
      'version is too large',
    ]);
  });

  it('logBodySchema: metadata exceeds the cap, at metadata', () => {
    const big = { blob: 'x'.repeat(MAX_METADATA_BYTES + 100) };
    const issues = issuesOf(
      logBodySchema.safeParse({ category: 'c', message: 'm', metadata: big }),
    );
    expect(issues.map((i) => [i.path, i.message])).toContainEqual([
      ['metadata'],
      `metadata exceeds ${MAX_METADATA_BYTES} serialized bytes`,
    ]);
  });

  it('dashboard catalog: duplicate id, dangling source and target, and dangerous content', () => {
    const issues = issuesOf(
      validateDashboardConfig({
        widgets: [widget('w1'), widget('w1', 'javascript:alert(1)')],
        interactions: [
          { kind: 'highlight_speaker', sourceWidgetId: 'nope', targetWidgetId: 'gone' },
        ],
      }),
    );
    const got = issues.map((i) => [i.path, i.message]);
    expect(got).toContainEqual([['widgets', 1, 'id'], 'Duplicate widget id "w1"']);
    expect(got).toContainEqual([
      ['widgets', 1, 'title'],
      'Field contains content that would be interpreted as a URL, an event handler, or code ' +
        '(e.g. a javascript: URI, an inline event-handler attribute, or a <script> tag) and is rejected.',
    ]);
    expect(got).toContainEqual([
      ['interactions', 0, 'sourceWidgetId'],
      'Interaction references unknown source widget id "nope"',
    ]);
    expect(got).toContainEqual([
      ['interactions', 0, 'targetWidgetId'],
      'Interaction references unknown target widget id "gone"',
    ]);
  });

  it('dashboard catalog: the serialized-size limit, at the root', () => {
    const widgets = Array.from({ length: 60 }, (_, i) => widget(`w${i}`, 'x'.repeat(200)));
    const issues = issuesOf(validateDashboardConfig({ widgets }));
    const size = issues.find((i) => i.path.length === 0);
    expect(size?.message).toMatch(
      /^Serialized dashboard configuration is \d+ bytes, exceeding the 12000-byte limit\.$/,
    );
  });
});

// The inputs and outputs recorded on zod 3 in task 1.2 (`z4-1.2-parse-before.json`).
describe('(c) defaults, transforms and stripping are unchanged (migrate-zod-4 D3)', () => {
  const cases: [string, { parse: (v: unknown) => unknown }, unknown, unknown][] = [
    [
      'newSessionBodySchema',
      newSessionBodySchema,
      { show_id: 's', episode: '001' },
      { frame_rate: 24, start_offset_frames: 0, show_id: 's', episode: '001' },
    ],
    [
      'newSessionBodySchema',
      newSessionBodySchema,
      { show_id: 's', frame_rate: 30, start_offset_frames: 5, extra: 1 },
      { frame_rate: 30, start_offset_frames: 5, show_id: 's' },
    ],
    [
      'sessionUpdateBodySchema',
      sessionUpdateBodySchema,
      { title: 't' },
      { title: 't', start_offset_frames: 0 },
    ],
    [
      'sessionUpdateBodySchema',
      sessionUpdateBodySchema,
      { title: 't', start_offset_frames: 9 },
      { title: 't', start_offset_frames: 9 },
    ],
    [
      'logBodySchema',
      logBodySchema,
      { category: 'cam', message: 'hi' },
      { category: 'cam', message: 'hi', metadata: {} },
    ],
    [
      'logBodySchema',
      logBodySchema,
      { category: 'cam', message: 'hi', metadata: { take: 1 }, marked_at_utc: null },
      { category: 'cam', message: 'hi', metadata: { take: 1 }, marked_at_utc: null },
    ],
    [
      'transcriptWordCreateSchema',
      transcriptWordCreateSchema,
      {},
      { session_time: '', speaker: '', word: '' },
    ],
    [
      'transcriptWordCreateSchema',
      transcriptWordCreateSchema,
      { session_time: '00:00:01', speaker: 'S1', word: 'w', extra: true },
      { session_time: '00:00:01', speaker: 'S1', word: 'w' },
    ],
    [
      'topicCreateSchema',
      topicCreateSchema,
      {},
      { session_time: '', duration_sec: 0, topic_level: 1, summary: '' },
    ],
    [
      'topicCreateSchema',
      topicCreateSchema,
      { session_time: '00:01:00', duration_sec: 2.5, topic_level: 3, summary: 's' },
      { session_time: '00:01:00', duration_sec: 2.5, topic_level: 3, summary: 's' },
    ],
    [
      'deleteVersionQuerySchema',
      deleteVersionQuerySchema,
      { version: '12', overwrite: '1' },
      { version: 12, overwrite: true },
    ],
    ['deleteVersionQuerySchema', deleteVersionQuerySchema, {}, {}],
    [
      'deleteVersionQuerySchema',
      deleteVersionQuerySchema,
      { version: '7', other: 'x' },
      { version: 7 },
    ],
    ['chatRequestSchema', chatRequestSchema, { message: '  hi  ' }, { message: 'hi' }],
    [
      'chatRequestSchema',
      chatRequestSchema,
      { message: 'x', claude_session_id: 'abc' },
      { message: 'x', claude_session_id: 'abc' },
    ],
    [
      'aiV2DesignRequestSchema',
      aiV2DesignRequestSchema,
      { message: '\n hello \t' },
      { message: 'hello' },
    ],
    [
      'aiV2QuestionAnswerItemSchema',
      aiV2QuestionAnswerItemSchema,
      { kind: 'text', text: '  free  ' },
      { kind: 'text', text: 'free' },
    ],
    [
      'aiV2QuestionAnswerItemSchema',
      aiV2QuestionAnswerItemSchema,
      { kind: 'option', widgetType: 'talk_time_by_speaker', extra: 1 },
      { kind: 'option', widgetType: 'talk_time_by_speaker' },
    ],
    [
      'aiV2AnswerRequestSchema',
      aiV2AnswerRequestSchema,
      { turnId: 't', requestId: 'r', answers: [{ kind: 'text', text: ' a ' }] },
      { turnId: 't', requestId: 'r', answers: [{ kind: 'text', text: 'a' }] },
    ],
    [
      'teamOwnerTransferBodySchema',
      teamOwnerTransferBodySchema,
      { user_id: '  u1  ' },
      { user_id: 'u1' },
    ],
    [
      'companionPresenceBodySchema',
      companionPresenceBodySchema,
      { client_id: 'c' },
      { client_id: 'c', visible: true, is_playing: false, closing: false },
    ],
    [
      'companionPresenceBodySchema',
      companionPresenceBodySchema,
      { client_id: 'c', visible: false, is_playing: true, closing: true },
      { client_id: 'c', visible: false, is_playing: true, closing: true },
    ],
    [
      'showUpdateEntrySchema',
      showUpdateEntrySchema,
      { show_id: 's', next_episode: 5, categories: [{ any: 1 }] },
      { show_id: 's', categories: [{ any: 1 }] },
    ],
    [
      'profileUpdateBodySchema',
      profileUpdateBodySchema,
      { settings: { any: { nested: true } } },
      { settings: { any: { nested: true } } },
    ],
  ];

  it.each(cases)('%s parses %j as before', (_name, schema, input, output) => {
    expect(schema.parse(input)).toStrictEqual(output);
  });

  it('dashboardConfigSchema defaults interactions and strips unknown widget keys', () => {
    expect(validateDashboardConfig({ widgets: [] }).data).toStrictEqual({
      widgets: [],
      interactions: [],
    });
    expect(
      validateDashboardConfig({ widgets: [{ ...widget('w1'), extra: 1 }], interactions: [] }).data,
    ).toStrictEqual({ widgets: [widget('w1')], interactions: [] });
  });
});

describe('(d) one-argument-record fields still take any string-keyed object (migrate-zod-4 D3)', () => {
  it('showUpdateEntrySchema.categories, logBodySchema.metadata and profileUpdateBodySchema.settings', () => {
    const value = { any: 1, nested: { deep: [true, 'x', null] } };
    expect(
      showUpdateEntrySchema.parse({ show_id: 's', categories: [value] }).categories,
    ).toStrictEqual([value]);
    expect(
      logBodySchema.parse({ category: 'c', message: 'm', metadata: value }).metadata,
    ).toStrictEqual(value);
    expect(profileUpdateBodySchema.parse({ settings: value }).settings).toStrictEqual(value);
  });
});

describe('(e) a non-finite number is refused (migrate-zod-4 D3, owner decision 6)', () => {
  it('topicCreateSchema.duration_sec refuses Infinity, at duration_sec', () => {
    const issues = issuesOf(
      topicCreateSchema.safeParse({ duration_sec: Number.POSITIVE_INFINITY }),
    );
    expect(issues.map((i) => i.path)).toContainEqual(['duration_sec']);
  });

  it('audioSegmentWaveformBodySchema.peaks refuses Infinity, at the peak', () => {
    const peaks = [Number.POSITIVE_INFINITY, ...Array(7).fill(0)];
    const issues = issuesOf(audioSegmentWaveformBodySchema.safeParse({ peaks }));
    expect(issues.map((i) => i.path)).toContainEqual(['peaks', 0]);
  });
});
