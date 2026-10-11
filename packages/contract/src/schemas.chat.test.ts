// The AI chat request body and `done` payload (ai-sdk-agent-harness design D6; api-contract-freeze
// "AI chat request and done event"). `history` is bounded to 40 user/assistant entries, each 1-8000
// characters after trimming and 64 000 in total; `claude_session_id: null` means absent; `done`
// carries a non-empty id on a CLI turn and null on an AI SDK turn. A NUL anywhere in the body is
// answered by the route with the existing NUL `400` before this schema runs.

import { describe, expect, it } from 'vitest';
import {
  CHAT_HISTORY_MAX_CHARS,
  CHAT_HISTORY_MAX_ENTRIES,
  chatDoneEventSchema,
  chatRequestSchema,
} from './schemas';

const ok = (body: unknown) => chatRequestSchema.safeParse(body).success;
const entry = (role: string, text: string) => ({ role, text });

describe('chatRequestSchema history (ai-sdk-agent-harness D6)', () => {
  it('bounds are 40 entries and 64 000 characters', () => {
    expect(CHAT_HISTORY_MAX_ENTRIES).toBe(40);
    expect(CHAT_HISTORY_MAX_CHARS).toBe(64_000);
  });

  it('is optional, and passes the entries through trimmed and in order', () => {
    expect(ok({ message: 'hi' })).toBe(true);
    const r = chatRequestSchema.safeParse({
      message: 'next',
      history: [entry('user', '  first  '), entry('assistant', 'reply\n')],
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.history).toEqual([entry('user', 'first'), entry('assistant', 'reply')]);
  });

  it('accepts 40 entries totalling 64 000 characters, and refuses a 41st entry', () => {
    const forty = Array.from({ length: 40 }, (_, i) =>
      entry(i % 2 ? 'assistant' : 'user', 'x'.repeat(1600)),
    );
    expect(ok({ message: 'hi', history: forty })).toBe(true);
    expect(ok({ message: 'hi', history: [...forty.slice(1), entry('user', 'y')] })).toBe(true);
    expect(ok({ message: 'hi', history: [...forty, entry('user', 'y')] })).toBe(false);
  });

  it('refuses more than 64 000 characters in total, counted after trimming', () => {
    const big = Array.from({ length: 8 }, () => entry('user', 'x'.repeat(8000)));
    expect(ok({ message: 'hi', history: big })).toBe(true);
    expect(ok({ message: 'hi', history: [...big, entry('assistant', 'x')] })).toBe(false);
    // Surrounding whitespace is trimmed before counting.
    expect(
      ok({ message: 'hi', history: [...big.slice(1), entry('user', ` ${'x'.repeat(8000)} `)] }),
    ).toBe(true);
  });

  it('allows only the user and assistant roles', () => {
    for (const role of ['system', 'tool', 'User', '', 'developer'])
      expect(ok({ message: 'hi', history: [entry(role, 'x')] }), role).toBe(false);
  });

  it('refuses an entry text that is empty after trimming or over 8000 characters', () => {
    expect(ok({ message: 'hi', history: [entry('user', '   ')] })).toBe(false);
    expect(ok({ message: 'hi', history: [entry('user', '')] })).toBe(false);
    expect(ok({ message: 'hi', history: [entry('user', 'x'.repeat(8000))] })).toBe(true);
    expect(ok({ message: 'hi', history: [entry('user', 'x'.repeat(8001))] })).toBe(false);
  });

  it('refuses a malformed history or entry', () => {
    for (const history of [null, 'x', {}, [null], [{ role: 'user' }], [{ text: 'x' }], [{ role: 'user', text: 1 }]])
      expect(ok({ message: 'hi', history }), JSON.stringify(history)).toBe(false);
  });
});

describe('chatRequestSchema claude_session_id (ai-sdk-agent-harness D6)', () => {
  it('accepts null as absent', () => {
    const r = chatRequestSchema.safeParse({ message: 'hi', claude_session_id: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.claude_session_id).toBeUndefined();
  });

  it('still takes a non-empty string and refuses an empty one', () => {
    const r = chatRequestSchema.safeParse({ message: 'hi', claude_session_id: 'abc' });
    expect(r.success && r.data.claude_session_id).toBe('abc');
    expect(ok({ message: 'hi', claude_session_id: '' })).toBe(false);
    expect(ok({ message: 'hi', claude_session_id: 1 })).toBe(false);
  });
});

describe('chatDoneEventSchema (ai-sdk-agent-harness D6)', () => {
  it('carries a non-empty CLI session id, or null on an AI SDK turn', () => {
    expect(chatDoneEventSchema.safeParse({ claude_session_id: 's1' }).success).toBe(true);
    expect(chatDoneEventSchema.safeParse({ claude_session_id: null }).success).toBe(true);
    expect(chatDoneEventSchema.safeParse({ claude_session_id: '' }).success).toBe(false);
    expect(chatDoneEventSchema.safeParse({}).success).toBe(false);
    expect(chatDoneEventSchema.safeParse({ claude_session_id: null, x: 1 }).success).toBe(false);
  });
});
