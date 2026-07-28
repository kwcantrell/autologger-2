// ai-topics-chat (design D3) — the in-process, loopback-only MCP listener.
//
// This is the transport/auth/registration SEAM for the session-scoped MCP
// toolset. It runs INSIDE the existing Node process (single-process invariant
// holds — a second listener, not a second process), bound to 127.0.0.1 on an
// ephemeral port, speaking Streamable HTTP via `@modelcontextprotocol/sdk`.
//
// Security posture (D3, the deliberate loopback invariant — mirror of the Vite
// `server.host` pin):
//   - NEVER binds a non-loopback address (hardcoded 127.0.0.1). "Helpfully"
//     binding it to LAN, or folding it onto the public :8787 app, re-opens
//     exactly the surface this design closes.
//   - Each chat turn registers with a per-turn ≥128-bit bearer token; the token
//     is validated AT THE HTTP LAYER, before any transport dispatch. An unknown
//     or dropped token gets 401 and never reaches the MCP transport.
//   - The autologger :sessionId a turn operates on is bound by the turn
//     REGISTRATION (token → sessionId), never by a tool parameter — the model
//     cannot address another session.
//   - Concurrent turns share the one listener via per-connection (per-request)
//     transport instantiation, so two turns on distinct sessions never share
//     transport state.
//   - Tool bodies resolve the hub at CALL TIME (`registry.get(sessionId)`),
//     never holding a handle across an await, so the idle-eviction sweeper can't
//     close it underneath a long turn.
//
// This listener is loopback-internal infrastructure — it adds NOTHING to the
// public :8787 HTTP/WS contract.
//
// Scope: this file owns the listener + registration + bearer/session resolution
// (task 2.1) AND the session-scoped MCP toolset (task 2.2) — the three tools'
// bodies in `buildSessionMcpServer`: `get_transcript_words` and `list_topics`
// read hub rows at call time; `create_topic` validates with `topicCreateSchema`
// and writes through the transactional `SessionHub.insertTopic` path.

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { topicCreateSchema } from '../schemas';
import type { SessionHubRegistry } from '../session/SessionHub';

const LOOPBACK = '127.0.0.1';
const MCP_PATH = '/mcp';
/** 32 bytes = 256 bits, comfortably over the ≥128-bit requirement (D3). */
const TOKEN_BYTES = 32;
const BEARER_PREFIX = 'Bearer ';

/** MCP server name — tool wire names are `mcp__autologger__<tool>` (spec). */
const MCP_SERVER_NAME = 'autologger';

/** The three tool short names exposed to the model (spec: Session-scoped MCP
 * toolset). Wire names are `mcp__${MCP_SERVER_NAME}__${name}`. */
export const AI_MCP_TOOL_NAMES = ['get_transcript_words', 'list_topics', 'create_topic'] as const;

/** One of the three short tool names above — the type callers use to
 * restrict `--allowedTools` for a turn (topic-generation design D7/D3). */
export type AiMcpToolName = (typeof AI_MCP_TOOL_NAMES)[number];

/** A registered chat turn's MCP coordinates. The CLI runner (task 3.2) consumes
 * this: `url` + `token` build the generated `--mcp-config`, and `dispose()` is
 * called in the turn's `finally` to drop the registration + retire the token. */
export interface AiMcpTurn {
  /** Loopback URL (127.0.0.1 + ephemeral port + /mcp) for `--mcp-config`. */
  readonly url: string;
  /** Per-turn bearer token (≥128-bit), sent as `Authorization: Bearer <token>`
   * and validated at the HTTP layer before dispatch. */
  readonly token: string;
  /** Drop the registration (idempotent). After this, the token gets 401. */
  dispose(): void;
}

interface TurnRegistration {
  readonly sessionId: string;
}

/**
 * The `create_topic` parameter surface advertised to the model. This declares
 * only field NAMES/TYPES for discoverability — the authoritative BOUNDS
 * (`session_time` ≤ 20, `duration_sec` ≥ 0, `topic_level` 1–10 int, `summary`
 * ≤ 8000) are NOT re-derived here: they live solely in `topicCreateSchema`,
 * applied inside the handler so a violation returns an `isError` tool result to
 * the model rather than a thrown JSON-RPC error (SDK schema validation throws
 * `McpError` before the handler runs — spec: "a violation SHALL return a tool
 * error to the model, no insert, no crash"). Fields are optional because
 * `topicCreateSchema` defaults each one.
 */
const createTopicToolShape = {
  session_time: z
    .string()
    .optional()
    .describe('Timecode into the session, HH:MM:SS-style (≤ 20 chars).'),
  duration_sec: z.number().optional().describe('Topic duration in seconds (≥ 0).'),
  topic_level: z.number().optional().describe('Topic depth/level, integer 1–10.'),
  summary: z.string().optional().describe('Concise topic summary (≤ 8000 chars).'),
};

/**
 * Build the per-request McpServer bound to one autologger session. All three
 * tools resolve the hub at call time via the registry (never held across an
 * await, so the idle-eviction sweeper can't close it underneath a long turn)
 * and can address ONLY `sessionId` — no tool parameter names a session.
 *
 * `get_transcript_words` / `list_topics` return the hub row fields verbatim;
 * `get_transcript_words` therefore OMITS the per-word `session_id` the HTTP read
 * surface adds (redundant here — the session is fixed by the registration).
 * `create_topic` validates with `topicCreateSchema` and writes through the
 * transactional, ordinal-assigning `SessionHub.insertTopic` — the identical code
 * path a manual insert takes (no WS emission: topics have none).
 */
/** Render transcript words as compact, readable text for the model. Groups
 * consecutive words by speaker into lines, each prefixed with the segment's
 * first available timecode (`[HH:MM:SS] speaker N: words…`). Empty timecodes
 * (anchorless transcripts) and blank speakers are omitted from the prefix. A
 * ~20x reduction vs `JSON.stringify(words)`, which kept the model from ever
 * reading a real (multi-thousand-word) transcript. */
function formatTranscriptForModel(
  words: Array<{ word: string; session_time: string; speaker: string }>,
): string {
  if (words.length === 0) return '(this session has no transcript)';
  const lines: string[] = [];
  let curSpeaker: string | null = null;
  let segTime = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const timePrefix = segTime ? `[${segTime}] ` : '';
    const speakerPrefix = curSpeaker ? `speaker ${curSpeaker}: ` : '';
    lines.push(`${timePrefix}${speakerPrefix}${buf.join(' ')}`.trim());
    buf = [];
  };
  for (const w of words) {
    const speaker = w.speaker ?? '';
    if (speaker !== curSpeaker) {
      flush();
      curSpeaker = speaker;
      segTime = w.session_time || '';
    } else if (!segTime && w.session_time) {
      segTime = w.session_time;
    }
    buf.push(w.word);
  }
  flush();
  return lines.join('\n');
}

function buildSessionMcpServer(registry: SessionHubRegistry, sessionId: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });

  server.tool(
    'get_transcript_words',
    "Returns this session's transcript as readable text (speaker- and " +
      'timecode-annotated), for reading and summarizing.',
    {},
    async () => {
      // Hub resolved at call time (D3) — never held across an await.
      const words = registry.get(sessionId).listTranscriptWords();
      // Return COMPACT, readable text — NOT the verbose per-word JSON. A real
      // transcript is thousands of 8-field word rows (~180 chars each); the
      // raw `JSON.stringify(words)` produced a single ~300KB line that
      // overflowed the CLI's tool-output token limit, so the model could not
      // read it at all and generated no usable topics. Grouping words into
      // speaker/timecode-prefixed lines drops that ~20x while preserving what
      // the model needs to read and to place topics on the timeline.
      return { content: [{ type: 'text', text: formatTranscriptForModel(words) }] };
    },
  );

  server.tool('list_topics', "Returns this session's topics.", {}, async () => {
    // Hub resolved at call time (D3) — never held across an await.
    const topics = registry.get(sessionId).listTopics();
    return { content: [{ type: 'text', text: JSON.stringify(topics) }] };
  });

  server.tool(
    'create_topic',
    'Create one topic on this session. The ordinal is assigned by the server.',
    createTopicToolShape,
    async (args) => {
      // Bounds enforced ONLY by topicCreateSchema (no re-derivation). On
      // violation return an isError tool result — NOT a thrown crash — and do
      // not insert (spec: "Out-of-bounds tool input is rejected safely").
      const parsed = topicCreateSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid topic input: ${parsed.error.issues
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                .join('; ')}`,
            },
          ],
          isError: true,
        };
      }
      // Hub resolved at call time (D3). insertTopic is the transactional,
      // server-assigned-ordinal manual-insert path; topics have no WS emission,
      // and this path introduces none.
      const topic = registry.get(sessionId).insertTopic(parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify(topic) }] };
    },
  );

  return server;
}

/**
 * The loopback-only, ephemeral-port Streamable-HTTP MCP listener. One instance
 * per Node process (see `getAiMcpListener`); tests may construct it directly.
 */
export class AiMcpListener {
  private httpServer: http.Server | null = null;
  private startPromise: Promise<void> | null = null;
  /** token → registration. The bearer allowlist: unknown token ⇒ 401. */
  private readonly turns = new Map<string, TurnRegistration>();

  constructor(private readonly registry: SessionHubRegistry) {}

  /** Start the listener (idempotent). Binds 127.0.0.1 on an ephemeral port —
   * NEVER a non-loopback address. Resolves once listening. */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.httpServer = server;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(0, LOOPBACK, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    return this.startPromise;
  }

  /** The bound address, or null before `start()` resolves. */
  get address(): AddressInfo | null {
    const a = this.httpServer?.address();
    return a && typeof a === 'object' ? a : null;
  }

  private get port(): number {
    const a = this.address;
    if (a === null) throw new Error('AiMcpListener not started');
    return a.port;
  }

  /**
   * Register a chat turn: mint a ≥128-bit bearer token bound to `sessionId` and
   * return the URL + token for the generated `--mcp-config`. The returned
   * `dispose()` (idempotent) drops the registration and retires the token — call
   * it in the turn's `finally`.
   */
  registerTurn(sessionId: string): AiMcpTurn {
    if (this.httpServer === null) throw new Error('AiMcpListener not started');
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    this.turns.set(token, { sessionId });
    const url = `http://${LOOPBACK}:${this.port}${MCP_PATH}`;
    let disposed = false;
    return {
      url,
      token,
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        this.turns.delete(token);
      },
    };
  }

  /** In-flight registration count (introspection / tests). */
  get registrationCount(): number {
    return this.turns.size;
  }

  /** Stop the listener and drop all registrations. */
  async close(): Promise<void> {
    this.turns.clear();
    const server = this.httpServer;
    this.httpServer = null;
    this.startPromise = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // ── Bearer check AT THE HTTP LAYER, before any transport dispatch (D3). ──
    const reg = this.resolveTurn(req);
    if (reg === null) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Per-connection (per-request) transport instantiation (D3): stateless,
    // so concurrent turns never share transport state. The tools are bound to
    // this turn's sessionId — resolved from the registration, not a param.
    try {
      const server = buildSessionMcpServer(this.registry, reg.sessionId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  }

  /** Extract the bearer token and resolve its registration, or null (⇒ 401). */
  private resolveTurn(req: http.IncomingMessage): TurnRegistration | null {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith(BEARER_PREFIX)) return null;
    const token = auth.slice(BEARER_PREFIX.length);
    if (token.length === 0) return null;
    return this.turns.get(token) ?? null;
  }
}

/** Read the full request body as parsed JSON, or undefined for a bodiless GET. */
async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  let raw = '';
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

// ── Process-wide singleton (the shared home task 3.2 consumes) ───────────────

let singletonPromise: Promise<AiMcpListener> | null = null;

/**
 * Get the process-wide MCP listener, starting it on first use with the app's
 * `SessionHubRegistry`. Single Node process ⇒ one registry ⇒ one listener; the
 * CLI runner (task 3.2) calls this, then `registerTurn` / `dispose` per turn.
 * The STARTED promise is cached (not the bare instance), so concurrent first
 * callers all await the same completed `start()` — never an unstarted listener
 * whose `port` getter would throw. A failed start clears the cache so a later
 * call can retry.
 */
export function getAiMcpListener(registry: SessionHubRegistry): Promise<AiMcpListener> {
  singletonPromise ??= (async () => {
    const listener = new AiMcpListener(registry);
    await listener.start();
    return listener;
  })().catch((err) => {
    singletonPromise = null;
    throw err;
  });
  return singletonPromise;
}

/** Test-only: close and clear the singleton so it doesn't leak across cases. */
export async function __resetAiMcpListenerForTests(): Promise<void> {
  const p = singletonPromise;
  singletonPromise = null;
  if (p !== null) {
    const listener = await p.catch(() => null);
    if (listener !== null) await listener.close();
  }
}
