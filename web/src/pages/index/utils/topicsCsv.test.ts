import { describe, expect, it, vi } from 'vitest';
import type { SessionTopic } from '../../../api/types';
import { buildTopicsCsv, downloadTopicsCsv } from './topicsCsv';

function topic(
  partial: Partial<SessionTopic> & Pick<SessionTopic, 'id' | 'ordinal'>,
): SessionTopic {
  return {
    session_time: '00:00:01:00',
    duration_sec: 10,
    topic_level: 1,
    summary: 'Hello',
    created_at_utc: '2026-07-27T00:00:00Z',
    ...partial,
  };
}

describe('buildTopicsCsv', () => {
  it('emits a header and rows in ordinal order with CRLF', () => {
    const csv = buildTopicsCsv([
      topic({ id: 'b', ordinal: 2, session_time: '00:00:02:00', summary: 'Second' }),
      topic({ id: 'a', ordinal: 1, session_time: '00:00:01:00', summary: 'First' }),
    ]);
    expect(csv).toBe(
      [
        'Session Time,Duration (s),Level,Summary',
        '00:00:01:00,10,1,First',
        '00:00:02:00,10,1,Second',
        '',
      ].join('\r\n'),
    );
  });

  it('quotes fields that contain commas', () => {
    const csv = buildTopicsCsv([topic({ id: 'a', ordinal: 1, summary: 'Hello, world' })]);
    expect(csv).toContain('"Hello, world"');
  });
});

describe('downloadTopicsCsv', () => {
  it('triggers a blob download with a topics_ filename', () => {
    const click = vi.fn();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:topics');
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue({
      click,
      href: '',
      download: '',
    } as unknown as HTMLAnchorElement);

    downloadTopicsCsv('abcdefgh-session', 'a,b\r\n');
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect((createElement.mock.results[0].value as HTMLAnchorElement).download).toBe(
      'topics_abcdefgh.csv',
    );
    expect(revoke).toHaveBeenCalledWith('blob:topics');

    create.mockRestore();
    revoke.mockRestore();
    createElement.mockRestore();
  });
});
