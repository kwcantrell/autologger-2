import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { TooltipProvider } from '../../../shared/ui/Tooltip';
import { renderStrict } from '../../../test/renderStrict';
import { buildTopicsCsv, downloadTopicsCsv } from '../utils/topicsCsv';
import { buildTranscriptCsv, downloadTranscriptCsv } from '../utils/transcriptCsv';
import { ExportFeed } from './ExportFeed';

// --- Export tab client-side CSV wiring (PR#4 review fix: previously untested)
//
// Every SessionWorkspace suite mocks ExportFeed to null and the visual shot
// only asserts the Event-feed link, so the Transcript/Topics buttons' disabled
// gating and click-to-download wiring (including the shared speakerOffset — a
// 0-based DeepGram transcript must export as Speaker 1..N) had no coverage.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../utils/transcriptCsv', () => ({
  buildTranscriptCsv: vi.fn(() => 'transcript,csv'),
  downloadTranscriptCsv: vi.fn(),
}));
vi.mock('../utils/topicsCsv', () => ({
  buildTopicsCsv: vi.fn(() => 'topics,csv'),
  downloadTopicsCsv: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_ID = 'sess-export-1';

const WORDS = [
  { id: 'w-1', session_id: SESSION_ID, session_time: '00:00:01:00', speaker: '0', word: 'hi', ordinal: 1 },
  { id: 'w-2', session_id: SESSION_ID, session_time: '00:00:02:00', speaker: '1', word: 'there', ordinal: 2 },
];
const TOPICS = [
  {
    id: 't-1',
    session_time: '00:00:01:00',
    duration_sec: 10,
    topic_level: 1,
    summary: 'First topic',
    ordinal: 1,
    created_at_utc: '2026-08-06T00:00:01Z',
  },
];

function mockData(words: unknown[], topics: unknown[]) {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/transcript-words')) return { words };
    if (path.includes('/topics')) return { topics };
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

function renderFeed() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={400}>
        <ExportFeed sessionId={SESSION_ID} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const transcriptBtn = () =>
  screen.getByRole('button', { name: /Transcript CSV/ }) as HTMLButtonElement;
const topicsBtn = () => screen.getByRole('button', { name: /Topics CSV/ }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExportFeed', () => {
  it('disables Transcript/Topics CSV while empty; server-side exports stay links', async () => {
    mockData([], []);
    renderFeed();
    await screen.findByRole('link', { name: /Event feed CSV/ });

    expect(transcriptBtn().disabled).toBe(true);
    expect(topicsBtn().disabled).toBe(true);
    fireEvent.click(transcriptBtn());
    fireEvent.click(topicsBtn());
    expect(downloadTranscriptCsv).not.toHaveBeenCalled();
    expect(downloadTopicsCsv).not.toHaveBeenCalled();

    const eventCsv = screen.getByRole('link', { name: /Event feed CSV/ });
    expect(eventCsv.getAttribute('href')).toContain(`/sessions/${SESSION_ID}/export.csv`);
    const eventJsonl = screen.getByRole('link', { name: /Event feed JSONL/ });
    expect(eventJsonl.getAttribute('href')).toContain(`/sessions/${SESSION_ID}/export.jsonl`);
  });

  it('downloads the transcript CSV with the shared speaker offset (0-based → +1)', async () => {
    mockData(WORDS, TOPICS);
    renderFeed();
    await screen.findByRole('button', { name: 'Transcript CSV (2)' });

    expect(transcriptBtn().disabled).toBe(false);
    fireEvent.click(transcriptBtn());
    expect(buildTranscriptCsv).toHaveBeenCalledExactlyOnceWith(WORDS, 1);
    expect(downloadTranscriptCsv).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'transcript,csv');
  });

  it('downloads the topics CSV when topics exist', async () => {
    mockData(WORDS, TOPICS);
    renderFeed();
    await screen.findByRole('button', { name: 'Topics CSV (1)' });

    expect(topicsBtn().disabled).toBe(false);
    fireEvent.click(topicsBtn());
    expect(buildTopicsCsv).toHaveBeenCalledExactlyOnceWith(TOPICS);
    expect(downloadTopicsCsv).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'topics,csv');
  });
});
