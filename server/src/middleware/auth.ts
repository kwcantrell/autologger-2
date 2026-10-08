// Per-request context + login gate — combines attach_auth_user and
// auth_identity_and_gate from src/autologger/web/app.py.

import { createCatalog } from '@autologger/catalog';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../appEnv';
import { hashCompanionDeviceToken } from '../auth/companionDeviceToken';
import { apiRequestRequiresLogin, bearerToken, resolveSessionUser } from '../auth/identity';
import { sessionCookieName } from '../env';

const LOGIN_REQUIRED = { detail: 'Login required.' };

export const authContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  // catalog-roles D9: resolve the caller and load the registry as system:auth-resolve; routes get
  // a catalog bound to the signed-in user, or an unbound one (every statement refused) with no
  // user. Both carry the registry snapshot loaded here.
  const sys = createCatalog(c.env.ports.catalog).system('auth-resolve');
  await sys.init();

  // Both decisions use the percent-decoded path the router matched (gate-decoded-path D1): Hono
  // routes `/%61pi/x` to `/api/x`, so the raw pathname would let it past the gate.
  const path = c.req.path;

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

  // Login is always required (require-login D2): the one place the 401 decision is made.
  const method = c.req.method.toUpperCase();
  if (apiRequestRequiresLogin(path, method) && !user) {
    return c.json(LOGIN_REQUIRED, 401);
  }

  await next();
};
