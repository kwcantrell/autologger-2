// Per-request context + login gate — combines attach_auth_user and
// auth_identity_and_gate from src/autologger/web/app.py.

import { createCatalog } from '@autologger/catalog';
import { parseWikiLinks } from '@autologger/contract';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../appEnv';
import { hashCompanionDeviceToken } from '../auth/companionDeviceToken';
import { apiRequestRequiresLogin, bearerToken, resolveSessionUser } from '../auth/identity';
import { MCP_SCOPE, mcpIssuer, mcpResource } from '../auth/mcpOAuthMetadata';
import { hashMcpSecret } from '../auth/mcpTokens';
import { customDashboardsEnabled, sessionCookieName } from '../env';

const LOGIN_REQUIRED = { detail: 'Login required.' };

/** The `/mcp` refusal's challenge (design 4.6, RFC 9728 section 5.1): it names the
 * protected-resource metadata, so a Claude client starts sign-in from the `401`. */
export function mcpWwwAuthenticate(issuer: string): string {
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"`;
}

export const authContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  // catalog-roles D9: resolve the caller and load the registry as system:auth-resolve; routes get
  // a catalog bound to the signed-in user, or an unbound one (every statement refused) with no
  // user. Both carry the registry snapshot loaded here.
  const sys = createCatalog(c.env.ports.catalog, { wikiLinks: parseWikiLinks }).system(
    'auth-resolve',
  );
  await sys.init();

  // Both decisions use the percent-decoded path the router matched (gate-decoded-path D1): Hono
  // routes `/%61pi/x` to `/api/x`, so the raw pathname would let it past the gate.
  const path = c.req.path;

  // The `/mcp` bearer (custom session dashboards J5; design 4.6; api-contract-freeze "Companion
  // device tokens authenticate only the Companion surface", its one exception). Only on exactly
  // `/mcp`, and only with the flag on: an MCP access token decides the caller and the cookie is
  // ignored. A `POST` with no token or a token that doesn't resolve gets the `401` challenge and no
  // handler runs; any other method reaches the router with no caller, which answers `405`. A
  // device token is not an MCP token, and an MCP token is accepted nowhere else.
  if (path === '/mcp' && customDashboardsEnabled(c.env.config)) {
    c.set('companionDevice', null);
    c.set('mcpGrant', null);
    if (c.req.method.toUpperCase() !== 'POST') {
      c.set('user', null);
      c.set('catalog', sys.unbound());
      await next();
      return;
    }
    const token = bearerToken(c.req.raw);
    const hit = token
      ? await sys.auth.authResolveMcpAccessToken(
          hashMcpSecret(token),
          mcpResource(c.env.config),
          new Date(c.env.ports.clock.now()).toISOString(),
        )
      : null;
    if (hit === null) {
      c.header('WWW-Authenticate', mcpWwwAuthenticate(mcpIssuer(c.env.config)));
      return c.json(LOGIN_REQUIRED, 401);
    }
    const user = {
      id: String(hit.user.id),
      email: String(hit.user.email),
      google_sub: String(hit.user.google_sub),
      given_name: String(hit.user.given_name ?? ''),
      family_name: String(hit.user.family_name ?? ''),
      picture_url: String(hit.user.picture_url ?? ''),
    };
    c.set('user', user);
    c.set('catalog', sys.forUser(user.id));
    c.set('mcpGrant', { id: hit.grantId, clientId: hit.clientId });
    // The throttled last-used update never delays or fails the request; a failure only warns.
    c.env.ports.mcpOAuth.touchGrant(hit.grantId).catch((err: unknown) => {
      console.warn(
        `MCP grant last-used update failed: grant=${hit.grantId}`,
        err instanceof Error ? err.message : String(err),
      );
    });
    await next();
    return;
  }

  // Companion device tokens authenticate only the Companion surface (companion-devices D2;
  // api-contract-freeze "Companion device tokens authenticate only the Companion surface"). On
  // /api/companion/* a Bearer header decides the caller and the cookie is ignored; anywhere else a
  // Bearer is ignored, so a device-token-only request is one with no credential. `API_TOKEN` is
  // not read. This is the single place the scope is decided.
  const bearer = path.startsWith('/api/companion/') ? bearerToken(c.req.raw) : null;
  if (bearer !== null) {
    const devices = c.env.ports.companionDevices;
    const hit = bearer ? await devices.lookup(hashCompanionDeviceToken(bearer)) : null;
    if (hit === null) return c.json(LOGIN_REQUIRED, 401);
    const { user, deviceId } = hit;
    c.set('user', user);
    c.set('catalog', sys.forUser(user.id));
    c.set('companionDevice', { id: deviceId });
    c.set('mcpGrant', null);
    // The throttled last-used update (D2) runs after the lookup and never delays or fails the
    // request; a failure only warns. A device's first use writes the audit line (ids only).
    devices
      .touch(deviceId)
      .then((r) => {
        if (r?.firstUse) {
          console.info(`Companion device first use: user=${user.id} device=${deviceId}`);
        }
      })
      .catch((err: unknown) => {
        console.warn(
          `Companion device last-used update failed: device=${deviceId}`,
          err instanceof Error ? err.message : String(err),
        );
      });
    await next();
    return;
  }

  const cookie = getCookie(c, sessionCookieName(c.env.config));
  const user = await resolveSessionUser(c.env.ports.kv, sys, cookie);
  c.set('user', user);
  c.set('catalog', user ? sys.forUser(user.id) : sys.unbound());
  c.set('companionDevice', null);
  c.set('mcpGrant', null);

  // Login is always required (require-login D2): the one place the 401 decision is made.
  const method = c.req.method.toUpperCase();
  if (apiRequestRequiresLogin(path, method) && !user) {
    return c.json(LOGIN_REQUIRED, 401);
  }

  await next();
};
