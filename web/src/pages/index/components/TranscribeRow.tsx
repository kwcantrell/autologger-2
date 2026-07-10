import clsx from 'clsx';
import { memo, useState } from 'react';
import type { TranscriptWord } from '../../../api/types';
import {
  FEED_CELL,
  FEED_CELL_TIME,
  FEED_INLINE_INPUT,
  FEED_INLINE_INPUT_MONO,
  FEED_ROW,
} from './FeedTable';

interface EditState {
  session_time: string;
  speaker: string;
  word: string;
}

type UpdateFn = (
  wordId: string,
  patch: { session_time?: string; speaker?: string; word?: string },
) => void;

interface Props {
  row: TranscriptWord;
  speakerOffset: number;
  onUpdate: UpdateFn;
}

function formatSpeaker(speaker: string, offset: number): string {
  const n = Number.parseInt(speaker, 10);
  if (!Number.isNaN(n) && String(n) === speaker.trim()) {
    return `Person ${n + offset}`;
  }
  return speaker;
}

export const TranscribeRow = memo(function TranscribeRow({ row, speakerOffset, onUpdate }: Props) {
  const [edit, setEdit] = useState<EditState | null>(null);

  function startEdit() {
    setEdit({ session_time: row.session_time, speaker: row.speaker, word: row.word });
  }

  function commitField(field: keyof EditState, value: string) {
    if (!edit) return;
    setEdit((p) => (p ? { ...p, [field]: value } : p));
    onUpdate(row.id, { [field]: value });
  }

  const vals = edit ?? { session_time: row.session_time, speaker: row.speaker, word: row.word };

  return (
    <tr className={FEED_ROW}>
      <td className={clsx(FEED_CELL, 'align-middle', FEED_CELL_TIME)}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_MONO, 'mono')}
          value={vals.session_time}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, session_time: e.target.value } : p))}
          onBlur={(e) => commitField('session_time', e.target.value)}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-middle')}>
        <input
          className={FEED_INLINE_INPUT}
          value={formatSpeaker(vals.speaker, speakerOffset)}
          placeholder="Unknown"
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, speaker: e.target.value } : p))}
          onBlur={(e) => commitField('speaker', e.target.value)}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-middle')}>
        <input
          className={FEED_INLINE_INPUT}
          value={vals.word}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, word: e.target.value } : p))}
          onBlur={(e) => commitField('word', e.target.value)}
        />
      </td>
    </tr>
  );
});
