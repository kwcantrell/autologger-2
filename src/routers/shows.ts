// Shows routes — ported from src/autologger/web/routers/shows.py.

import { Hono } from 'hono';
import { showApiDict } from '../db/d1';
import { oauthConfigured } from '../env';
import { showCreateBodySchema } from '../schemas';
import {
  DEFAULT_STUDIO_ID,
  defaultSettingsBlob,
  freshCategoryIds,
  normalizeEventPaletteNine,
  suggestedShowCode,
  validateCategoriesList,
} from '../studio';
import type { AppEnv } from '../types';

export const showsRouter = new Hono<AppEnv>();

showsRouter.get('/api/shows', async (c) => {
  const catalog = c.get('catalog');
  const user = c.get('user');
  if (user === null && oauthConfigured(c.env)) return c.json({ shows: [] });

  let sid = (c.req.query('studio_id') ?? '').trim();
  if (!sid) {
    const eff = await catalog.getEffectiveStudioForUser(user, oauthConfigured(c.env));
    if (eff === null) return c.json({ shows: [] });
    sid = eff.id;
  }
  if (!catalog.isKnownStudio(sid)) return c.json({ detail: 'Unknown studio id.' }, 400);
  if (user !== null && !(await catalog.authUserHasStudio(user.id, sid))) {
    return c.json({ detail: 'Unknown studio id.' }, 404);
  }
  const out = (await catalog.listShowsForStudio(sid)).map(showApiDict);
  return c.json({ shows: out });
});

showsRouter.post('/api/shows', async (c) => {
  const catalog = c.get('catalog');
  const body = showCreateBodySchema.parse(await c.req.json());
  const user = c.get('user');
  if (user === null && oauthConfigured(c.env)) return c.json({ detail: 'Login required.' }, 401);

  if (!catalog.isKnownStudio(body.studio_id)) return c.json({ detail: 'Unknown studio id.' }, 400);
  if (user !== null && !(await catalog.authUserHasStudio(user.id, body.studio_id))) {
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
  const newId = await catalog.createShow({
    studioId: body.studio_id,
    name: body.name.trim(),
    showCode: code,
    categoriesJson: JSON.stringify(norm),
    paletteJson: palJson,
    paletteCustomJson: palJson,
  });
  const row = await catalog.getShowRow(newId);
  if (row === null) return c.json({ detail: 'Show was not created.' }, 500);
  return c.json({ show: showApiDict(row) });
});
