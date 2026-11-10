import { describe, expect, it } from 'vitest';
import {
  adminStudioCreateBodySchema,
  audioSegmentWaveformBodySchema,
  companionCommandBodySchema,
  deleteVersionQuerySchema,
  eventGenerateBodySchema,
  eventUpdateBodySchema,
  logBodySchema,
  MAX_METADATA_BYTES,
  newSessionBodySchema,
  topicUpdateSchema,
  transcriptWordUpdateSchema,
  validateYoutubeImportUrl,
  validateYoutubePlaylistUrl,
  youtubeImportBodySchema,
  youtubePlaylistBodySchema,
} from './schemas';

describe('logBodySchema.metadata cap', () => {
  it('accepts a normal small metadata object', () => {
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi', metadata: { take: 1 } });
    expect(r.success).toBe(true);
  });

  it('defaults metadata to {} when absent', () => {
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.metadata).toEqual({});
  });

  it('rejects metadata that serializes beyond the cap', () => {
    const big = { blob: 'x'.repeat(MAX_METADATA_BYTES + 100) };
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi', metadata: big });
    expect(r.success).toBe(false);
  });
});

describe('newSessionBodySchema', () => {
  it('defaults frame_rate=24, start_offset=0 and requires show_id', () => {
    const r = newSessionBodySchema.safeParse({ show_id: 's', episode: '001' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ frame_rate: 24, start_offset_frames: 0 });
  });
  it('rejects frame_rate out of [1,120]', () => {
    expect(
      newSessionBodySchema.safeParse({ show_id: 's', episode: '1', frame_rate: 0 }).success,
    ).toBe(false);
    expect(
      newSessionBodySchema.safeParse({ show_id: 's', episode: '1', frame_rate: 121 }).success,
    ).toBe(false);
  });
  // session-title-suffix (design D6): blank/omitted episode is valid at the
  // schema level — the create-path handler (not the schema) enforces
  // "required" conditionally on the show's title_suffix + whether an
  // explicit title bypasses derivation (see sessions.int.test.ts).
  it('allows a blank or omitted episode', () => {
    expect(newSessionBodySchema.safeParse({ show_id: 's', episode: '' }).success).toBe(true);
    expect(newSessionBodySchema.safeParse({ show_id: 's' }).success).toBe(true);
  });
});

describe('eventUpdateBodySchema', () => {
  it('requires exactly-8-char timecode_hms', () => {
    const base = { category: 'c', message: 'm', wall_time_utc: 'w' };
    expect(eventUpdateBodySchema.safeParse({ ...base, timecode_hms: '00:00:00' }).success).toBe(
      true,
    );
    expect(eventUpdateBodySchema.safeParse({ ...base, timecode_hms: '1:2:3' }).success).toBe(false);
  });
});

describe('enum + bound schemas', () => {
  it('companionCommandBodySchema accepts only known actions', () => {
    expect(companionCommandBodySchema.safeParse({ type: 'record-start' }).success).toBe(true);
    expect(companionCommandBodySchema.safeParse({ type: 'nope' }).success).toBe(false);
  });
  it('adminStudioCreateBodySchema enforces id length 2..63', () => {
    expect(adminStudioCreateBodySchema.safeParse({ id: 'a', display_name: 'x' }).success).toBe(
      false,
    );
    expect(adminStudioCreateBodySchema.safeParse({ id: 'ab', display_name: 'x' }).success).toBe(
      true,
    );
  });
  it('audioSegmentWaveformBodySchema bounds peaks 8..4096', () => {
    expect(audioSegmentWaveformBodySchema.safeParse({ peaks: [1, 2, 3] }).success).toBe(false);
    expect(audioSegmentWaveformBodySchema.safeParse({ peaks: Array(8).fill(0) }).success).toBe(
      true,
    );
  });
});

// event-generate-hardening D5 — DoS-hardening bounds on the generate body.
describe('eventGenerateBodySchema bounds', () => {
  it('accepts a selection of exactly 500 entries', () => {
    const selection = Array.from({ length: 500 }, (_, i) => ({ category_id: `c${i}` }));
    expect(eventGenerateBodySchema.safeParse({ selection }).success).toBe(true);
  });

  it('rejects a selection of 501 entries', () => {
    const selection = Array.from({ length: 501 }, (_, i) => ({ category_id: `c${i}` }));
    expect(eventGenerateBodySchema.safeParse({ selection }).success).toBe(false);
  });

  it('accepts a 200-char category_id', () => {
    const selection = [{ category_id: 'c'.repeat(200) }];
    expect(eventGenerateBodySchema.safeParse({ selection }).success).toBe(true);
  });

  it('rejects a 201-char category_id', () => {
    const selection = [{ category_id: 'c'.repeat(201) }];
    expect(eventGenerateBodySchema.safeParse({ selection }).success).toBe(false);
  });

  it('accepts a 200-char option_label', () => {
    const selection = [{ category_id: 'c', option_label: 'o'.repeat(200) }];
    expect(eventGenerateBodySchema.safeParse({ selection }).success).toBe(true);
  });

  it('rejects a 201-char option_label', () => {
    const selection = [{ category_id: 'c', option_label: 'o'.repeat(201) }];
    expect(eventGenerateBodySchema.safeParse({ selection }).success).toBe(false);
  });

  it('keeps option_label nullable/optional under the bound', () => {
    expect(
      eventGenerateBodySchema.safeParse({ selection: [{ category_id: 'c', option_label: null }] })
        .success,
    ).toBe(true);
    expect(eventGenerateBodySchema.safeParse({ selection: [{ category_id: 'c' }] }).success).toBe(
      true,
    );
  });
});

describe('youtubeImportBodySchema', () => {
  it('accepts a well-formed body', () => {
    const r = youtubeImportBodySchema.safeParse({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      use_publish_date: true,
    });
    expect(r.success).toBe(true);
  });

  it('requires url to be present', () => {
    expect(youtubeImportBodySchema.safeParse({ use_publish_date: true }).success).toBe(false);
  });

  it('rejects a non-boolean use_publish_date', () => {
    const r = youtubeImportBodySchema.safeParse({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      use_publish_date: 'yes',
    });
    expect(r.success).toBe(false);
  });
});

describe('validateYoutubeImportUrl (design D6 — exact-hostname allowlist)', () => {
  const allowlisted = [
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ];

  it.each(allowlisted)('accepts allowlisted host: %s', (url) => {
    const r = validateYoutubeImportUrl(url);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.href).toBe(new URL(url).href);
  });

  it('accepts an uppercase-host variant by normalizing before comparison', () => {
    const r = validateYoutubeImportUrl('https://YouTu.be/dQw4w9WgXcQ');
    expect(r.ok).toBe(true);
  });

  it('rejects a dot-suffix look-alike host (youtube.com.evil.com)', () => {
    expect(validateYoutubeImportUrl('https://youtube.com.evil.com/watch?v=x').ok).toBe(false);
  });

  it('rejects a prefix/hyphen look-alike host (evil-youtube.com)', () => {
    expect(validateYoutubeImportUrl('https://evil-youtube.com/watch?v=x').ok).toBe(false);
  });

  it('rejects a userinfo trick whose real host is evil.com', () => {
    const r = validateYoutubeImportUrl('https://youtube.com@evil.com/watch?v=x');
    expect(r.ok).toBe(false);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(validateYoutubeImportUrl('ftp://youtube.com/watch?v=x').ok).toBe(false);
    expect(validateYoutubeImportUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(validateYoutubeImportUrl('not a url').ok).toBe(false);
    expect(validateYoutubeImportUrl('').ok).toBe(false);
  });
});

// session-row-versions design D4: the optional expected version and overwrite flag on the three
// update bodies, and the DELETE query.
describe('expected versions (session-row-versions D4)', () => {
  const event = { category: 'c', message: 'm', wall_time_utc: 'x', timecode_hms: '00:00:01' };
  const bodies = [
    ['eventUpdateBodySchema', eventUpdateBodySchema, event],
    ['transcriptWordUpdateSchema', transcriptWordUpdateSchema, { word: 'w' }],
    ['topicUpdateSchema', topicUpdateSchema, { summary: 's' }],
  ] as const;

  for (const [name, schema, base] of bodies) {
    it(`${name}: version is optional, a positive safe integer, and overwrite needs it`, () => {
      expect(schema.safeParse(base).success).toBe(true);
      expect(schema.parse({ ...base, version: 3 })).toMatchObject({ version: 3 });
      expect(schema.parse({ ...base, version: 3, overwrite: true })).toMatchObject({ version: 3, overwrite: true });
      expect(schema.safeParse({ ...base, version: Number.MAX_SAFE_INTEGER }).success).toBe(true);
      for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', null]) {
        expect(schema.safeParse({ ...base, version: bad }).success, String(bad)).toBe(false);
      }
      expect(schema.safeParse({ ...base, overwrite: true }).success).toBe(false);
      expect(schema.safeParse({ ...base, version: 1, overwrite: 'yes' }).success).toBe(false);
    });
  }

  it('deleteVersionQuerySchema: decimal version from 1, overwrite only as "1" and only with a version', () => {
    expect(deleteVersionQuerySchema.parse({})).toEqual({});
    expect(deleteVersionQuerySchema.parse({ version: '7' })).toEqual({ version: 7 });
    expect(deleteVersionQuerySchema.parse({ version: '7', overwrite: '1' })).toEqual({ version: 7, overwrite: true });
    expect(deleteVersionQuerySchema.parse({ version: String(Number.MAX_SAFE_INTEGER) })).toEqual({
      version: Number.MAX_SAFE_INTEGER,
    });
    for (const bad of [
      { version: 'abc' },
      { version: '0' },
      { version: '07' },
      { version: '-1' },
      { version: '1.5' },
      { version: '9007199254740992' },
      { overwrite: '1' },
      { version: '1', overwrite: 'true' },
    ]) {
      expect(deleteVersionQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('validateYoutubePlaylistUrl (youtube-playlist-import D2)', () => {
  const accepted: Array<[string, string]> = [
    ['https://www.youtube.com/playlist?list=PLBB231211A4F62143', 'PLBB231211A4F62143'],
    ['http://youtube.com/playlist?list=PL_x-1', 'PL_x-1'],
    ['https://m.youtube.com/watch?v=RlJy2Kt8Be0&list=PLBB231211A4F62143', 'PLBB231211A4F62143'],
    ['https://music.youtube.com/playlist?list=OLAK5uy_abc', 'OLAK5uy_abc'],
    ['https://WWW.YouTube.com/playlist?list=UUBR8-60-B28hp2BmDPdntcQ', 'UUBR8-60-B28hp2BmDPdntcQ'],
    // Not special-cased: reaches yt-dlp and gets the private-or-nonexistent 502.
    ['https://www.youtube.com/playlist?list=WL', 'WL'],
  ];
  it.each(accepted)('accepts %s', (url, listId) => {
    expect(validateYoutubePlaylistUrl(url)).toEqual({
      ok: true,
      listId,
      href: `https://www.youtube.com/playlist?list=${listId}`,
    });
  });

  const notPlaylist = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?list=PLx1',
    'https://www.youtube.com/@channel',
    'https://youtube.com.evil.com/playlist?list=PLx1',
    'https://youtube.com@evil.com/playlist?list=PLx1',
    'ftp://youtube.com/playlist?list=PLx1',
    'https://www.youtube.com/playlist?list=a',
    `https://www.youtube.com/playlist?list=${'P'.repeat(65)}`,
    'https://www.youtube.com/playlist?list=PL%20x',
    'not a url',
  ];
  it.each(notPlaylist)('refuses %s as not-playlist', (url) => {
    expect(validateYoutubePlaylistUrl(url)).toEqual({ ok: false, reason: 'not-playlist' });
  });

  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=RDCLAK5uy_x',
  ])('refuses %s as mix', (url) => {
    expect(validateYoutubePlaylistUrl(url)).toEqual({ ok: false, reason: 'mix' });
  });

  it('accepts a 64-character list id', () => {
    expect(validateYoutubePlaylistUrl(`https://www.youtube.com/playlist?list=${'P'.repeat(64)}`).ok).toBe(true);
  });
});

describe('youtubePlaylistBodySchema', () => {
  it('accepts url of 1 and 2048 characters and strips unknown keys', () => {
    expect(youtubePlaylistBodySchema.safeParse({ url: 'x' }).success).toBe(true);
    const r = youtubePlaylistBodySchema.safeParse({ url: 'x'.repeat(2048), extra: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ url: 'x'.repeat(2048) });
  });
  it.each([{}, { url: '' }, { url: 'x'.repeat(2049) }, { url: 5 }])('refuses %j', (body) => {
    const r = youtubePlaylistBodySchema.safeParse(body);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['url']);
  });
});
