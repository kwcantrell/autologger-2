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

export const newSessionBodySchema = z.object({
  title: z.string().max(200).nullish(),
  frame_rate: z.number().min(1.0).max(120.0).default(24.0),
  start_offset_frames: z.number().int().min(0).default(0),
  show_id: z.string().min(1).max(120),
  episode: z.string().min(1).max(80),
  notes: z.string().max(2000).nullish(),
});
export type NewSessionBody = z.infer<typeof newSessionBodySchema>;

export const sessionUpdateBodySchema = z.object({
  title: z.string().min(1).max(200),
  start_offset_frames: z.number().int().min(0).default(0),
});
export type SessionUpdateBody = z.infer<typeof sessionUpdateBodySchema>;

export const logBodySchema = z.object({
  category: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
  metadata: z.record(z.unknown()).default({}),
  marked_at_utc: z.string().nullish(),
});
export type LogBody = z.infer<typeof logBodySchema>;

export const eventUpdateBodySchema = z.object({
  category: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
  wall_time_utc: z.string().min(1).max(80),
  timecode_hms: z.string().min(8).max(8),
});
export type EventUpdateBody = z.infer<typeof eventUpdateBodySchema>;

export const audioRecordingLeaseBodySchema = z.object({
  client_id: z.string().min(1).max(256),
});
export type AudioRecordingLeaseBody = z.infer<typeof audioRecordingLeaseBodySchema>;

export const audioSegmentWaveformBodySchema = z.object({
  peaks: z.array(z.number()).min(8).max(4096),
});
export type AudioSegmentWaveformBody = z.infer<typeof audioSegmentWaveformBodySchema>;

export const adminStudioCreateBodySchema = z.object({
  id: z.string().min(2).max(63),
  display_name: z.string().min(1).max(200),
});
export type AdminStudioCreateBody = z.infer<typeof adminStudioCreateBodySchema>;

export const adminMembershipBodySchema = z.object({
  studio_id: z.string().min(1).max(120),
});
export type AdminMembershipBody = z.infer<typeof adminMembershipBodySchema>;

export const transcriptWordCreateSchema = z.object({
  session_time: z.string().max(20).default(''),
  speaker: z.string().max(200).default(''),
  word: z.string().max(2000).default(''),
});
export type TranscriptWordCreate = z.infer<typeof transcriptWordCreateSchema>;

export const transcriptWordUpdateSchema = z.object({
  session_time: z.string().max(20).nullish(),
  speaker: z.string().max(200).nullish(),
  word: z.string().max(2000).nullish(),
});
export type TranscriptWordUpdate = z.infer<typeof transcriptWordUpdateSchema>;

export const topicCreateSchema = z.object({
  session_time: z.string().max(20).default(''),
  duration_sec: z.number().min(0).default(0),
  topic_level: z.number().int().min(1).max(10).default(1),
  summary: z.string().max(8000).default(''),
});
export type TopicCreate = z.infer<typeof topicCreateSchema>;

export const topicUpdateSchema = z.object({
  session_time: z.string().max(20).nullish(),
  duration_sec: z.number().min(0).nullish(),
  topic_level: z.number().int().min(1).max(10).nullish(),
  summary: z.string().max(8000).nullish(),
});
export type TopicUpdate = z.infer<typeof topicUpdateSchema>;

export const companionPresenceBodySchema = z.object({
  client_id: z.string().min(1).max(256),
  session_id: z.string().max(120).nullish(),
  visible: z.boolean().default(true),
  is_playing: z.boolean().default(false),
  closing: z.boolean().default(false),
});
export type CompanionPresenceBody = z.infer<typeof companionPresenceBodySchema>;

export const companionLogBodySchema = z.object({
  category_id: z.string().max(200).nullish(),
  category_label: z.string().max(200).nullish(),
  message: z.string().min(1).max(8000),
});
export type CompanionLogBody = z.infer<typeof companionLogBodySchema>;

export const companionTransportBodySchema = z.object({
  action: z.enum(['start', 'stop', 'toggle']),
});
export type CompanionTransportBody = z.infer<typeof companionTransportBodySchema>;

export const companionCommandBodySchema = z.object({
  type: z.enum(['record-start', 'record-stop', 'record-toggle', 'play-toggle']),
});
export type CompanionCommandBody = z.infer<typeof companionCommandBodySchema>;

export const companionCommandAckBodySchema = z.object({
  client_id: z.string().min(1).max(256),
  ok: z.boolean(),
  error: z.string().max(2000).nullish(),
});
export type CompanionCommandAckBody = z.infer<typeof companionCommandAckBodySchema>;

export const profileUpdateBodySchema = z.object({
  active_studio_id: z.string().max(120).nullish(),
  active_show_id: z.string().min(1).max(120).nullish(),
  settings: z.record(z.unknown()).nullish(),
  show_updates: z.array(showUpdateEntrySchema).nullish(),
  given_name: z.string().max(200).nullish(),
  family_name: z.string().max(200).nullish(),
});
export type ProfileUpdateBody = z.infer<typeof profileUpdateBodySchema>;
