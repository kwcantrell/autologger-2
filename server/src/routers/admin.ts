// Admin routes — ported from web/routers/admin.py. Bearer-gated by ADMIN_TOKEN.
// POST /api/admin/restart is dropped: serverless has no supervised process to
// restart (adminMeta already returns restart_supported:false).

import { adminMembershipBodySchema, adminStudioCreateBodySchema } from '@autologger/contract';
import { ValidationError } from '@autologger/domain';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { requestHasValidAdminToken } from '../auth/identity';
import { adminTokenConfigured } from '../env';
import { ApiError } from '../httpError';
import { closeSocketsAfterAccessLoss, teamShowIds } from './_helpers';

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
  const names = catalog.studios.studioNamesDict();
  // `builtin` stays in the frozen shape, always false: there are no built-in teams
  // (owner-bootstrap D9).
  const studiosCatalog = catalog.studios.studioOrderTuple().map((sid) => ({
    id: sid,
    name: names[sid],
    builtin: false,
  }));
  const usersOut: Record<string, unknown>[] = [];
  for (const r of await catalog.auth.authListUsersAdmin()) {
    const uid = String(r.id);
    const mids = await catalog.auth.authListStudioIdsForUser(uid);
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
    await catalog.studios.adminCreateStudio(body.id.trim(), body.display_name.trim());
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  const names = catalog.studios.studioNamesDict();
  const id = body.id.trim();
  return c.json({ studio: { id, name: names[id], builtin: false } });
});

adminRouter.delete('/api/admin/studios/:studioId', async (c) => {
  requireAdminToken(c);
  try {
    await c.get('catalog').studios.adminDeleteStudio(c.req.param('studioId').trim());
    await c.get('catalog').studios.refreshAfterWrite();
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  return c.json({ ok: true });
});

adminRouter.post('/api/admin/users/:userId/memberships', async (c) => {
  requireAdminToken(c);
  const body = adminMembershipBodySchema.parse(await c.req.json());
  const sid = body.studio_id.trim();
  // The team is checked inside the upsert's transaction, not against the request's snapshot, so a
  // team deleted meanwhile gets no membership (catalog-concurrency-hazards D3).
  const userId = await c.get('catalog').tx(async (catalog) => {
    if (!(await catalog.studios.studioExists(sid))) throw new ApiError(400, 'Unknown team id.');
    const row = await catalog.auth.authGetUserRowAny(c.req.param('userId').trim());
    if (row === null) throw new ApiError(404, 'User not found.');
    const userId = String(row.id);
    // owner-bootstrap D6: an owner upsert demotes the current owner to admin and makes the target
    // owner, in this transaction, so the team never has two owners.
    if (body.role === 'owner') {
      await catalog.auth.authSetOwner(sid, userId);
      return userId;
    }
    // A role-less body defaults to 'member', which would demote the owner by accident (owner
    // decision C): refuse it; an explicit role still applies.
    if (
      body.role === undefined &&
      (await catalog.auth.authGetMembershipRole(userId, sid)) === 'owner'
    ) {
      throw new ApiError(409, 'Explicit role required to change the team owner.');
    }
    // Upsert (not the ON CONFLICT DO NOTHING of authAddMemberships): with the role
    // column present, a re-POST on an existing membership must update its role
    // (defaulting to 'member' when absent) — the orphaned-team rescue path
    // (teams-self-serve) needs promotion to actually take effect, not no-op.
    await catalog.auth.authUpsertMembershipRole(userId, sid, body.role ?? 'member');
    return userId;
  });
  // After the commit, an upsert that leaves the user a member closes their sockets on the team's
  // shows they hold no grant for (show-grants D20).
  if ((body.role ?? 'member') === 'member') {
    await closeSocketsAfterAccessLoss(c, userId, () => teamShowIds(c, sid));
  }
  return c.json({ ok: true });
});

adminRouter.delete('/api/admin/users/:userId/memberships/:studioId', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = await catalog.auth.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  const studioId = c.req.param('studioId').trim();
  // authRemoveMembership deletes the member's grants in the team in the same transaction (D2);
  // after it commits, their sockets in the team close (show-grants D20).
  await catalog.auth.authRemoveMembership(String(row.id), studioId);
  await closeSocketsAfterAccessLoss(c, String(row.id), () => teamShowIds(c, studioId));
  return c.json({ ok: true });
});

adminRouter.post('/api/admin/users/:userId/disable', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = await catalog.auth.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  // Disabling flips disabled_at_utc; resolveSessionUser already filters disabled
  // users, so existing KV sessions stop resolving without an explicit sweep.
  await catalog.auth.authSetUserDisabled(String(row.id), true);
  return c.json({ ok: true });
});

adminRouter.post('/api/admin/users/:userId/enable', async (c) => {
  requireAdminToken(c);
  const catalog = c.get('catalog');
  const row = await catalog.auth.authGetUserRowAny(c.req.param('userId').trim());
  if (row === null) throw new ApiError(404, 'User not found.');
  await catalog.auth.authSetUserDisabled(String(row.id), false);
  return c.json({ ok: true });
});
