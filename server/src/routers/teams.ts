// Team management routes — self-serve team CRUD, membership roles, ownership transfer and email
// invites (teams-self-serve change; owner-bootstrap). New surface, additive to the frozen
// contract (api-contract-freeze, "Team management endpoint family").
//
// Authorization posture (teams-self-serve D3, owner-bootstrap D2): every route requires a
// logged-in user (401 otherwise); there are no built-in teams (owner-bootstrap D9); team-scoped
// routes mask non-membership as a 404 indistinguishable from a nonexistent team; a member without
// the route's role gets 403. Roles are owner, admin and member: rename, invites and removing a
// member need owner or admin; role changes, removing an admin, delete and transfer need the
// owner. The owner anchors the team: no route here removes, demotes or lets the owner leave
// (409 `Transfer ownership first.`); ownership moves only by transfer. Each write re-checks the
// caller's role and the target's inside its transaction. Session content follows show access
// (show-grants D3): `requireSession` admits owners and admins of the show's team and members with
// a grant for the show; the grants themselves are managed here (show-grants D5). A revoke, a
// removal, a leave and a demotion to member close the user's sockets on sessions they no longer
// reach, after the write commits (show-grants D20).

import type { AuthUser, CatalogFacade, Row, TeamRole } from '@autologger/catalog';
import {
  teamCreateBodySchema,
  teamInviteBodySchema,
  teamOwnerTransferBodySchema,
  teamRenameBodySchema,
  teamRoleChangeBodySchema,
} from '@autologger/contract';
import { normalizeEmail, ValidationError } from '@autologger/domain';
import { type Context, Hono } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import { closeSocketsAfterAccessLoss, requireUser, teamShowIds } from './_helpers';

/** The frozen contract calls out `400` (not the codebase-wide ZodError→422
 * convention) for this family's body validation — "validation errors 400" on
 * create, "schema-rejected 400" for role values (api-contract-freeze delta,
 * default-behaviors clause). safeParse + ApiError keeps the whole family
 * consistent rather than special-casing only the role field. */
function parseTeamBody<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'Invalid request body.';
    throw new ApiError(400, msg);
  }
  return parsed.data;
}

export const teamsRouter = new Hono<AppEnv>();

// DoS ceilings (design D10, gate ruling 2026-07-14) — abuse guards, not
// product quotas; honest deployments never see them.
const MAX_OWNED_TEAMS = 20;
const MAX_PENDING_INVITES = 200;

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlausibleEmail(email: string): boolean {
  return email.length > 0 && email.length <= 254 && EMAIL_SHAPE_RE.test(email);
}

/** requireTeamMember (design D3): a signed-in user (the login gate 401s before this; require-login
 * D3); masked 404 for a team the caller isn't a member of (nonexistent and foreign teams are
 * indistinguishable). Former built-ins are ordinary teams (owner-bootstrap D9). */
async function requireTeamMember(
  c: Context<AppEnv>,
  teamId: string,
): Promise<{ user: AuthUser; role: TeamRole }> {
  const user = requireUser(c);
  const role = await c.get('catalog').auth.authGetMembershipRole(user.id, teamId);
  if (role === null) throw new ApiError(404, 'Team not found');
  return { user, role };
}

/** requireTeamRole (owner-bootstrap D2): member check first, then 403 for a member whose role
 * is not in `roles` (they may know the team exists; they may not manage it). The detail names
 * the admin role when admins are allowed, else the owner role. */
async function requireTeamRole(
  c: Context<AppEnv>,
  teamId: string,
  roles: readonly TeamRole[],
): Promise<{ user: AuthUser; role: TeamRole }> {
  const { user, role } = await requireTeamMember(c, teamId);
  if (!roles.includes(role)) throw new ApiError(403, roleRequiredMessage(roles));
  return { user, role };
}

/** The role check again, inside the write's transaction, with the caller's membership row
 * locked for share (catalog-concurrency-hazards D2): a demotion, removal or transfer that commits
 * while the request is in flight either waits for the write or fails it, and the re-run answers
 * as a serial order would. Same statuses as `requireTeamRole`; returns the caller's role. */
async function requireTeamRoleIn(
  cat: CatalogFacade,
  userId: string,
  teamId: string,
  roles: readonly TeamRole[],
): Promise<TeamRole> {
  const role = await cat.auth.authGetMembershipRoleForShare(userId, teamId);
  if (role === null) throw new ApiError(404, 'Team not found');
  if (!roles.includes(role)) throw new ApiError(403, roleRequiredMessage(roles));
  return role;
}

function roleRequiredMessage(roles: readonly TeamRole[]): string {
  return roles.includes('admin') ? 'Admin role required.' : 'Owner role required.';
}

const OWNER_OR_ADMIN: readonly TeamRole[] = ['owner', 'admin'];
const OWNER_ONLY: readonly TeamRole[] = ['owner'];

/** The owner anchors the team (owner-bootstrap D2): no team-plane write targets the owner. */
const OWNER_TARGET_MESSAGE = 'Transfer ownership first.';

// -- POST /api/teams — self-serve creation (any user) -------------------------

teamsRouter.post('/api/teams', async (c) => {
  const user = requireUser(c);
  const body = parseTeamBody(teamCreateBodySchema, await c.req.json());
  const catalog = c.get('catalog');
  const teamId = body.id.trim();
  const displayName = body.display_name.trim();

  try {
    const { sid, disp } = catalog.studios.validateNewStudio(teamId, displayName);
    // Cap, definition and owner membership in one transaction (catalog-concurrency-hazards D2,
    // owner-bootstrap D5): two creates can't both pass the cap, and the team never exists without
    // its owner.
    await catalog.tx(async (cat) => {
      if ((await cat.auth.authCountOwnedTeams(user.id)) >= MAX_OWNED_TEAMS) {
        throw new ApiError(
          400,
          `You already own ${MAX_OWNED_TEAMS} teams; the limit has been reached.`,
        );
      }
      await cat.studios.insertStudioDefinition(sid, disp);
      await cat.auth.authAddMembershipWithRole(user.id, sid, 'owner');
    });
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  await catalog.studios.refreshAfterWrite();
  return c.json({ id: teamId, name: displayName, role: 'owner' as TeamRole });
});

// -- GET /api/teams/:id — detail (member) --------------------------------------

teamsRouter.get('/api/teams/:id', async (c) => {
  const teamId = c.req.param('id').trim();
  const { role } = await requireTeamMember(c, teamId);
  const catalog = c.get('catalog');
  const name = catalog.studios.studioNamesDict()[teamId] ?? teamId;
  const members = await catalog.auth.authListTeamMembers(teamId);
  const enabledAdminCount = await catalog.auth.authCountEnabledAdmins(teamId);
  const body: Record<string, unknown> = {
    id: teamId,
    name,
    role,
    enabled_admin_count: enabledAdminCount,
    members,
  };
  if (role === 'admin' || role === 'owner') {
    // show-grants D6: each member's granted show ids, for managers only (like `invites`). An owner
    // or admin row is `[]`: their role gives access, and a stored grant is inert while they hold it.
    const granted = new Map<string, string[]>();
    for (const g of await catalog.auth.authListShowGrantsInStudio(teamId)) {
      granted.set(g.user_id, [...(granted.get(g.user_id) ?? []), g.show_id]);
    }
    body.members = members.map((m) => ({
      ...m,
      show_ids: m.role === 'member' ? [...(granted.get(m.id) ?? [])].sort() : [],
    }));
    body.invites = (await catalog.auth.authListInvitesForTeam(teamId)).map((r) => ({
      email: String(r.email_norm),
      invited_at_utc: String(r.invited_at_utc),
    }));
  }
  return c.json(body);
});

// -- PATCH /api/teams/:id — rename, display-name only (admin) -----------------

teamsRouter.patch('/api/teams/:id', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: admin } = await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const body = parseTeamBody(teamRenameBodySchema, await c.req.json());
  const catalog = c.get('catalog');
  const displayName = body.display_name.trim();
  try {
    await catalog.tx(async (cat) => {
      await requireTeamRoleIn(cat, admin.id, teamId, OWNER_OR_ADMIN);
      await cat.studios.renameStudio(teamId, displayName);
    });
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  await catalog.studios.refreshAfterWrite();
  return c.json({ id: teamId, name: displayName });
});

// -- DELETE /api/teams/:id — delete, blocked while shows exist (owner) --------

teamsRouter.delete('/api/teams/:id', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: owner } = await requireTeamRole(c, teamId, OWNER_ONLY);
  const catalog = c.get('catalog');
  try {
    // Shared with the admin plane (studioRegistry.adminDeleteStudio) so both
    // planes cascade identically, incl. team_invites — design D4. Its transaction joins this one.
    await catalog.tx(async (cat) => {
      await requireTeamRoleIn(cat, owner.id, teamId, OWNER_ONLY);
      await cat.studios.adminDeleteStudio(teamId);
    });
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  await catalog.studios.refreshAfterWrite();
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/invites — invite by email (owner or admin) -----------

teamsRouter.post('/api/teams/:id/invites', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: admin } = await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const body = parseTeamBody(teamInviteBodySchema, await c.req.json());
  const emailNorm = normalizeEmail(body.email);
  if (!isPlausibleEmail(emailNorm)) throw new ApiError(400, 'Invalid email address.');

  // One transaction for the lookup, the cap and the write (catalog-concurrency-hazards D2): two
  // invites can't pass the cap together, and an invite can't miss a user whose first sign-in
  // commits meanwhile.
  await c.get('catalog').tx(async (catalog) => {
    await requireTeamRoleIn(catalog, admin.id, teamId, OWNER_OR_ADMIN);
    const matches = await catalog.auth.authListUsersByEmailNorm(emailNorm);
    if (matches.length > 0) {
      // Immediate membership for every matching user row (incl. disabled —
      // design D2); a match that's already a member is a strict no-op (role
      // preserved by authAddMembershipWithRole's ON CONFLICT DO NOTHING).
      for (const m of matches) {
        await catalog.auth.authAddMembershipWithRole(String(m.id), teamId, 'member');
      }
    } else {
      const pending = await catalog.auth.authListInvitesForTeam(teamId);
      const alreadyPending = pending.some((r) => String(r.email_norm) === emailNorm);
      if (!alreadyPending && pending.length >= MAX_PENDING_INVITES) {
        throw new ApiError(
          400,
          `This team already has ${MAX_PENDING_INVITES} pending invites; revoke one before inviting more.`,
        );
      }
      await catalog.auth.authUpsertInvite(teamId, emailNorm, admin.id);
    }
  });
  // Uniform 200 either way (design D2: shape minimalism, not enumeration
  // hygiene — the admin reads the outcome from the next GET team detail).
  return c.json({ ok: true });
});

// -- DELETE /api/teams/:id/invites/:email — revoke, idempotent (owner or admin)

teamsRouter.delete('/api/teams/:id/invites/:email', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: admin } = await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  // Hono decodes path params already; normalize identically to invite-time.
  const emailNorm = normalizeEmail(c.req.param('email'));
  await c.get('catalog').tx(async (cat) => {
    await requireTeamRoleIn(cat, admin.id, teamId, OWNER_OR_ADMIN);
    await cat.auth.authDeleteInvite(teamId, emailNorm);
  });
  return c.json({ ok: true });
});

// -- PUT/DELETE /api/teams/:id/shows/:showId/grants/:userId — show grants (owner or admin) --
// show-grants D5. Status order: 401 (login gate), masked 404 team, 403 role, 404 show, 404 target.
// No body (any body is ignored). There is no GET: managers read grants from the team detail.

/** The show, which must belong to the team (`404 Show not found.` otherwise). */
async function requireTeamShow(c: Context<AppEnv>, teamId: string, showId: string): Promise<Row> {
  const show = await c.get('catalog').shows.getShowRow(showId);
  if (show === null || String(show.studio_id) !== teamId) {
    throw new ApiError(404, 'Show not found.');
  }
  return show;
}

teamsRouter.put('/api/teams/:id/shows/:showId/grants/:userId', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: caller } = await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const showId = c.req.param('showId');
  await requireTeamShow(c, teamId, showId);
  const targetUserId = c.req.param('userId').trim();
  await c.get('catalog').tx(async (cat) => {
    await requireTeamRoleIn(cat, caller.id, teamId, OWNER_OR_ADMIN);
    // The target's membership is read FOR SHARE, so a leave or removal racing this grant either
    // commits first (404 here on the re-run) or deletes the grant after it (show-grants D5).
    const targetRole = await cat.auth.authGetMembershipRoleForShare(targetUserId, teamId);
    if (targetRole === null) throw new ApiError(404, 'Member not found');
    // An owner or admin already reaches every show of the team: nothing to store.
    if (targetRole !== 'member') return;
    await cat.auth.authGrantShow(targetUserId, showId, caller.id, new Date().toISOString());
  });
  return c.json({ ok: true });
});

teamsRouter.delete('/api/teams/:id/shows/:showId/grants/:userId', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: caller } = await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const showId = c.req.param('showId');
  await requireTeamShow(c, teamId, showId);
  const targetUserId = c.req.param('userId').trim();
  // Idempotent, also for a non-member target (like invite revocation).
  await c.get('catalog').tx(async (cat) => {
    await requireTeamRoleIn(cat, caller.id, teamId, OWNER_OR_ADMIN);
    await cat.auth.authRevokeShow(targetUserId, showId);
  });
  // After the commit: the target's sockets on this show's sessions close (show-grants D20).
  await closeSocketsAfterAccessLoss(c, targetUserId, [showId]);
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/members/:userId/role — promote/demote (owner) --------

teamsRouter.post('/api/teams/:id/members/:userId/role', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: owner } = await requireTeamRole(c, teamId, OWNER_ONLY);
  const targetUserId = c.req.param('userId').trim();
  const body = parseTeamBody(teamRoleChangeBodySchema, await c.req.json());

  const changed = await c.get('catalog').tx(async (catalog) => {
    await requireTeamRoleIn(catalog, owner.id, teamId, OWNER_ONLY);
    const currentRole = await catalog.auth.authGetMembershipRole(targetUserId, teamId);
    if (currentRole === null) throw new ApiError(404, 'Member not found');
    if (currentRole === 'owner') throw new ApiError(409, OWNER_TARGET_MESSAGE);
    if (currentRole === body.role) return false; // idempotent
    // Updates an existing membership only, so a raced removal is never undone.
    if (!(await catalog.auth.authSetExistingMembershipRole(targetUserId, teamId, body.role))) {
      throw new ApiError(404, 'Member not found');
    }
    return true;
  });
  // After the commit, a demotion to member closes the target's sockets on the team's shows they
  // hold no grant for (show-grants D20; granted shows keep theirs).
  if (changed && body.role === 'member') {
    await closeSocketsAfterAccessLoss(c, targetUserId, () => teamShowIds(c, teamId));
  }
  return c.json({ ok: true, role: body.role });
});

// -- DELETE /api/teams/:id/members/:userId — remove a member (owner or admin) -

teamsRouter.delete('/api/teams/:id/members/:userId', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: caller } = await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const targetUserId = c.req.param('userId').trim();
  await c.get('catalog').tx(async (catalog) => {
    const callerRole = await requireTeamRoleIn(catalog, caller.id, teamId, OWNER_OR_ADMIN);
    const targetRole = await catalog.auth.authGetMembershipRole(targetUserId, teamId);
    if (targetRole === null) throw new ApiError(404, 'Member not found');
    if (targetRole === 'owner') throw new ApiError(409, OWNER_TARGET_MESSAGE);
    if (targetRole === 'admin' && callerRole !== 'owner') {
      throw new ApiError(403, 'Owner role required.');
    }
    if (!(await catalog.auth.authRemoveMembership(targetUserId, teamId))) {
      throw new ApiError(404, 'Member not found');
    }
  });
  // After the commit: the removed member's sockets in this team close (show-grants D20).
  await closeSocketsAfterAccessLoss(c, targetUserId, () => teamShowIds(c, teamId));
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/leave — caller leaves (member; not the owner) ---------

teamsRouter.post('/api/teams/:id/leave', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user } = await requireTeamMember(c, teamId);
  await c.get('catalog').tx(async (catalog) => {
    // Re-read under FOR SHARE: a transfer to the caller that commits first makes them the owner.
    const role = await catalog.auth.authGetMembershipRoleForShare(user.id, teamId);
    if (role === null) throw new ApiError(404, 'Member not found');
    if (role === 'owner') throw new ApiError(409, OWNER_TARGET_MESSAGE);
    if (!(await catalog.auth.authRemoveMembership(user.id, teamId))) {
      throw new ApiError(404, 'Member not found');
    }
  });
  // After the commit: the caller's own sockets in this team close (show-grants D20).
  await closeSocketsAfterAccessLoss(c, user.id, () => teamShowIds(c, teamId));
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/owner — transfer ownership (owner; owner-bootstrap D3) -

teamsRouter.post('/api/teams/:id/owner', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user: owner } = await requireTeamRole(c, teamId, OWNER_ONLY);
  const body = parseTeamBody(teamOwnerTransferBodySchema, await c.req.json());
  const targetUserId = body.user_id;

  await c.get('catalog').tx(async (catalog) => {
    await requireTeamRoleIn(catalog, owner.id, teamId, OWNER_ONLY);
    if (targetUserId === owner.id) return; // self-transfer: no change
    if ((await catalog.auth.authGetMembershipRole(targetUserId, teamId)) === null) {
      throw new ApiError(404, 'Member not found');
    }
    const row: Row | null = await catalog.auth.authGetUserRowAny(targetUserId);
    if (row?.disabled_at_utc !== null && row?.disabled_at_utc !== undefined) {
      throw new ApiError(400, "That member's account is disabled.");
    }
    try {
      // Demote then promote, one transaction; throws (rolling back) if either row is gone.
      await catalog.auth.authTransferOwnership(teamId, owner.id, targetUserId);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof Error && e.message.startsWith('ownership transfer:')) {
        throw new ApiError(404, 'Member not found');
      }
      throw e;
    }
  });
  return c.json({ ok: true });
});
