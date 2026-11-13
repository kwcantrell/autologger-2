// The MCP OAuth server's storage ports (ADR 0035 decisions 5, 16, 17; design
// docs/design/custom-session-dashboards.md sections 4.3, 4.7 and 4.9; mcp-authorization).
// `@autologger/storage` implements both on the system-only `catalog.mcp_*` tables:
// - `McpOAuthStore` on `bindSystem('mcp-oauth')`, wired as `Bindings.ports.mcpOAuth`: client
//   registration and the shared rate-limit windows (J2), and grants, token issue, refresh
//   rotation with reuse detection and the grace window, and revocation (J3);
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

/** A registered client, as the authorization endpoint reads it. */
export interface McpClient {
  id: string;
  client_name: string;
  redirect_uris: string[];
}

/** A grant to create at consent. `id` is minted by the caller. */
export interface NewMcpGrant {
  id: string;
  userId: string;
  clientId: string;
  scope: string;
  resource: string;
}

/** A freshly minted token pair: the raw values go to the client, only the hashes are stored. */
export interface McpMintedTokens {
  accessToken: string;
  accessHash: string;
  refreshToken: string;
  refreshHash: string;
}

/** What a token answer carries: the raw tokens, the access token's expiry, and the grant's scope. */
export interface McpIssuedTokens {
  grantId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms: the earlier of 1 h after issue and the grant's 90-day cap. */
  accessExpiresAtMs: number;
  scope: string;
}

/** The successor a rotation seals onto the spent refresh token's row (design 4.5). */
export interface McpSealedSuccessor {
  access_token: string;
  refresh_token: string;
  /** Epoch ms. */
  access_expires_at: number;
}

/** The row a seal is bound to (its additional authenticated data). */
export interface McpSealBinding {
  tokenHash: string;
  grantId: string;
}

/** One `refresh_token` grant request (design 4.5). The crypto is the caller's: the store calls
 * `mint`, `seal` and `open` inside its transaction, which may run more than once, so each must be
 * free of side effects other than producing its value. */
export interface McpRefreshRequest {
  /** The hex sha256 of the presented refresh token. */
  tokenHash: string;
  /** The request's `client_id`, possibly not the grant's. */
  clientId: string;
  /** The grace window in whole seconds; 0 turns it off (no seal written, every reuse revokes). */
  graceSeconds: number;
  mint(): McpMintedTokens;
  seal(successor: McpSealedSuccessor, binding: McpSealBinding): string;
  /** The opened successor, or null when the seal doesn't open (wrong key or row). */
  open(sealed: string, binding: McpSealBinding): McpSealedSuccessor | null;
}

/**
 * The outcome of a refresh:
 * - `rotated`: the token was spent and a new pair issued;
 * - `grace`: a same-client reuse inside the window, answered with the successor already issued;
 * - `invalid`: unknown, expired, another client's live token, or a dead grant or user; nothing
 *   was written;
 * - `revoked`: a reuse outside the grace rules; the grant was revoked and its tokens deleted.
 */
export type McpRefreshResult =
  | { kind: 'rotated'; tokens: McpIssuedTokens }
  | { kind: 'grace'; tokens: McpIssuedTokens }
  | { kind: 'invalid' }
  | { kind: 'revoked'; grantId: string };

export interface McpOAuthStore {
  /**
   * Counts one hit in the fixed window of `windowMs` that holds the clock's now, for `bucket`,
   * and returns the window's count including this hit and the milliseconds left in the window.
   * One atomic upsert, shared by every process.
   */
  takeRateSlot(bucket: string, windowMs: number): Promise<{ count: number; retryAfterMs: number }>;
  /** Inserts the client unless `maxClients` clients already exist, in one statement. */
  registerClient(client: NewMcpClient, maxClients: number): Promise<RegisterMcpClientResult>;
  /** The client, or null when it is unknown (never registered, or swept). */
  getClient(id: string): Promise<McpClient | null>;
  /**
   * Creates a grant at consent, expiring 90 days after the clock's now (ADR 0035 decision 16),
   * and stamps the client's `last_authorized_at_utc`. Null when the client or the user is gone.
   */
  createGrant(grant: NewMcpGrant): Promise<{ expiresAtMs: number } | null>;
  /**
   * Issues the first token pair of a grant (the `authorization_code` exchange). Null, writing
   * nothing, when the grant is not the client's, is revoked or past its cap, or its user is
   * disabled.
   */
  issueTokens(
    grantId: string,
    clientId: string,
    tokens: McpMintedTokens,
  ): Promise<McpIssuedTokens | null>;
  /** Runs one `refresh_token` grant in one transaction (design 4.5, ADR 0035 decision 17). */
  refresh(req: McpRefreshRequest): Promise<McpRefreshResult>;
  /** Revokes a grant: sets `revoked_at_utc` (once) and deletes its tokens, in one transaction.
   * True when the grant exists. */
  revokeGrant(grantId: string): Promise<boolean>;
  /**
   * RFC 7009: revokes the grant of the access or refresh token with this hash when that grant is
   * `clientId`'s. Returns the revoked grant's id, or null when no such token is the client's.
   */
  revokeByToken(tokenHash: string, clientId: string): Promise<string | null>;
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
