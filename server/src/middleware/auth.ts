// Per-request context + login gate — combines attach_auth_user and
// auth_identity_and_gate from src/autologger/web/app.py.

import { createCatalog } from '@autologger/catalog';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../appEnv';
import {
  apiRequestRequiresLogin,
  requestHasValidApiToken,
  resolveSessionUser,
} from '../auth/identity';
import { requireLoginEnabled, sessionCookieName } from '../env';

export const authContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const catalog = createCatalog(c.env.ports.catalog);
  catalog.init();
  c.set('catalog', catalog);

  const cookie = getCookie(c, sessionCookieName(c.env.config));
  const user = await resolveSessionUser(c.env.ports.kv, catalog, cookie);
  c.set('user', user);

  // API_TOKEN authenticates only the Companion surface (api-contract-freeze
  // "API_TOKEN authenticates only the Companion surface"; design D10). Outside
  // /api/companion/ a token-only request is treated as carrying no credential.
  // This is the single place the scope is decided; every reader of
  // `apiTokenAuth` (the login gate below and the AI v2 principal-less refusal) sees it;
  // requireSession and the WS upgrade path do not read it.
  // Both decisions use the percent-decoded path the router matched (gate-decoded-path D1): Hono
  // routes `/%61pi/x` to `/api/x`, so the raw pathname would let it past the gate.
  const path = c.req.path;
  const apiTokenAuth =
    path.startsWith('/api/companion/') &&
    requestHasValidApiToken(c.req.raw, c.env.config.API_TOKEN);
  c.set('apiTokenAuth', apiTokenAuth);

  if (requireLoginEnabled(c.env.config)) {
    const method = c.req.method.toUpperCase();
    if (apiRequestRequiresLogin(path, method) && !user && !apiTokenAuth) {
      return c.json({ detail: 'Login required.' }, 401);
    }
  }

  await next();
};
