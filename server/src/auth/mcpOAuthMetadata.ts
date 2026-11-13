// The MCP OAuth server's identifiers and discovery documents (ADR 0035 decision 5; design
// docs/design/custom-session-dashboards.md sections 4.1 and 4.2; mcp-authorization "Discovery
// metadata"). The issuer is `PUBLIC_BASE_URL` with no trailing slash, which the boot guard
// requires to be an `https:` origin while the flag is on (J1). The documents' fields are fixed.

import type { Config } from '@autologger/ports';
import { publicBaseUrl } from '../env';
import { parseClientAddress } from '../middleware/ipAllowlist';

/** The one OAuth scope (design 4.1, section 13.3 item 10). */
export const MCP_SCOPE = 'dashboards';

/** `ISSUER`: the app's public origin. */
export function mcpIssuer(env: Config): string {
  return publicBaseUrl(env);
}

/** `RESOURCE`: the canonical MCP URL a user pastes into Claude. */
export function mcpResource(env: Config): string {
  return `${mcpIssuer(env)}/mcp`;
}

/** RFC 9728 protected-resource metadata. */
export function protectedResourceMetadata(env: Config) {
  return {
    resource: mcpResource(env),
    authorization_servers: [mcpIssuer(env)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'AutoLogger',
  };
}

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata(env: Config) {
  const issuer = mcpIssuer(env);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * The source a per-address limit counts (design 4.3): an IPv4 address alone (an IPv4-mapped IPv6
 * address counts as its IPv4 address), an IPv6 address by its /64 prefix, written
 * `a:b:c:d::/64`. An address that doesn't parse (none at all, in a test without a socket) counts
 * as `unknown`.
 */
export function rateLimitSource(addr: string): string {
  const parsed = parseClientAddress(addr);
  if (parsed === null) return 'unknown';
  if (parsed.version === 4) {
    const v = parsed.value;
    return [24n, 16n, 8n, 0n].map((s) => ((v >> s) & 0xffn).toString()).join('.');
  }
  const prefix = parsed.value >> 64n;
  const groups = [48n, 32n, 16n, 0n].map((s) => ((prefix >> s) & 0xffffn).toString(16));
  return `${groups.join(':')}::/64`;
}
