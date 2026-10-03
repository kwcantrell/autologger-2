// POST …/events/generate: from the resolved transcript word snapshot to the per-session AI slot is
// an await-free window holding no storage call (async-session-callers D4; core-ports-architecture
// "Server code never drops or misuses a promise"). The window starts after the awaited snapshot
// statement (async-session-hub D12).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('event-generation word-snapshot window', () => {
  it('has no await and no catalog call between the snapshot and tryAcquire', () => {
    const src = readFileSync(join(__dirname, 'events.ts'), 'utf8');
    const snapshot =
      'const transcriptWords = await (await getSessionHub(c, sessionId)).listTranscriptWords();';
    const at = src.indexOf(snapshot);
    expect(at).toBeGreaterThan(0);
    const start = at + snapshot.length;
    const end = src.indexOf('aiChatTurns.tryAcquire(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const window = src.slice(start, end);
    expect(window).not.toMatch(/\bawait\b/);
    expect(window).not.toMatch(/catalog\./);
  });
});
