import { describe, expect, it } from 'vitest';
import {
  adminStudioCreateBodySchema,
  audioSegmentWaveformBodySchema,
  companionCommandBodySchema,
  eventGenerateBodySchema,
  eventUpdateBodySchema,
  logBodySchema,
  MAX_METADATA_BYTES,
  newSessionBodySchema,
  validateYoutubeImportUrl,
  youtubeImportBodySchema,
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
