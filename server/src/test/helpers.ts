import { env } from './harness';
import { createLoginSession } from '../auth/identity';
import { Catalog } from '../db/catalog';
import { sessionCookieName } from '../env';

export function catalogFor(): Catalog {
  return new Catalog(env.ports.catalog);
}

let counter = 0;
const uid = (p: string): string => `${p}-${(counter += 1)}`;

export async function seedStudio(opts: { id?: string; name?: string } = {}): Promise<string> {
  const id = opts.id ?? uid('studio');
  catalogFor().studios.adminCreateStudio(id, opts.name ?? `Studio ${id}`);
  return id;
}

export async function seedUser(
  opts: { email?: string; sub?: string; studios?: string[] } = {},
): Promise<string> {
  const cat = catalogFor();
  const id = cat.auth.authCreateUserGoogle({
    email: opts.email ?? `${uid('user')}@example.com`,
    googleSub: opts.sub ?? uid('sub'),
    givenName: 'Test',
    familyName: 'User',
    pictureUrl: '',
  });
  if (opts.studios?.length) cat.auth.authAddMemberships(id, opts.studios);
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

export async function loginCookie(userId: string): Promise<string> {
  const raw = await createLoginSession(env.ports.kv, userId, 14);
  return `${sessionCookieName(env.config)}=${raw}`;
}

export function adminHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Register companion presence so primarySession() resolves to sessionId. */
export function setCompanionPresence(
  clientId: string,
  sessionId: string,
  opts: { visible?: boolean; is_playing?: boolean } = {},
): void {
  env.ports.presence.upsert(clientId, {
    session_id: sessionId,
    visible: opts.visible ?? true,
    is_playing: opts.is_playing ?? false,
    updated: env.ports.clock.now(),
  });
}
