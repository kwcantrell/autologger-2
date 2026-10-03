// Shows routes — ported from src/autologger/web/routers/shows.py.

import { showApiDict } from '@autologger/catalog';
import { showCreateBodySchema } from '@autologger/contract';
import {
  defaultSettingsBlob,
  freshCategoryIds,
  normalizeEventPaletteNine,
  suggestedShowCode,
  validateCategoriesList,
} from '@autologger/domain';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { requireUser } from './_helpers';

export const showsRouter = new Hono<AppEnv>();

showsRouter.get('/api/shows', async (c) => {
  const catalog = c.get('catalog');
  const user = requireUser(c);

  let sid = (c.req.query('studio_id') ?? '').trim();
  if (!sid) {
    const eff = await catalog.profile.getEffectiveStudioForUser(user);
    if (eff === null) return c.json({ shows: [] });
    sid = eff.id;
  }
  if (!catalog.studios.isKnownStudio(sid)) return c.json({ detail: 'Unknown studio id.' }, 400);
  if (!(await catalog.auth.authUserHasStudio(user.id, sid))) {
    return c.json({ detail: 'Unknown studio id.' }, 404);
  }
  const out = (await catalog.shows.listShowsForStudio(sid)).map(showApiDict);
  return c.json({ shows: out });
});

// One show's full configuration (profile-shows-slimming). `/api/profile` now
// emits only `showBriefApiDict` entries, so a client that needs a show's
// categories or palettes without knowing (or caring about) its studio fetches
// it here; the studio-scoped list route above serves the "every show in this
// studio" case. Auth mirrors that list route: the caller must be a member of
// the show's studio (require-login D3). Both the unknown-id and the not-a-member outcomes are the SAME 404
// with the same body: a distinguishable 403 would turn this route into an
// existence oracle for other tenants' show ids.
showsRouter.get('/api/shows/:showId', async (c) => {
  const catalog = c.get('catalog');
  const user = requireUser(c);
  const notFound = () => c.json({ detail: 'Show not found.' }, 404);

  const row = await catalog.shows.getShowRow(c.req.param('showId'));
  if (row === null) return notFound();
  if (!(await catalog.auth.authUserHasStudio(user.id, String(row.studio_id)))) {
    return notFound();
  }
  return c.json({ show: showApiDict(row) });
});

showsRouter.post('/api/shows', async (c) => {
  const catalog = c.get('catalog');
  const body = showCreateBodySchema.parse(await c.req.json());
  const user = requireUser(c);

  const code = (body.show_code ?? '').trim().toUpperCase() || suggestedShowCode(body.name);
  if (!code) return c.json({ detail: 'Show code is required.' }, 400);

  let norm: ReturnType<typeof validateCategoriesList>;
  try {
    norm = validateCategoriesList(defaultSettingsBlob(body.studio_id).categories);
  } catch {
    norm = validateCategoriesList(defaultSettingsBlob('').categories);
  }
  norm = freshCategoryIds(norm);

  const palJson = JSON.stringify(normalizeEventPaletteNine(null));
  // The team, the caller's membership and role are checked inside the insert's transaction, so a
  // team deleted or a caller demoted meanwhile never gets a show (catalog-concurrency-hazards D3;
  // show-grants D9: only owners and admins create shows).
  const created = await catalog.tx(async (cat) => {
    if (!(await cat.studios.studioExists(body.studio_id))) {
      // catalog-policies D6: the policy hides a foreign team's definition; the definer check
      // tells it (404, as before) from a missing or concurrently deleted team (400).
      return (await cat.studios.studioExistsAnywhere(body.studio_id)) ? (404 as const) : (400 as const);
    }
    const role = await cat.auth.authGetMembershipRoleForShare(user.id, body.studio_id);
    if (role === null) return 404 as const;
    if (role !== 'owner' && role !== 'admin') return 403 as const;
    return cat.shows.createShow({
      studioId: body.studio_id,
      name: body.name.trim(),
      showCode: code,
      categoriesJson: JSON.stringify(norm),
      paletteJson: palJson,
      paletteCustomJson: palJson,
    });
  });
  if (created === 403) return c.json({ detail: 'Admin role required.' }, 403);
  if (typeof created === 'number') return c.json({ detail: 'Unknown studio id.' }, created);
  const row = await catalog.shows.getShowRow(created);
  if (row === null) return c.json({ detail: 'Show was not created.' }, 500);
  return c.json({ show: showApiDict(row) });
});
