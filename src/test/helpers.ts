import { env } from 'cloudflare:test';
import { createLoginSession } from '../auth/identity';
import { Catalog } from '../db/d1';
import { sessionCookieName } from '../env';

export function catalogFor(): Catalog {
  return new Catalog(env.DB);
}

let counter = 0;
const uid = (p: string): string => `${p}-${(counter += 1)}`;

export async function seedStudio(opts: { id?: string; name?: string } = {}): Promise<string> {
  const id = opts.id ?? uid('studio');
  await catalogFor().adminCreateStudio(id, opts.name ?? `Studio ${id}`);
  return id;
}

export async function seedUser(
  opts: { email?: string; sub?: string; studios?: string[] } = {},
): Promise<string> {
  const cat = catalogFor();
  const id = await cat.authCreateUserGoogle({
    email: opts.email ?? `${uid('user')}@example.com`,
    googleSub: opts.sub ?? uid('sub'),
    givenName: 'Test',
    familyName: 'User',
    pictureUrl: '',
  });
  if (opts.studios?.length) await cat.authAddMemberships(id, opts.studios);
  return id;
}

export async function seedShow(opts: {
  studioId: string;
  name?: string;
  code?: string;
}): Promise<string> {
  return catalogFor().createShow({
    studioId: opts.studioId,
    name: opts.name ?? 'Test Show',
    showCode: opts.code ?? 'TS',
    categoriesJson: '[]',
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
  return catalogFor().createSessionIndex({
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
  const raw = await createLoginSession(env.AUTH, userId, 14);
  return `${sessionCookieName(env)}=${raw}`;
}

export function adminHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
