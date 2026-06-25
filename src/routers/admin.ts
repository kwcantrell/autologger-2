// Admin routes — ported from web/routers/admin.py. Bearer-gated by ADMIN_TOKEN.
// POST /api/admin/restart is dropped: serverless has no supervised process to
// restart (adminMeta already returns restart_supported:false).

import { type Context, Hono } from 'hono';
import { requestHasValidAdminToken } from '../auth/identity';
import { adminTokenConfigured } from '../env';
import { adminMembershipBodySchema, adminStudioCreateBodySchema } from '../schemas';
import { BUILTIN_STUDIO_ORDER, ValidationError } from '../studio';
import type { AppEnv } from '../types';
import { ApiError } from './_helpers';

export const adminRouter = new Hono<AppEnv>();

function requireAdminToken(c: Context<AppEnv>): void {
  if (!adminTokenConfigured(c.env)) {
    throw new ApiError(503, 'Set ADMIN_TOKEN in the environment to use admin APIs.');
  }
  if (!requestHasValidAdminToken(c.req.raw, c.env.ADMIN_TOKEN)) {
    throw new ApiError(401, 'Invalid or missing admin token.');
  }
}

adminRouter.get('/api/admin/users', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const builtin = new Set(BUILTIN_STUDIO_ORDER);
  const names = catalog.studioNamesDict();
  const studiosCatalog = catalog.studioOrderTuple().map((sid) => ({
    id: sid,
    name: names[sid],
    builtin: builtin.has(sid),
  }));
  const usersOut: Record<string, unknown>[] = [];
  for (const r of await catalog.authListUsersAdmin()) {
    const uid = String(r.id);
    const mids = await catalog.authListStudioIdsForUser(uid);
    usersOut.push({
      id: uid,
      email: String(r.email),
      given_name: String(r.given_name ?? ''),
      family_name: String(r.family_name ?? ''),
      picture_url: String(r.picture_url ?? ''),
      created_at_utc: String(r.created_at_utc),
      disabled: Boolean(r.disabled_at_utc),
      studios: mids.map((m) => ({ id: m, name: names[m] ?? m })),
    });
  }
  return c.json({ studios_catalog: studiosCatalog, users: usersOut });
});

adminRouter.post('/api/admin/studios', async (c) => {
  requireAdminToken(c);
  const body = adminStudioCreateBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  try {
    await catalog.adminCreateStudio(body.id.trim(), body.display_name.trim());
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  const builtin = new Set(BUILTIN_STUDIO_ORDER);
  const names = catalog.studioNamesDict();
  const id = body.id.trim();
  return c.json({ studio: { id, name: names[id], builtin: builtin.has(id) } });
});

adminRouter.delete('/api/admin/studios/:studioId', async (c) => {
  requireAdminToken(c);
  try {
    await c.get('catalog').adminDeleteStudio(c.req.param('studioId').trim());
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  return c.json({ ok: true });
});

adminRouter.post('/api/admin/users/:userId/memberships', async (c) => {
  requireAdminToken(c);
  const body = adminMembershipBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  const sid = body.studio_id.trim();
  if (!catalog.isKnownStudio(sid)) throw new ApiError(400, 'Unknown team id.');
  const row = await catalog.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  await catalog.authAddMemberships(String(row.id), [sid]);
  return c.json({ ok: true });
});

adminRouter.delete('/api/admin/users/:userId/memberships/:studioId', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = await catalog.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  await catalog.authRemoveMembership(String(row.id), c.req.param('studioId').trim());
  return c.json({ ok: true });
});

adminRouter.post('/api/admin/users/:userId/disable', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = await catalog.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  // Disabling flips disabled_at_utc; resolveSessionUser already filters disabled
  // users, so existing KV sessions stop resolving without an explicit sweep.
  await catalog.authSetUserDisabled(String(row.id), true);
  return c.json({ ok: true });
});

adminRouter.post('/api/admin/users/:userId/enable', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = await catalog.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  await catalog.authSetUserDisabled(String(row.id), false);
  return c.json({ ok: true });
});
