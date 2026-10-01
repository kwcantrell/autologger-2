// POST …/events/generate: the transcript word snapshot to the AI turn registration is an
// await-free window holding no storage call (async-session-callers D4; core-ports-architecture
// "Server code never drops or misuses a promise").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('event-generation word-snapshot window', () => {
  it('has no await and no catalog call between the snapshot and tryAcquire', () => {
    const src = readFileSync(join(__dirname, 'events.ts'), 'utf8');
    const start = src.indexOf(
      'const transcriptWords = getSessionHub(c, sessionId).listTranscriptWords();',
    );
    const end = src.indexOf('aiChatTurns.tryAcquire(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const window = src.slice(start, end);
    expect(window).not.toMatch(/\bawait\b/);
    expect(window).not.toMatch(/catalog\./);
  });
});
