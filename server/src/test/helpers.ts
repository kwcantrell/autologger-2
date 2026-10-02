import { Catalog } from '@autologger/catalog';
import { createLoginSession } from '../auth/identity';
import { sessionCookieName } from '../env';
import { defaultUser, env } from './harness';

export function catalogFor(): Catalog {
  return new Catalog(env.ports.catalog);
}

let counter = 0;
const uid = (p: string): string => {
  counter += 1;
  return `${p}-${counter}`;
};

// Seed helpers are async and call the real store methods (async-catalog-stores D7), so the
// seeded rows are exactly what the stores write, on any engine.
export async function seedStudio(opts: { id?: string; name?: string } = {}): Promise<string> {
  const id = opts.id ?? uid('studio');
  await catalogFor().studios.adminCreateStudio(id, opts.name ?? `Studio ${id}`);
  return id;
}

/** `seedStudio` plus an `admin` membership for the default signed-in user (harness `app`), for
 * suites whose default caller works in a studio they seed themselves (require-login D7). An admin
 * reaches every show of the studio without a grant (show-grants D14). */
export async function seedMemberStudio(opts: { id?: string; name?: string } = {}): Promise<string> {
  const id = await seedStudio(opts);
  await catalogFor().auth.authAddMembershipWithRole((await defaultUser()).id, id, 'admin');
  return id;
}

/** A user, optionally a member of `studios`: with the column default role (`member`), or with
 * `role` (show-grants D14: an `admin` reaches every show of the team without a grant). */
export async function seedUser(
  opts: {
    id?: string;
    email?: string;
    sub?: string;
    studios?: string[];
    role?: 'owner' | 'admin' | 'member';
  } = {},
): Promise<string> {
  const cat = catalogFor();
  const created = await cat.auth.authCreateUserGoogle({
    id: opts.id ?? crypto.randomUUID(),
    email: opts.email ?? `${uid('user')}@example.com`,
    googleSub: opts.sub ?? uid('sub'),
    givenName: 'Test',
    familyName: 'User',
    pictureUrl: '',
  });
  if (created === null) throw new Error(`seedUser: a user with that sub already exists`);
  const id = created;
  if (opts.studios?.length) {
    if (opts.role === undefined) await cat.auth.authAddMemberships(id, opts.studios);
    else {
      for (const sid of opts.studios) await cat.auth.authAddMembershipWithRole(id, sid, opts.role);
    }
  }
  return id;
}

/** A single valid BUTTON category with the stable id `cam`, so event logging
 * (which rejects unknown categories) works against a seeded session. */
export const SEED_CATEGORY_ID = 'cam';
const SEED_CATEGORIES_JSON = JSON.stringify([
  {
    id: SEED_CATEGORY_ID,
    name: 'Camera',
    color: '#112233',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  },
]);

export async function seedShow(opts: {
  studioId: string;
  name?: string;
  code?: string;
  categoriesJson?: string;
}): Promise<string> {
  return catalogFor().shows.createShow({
    studioId: opts.studioId,
    name: opts.name ?? 'Test Show',
    showCode: opts.code ?? 'TS',
    categoriesJson: opts.categoriesJson ?? SEED_CATEGORIES_JSON,
    paletteJson: '[]',
    paletteCustomJson: '[]',
  });
}

export async function seedSession(opts: {
  showId: string;
  episode?: string;
  title?: string;
  frameRate?: number;
}): Promise<string> {
  const now = new Date().toISOString();
  return catalogFor().sessions.createSessionIndex({
    showId: opts.showId,
    title: opts.title ?? 'Test Session',
    frameRate: opts.frameRate ?? 24,
    startOffsetFrames: 0,
    episode: opts.episode ?? '001',
    notes: '',
    startedAtUtc: now,
    createdAtUtc: now,
  });
}

/** Seed the standard studio → show → session chain in one call; the default signed-in user
 * (harness `app`) is made an `admin` of the new studio (show-grants D14; code-health-tail
 * task 5.1, finding 5.10) — the fixture nearly every router int test needs.
 * Returns all three ids so callers can grab whichever layer they assert on
 * (most want `.sessionId`; cross-studio tests also read `.studioId`).
 * Options pass through to the underlying seed helpers — parameterized, not
 * normalized, so files whose assertions depend on specific categories keep
 * their exact fixture semantics. Async like the seed primitives. */
export async function seededSession(opts: { categoriesJson?: string } = {}): Promise<{
  studioId: string;
  showId: string;
  sessionId: string;
}> {
  const studioId = await seedStudio();
  // The default signed-in caller is an admin of every seededSession studio (require-login D7,
  // show-grants D14), so it reaches the show without a grant.
  await catalogFor().auth.authAddMembershipWithRole((await defaultUser()).id, studioId, 'admin');
  const showId = await seedShow({ studioId, categoriesJson: opts.categoriesJson });
  const sessionId = await seedSession({ showId });
  return { studioId, showId, sessionId };
}

/** A signed-in test caller: its user id and a session cookie header value. */
export interface TestCaller {
  id: string;
  cookie: string;
}

/** The show-access matrix (show-grants D14): a fresh team with one show and one session, and a
 * caller per access case: the team's `owner`, an `admin`, a `member` granted the show, a `member`
 * with no grant, and a signed-in user outside the team. The default user is not added. */
export async function seedAccessMatrix(opts: { categoriesJson?: string } = {}): Promise<{
  studioId: string;
  showId: string;
  sessionId: string;
  owner: TestCaller;
  admin: TestCaller;
  granted: TestCaller;
  ungranted: TestCaller;
  nonMember: TestCaller;
}> {
  const cat = catalogFor();
  const studioId = await seedStudio();
  const showId = await seedShow({ studioId, categoriesJson: opts.categoriesJson });
  const sessionId = await seedSession({ showId });
  const caller = async (role: 'owner' | 'admin' | 'member' | null): Promise<TestCaller> => {
    const id = await seedUser();
    if (role !== null) await cat.auth.authAddMembershipWithRole(id, studioId, role);
    return { id, cookie: await loginCookie(id) };
  };
  const owner = await caller('owner');
  const admin = await caller('admin');
  const granted = await caller('member');
  const ungranted = await caller('member');
  const nonMember = await caller(null);
  await cat.auth.authGrantShow(granted.id, showId, owner.id, new Date().toISOString());
  return { studioId, showId, sessionId, owner, admin, granted, ungranted, nonMember };
}

/** Parse Hono's `streamSSE` wire format (`event: <t>\ndata: <json>\n\n`, no
 * id/retry per spec) into structured events for assertions. Shared by the
 * SSE-streaming int tests (ai, aiV2). */
export function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLines = lines
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice('data: '.length));
      return {
        event: eventLine?.slice('event: '.length) ?? '',
        data: JSON.parse(dataLines.join('\n')),
      };
    });
}

export async function loginCookie(userId: string): Promise<string> {
  const raw = await createLoginSession(env.ports.kv, userId, 14);
  return `${sessionCookieName(env.config)}=${raw}`;
}

export function adminHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** The harness `API_TOKEN` as a bearer: what the Companion sends on `/api/companion/*`. The
 * wrapped harness `app` never signs those paths in (require-login D7). */
export const COMPANION_BEARER: Record<string, string> = { Authorization: 'Bearer test-api-token' };

/** Register companion presence so primarySession() resolves to sessionId. */
export function setCompanionPresence(
  clientId: string,
  sessionId: string,
  opts: { visible?: boolean; is_playing?: boolean } = {},
): Promise<void> {
  return env.ports.presence.upsert(clientId, {
    session_id: sessionId,
    visible: opts.visible ?? true,
    is_playing: opts.is_playing ?? false,
    updated: env.ports.clock.now(),
  });
}
