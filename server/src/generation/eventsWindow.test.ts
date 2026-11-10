// batch-autogenerate D6: the events runner keeps the route's await-free window (async-session-callers
// D4; core-ports-architecture "Server code never drops or misuses a promise"): from the resolved
// transcript word snapshot to the per-session AI slot there is no await and no catalog call. The
// route's own source check (`routers/eventsGenerateWindow.test.ts`) reads `routers/events.ts`,
// where this code lived before the extraction.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('events runner word-snapshot window', () => {
  it('has no await and no catalog call between the snapshot and tryAcquire', () => {
    const src = readFileSync(join(__dirname, 'events.ts'), 'utf8');
    const snapshot =
      'const transcriptWords = await (await hubFor(p, sessionId)).listTranscriptWords();';
    const at = src.indexOf(snapshot);
    expect(at).toBeGreaterThan(0);
    const start = at + snapshot.length;
    const end = src.indexOf('aiChatTurns.tryAcquire(', start);
    expect(end).toBeGreaterThan(start);
    const window = src.slice(start, end);
    expect(window).not.toMatch(/\bawait\b/);
    expect(window).not.toMatch(/catalog\./);
  });
});
