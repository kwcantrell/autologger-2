// Profile + studio routes — ported from src/autologger/web/routers/profile.py.

import { Hono } from 'hono';
import type { ProfileCtx } from '../db/catalog';
import { adminMeta, oauthConfigured } from '../env';
import { profileUpdateBodySchema } from '../schemas';
import {
  normalizeEventPaletteNine,
  SETTING_ACTIVE_SHOW,
  SETTING_ACTIVE_STUDIO,
  studioToApiDict,
  validateCategoriesList,
  validateEventPalettePreset,
} from '../studio';
import type { AppEnv, Config } from '../types';

export const profileRouter = new Hono<AppEnv>();

function ctx(config: Config): ProfileCtx {
  return { oauthConfigured: oauthConfigured(config), adminMeta: adminMeta(config) };
}

profileRouter.get('/api/studio', async (c) => {
  const catalog = c.get('catalog');
  const prof = catalog.profile.getEffectiveStudioForUser(c.get('user'), oauthConfigured(c.env.config));
  if (prof === null) return c.json({ detail: 'No team access.' }, 403);
  return c.json(studioToApiDict(prof));
});

profileRouter.get('/api/profile', async (c) => {
  const catalog = c.get('catalog');
  return c.json(catalog.profile.profilePayload(c.get('user'), ctx(c.env.config)));
});

profileRouter.put('/api/profile', async (c) => {
  const catalog = c.get('catalog');
  const body = profileUpdateBodySchema.parse(await c.req.json());
  const user = c.get('user');
  if (user === null && oauthConfigured(c.env.config)) return c.json({ detail: 'Login required.' }, 401);

  const rawSid = (body.active_studio_id ?? '').trim();

  // Logged-in user with no team memberships: only name edits allowed.
  if (user !== null && (catalog.auth.authListStudioIdsForUser(user.id)).length === 0) {
    if (rawSid || body.settings != null || (body.show_updates && body.show_updates.length)) {
      return c.json({ detail: 'No team access.' }, 403);
    }
    if (body.given_name != null || body.family_name != null) {
      const gn = (body.given_name ?? user.given_name).trim().slice(0, 200);
      const fn = (body.family_name ?? user.family_name).trim().slice(0, 200);
      catalog.auth.authUpdateUserNames(user.id, gn, fn);
    }
    return c.json(catalog.profile.profilePayload(user, ctx(c.env.config)));
  }

  if (!rawSid) return c.json({ detail: 'active_studio_id is required.' }, 400);
  if (!catalog.studios.isKnownStudio(rawSid)) return c.json({ detail: 'Unknown studio id.' }, 400);
  if (user !== null && !(catalog.auth.authUserHasStudio(user.id, rawSid))) {
    return c.json({ detail: 'No access to that team.' }, 403);
  }

  if (body.settings != null) {
    catalog.studios.saveStudioSettingsBlob(rawSid, body.settings); // ValidationError → 400 via onError
  }

  if (body.show_updates && body.show_updates.length) {
    for (const ent of body.show_updates) {
      const sid = ent.show_id.trim();
      const row = catalog.shows.getShowRow(sid);
      if (row === null || String(row.studio_id) !== rawSid) {
        return c.json({ detail: `Show '${ent.show_id}' is not part of the selected team.` }, 400);
      }
      const fields: Parameters<typeof catalog.shows.updateShowFields>[1] = {};
      if (ent.name != null) fields.name = ent.name.trim();
      if (ent.show_code != null) fields.show_code = ent.show_code.trim();
      if (ent.next_episode != null) fields.next_episode = ent.next_episode;
      if (ent.categories != null) {
        fields.categories_json = JSON.stringify(validateCategoriesList(ent.categories));
      }
      if (ent.event_palette != null) {
        fields.event_palette_json = JSON.stringify(normalizeEventPaletteNine(ent.event_palette));
      }
      if (ent.event_palette_preset != null) {
        fields.event_palette_preset = validateEventPalettePreset(ent.event_palette_preset);
      }
      if (ent.event_palette_custom != null) {
        fields.event_palette_custom_json = JSON.stringify(
          normalizeEventPaletteNine(ent.event_palette_custom),
        );
      }
      if (Object.keys(fields).length) {
        catalog.shows.updateShowFields(sid, fields);
        // bump_events_stream_revision_for_show: the events stream lives in the
        // session hub, not the catalog — nothing to bump here.
      }
    }
  }

  const showsNow = catalog.shows.listShowsForStudio(rawSid);
  const validShowIds = new Set(showsNow.map((r) => String(r.id)));
  const rawActiveShow = (body.active_show_id ?? '').trim();
  let nextShow: string;
  if (rawActiveShow) {
    if (!validShowIds.has(rawActiveShow)) {
      return c.json({ detail: 'active_show_id must belong to the selected team.' }, 400);
    }
    nextShow = rawActiveShow;
  } else {
    nextShow = showsNow.length ? String(showsNow[0].id) : '';
  }

  if (user === null) {
    catalog.studios.setSetting(SETTING_ACTIVE_SHOW, nextShow);
    catalog.studios.setSetting(SETTING_ACTIVE_STUDIO, rawSid);
  } else {
    catalog.auth.authSetPrefs(user.id, rawSid, nextShow);
  }

  if (user !== null && (body.given_name != null || body.family_name != null)) {
    const gn = (body.given_name ?? user.given_name).trim().slice(0, 200);
    const fn = (body.family_name ?? user.family_name).trim().slice(0, 200);
    catalog.auth.authUpdateUserNames(user.id, gn, fn);
  }

  return c.json(catalog.profile.profilePayload(user, ctx(c.env.config)));
});
