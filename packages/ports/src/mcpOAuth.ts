// The MCP OAuth server's storage ports (ADR 0035 decisions 5, 16, 17; design
// docs/design/custom-session-dashboards.md sections 4.3, 4.7 and 4.9; mcp-authorization).
// `@autologger/storage` implements both on the system-only `catalog.mcp_*` tables:
// - `McpOAuthStore` on `bindSystem('mcp-oauth')`, wired as `Bindings.ports.mcpOAuth`: client
//   registration and the shared rate-limit windows;
// - `McpOAuthSweeper` on `bindSystem('mcp-sweep')`, wired as `Bindings.ports.mcpOAuthSweeper`:
//   the once-a-minute cleanup.
// Raw tokens never pass through here; the tables hold only their SHA-256 (hex).

/** A client to register. `redirect_uris` are already validated (1-5). */
export interface NewMcpClient {
  id: string;
  client_name: string;
  redirect_uris: string[];
  /** The IPv4 address or IPv6 /64 the registration limit counted. */
  registered_from: string;
}

/** `registerClient`'s result: the stored client, or the live-client cap already reached. */
export type RegisterMcpClientResult =
  | { kind: 'created'; created_at_utc: string }
  | { kind: 'cap-reached' };

export interface McpOAuthStore {
  /**
   * Counts one hit in the fixed window of `windowMs` that holds the clock's now, for `bucket`,
   * and returns the window's count including this hit and the milliseconds left in the window.
   * One atomic upsert, shared by every process.
   */
  takeRateSlot(bucket: string, windowMs: number): Promise<{ count: number; retryAfterMs: number }>;
  /** Inserts the client unless `maxClients` clients already exist, in one statement. */
  registerClient(client: NewMcpClient, maxClients: number): Promise<RegisterMcpClientResult>;
}

/** What one sweep deleted or cleared, per kind (each bounded by the sweep's limit). */
export interface McpOAuthSweepResult {
  accessTokens: number;
  refreshTokens: number;
  sealsCleared: number;
  grants: number;
  clients: number;
  rateWindows: number;
}

export interface McpOAuthSweeper {
  /**
   * One cleanup pass at the clock's now (design section 4.9). `graceSeconds` is the refresh grace
   * window: a refresh token used longer ago than that loses its `successor_sealed`.
   */
  sweepOnce(graceSeconds: number): Promise<McpOAuthSweepResult>;
}
