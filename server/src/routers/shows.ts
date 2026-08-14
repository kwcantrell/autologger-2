// Shows routes — ported from src/autologger/web/routers/shows.py.

import { showApiDict } from '@autologger/catalog';
import { showCreateBodySchema } from '@autologger/contract';
import {
  DEFAULT_STUDIO_ID,
  defaultSettingsBlob,
  freshCategoryIds,
  normalizeEventPaletteNine,
  suggestedShowCode,
  validateCategoriesList,
} from '@autologger/domain';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { oauthConfigured } from '../env';

export const showsRouter = new Hono<AppEnv>();

showsRouter.get('/api/shows', async (c) => {
  const catalog = c.get('catalog');
  const user = c.get('user');
  if (user === null && oauthConfigured(c.env.config)) return c.json({ shows: [] });

  let sid = (c.req.query('studio_id') ?? '').trim();
  if (!sid) {
    const eff = catalog.profile.getEffectiveStudioForUser(user, oauthConfigured(c.env.config));
    if (eff === null) return c.json({ shows: [] });
    sid = eff.id;
  }
  if (!catalog.studios.isKnownStudio(sid)) return c.json({ detail: 'Unknown studio id.' }, 400);
  if (user !== null && !catalog.auth.authUserHasStudio(user.id, sid)) {
    return c.json({ detail: 'Unknown studio id.' }, 404);
  }
  const out = catalog.shows.listShowsForStudio(sid).map(showApiDict);
  return c.json({ shows: out });
});

// One show's full configuration (profile-shows-slimming). `/api/profile` now
// emits only `showBriefApiDict` entries, so a client that needs a show's
// categories or palettes without knowing (or caring about) its studio fetches
// it here; the studio-scoped list route above serves the "every show in this
// studio" case. Auth mirrors that list route — anonymous is allowed only while
// OAuth is unconfigured, and a logged-in caller must be a member of the show's
// studio. Both the unknown-id and the not-a-member outcomes are the SAME 404
// with the same body: a distinguishable 403 would turn this route into an
// existence oracle for other tenants' show ids.
showsRouter.get('/api/shows/:showId', async (c) => {
  const catalog = c.get('catalog');
  const user = c.get('user');
  const notFound = () => c.json({ detail: 'Show not found.' }, 404);
  if (user === null && oauthConfigured(c.env.config)) return notFound();

  const row = catalog.shows.getShowRow(c.req.param('showId'));
  if (row === null) return notFound();
  if (user !== null && !catalog.auth.authUserHasStudio(user.id, String(row.studio_id))) {
    return notFound();
  }
  return c.json({ show: showApiDict(row) });
});

showsRouter.post('/api/shows', async (c) => {
  const catalog = c.get('catalog');
  const body = showCreateBodySchema.parse(await c.req.json());
  const user = c.get('user');
  if (user === null && oauthConfigured(c.env.config))
    return c.json({ detail: 'Login required.' }, 401);

  if (!catalog.studios.isKnownStudio(body.studio_id))
    return c.json({ detail: 'Unknown studio id.' }, 400);
  if (user !== null && !catalog.auth.authUserHasStudio(user.id, body.studio_id)) {
    return c.json({ detail: 'Unknown studio id.' }, 404);
  }

  const code = (body.show_code ?? '').trim().toUpperCase() || suggestedShowCode(body.name);
  if (!code) return c.json({ detail: 'Show code is required.' }, 400);

  let norm: ReturnType<typeof validateCategoriesList>;
  try {
    norm = validateCategoriesList(defaultSettingsBlob(body.studio_id).categories);
  } catch {
    norm = validateCategoriesList(defaultSettingsBlob(DEFAULT_STUDIO_ID).categories);
  }
  norm = freshCategoryIds(norm);

  const palJson = JSON.stringify(normalizeEventPaletteNine(null));
  const newId = catalog.shows.createShow({
    studioId: body.studio_id,
    name: body.name.trim(),
    showCode: code,
    categoriesJson: JSON.stringify(norm),
    paletteJson: palJson,
    paletteCustomJson: palJson,
  });
  const row = catalog.shows.getShowRow(newId);
  if (row === null) return c.json({ detail: 'Show was not created.' }, 500);
  return c.json({ show: showApiDict(row) });
});
