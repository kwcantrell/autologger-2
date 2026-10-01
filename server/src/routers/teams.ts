// Team management routes — self-serve team CRUD, membership roles, and email
// invites (teams-self-serve change). New surface, additive to the frozen
// contract (api-contract-freeze delta, "Team management endpoint family").
//
// Authorization posture (design D3): every route requires a logged-in user
// (401 otherwise — dev-anonymous has no user identity); a wholesale built-in
// guard runs before membership/role checks (400 on any `test-studios` /
// `test-studio-2` operation); team-scoped routes mask non-membership as a 404
// indistinguishable from a nonexistent team; admin-only routes 403 a plain
// member. `requireSession` and content routers are untouched — role checks
// live ONLY here.

import type { AuthUser, CatalogFacade, Row, TeamRole } from '@autologger/catalog';
import {
  teamCreateBodySchema,
  teamInviteBodySchema,
  teamRenameBodySchema,
  teamRoleChangeBodySchema,
} from '@autologger/contract';
import { BUILTIN_STUDIO_ORDER, normalizeEmail, ValidationError } from '@autologger/domain';
import { type Context, Hono } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';

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

function requireUser(c: Context<AppEnv>): AuthUser {
  const user = c.get('user');
  if (user === null) throw new ApiError(401, 'Login required.');
  return user;
}

function requireNotBuiltin(teamId: string): void {
  if (BUILTIN_STUDIO_ORDER.includes(teamId)) {
    throw new ApiError(400, 'Built-in teams are managed by support, not self-serve.');
  }
}

/** requireTeamMember (design D3): 401 with no user; the built-in guard runs
 * before membership is even consulted; masked 404 for a team the caller isn't
 * a member of (nonexistent and foreign teams are indistinguishable). */
async function requireTeamMember(
  c: Context<AppEnv>,
  teamId: string,
): Promise<{ user: AuthUser; role: TeamRole }> {
  const user = requireUser(c);
  requireNotBuiltin(teamId);
  const role = await c.get('catalog').auth.authGetMembershipRole(user.id, teamId);
  if (role === null) throw new ApiError(404, 'Team not found');
  return { user, role };
}

/** requireTeamAdmin (design D3): member check first, then 403 for a
 * non-admin member (they may know the team exists; they may not manage it). */
async function requireTeamAdmin(c: Context<AppEnv>, teamId: string): Promise<AuthUser> {
  const { user, role } = await requireTeamMember(c, teamId);
  if (role !== 'admin') throw new ApiError(403, 'Admin role required.');
  return user;
}

/** Count of non-built-in teams the user currently admins — self-serve
 * creation cap (design D10). Single indexed query (phase-2 review: replaced
 * an N+1 over every membership the user holds, which didn't scale with a
 * user's total membership count even though the cap only bounds admin'd
 * teams). */
async function countOwnedNonBuiltinTeams(catalog: CatalogFacade, userId: string): Promise<number> {
  return await catalog.auth.authCountAdminTeams(userId, [...BUILTIN_STUDIO_ORDER]);
}

/** Last-admin protection is a global invariant (design: team-management
 * delta) — true when `targetUserId` currently holds the team's ONLY enabled
 * admin seat (a disabled admin row never counts, so demoting/removing one is
 * always safe). */
async function wouldStripLastEnabledAdmin(
  catalog: CatalogFacade,
  teamId: string,
  targetUserId: string,
): Promise<boolean> {
  if ((await catalog.auth.authGetMembershipRole(targetUserId, teamId)) !== 'admin') return false;
  const row: Row | null = await catalog.auth.authGetUserRowAny(targetUserId);
  if (row === null) return false;
  const disabled = row.disabled_at_utc !== null && row.disabled_at_utc !== undefined;
  if (disabled) return false;
  return (await catalog.auth.authCountEnabledAdmins(teamId)) <= 1;
}

const LAST_ADMIN_MESSAGE = 'This would leave the team with no enabled admin.';

/** Runs `mutate` inside ONE catalog transaction together with the
 * last-enabled-admin count check (normative — team-management delta: "the
 * admin count and the mutation SHALL execute within a single catalog
 * transaction"). Shared by demote / remove / leave. Both run on the
 * transaction-bound catalog, and `mutate` is awaited inside the transaction
 * (async-catalog-stores D3). */
async function guardedAgainstLastAdmin(
  c: Context<AppEnv>,
  teamId: string,
  targetUserId: string,
  mutate: (catalog: CatalogFacade) => Promise<void>,
): Promise<void> {
  const blocked = await c.get('catalog').tx(async (cat) => {
    if (await wouldStripLastEnabledAdmin(cat, teamId, targetUserId)) return true;
    await mutate(cat);
    return false;
  });
  if (blocked) throw new ApiError(409, LAST_ADMIN_MESSAGE);
}

// -- POST /api/teams — self-serve creation (any user) -------------------------

teamsRouter.post('/api/teams', async (c) => {
  const user = requireUser(c);
  const body = parseTeamBody(teamCreateBodySchema, await c.req.json());
  const catalog = c.get('catalog');
  const teamId = body.id.trim();
  const displayName = body.display_name.trim();

  if ((await countOwnedNonBuiltinTeams(catalog, user.id)) >= MAX_OWNED_TEAMS) {
    throw new ApiError(
      400,
      `You already admin ${MAX_OWNED_TEAMS} teams; the limit has been reached.`,
    );
  }
  try {
    await catalog.studios.adminCreateStudio(teamId, displayName);
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  await catalog.auth.authAddMembershipWithRole(user.id, teamId, 'admin');
  return c.json({ id: teamId, name: displayName, role: 'admin' as TeamRole });
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
  if (role === 'admin') {
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
  await requireTeamAdmin(c, teamId);
  const body = parseTeamBody(teamRenameBodySchema, await c.req.json());
  const catalog = c.get('catalog');
  const displayName = body.display_name.trim();
  try {
    await catalog.studios.renameStudio(teamId, displayName);
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  return c.json({ id: teamId, name: displayName });
});

// -- DELETE /api/teams/:id — delete, blocked while shows exist (admin) --------

teamsRouter.delete('/api/teams/:id', async (c) => {
  const teamId = c.req.param('id').trim();
  await requireTeamAdmin(c, teamId);
  const catalog = c.get('catalog');
  try {
    // Shared with the admin plane (studioRegistry.adminDeleteStudio) so both
    // planes cascade identically, incl. team_invites — design D4.
    await catalog.studios.adminDeleteStudio(teamId);
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/invites — invite by email (admin) --------------------

teamsRouter.post('/api/teams/:id/invites', async (c) => {
  const teamId = c.req.param('id').trim();
  const admin = await requireTeamAdmin(c, teamId);
  const body = parseTeamBody(teamInviteBodySchema, await c.req.json());
  const emailNorm = normalizeEmail(body.email);
  if (!isPlausibleEmail(emailNorm)) throw new ApiError(400, 'Invalid email address.');

  const catalog = c.get('catalog');
  const matches = await catalog.auth.authListUsersByEmailNorm(emailNorm);
  if (matches.length > 0) {
    // Immediate membership for every matching user row (incl. disabled —
    // design D2); a match that's already a member is a strict no-op (role
    // preserved by authAddMembershipWithRole's INSERT OR IGNORE).
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
  // Uniform 200 either way (design D2: shape minimalism, not enumeration
  // hygiene — the admin reads the outcome from the next GET team detail).
  return c.json({ ok: true });
});

// -- DELETE /api/teams/:id/invites/:email — revoke, idempotent (admin) --------

teamsRouter.delete('/api/teams/:id/invites/:email', async (c) => {
  const teamId = c.req.param('id').trim();
  await requireTeamAdmin(c, teamId);
  // Hono decodes path params already; normalize identically to invite-time.
  const emailNorm = normalizeEmail(c.req.param('email'));
  await c.get('catalog').auth.authDeleteInvite(teamId, emailNorm);
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/members/:userId/role — promote/demote (admin) --------

teamsRouter.post('/api/teams/:id/members/:userId/role', async (c) => {
  const teamId = c.req.param('id').trim();
  await requireTeamAdmin(c, teamId);
  const targetUserId = c.req.param('userId').trim();
  const body = parseTeamBody(teamRoleChangeBodySchema, await c.req.json());
  const catalog = c.get('catalog');

  const currentRole = await catalog.auth.authGetMembershipRole(targetUserId, teamId);
  if (currentRole === null) throw new ApiError(404, 'Member not found');
  if (currentRole === body.role) return c.json({ ok: true, role: body.role }); // idempotent

  if (body.role === 'member') {
    await guardedAgainstLastAdmin(c, teamId, targetUserId, async (cat) => {
      await cat.auth.authUpsertMembershipRole(targetUserId, teamId, 'member');
    });
  } else {
    await catalog.auth.authUpsertMembershipRole(targetUserId, teamId, 'admin');
  }
  return c.json({ ok: true, role: body.role });
});

// -- DELETE /api/teams/:id/members/:userId — remove a member (admin) ----------

teamsRouter.delete('/api/teams/:id/members/:userId', async (c) => {
  const teamId = c.req.param('id').trim();
  await requireTeamAdmin(c, teamId);
  const targetUserId = c.req.param('userId').trim();
  const catalog = c.get('catalog');
  if ((await catalog.auth.authGetMembershipRole(targetUserId, teamId)) === null) {
    throw new ApiError(404, 'Member not found');
  }
  await guardedAgainstLastAdmin(c, teamId, targetUserId, async (cat) => {
    await cat.auth.authRemoveMembership(targetUserId, teamId);
  });
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/leave — caller leaves (member) ------------------------

teamsRouter.post('/api/teams/:id/leave', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user } = await requireTeamMember(c, teamId);
  await guardedAgainstLastAdmin(c, teamId, user.id, async (cat) => {
    await cat.auth.authRemoveMembership(user.id, teamId);
  });
  return c.json({ ok: true });
});
