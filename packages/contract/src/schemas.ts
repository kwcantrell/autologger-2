// Zod request schemas — ported from the catalog-relevant Pydantic models in
// src/autologger/web/schemas.py. Validated at the Hono route boundary; TS types inferred.
// Response bodies stay ad-hoc dict-shaped (see db/catalog.ts) to keep the JSON keys
// byte-compatible with the current React app's api/types.ts.

import { z } from 'zod';
import { widgetTypeSchema } from './aiV2Catalog';

export const MAX_METADATA_BYTES = 8000; // matches the message length cap.

// Pydantic `X | None = None` ⇒ field is optional and may be null. `.nullish()`
// folds both "absent" and explicit `null` to `null | undefined`, preserving the
// origin Python routers' `is not None` semantics.

export const showUpdateEntrySchema = z.object({
  show_id: z.string().min(1).max(120),
  name: z.string().min(1).max(200).nullish(),
  show_code: z.string().min(1).max(40).nullish(),
  // session-title-suffix (design D1/D8, gate ruling 2026-08-02): the wire
  // `next_episode` update key is gone — there is deliberately no field for
  // it here. A legacy client that still sends `next_episode` is unaffected:
  // zod's default object mode strips unrecognized keys, so the key is
  // ignored (never reaches `profile.ts`'s field-mapping) and does NOT cause
  // a 400 solely because it's present.
  title_suffix: z.enum(['date', 'episode']).nullish(),
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
  // session-title-suffix (design D6): blank/omitted episode is valid at the
  // schema level — whether it's REQUIRED depends on the linked show's
  // title_suffix (date vs episode) and whether an explicit title bypasses
  // derivation, both enforced by the create-path handler (400), not here.
  episode: z.string().max(80).nullish(),
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
  metadata: z
    .record(z.unknown())
    .default({})
    .refine((v) => JSON.stringify(v).length <= MAX_METADATA_BYTES, {
      message: `metadata exceeds ${MAX_METADATA_BYTES} serialized bytes`,
    }),
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

export const eventGenerateBodySchema = z
  .object({
    regenerate: z.boolean().optional(),
    // event-generate-hardening D5: DoS-hardening bounds, not semantic limits —
    // 500 entries exceeds any realistic instruction-bearing set; category_id
    // mirrors eventUpdateBodySchema.category's 200-char cap (ids are UUIDs);
    // option_label mirrors the settings write path's 200-char dropdown-option
    // cap (validateCategoriesList), so no storable label is ever excluded.
    selection: z
      .array(
        z.object({
          category_id: z.string().max(200),
          option_label: z.string().max(200).nullable().optional(),
        }),
      )
      .max(500)
      .optional(),
  })
  .refine((body) => !(body.regenerate === true && (body.selection?.length ?? 0) > 0), {
    message: 'regenerate cannot be combined with a non-empty selection',
  });
export type EventGenerateBody = z.infer<typeof eventGenerateBodySchema>;

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
  role: z.enum(['admin', 'member']).optional(),
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

// -- ai-topics-chat: the chat turn request body -------------------------------
// `message` is 1–8000 chars AFTER trimming (whitespace-only ⇒ invalid); the
// trimmed value is what the turn runner delivers to the CLI via stdin.
// `claude_session_id`, when present, is a non-empty string (ownership is checked
// against the per-session issued-id set in the turn runner — Phase 3).
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  claude_session_id: z.string().min(1).optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

// -- ai-v2-dashboards: the design-turn request body ---------------------------
// Deliberately mirrors chatRequestSchema's shape: `message` is 1-8000 chars
// after trimming (whitespace-only ⇒ invalid); `claude_session_id`, when
// present, is a non-empty string naming a previous design conversation to
// resume. Task 2.1/2.2's scope is the route's guard SHELL only — ownership/
// continuity checks against a resume id, the real turn runner, and MCP
// option-set building belong to tasks 2.3-2.8, which may extend this schema.
export const aiV2DesignRequestSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  claude_session_id: z.string().min(1).optional(),
});
export type AiV2DesignRequest = z.infer<typeof aiV2DesignRequestSchema>;

// -- ai-v2-dashboards: the design-question answer request body (task 3.2) ----
// spec "Design question round trip" + "Previews reflect the rendered result".
// A discriminated union so a chosen catalog option and the free-text fallback
// are STRUCTURALLY different shapes, never conflated:
//   - `kind: 'option'` carries a catalog widget-type identifier, validated
//     against the SAME closed enum `widgetTypeSchema` already enforces for
//     stored dashboards (`./aiV2Catalog.ts`) — an option naming a
//     type outside the catalog fails validation here (422), so "resolving an
//     option to its component is an exact lookup" never depends on matching
//     agent-authored display text.
//   - `kind: 'text'` is the free-text fallback the user typed instead.
// `turnId`/`requestId` are the ≥128-bit CSPRNG ids minted server-side
// (`@autologger/ai-runtime`'s `aiV2PendingQuestions.ts`) and echoed back by the client
// verbatim; the bound is generous (they're hex strings) but finite so a
// malformed body fails schema validation rather than reaching the registry.
export const aiV2QuestionAnswerItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('option'), widgetType: widgetTypeSchema }),
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(2000) }),
]);
export type AiV2AnswerItem = z.infer<typeof aiV2QuestionAnswerItemSchema>;

export const aiV2AnswerRequestSchema = z.object({
  turnId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(64),
  // AskUserQuestion asks 1-4 questions per call (SDK bound); one answer per
  // question, matched by array position.
  answers: z.array(aiV2QuestionAnswerItemSchema).min(1).max(4),
});
export type AiV2AnswerRequest = z.infer<typeof aiV2AnswerRequestSchema>;

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

// -- teams-self-serve (design D4): the /api/teams family bodies ---------------

export const teamCreateBodySchema = z.object({
  id: z.string().min(1).max(120),
  display_name: z.string().min(1).max(200),
});
export type TeamCreateBody = z.infer<typeof teamCreateBodySchema>;

export const teamRenameBodySchema = z.object({
  display_name: z.string().min(1).max(200),
});
export type TeamRenameBody = z.infer<typeof teamRenameBodySchema>;

export const teamInviteBodySchema = z.object({
  email: z.string().min(1).max(320),
});
export type TeamInviteBody = z.infer<typeof teamInviteBodySchema>;

export const teamRoleChangeBodySchema = z.object({
  role: z.enum(['admin', 'member']),
});
export type TeamRoleChangeBody = z.infer<typeof teamRoleChangeBodySchema>;

// -- youtube-audio-import: request body + exact-hostname allowlist (D6) ------
// `url`/`use_publish_date` are the verbatim snake_case keys the client sends
// (web/src/api/hooks/useSessions.ts useYoutubeImport). The allowlist validator
// is consumed by the route handler (Phase 5.3) BEFORE any `yt-dlp` spawn — see
// spec "Request and URL validation": rejection requires an EXACT lowercased-
// hostname match against the enumerated allowlist, never substring/suffix
// (bypassable by hosts like `youtube.com.evil.com`). `new URL()` already
// lowercases the host, strips userinfo (so `https://youtube.com@evil.com`
// resolves to host `evil.com` and is rejected), and punycode-normalizes IDN.
export const youtubeImportBodySchema = z.object({
  url: z.string().min(1).max(2048),
  use_publish_date: z.boolean(),
});
export type YoutubeImportBody = z.infer<typeof youtubeImportBodySchema>;

const YOUTUBE_HOST_ALLOWLIST: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
]);

export type YoutubeUrlValidation = { ok: true; href: string } | { ok: false };

/**
 * Exact-hostname YouTube allowlist validator (design D6). Parses `raw` with
 * `new URL()`, requires `http(s)`, and requires the lowercased `hostname` be
 * an exact member of `YOUTUBE_HOST_ALLOWLIST`. Returns the normalized
 * `url.href` on success so the caller spawns `yt-dlp` against the validated,
 * parser-normalized value rather than the raw request string.
 */
export function validateYoutubeImportUrl(raw: string): YoutubeUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false };
  if (!YOUTUBE_HOST_ALLOWLIST.has(parsed.hostname.toLowerCase())) return { ok: false };
  return { ok: true, href: parsed.href };
}

export const profileUpdateBodySchema = z.object({
  active_studio_id: z.string().max(120).nullish(),
  active_show_id: z.string().min(1).max(120).nullish(),
  settings: z.record(z.unknown()).nullish(),
  show_updates: z.array(showUpdateEntrySchema).nullish(),
  given_name: z.string().max(200).nullish(),
  family_name: z.string().max(200).nullish(),
});
export type ProfileUpdateBody = z.infer<typeof profileUpdateBodySchema>;
