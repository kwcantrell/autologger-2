// Per-request context + login gate — combines attach_auth_user and
// auth_identity_and_gate from src/autologger/web/app.py.

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  apiRequestRequiresLogin,
  requestHasValidApiToken,
  resolveSessionUser,
} from '../auth/identity';
import { Catalog } from '../db/catalog';
import { requireLoginEnabled, sessionCookieName } from '../env';
import type { AppEnv } from '../types';

export const authContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const catalog = new Catalog(c.env.DB);
  await catalog.init();
  c.set('catalog', catalog);

  const cookie = getCookie(c, sessionCookieName(c.env));
  const user = await resolveSessionUser(c.env.AUTH, catalog, cookie);
  c.set('user', user);

  const apiTokenAuth = requestHasValidApiToken(c.req.raw, c.env.API_TOKEN);
  c.set('apiTokenAuth', apiTokenAuth);

  if (requireLoginEnabled(c.env)) {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method.toUpperCase();
    if (apiRequestRequiresLogin(path, method) && !user && !apiTokenAuth) {
      return c.json({ detail: 'Login required.' }, 401);
    }
  }

  await next();
};
