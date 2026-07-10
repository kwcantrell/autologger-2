import clsx from 'clsx';
import { memo, useState } from 'react';
import type { TranscriptWord } from '../../../api/types';
import styles from './FeedTable.module.css';

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
    <tr className={styles.feedRow}>
      <td className={clsx(styles.feedCell, styles.feedCellTime)}>
        <input
          className={clsx(styles.feedInlineInput, 'mono')}
          value={vals.session_time}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, session_time: e.target.value } : p))}
          onBlur={(e) => commitField('session_time', e.target.value)}
        />
      </td>
      <td className={styles.feedCell}>
        <input
          className={styles.feedInlineInput}
          value={formatSpeaker(vals.speaker, speakerOffset)}
          placeholder="Unknown"
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, speaker: e.target.value } : p))}
          onBlur={(e) => commitField('speaker', e.target.value)}
        />
      </td>
      <td className={styles.feedCell}>
        <input
          className={styles.feedInlineInput}
          value={vals.word}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, word: e.target.value } : p))}
          onBlur={(e) => commitField('word', e.target.value)}
        />
      </td>
    </tr>
  );
});
