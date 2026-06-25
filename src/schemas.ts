// Zod request schemas — ported from the catalog-relevant Pydantic models in
// src/autologger/web/schemas.py. Validated at the Hono route boundary; TS types inferred.
// Response bodies stay ad-hoc dict-shaped (see db/d1.ts) to keep the JSON keys
// byte-compatible with the current React app's api/types.ts.

import { z } from 'zod';

// Pydantic `X | None = None` ⇒ field is optional and may be null. `.nullish()`
// folds both "absent" and explicit `null` to `null | undefined`, matching the
// Python routers' `is not None` checks.

export const showUpdateEntrySchema = z.object({
  show_id: z.string().min(1).max(120),
  name: z.string().min(1).max(200).nullish(),
  show_code: z.string().min(1).max(40).nullish(),
  next_episode: z.number().int().min(1).max(999999).nullish(),
  categories: z.array(z.record(z.unknown())).nullish(),
  event_palette: z.array(z.string()).nullish(),
  event_palette_preset: z.string().max(32).nullish(),
  event_palette_custom: z.array(z.string()).nullish(),
});
export type ShowUpdateEntry = z.infer<typeof showUpdateEntrySchema>;

export const showCreateBodySchema = z.object({
  studio_id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  show_code: z.string().max(40).nullish(),
});
export type ShowCreateBody = z.infer<typeof showCreateBodySchema>;

export const profileUpdateBodySchema = z.object({
  active_studio_id: z.string().max(120).nullish(),
  active_show_id: z.string().min(1).max(120).nullish(),
  settings: z.record(z.unknown()).nullish(),
  show_updates: z.array(showUpdateEntrySchema).nullish(),
  given_name: z.string().max(200).nullish(),
  family_name: z.string().max(200).nullish(),
});
export type ProfileUpdateBody = z.infer<typeof profileUpdateBodySchema>;
