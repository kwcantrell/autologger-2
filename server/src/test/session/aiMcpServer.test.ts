// Source inspection of the create_event handler (async-session-hub D8 / delta spec "The
// create_event cap is reserved before any await"). It reads a file and runs no hub, so it runs in
// the unit tier (moved from aiMcpServer.int.test.ts, which keeps the behavioral cap tests).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_RUNTIME_FIXTURES_DIR } from '@autologger/ai-runtime/fixturesDir';
import { describe, expect, it } from 'vitest';

/** Strip `//` and `/* *\/` comments while preserving string/template literal
 * content verbatim — the same dependency-free regex idiom
 * `packageBoundaries.repo.test.ts` uses for source inspection without a real
 * parser. Comments in the `create_event` handler literally contain the word
 * "await" in prose ("never held across an await"), so comments MUST be
 * stripped before a substring search for the keyword, or the pin below would
 * false-positive on its own documentation. */
function stripComments(src: string): string {
  return src.replace(
    /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('//') || m.startsWith('/*') ? '' : m),
  );
}

describe('create_event handler — the cap is reserved before the first await (async-session-hub D8 / delta spec "The create_event cap is reserved before any await")', () => {
  const AI_MCP_SERVER_SRC = join(AI_RUNTIME_FIXTURES_DIR, '../src/aiMcpServer.ts');

  it('stripComments removes a comment containing the word "await" (mutation check — proves the predicate is not vacuous)', async () => {
    const sample = 'const x = 1; // never held across an await\nconst y = 2;';
    const stripped = stripComments(sample);
    expect(stripped).not.toMatch(/await/);
    expect(stripped).toContain('const y = 2;');
  });

  it("the handler's cap check and its reservation both precede its first `await`", async () => {
    const source = readFileSync(AI_MCP_SERVER_SRC, 'utf8');
    const startMarker =
      'create_event: (server, { registry, sessionId, caller, generation, createdEvents }) => {';
    const startIdx = source.indexOf(startMarker);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // The unique two-line close of TOOL_BUILDERS ("  },\n};") — create_event
    // is TOOL_BUILDERS' last key, so this is the entry's own close too.
    const endMarker = '\n  },\n};';
    const endIdx = source.indexOf(endMarker, startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const handler = stripComments(source.slice(startIdx, endIdx));
    const capCheck = handler.indexOf(
      'if (createdEvents.count + createdEvents.reserved >= generation.cap)',
    );
    const reserve = handler.indexOf('createdEvents.reserved += 1;');
    expect(capCheck).toBeGreaterThanOrEqual(0);
    expect(reserve).toBeGreaterThan(capCheck);
    const firstAwait = handler.search(/\bawait\b/);
    if (firstAwait >= 0) expect(reserve).toBeLessThan(firstAwait);
  });
});
