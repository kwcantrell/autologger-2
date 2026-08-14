import type { TranscriptWord } from '../../../api/types';
import { formatSpeaker } from './speakerOffset';

const COLUMNS = ['Session Time', 'Speaker', 'Word(s)'] as const;

/** QUOTE_MINIMAL-style quoting + CRLF — same dialect as server export.csv. */
function csvField(value: string): string {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build a CSV of transcript words in ordinal (chronological) order. */
export function buildTranscriptCsv(words: TranscriptWord[], speakerOffset: number): string {
  const ordered = [...words].sort((a, b) => a.ordinal - b.ordinal);
  const lines = [COLUMNS.map(csvField).join(',')];
  for (const w of ordered) {
    lines.push(
      [
        csvField(w.session_time),
        csvField(formatSpeaker(w.speaker, speakerOffset)),
        csvField(w.word),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Trigger a browser download of the given CSV text. */
export function downloadTranscriptCsv(sessionId: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcription_${sessionId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
