// ai-topics-chat (task 3.3, design D6, spec "SSE reply stream shape") — the
// JSONL→SSE stream relay: parses the spawned `claude` CLI's stream-json
// stdout and maps it to the frozen four-event SSE vocabulary (delta/tool/
// done/error), enforcing:
//
//   - DEDUP (D6): text/tool events are relayed ONLY from full `assistant`
//     message events; every `stream_event` partial line is dropped wholesale
//     — the `--include-partial-messages` double-emit the 2026-07-14 spike
//     proved (the same text/tool_use appears both as partial stream_event
//     lines AND in the complete assistant message).
//   - PRIVACY (D6): `thinking`/`signature`/any non-`text`/`tool_use` content
//     block is never mapped to an SSE event — model reasoning never reaches
//     the client.
//   - `tool_use` blocks → `tool {name}` with the `mcp__autologger__` wire
//     prefix stripped (spec: the short name).
//   - the terminal `result` (not `is_error`) → `done {claude_session_id}`,
//     using the session id captured from the `system/init` line (falling
//     back to the result line's own `session_id`).
//   - every other failure path — a CLI-signaled `result.is_error`, a nonzero
//     exit, unparseable/absent stdout, a spawn error, or a `claude login`-
//     class stderr message — maps to exactly one scrubbed `error {detail}`
//     from the fixed set (spec: never raw stdout/stderr/paths/URLs).
//   - unrecognized JSONL `type`s are ignored, not fatal (forward-compat with
//     future CLI versions — mirrors the SSE vocabulary's additive-open
//     posture on the wire this relay consumes).
//   - exactly ONE terminal event (`done` XOR `error`) per completed stream —
//     enforced by short-circuiting on the first terminal-producing line and
//     never emitting a second one from the post-stream exit-code fallback.

import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** The scrubbed error details this relay can emit. `not-configured` belongs
 * to the route's 503 gate (never reached here); `timeout` is task 3.4's kill
 * ladder — this relay never emits it, but the type stays open for reuse. */
export type AiChatErrorDetail = 'upstream-failed' | 'not-logged-in' | 'internal-error' | 'timeout';

export interface AiChatSseEvent {
  event: 'delta' | 'tool' | 'done' | 'error';
  data: Record<string, unknown>;
}

export type AiChatRelayOutcome =
  | { ok: true; claudeSessionId: string }
  | { ok: false; detail: AiChatErrorDetail };

const TOOL_PREFIX = 'mcp__autologger__';

/** Stderr signatures of a `claude login` / auth failure — the CLI reports
 * these as plain text (never stream-json), including a device-login URL.
 * Matched ONLY to select the `not-logged-in` detail; the matched text itself
 * is never relayed to the client. */
const LOGIN_FAILURE_PATTERN = /claude login|invalid api key|not logged in|please authenticate/i;

function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function waitForExitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
}

interface RelayState {
  initSessionId: string | undefined;
}

/** Handle one parsed JSONL object; returns a terminal outcome once a `result`
 * line resolves the turn, or `null` for every non-terminal / ignored line. */
async function processLine(
  obj: unknown,
  emit: (event: AiChatSseEvent) => Promise<void> | void,
  state: RelayState,
): Promise<AiChatRelayOutcome | null> {
  if (obj === null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const type = rec.type;

  if (type === 'system') {
    if (rec.subtype === 'init' && typeof rec.session_id === 'string') {
      state.initSessionId = rec.session_id;
    }
    return null;
  }

  if (type === 'assistant') {
    const content = (rec.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          await emit({ event: 'delta', data: { text: b.text } });
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          await emit({ event: 'tool', data: { name: stripToolPrefix(b.name) } });
        }
        // thinking / signature / redacted_thinking / anything else: never
        // relayed — the model's reasoning stays server-side (D6).
      }
    }
    return null;
  }

  if (type === 'result') {
    const isError = Boolean(rec.is_error);
    if (!isError) {
      const sessionId =
        state.initSessionId ?? (typeof rec.session_id === 'string' ? rec.session_id : undefined);
      if (sessionId) {
        await emit({ event: 'done', data: { claude_session_id: sessionId } });
        return { ok: true, claudeSessionId: sessionId };
      }
      // A success result with no session id anywhere is unusable for resume
      // — surface it as our own scrubbed failure rather than a bogus `done`.
      await emit({ event: 'error', data: { detail: 'internal-error' } });
      return { ok: false, detail: 'internal-error' };
    }
    // CLI-signaled failure (budget exceeded, refusal, …) — `result.result`
    // may carry free-text detail; never relay it, only the fixed detail.
    await emit({ event: 'error', data: { detail: 'upstream-failed' } });
    return { ok: false, detail: 'upstream-failed' };
  }

  // `stream_event` (dropped — D6 dedup), `user` (tool_result echoes),
  // `rate_limit_event`, and any other/unrecognized type: ignored.
  return null;
}

/**
 * Relay one child `claude` turn's stdout to `emit`, per the D6 mapping.
 * `emit` is awaited so SSE backpressure is respected; this function itself
 * never throws — every failure path (parse errors, a nonzero exit, a spawn
 * error, unparseable/empty output, a `claude login` stderr message) resolves
 * to exactly one `error` emission instead. Resolves once the turn is over.
 */
export async function relayAiChatTurn(
  child: ChildProcess,
  emit: (event: AiChatSseEvent) => Promise<void> | void,
): Promise<AiChatRelayOutcome> {
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  let spawnError: Error | null = null;
  child.once('error', (err) => {
    spawnError = err;
  });

  const state: RelayState = { initSessionId: undefined };
  let terminal: AiChatRelayOutcome | null = null;

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const raw of rl) {
      if (terminal) continue; // keep draining so the child never blocks on a full pipe
      const line = raw.trim();
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // unparseable line on its own is not fatal — D6/spec: only
        // a stream that never produces a usable result becomes an error.
      }
      terminal = await processLine(obj, emit, state);
    }
  }

  const exitCode = await waitForExitCode(child);
  if (terminal) return terminal;

  const stderrText = Buffer.concat(stderrChunks).toString('utf8');
  const detail: AiChatErrorDetail = spawnError
    ? 'internal-error'
    : LOGIN_FAILURE_PATTERN.test(stderrText)
      ? 'not-logged-in'
      : exitCode !== 0
        ? 'upstream-failed'
        : 'internal-error';
  await emit({ event: 'error', data: { detail } });
  return { ok: false, detail };
}
