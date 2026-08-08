// Admin routes — ported from web/routers/admin.py. Bearer-gated by ADMIN_TOKEN.
// POST /api/admin/restart is dropped: serverless has no supervised process to
// restart (adminMeta already returns restart_supported:false).

import { adminMembershipBodySchema, adminStudioCreateBodySchema } from '@autologger/contract';
import { BUILTIN_STUDIO_ORDER, ValidationError } from '@autologger/domain';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { requestHasValidAdminToken } from '../auth/identity';
import { adminTokenConfigured } from '../env';
import { ApiError } from '../httpError';

export const adminRouter = new Hono<AppEnv>();

function requireAdminToken(c: Context<AppEnv>): void {
  if (!adminTokenConfigured(c.env.config)) {
    throw new ApiError(503, 'Set ADMIN_TOKEN in the environment to use admin APIs.');
  }
  if (!requestHasValidAdminToken(c.req.raw, c.env.config.ADMIN_TOKEN)) {
    throw new ApiError(401, 'Invalid or missing admin token.');
  }
}

adminRouter.get('/api/admin/users', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const builtin = new Set(BUILTIN_STUDIO_ORDER);
  const names = catalog.studios.studioNamesDict();
  const studiosCatalog = catalog.studios.studioOrderTuple().map((sid) => ({
    id: sid,
    name: names[sid],
    builtin: builtin.has(sid),
  }));
  const usersOut: Record<string, unknown>[] = [];
  for (const r of catalog.auth.authListUsersAdmin()) {
    const uid = String(r.id);
    const mids = catalog.auth.authListStudioIdsForUser(uid);
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
    catalog.studios.adminCreateStudio(body.id.trim(), body.display_name.trim());
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  const builtin = new Set(BUILTIN_STUDIO_ORDER);
  const names = catalog.studios.studioNamesDict();
  const id = body.id.trim();
  return c.json({ studio: { id, name: names[id], builtin: builtin.has(id) } });
});

adminRouter.delete('/api/admin/studios/:studioId', async (c) => {
  requireAdminToken(c);
  try {
    c.get('catalog').studios.adminDeleteStudio(c.req.param('studioId').trim());
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
  if (!catalog.studios.isKnownStudio(sid)) throw new ApiError(400, 'Unknown team id.');
  const row = catalog.auth.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  // Upsert (not the INSERT OR IGNORE of authAddMemberships): with the role
  // column present, a re-POST on an existing membership must update its role
  // (defaulting to 'member' when absent) — the orphaned-team rescue path
  // (teams-self-serve) needs promotion to actually take effect, not no-op.
  catalog.auth.authUpsertMembershipRole(String(row.id), sid, body.role ?? 'member');
  return c.json({ ok: true });
});

adminRouter.delete('/api/admin/users/:userId/memberships/:studioId', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = catalog.auth.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  catalog.auth.authRemoveMembership(String(row.id), c.req.param('studioId').trim());
  return c.json({ ok: true });
});

adminRouter.post('/api/admin/users/:userId/disable', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = catalog.auth.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  // Disabling flips disabled_at_utc; resolveSessionUser already filters disabled
  // users, so existing KV sessions stop resolving without an explicit sweep.
  catalog.auth.authSetUserDisabled(String(row.id), true);
  return c.json({ ok: true });
});

adminRouter.post('/api/admin/users/:userId/enable', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = catalog.auth.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  catalog.auth.authSetUserDisabled(String(row.id), false);
  return c.json({ ok: true });
});
