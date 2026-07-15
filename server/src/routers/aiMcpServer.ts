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
// Scope split: this file owns the listener + registration + bearer/session
// resolution (task 2.1). Task 2.2 (Session-scoped MCP toolset) owns the final
// tool-output contract (row-field shaping), `create_topic`'s topicCreateSchema
// validation and `SessionHub.insertTopic` write path, and the tool int tests —
// see the TODO(2.2) markers in `buildSessionMcpServer`.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
export const AI_MCP_TOOL_NAMES = [
  'get_transcript_words',
  'list_topics',
  'create_topic',
] as const;

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
 * Build the per-request McpServer bound to one autologger session. The three
 * tools resolve the hub at call time via the registry (never held across an
 * await) and can address ONLY `sessionId` — no tool parameter names a session.
 *
 * Task 2.2 replaces the tool bodies with the spec'd contract (row-field shaping;
 * `create_topic` topicCreateSchema validation + `SessionHub.insertTopic` write
 * path). The two read tools are wired here as the minimal call-time-resolution
 * seam so this task's no-cross-talk test can exercise the full HTTP → transport
 * → auth → registration → hub-resolution path end to end.
 */
function buildSessionMcpServer(registry: SessionHubRegistry, sessionId: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });

  server.tool(
    'get_transcript_words',
    "Returns this session's transcript words (the DeepGram output).",
    {},
    async () => {
      // Hub resolved at call time (D3) — never held across an await.
      const words = registry.get(sessionId).listTranscriptWords();
      return { content: [{ type: 'text', text: JSON.stringify(words) }] };
    },
  );

  server.tool('list_topics', "Returns this session's topics.", {}, async () => {
    // Hub resolved at call time (D3) — never held across an await.
    const topics = registry.get(sessionId).listTopics();
    return { content: [{ type: 'text', text: JSON.stringify(topics) }] };
  });

  server.tool(
    'create_topic',
    'Create one topic on this session.',
    {},
    async () => {
      // TODO(2.2): validate input with topicCreateSchema bounds (tool error on
      // violation, no insert) and write through SessionHub.insertTopic (the
      // transactional, server-assigned-ordinal manual-insert code path).
      return {
        content: [{ type: 'text', text: 'create_topic is not yet implemented (task 2.2).' }],
        isError: true,
      };
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

let singleton: AiMcpListener | null = null;

/**
 * Get the process-wide MCP listener, starting it on first use with the app's
 * `SessionHubRegistry`. Single Node process ⇒ one registry ⇒ one listener; the
 * CLI runner (task 3.2) calls this, then `registerTurn` / `dispose` per turn.
 */
export async function getAiMcpListener(registry: SessionHubRegistry): Promise<AiMcpListener> {
  if (singleton === null) {
    singleton = new AiMcpListener(registry);
    await singleton.start();
  }
  return singleton;
}

/** Test-only: close and clear the singleton so it doesn't leak across cases. */
export async function __resetAiMcpListenerForTests(): Promise<void> {
  if (singleton !== null) {
    await singleton.close();
    singleton = null;
  }
}
