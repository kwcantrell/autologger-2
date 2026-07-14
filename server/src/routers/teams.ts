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

import { type Context, Hono } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import type { AuthUser, Catalog, Row } from '../db/catalog';
import type { TeamRole } from '../db/authStore';
import { normalizeEmail } from '../db/shared';
import {
  teamCreateBodySchema,
  teamInviteBodySchema,
  teamRenameBodySchema,
  teamRoleChangeBodySchema,
} from '../schemas';
import { BUILTIN_STUDIO_ORDER, ValidationError } from '../studio';
import type { AppEnv } from '../types';
import { ApiError } from './_helpers';

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
function requireTeamMember(
  c: Context<AppEnv>,
  teamId: string,
): { user: AuthUser; role: TeamRole } {
  const user = requireUser(c);
  requireNotBuiltin(teamId);
  const role = c.get('catalog').auth.authGetMembershipRole(user.id, teamId);
  if (role === null) throw new ApiError(404, 'Team not found');
  return { user, role };
}

/** requireTeamAdmin (design D3): member check first, then 403 for a
 * non-admin member (they may know the team exists; they may not manage it). */
function requireTeamAdmin(c: Context<AppEnv>, teamId: string): AuthUser {
  const { user, role } = requireTeamMember(c, teamId);
  if (role !== 'admin') throw new ApiError(403, 'Admin role required.');
  return user;
}

/** Count of non-built-in teams the user currently admins — self-serve
 * creation cap (design D10). Single indexed query (phase-2 review: replaced
 * an N+1 over every membership the user holds, which didn't scale with a
 * user's total membership count even though the cap only bounds admin'd
 * teams). */
function countOwnedNonBuiltinTeams(catalog: Catalog, userId: string): number {
  return catalog.auth.authCountAdminTeams(userId, [...BUILTIN_STUDIO_ORDER]);
}

/** Last-admin protection is a global invariant (design: team-management
 * delta) — true when `targetUserId` currently holds the team's ONLY enabled
 * admin seat (a disabled admin row never counts, so demoting/removing one is
 * always safe). */
function wouldStripLastEnabledAdmin(
  catalog: Catalog,
  teamId: string,
  targetUserId: string,
): boolean {
  if (catalog.auth.authGetMembershipRole(targetUserId, teamId) !== 'admin') return false;
  const row: Row | null = catalog.auth.authGetUserRowAny(targetUserId);
  if (row === null) return false;
  const disabled = row.disabled_at_utc !== null && row.disabled_at_utc !== undefined;
  if (disabled) return false;
  return catalog.auth.authCountEnabledAdmins(teamId) <= 1;
}

const LAST_ADMIN_MESSAGE = 'This would leave the team with no enabled admin.';

/** Runs `mutate` inside ONE catalog transaction together with the
 * last-enabled-admin count check (normative — team-management delta: "the
 * admin count and the mutation SHALL execute within a single catalog
 * transaction"). Shared by demote / remove / leave. */
function guardedAgainstLastAdmin(
  c: Context<AppEnv>,
  teamId: string,
  targetUserId: string,
  mutate: (catalog: Catalog) => void,
): void {
  const catalog = c.get('catalog');
  let blocked = false;
  c.env.ports.catalog.tx(() => {
    if (wouldStripLastEnabledAdmin(catalog, teamId, targetUserId)) {
      blocked = true;
      return;
    }
    mutate(catalog);
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

  if (countOwnedNonBuiltinTeams(catalog, user.id) >= MAX_OWNED_TEAMS) {
    throw new ApiError(
      400,
      `You already admin ${MAX_OWNED_TEAMS} teams; the limit has been reached.`,
    );
  }
  try {
    catalog.studios.adminCreateStudio(teamId, displayName);
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  catalog.auth.authAddMembershipWithRole(user.id, teamId, 'admin');
  return c.json({ id: teamId, name: displayName, role: 'admin' as TeamRole });
});

// -- GET /api/teams/:id — detail (member) --------------------------------------

teamsRouter.get('/api/teams/:id', async (c) => {
  const teamId = c.req.param('id').trim();
  const { role } = requireTeamMember(c, teamId);
  const catalog = c.get('catalog');
  const name = catalog.studios.studioNamesDict()[teamId] ?? teamId;
  const members = catalog.auth.authListTeamMembers(teamId);
  const enabledAdminCount = catalog.auth.authCountEnabledAdmins(teamId);
  const body: Record<string, unknown> = {
    id: teamId,
    name,
    role,
    enabled_admin_count: enabledAdminCount,
    members,
  };
  if (role === 'admin') {
    body.invites = catalog.auth.authListInvitesForTeam(teamId).map((r) => ({
      email: String(r.email_norm),
      invited_at_utc: String(r.invited_at_utc),
    }));
  }
  return c.json(body);
});

// -- PATCH /api/teams/:id — rename, display-name only (admin) -----------------

teamsRouter.patch('/api/teams/:id', async (c) => {
  const teamId = c.req.param('id').trim();
  requireTeamAdmin(c, teamId);
  const body = parseTeamBody(teamRenameBodySchema, await c.req.json());
  const catalog = c.get('catalog');
  const displayName = body.display_name.trim();
  try {
    catalog.studios.renameStudio(teamId, displayName);
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  return c.json({ id: teamId, name: displayName });
});

// -- DELETE /api/teams/:id — delete, blocked while shows exist (admin) --------

teamsRouter.delete('/api/teams/:id', async (c) => {
  const teamId = c.req.param('id').trim();
  requireTeamAdmin(c, teamId);
  const catalog = c.get('catalog');
  try {
    // Shared with the admin plane (studioRegistry.adminDeleteStudio) so both
    // planes cascade identically, incl. team_invites — design D4.
    catalog.studios.adminDeleteStudio(teamId);
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/invites — invite by email (admin) --------------------

teamsRouter.post('/api/teams/:id/invites', async (c) => {
  const teamId = c.req.param('id').trim();
  const admin = requireTeamAdmin(c, teamId);
  const body = parseTeamBody(teamInviteBodySchema, await c.req.json());
  const emailNorm = normalizeEmail(body.email);
  if (!isPlausibleEmail(emailNorm)) throw new ApiError(400, 'Invalid email address.');

  const catalog = c.get('catalog');
  const matches = catalog.auth.authListUsersByEmailNorm(emailNorm);
  if (matches.length > 0) {
    // Immediate membership for every matching user row (incl. disabled —
    // design D2); a match that's already a member is a strict no-op (role
    // preserved by authAddMembershipWithRole's INSERT OR IGNORE).
    for (const m of matches) {
      catalog.auth.authAddMembershipWithRole(String(m.id), teamId, 'member');
    }
  } else {
    const pending = catalog.auth.authListInvitesForTeam(teamId);
    const alreadyPending = pending.some((r) => String(r.email_norm) === emailNorm);
    if (!alreadyPending && pending.length >= MAX_PENDING_INVITES) {
      throw new ApiError(
        400,
        `This team already has ${MAX_PENDING_INVITES} pending invites; revoke one before inviting more.`,
      );
    }
    catalog.auth.authUpsertInvite(teamId, emailNorm, admin.id);
  }
  // Uniform 200 either way (design D2: shape minimalism, not enumeration
  // hygiene — the admin reads the outcome from the next GET team detail).
  return c.json({ ok: true });
});

// -- DELETE /api/teams/:id/invites/:email — revoke, idempotent (admin) --------

teamsRouter.delete('/api/teams/:id/invites/:email', async (c) => {
  const teamId = c.req.param('id').trim();
  requireTeamAdmin(c, teamId);
  // Hono decodes path params already; normalize identically to invite-time.
  const emailNorm = normalizeEmail(c.req.param('email'));
  c.get('catalog').auth.authDeleteInvite(teamId, emailNorm);
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/members/:userId/role — promote/demote (admin) --------

teamsRouter.post('/api/teams/:id/members/:userId/role', async (c) => {
  const teamId = c.req.param('id').trim();
  requireTeamAdmin(c, teamId);
  const targetUserId = c.req.param('userId').trim();
  const body = parseTeamBody(teamRoleChangeBodySchema, await c.req.json());
  const catalog = c.get('catalog');

  const currentRole = catalog.auth.authGetMembershipRole(targetUserId, teamId);
  if (currentRole === null) throw new ApiError(404, 'Member not found');
  if (currentRole === body.role) return c.json({ ok: true, role: body.role }); // idempotent

  if (body.role === 'member') {
    guardedAgainstLastAdmin(c, teamId, targetUserId, (cat) =>
      cat.auth.authUpsertMembershipRole(targetUserId, teamId, 'member'),
    );
  } else {
    catalog.auth.authUpsertMembershipRole(targetUserId, teamId, 'admin');
  }
  return c.json({ ok: true, role: body.role });
});

// -- DELETE /api/teams/:id/members/:userId — remove a member (admin) ----------

teamsRouter.delete('/api/teams/:id/members/:userId', async (c) => {
  const teamId = c.req.param('id').trim();
  requireTeamAdmin(c, teamId);
  const targetUserId = c.req.param('userId').trim();
  const catalog = c.get('catalog');
  if (catalog.auth.authGetMembershipRole(targetUserId, teamId) === null) {
    throw new ApiError(404, 'Member not found');
  }
  guardedAgainstLastAdmin(c, teamId, targetUserId, (cat) =>
    cat.auth.authRemoveMembership(targetUserId, teamId),
  );
  return c.json({ ok: true });
});

// -- POST /api/teams/:id/leave — caller leaves (member) ------------------------

teamsRouter.post('/api/teams/:id/leave', async (c) => {
  const teamId = c.req.param('id').trim();
  const { user } = requireTeamMember(c, teamId);
  guardedAgainstLastAdmin(c, teamId, user.id, (cat) => cat.auth.authRemoveMembership(user.id, teamId));
  return c.json({ ok: true });
});
