// MCP OAuth token, code and consent crypto (ADR 0035 decisions 5, 16, 17; design
// docs/design/custom-session-dashboards.md sections 4.4 and 4.5; mcp-authorization).
//
// - Access tokens are `alm_` and refresh tokens `alr_`, each followed by 32 random bytes in
//   base64url. Authorization codes and authorize-request ids are random too. Only the hex SHA-256 of
//   a token or code is ever stored; the raw value is never logged.
// - PKCE: `BASE64URL(SHA256(code_verifier))` compared with the stored `code_challenge` in constant
//   time.
// - The consent CSRF token is an HMAC-SHA256, under `MCP_SIGNING_SECRET`, of the authorize-request
//   id and the SHA-256 of the session cookie, so a form lifted from another session or request
//   fails.
// - The refresh grace window's sealed successor (section 13.3 item 14 (c), as approved): AES-256-GCM
//   with a random 96-bit nonce and the row's `token_hash` and `grant_id` as additional
//   authenticated data, under a key from HKDF-SHA256 over the spent raw refresh token with
//   `MCP_SIGNING_SECRET` as the salt and `mcp-refresh-grace` as the info. A database dump plus a
//   spent token therefore opens nothing without the live server's secret, and a seal moved to
//   another row doesn't open.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { McpMintedTokens, McpSealBinding, McpSealedSuccessor } from '@autologger/ports';

export const MCP_ACCESS_TOKEN_PREFIX = 'alm_';
export const MCP_REFRESH_TOKEN_PREFIX = 'alr_';

const b64url = (buf: Buffer): string => buf.toString('base64url');

/** 32 random bytes in base64url (an authorization code). */
export function newMcpCode(): string {
  return b64url(randomBytes(32));
}

/** A 128-bit authorize-request id in base64url (22 characters). */
export function newMcpRequestId(): string {
  return b64url(randomBytes(16));
}

/** The shape of `newMcpRequestId`'s output, so an id from a URL or form can be checked first. */
export const MCP_REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;

/** A grant id: 16 random bytes in base64url. */
export function newMcpGrantId(): string {
  return `alg_${b64url(randomBytes(16))}`;
}

/** The hex SHA-256 of a token or code, the only form ever stored. */
export function hashMcpSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A fresh access and refresh token with their hashes. */
export function mintMcpTokens(): McpMintedTokens {
  const accessToken = `${MCP_ACCESS_TOKEN_PREFIX}${b64url(randomBytes(32))}`;
  const refreshToken = `${MCP_REFRESH_TOKEN_PREFIX}${b64url(randomBytes(32))}`;
  return {
    accessToken,
    accessHash: hashMcpSecret(accessToken),
    refreshToken,
    refreshHash: hashMcpSecret(refreshToken),
  };
}

/** RFC 7636 section 4.1: 43-128 characters of the unreserved set. Also the challenge's shape. */
export const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Constant-time compare of two ASCII strings (a length difference returns false at once). */
function sameString(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Whether `BASE64URL(SHA256(verifier))` equals the stored S256 challenge, in constant time. */
export function pkceS256Matches(verifier: string, challenge: string): boolean {
  const computed = b64url(createHash('sha256').update(verifier, 'ascii').digest());
  return sameString(computed, challenge);
}

/** The consent form's CSRF token for this request and session cookie. */
export function consentCsrf(secret: string, requestId: string, sessionCookie: string): string {
  const cookieHash = createHash('sha256').update(sessionCookie, 'utf8').digest('hex');
  return b64url(
    createHmac('sha256', secret).update(`mcp-consent\n${requestId}\n${cookieHash}`).digest(),
  );
}

/** Whether a posted CSRF token is the one for this request and session cookie. */
export function consentCsrfValid(
  secret: string,
  requestId: string,
  sessionCookie: string,
  posted: string,
): boolean {
  return sameString(consentCsrf(secret, requestId, sessionCookie), posted);
}

const SEAL_VERSION = 'v1';
const SEAL_INFO = 'mcp-refresh-grace';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function sealKey(spentRefreshToken: string, secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(spentRefreshToken, 'utf8'),
      Buffer.from(secret, 'utf8'),
      SEAL_INFO,
      32,
    ),
  );
}

const sealAad = (b: McpSealBinding): Buffer =>
  Buffer.from(`${SEAL_VERSION}\n${b.tokenHash}\n${b.grantId}`, 'utf8');

/** Seals the successor onto the spent token's row: `v1.` + base64url(nonce, ciphertext, tag). */
export function sealSuccessor(
  spentRefreshToken: string,
  secret: string,
  successor: McpSealedSuccessor,
  binding: McpSealBinding,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sealKey(spentRefreshToken, secret), nonce);
  cipher.setAAD(sealAad(binding));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(successor), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${SEAL_VERSION}.${b64url(Buffer.concat([nonce, body]))}`;
}

/** Opens a seal, or null when it doesn't open (another token, secret or row) or is malformed. */
export function openSuccessor(
  spentRefreshToken: string,
  secret: string,
  sealed: string,
  binding: McpSealBinding,
): McpSealedSuccessor | null {
  if (!sealed.startsWith(`${SEAL_VERSION}.`)) return null;
  const raw = Buffer.from(sealed.slice(SEAL_VERSION.length + 1), 'base64url');
  if (raw.length <= NONCE_BYTES + TAG_BYTES) return null;
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealKey(spentRefreshToken, secret), nonce);
    decipher.setAAD(sealAad(binding));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const v = JSON.parse(plain) as Partial<McpSealedSuccessor>;
    if (
      typeof v.access_token !== 'string' ||
      typeof v.refresh_token !== 'string' ||
      typeof v.access_expires_at !== 'number'
    ) {
      return null;
    }
    return {
      access_token: v.access_token,
      refresh_token: v.refresh_token,
      access_expires_at: v.access_expires_at,
    };
  } catch {
    return null;
  }
}
