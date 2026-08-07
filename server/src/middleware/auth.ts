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

  const apiTokenAuth = requestHasValidApiToken(c.req.raw, c.env.config.API_TOKEN);
  c.set('apiTokenAuth', apiTokenAuth);

  if (requireLoginEnabled(c.env.config)) {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method.toUpperCase();
    if (apiRequestRequiresLogin(path, method) && !user && !apiTokenAuth) {
      return c.json({ detail: 'Login required.' }, 401);
    }
  }

  await next();
};
