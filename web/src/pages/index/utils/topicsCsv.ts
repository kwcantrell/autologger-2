import type { SessionTopic } from '../../../api/types';

const COLUMNS = ['Session Time', 'Duration (s)', 'Level', 'Summary'] as const;

/** QUOTE_MINIMAL-style quoting + CRLF — same dialect as server export.csv. */
function csvField(value: string): string {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build a CSV of topics in ordinal (chronological) order. */
export function buildTopicsCsv(topics: SessionTopic[]): string {
  const ordered = [...topics].sort((a, b) => a.ordinal - b.ordinal);
  const lines = [COLUMNS.map(csvField).join(',')];
  for (const t of ordered) {
    lines.push(
      [
        csvField(t.session_time),
        csvField(String(t.duration_sec)),
        csvField(String(t.topic_level)),
        csvField(t.summary),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Trigger a browser download of the given CSV text. */
export function downloadTopicsCsv(sessionId: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `topics_${sessionId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
