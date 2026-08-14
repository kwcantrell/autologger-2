import { describe, expect, it, vi } from 'vitest';
import type { TranscriptWord } from '../../../api/types';
import { buildTranscriptCsv, downloadTranscriptCsv } from './transcriptCsv';

function word(
  partial: Partial<TranscriptWord> & Pick<TranscriptWord, 'id' | 'ordinal'>,
): TranscriptWord {
  return {
    session_time: '00:00:01:00',
    speaker: '0',
    word: 'hello',
    start_sec: 1,
    end_sec: 1.2,
    ...partial,
  };
}

// `formatSpeaker` itself now lives in (and is tested from) `./speakerOffset`,
// alongside its `parseSpeaker` inverse — one definition shared by this exporter
// and TranscribeRow's display, so the two labelings cannot drift.

describe('buildTranscriptCsv', () => {
  it('emits a header and rows in ordinal order with CRLF', () => {
    const csv = buildTranscriptCsv(
      [
        word({ id: 'b', ordinal: 2, session_time: '00:00:02:00', speaker: '1', word: 'world' }),
        word({ id: 'a', ordinal: 1, session_time: '00:00:01:00', speaker: '0', word: 'hello' }),
      ],
      1,
    );
    expect(csv).toBe(
      'Session Time,Speaker,Word(s)\r\n' +
        '00:00:01:00,Person 1,hello\r\n' +
        '00:00:02:00,Person 2,world\r\n',
    );
  });

  it('quotes fields that contain commas, quotes, or newlines', () => {
    const csv = buildTranscriptCsv([word({ id: 'a', ordinal: 1, word: 'say "hi", then\nbye' })], 0);
    expect(csv).toContain('"say ""hi"", then\nbye"');
  });
});

describe('downloadTranscriptCsv', () => {
  it('creates an object-URL download with the short session id filename', () => {
    const click = vi.fn();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const createEl = vi.spyOn(document, 'createElement').mockReturnValue({
      click,
      href: '',
      download: '',
    } as unknown as HTMLAnchorElement);

    downloadTranscriptCsv('abcdefgh-ijkl', 'Session Time,Speaker,Word(s)\r\n');

    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:mock');
    const anchor = createEl.mock.results[0]?.value as HTMLAnchorElement;
    expect(anchor.download).toBe('transcription_abcdefgh.csv');

    create.mockRestore();
    revoke.mockRestore();
    createEl.mockRestore();
  });
});
