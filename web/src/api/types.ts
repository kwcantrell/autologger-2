// TypeScript interfaces mirroring FastAPI schemas and response shapes.
// Derived from src/autologger/web/schemas.py and router responses.

// ---------------------------------------------------------------------------
// Studio / Profile
// ---------------------------------------------------------------------------

export interface DropdownOption {
  label: string;
  needs_context: boolean;
}

/**
 * Category shape for `GET /api/sessions/:id/show-categories` — server:
 * `showCategoriesApiShape` + `dropdownOptionsApiShape`
 * (`server/src/db/showsStore.ts`). `dropdown_options` carries the full
 * `{label, needs_context}` objects (and is `[]` for any non-`DROPDOWN`
 * category).
 *
 * NOT the shape of `profile.active_studio.categories` — that one is
 * `ActiveStudioCategory` below, whose `dropdown_options` is a bare `string[]`.
 * The two shared this type until web-api-shape-conformance audit CW-2 found
 * the divergence.
 */
export interface Category {
  id: string;
  label: string;
  color: string;
  type: 'BUTTON' | 'DROPDOWN' | 'TEXT' | 'ON_OFF';
  dropdown_options: DropdownOption[];
  on_label: string;
  off_label: string;
}

/**
 * `profile.active_studio.categories[]` — server: `studioToApiDict`
 * (`server/src/studio.ts`), fed by `blobToProfile`. Same key set as `Category`
 * and likewise `label`-keyed, but `blobToProfile` flattens every stored option
 * to its bare label, so `dropdown_options` is `string[]`, not
 * `DropdownOption[]` (web-api-shape-conformance audit CW-2 — the client
 * declared `Category` here, which was wrong for any DROPDOWN category).
 * `GET /api/studio` emits this same shape; it has no web caller.
 */
export interface ActiveStudioCategory {
  id: string;
  label: string;
  color: string;
  type: 'BUTTON' | 'DROPDOWN' | 'TEXT' | 'ON_OFF';
  dropdown_options: string[];
  on_label: string;
  off_label: string;
}

/**
 * Category shape for `profile.shows[].categories` and the `show_updates[].categories`
 * request payload — the *stored* `CategoryRecord` (server: `server/src/studio.ts`), keyed
 * `name`. `showApiDict` (server: `server/src/db/showsStore.ts`) passes this through
 * verbatim; only the events/Companion/`active_studio` read shapes go through the
 * `label`-mapping shaper (teams-settings-nav, D3) — of those, events/Companion keep the
 * `Category` type above, while `active_studio` has its own `ActiveStudioCategory`
 * (see the CW-2 note there).
 * `label` stays optional here defensively, in case a `label`-keyed shape ever feeds this
 * type — readers should hydrate with `c.name ?? c.label ?? ''`.
 */
export interface ShowCategory {
  id: string;
  name: string;
  label?: string;
  color: string;
  type: 'BUTTON' | 'DROPDOWN' | 'TEXT' | 'ON_OFF';
  dropdown_options: DropdownOption[];
  on_label: string;
  off_label: string;
}

export interface Show {
  id: string;
  studio_id: string;
  name: string;
  show_code: string;
  next_episode: number;
  categories: ShowCategory[];
  event_palette: string[];
  event_palette_preset: string;
  event_palette_custom: string[];
}

export interface StudioBrief {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Teams (teams-self-serve)
// ---------------------------------------------------------------------------

export type TeamRole = 'admin' | 'member';

/** `auth.user.teams[]` entries (profile assembler, teams-self-serve task 4.1):
 * a StudioBrief plus the caller's role in that team. */
export interface TeamMembershipBrief extends StudioBrief {
  role: TeamRole;
}

export interface TeamMember {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  role: TeamRole;
}

export interface TeamInvite {
  email: string;
  invited_at_utc: string;
}

/** `GET /api/teams/:id` response. `invites` is present only when `role` is
 * `admin` (server omits the field for members — design D4). */
export interface TeamDetail {
  id: string;
  name: string;
  role: TeamRole;
  enabled_admin_count: number;
  members: TeamMember[];
  invites?: TeamInvite[];
}

export interface TeamCreateBody {
  id: string;
  display_name: string;
}

export interface TeamCreateResponse {
  id: string;
  name: string;
  role: TeamRole;
}

export interface TeamRenameBody {
  display_name: string;
}

export interface TeamRenameResponse {
  id: string;
  name: string;
}

export interface TeamInviteBody {
  email: string;
}

export interface TeamRoleChangeBody {
  role: TeamRole;
}

export interface TeamRoleChangeResponse {
  ok: boolean;
  role: TeamRole;
}

export interface OkResponse {
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The transport snapshot both transport routes return — server:
 * `TransportStore.transportStateDict` (`server/src/session/transportStore.ts`),
 * typed there as `TransportState`.
 */
export interface TransportStateSnapshot {
  is_rolling: boolean;
  current_take: number;
  roll_started_at_utc: string | null;
  elapsed_frames: number;
  timecode: string;
  timecode_total_frames: number;
}

/**
 * `POST /api/sessions/:id/transport/start`. The route `return c.json(state)`s
 * the transport snapshot plus `started` — there is **no `ok` key on any path**
 * (web-api-shape-conformance audit CW-1; it was typed `OkResponse`).
 * `started` is `false` on the already-rolling early return, which writes nothing.
 */
export interface TransportStartResponse extends TransportStateSnapshot {
  started: boolean;
}

/**
 * `POST /api/sessions/:id/transport/stop` — as above, with `stopped` (`false`
 * on the already-stopped early return). Kept a **separate** type from the start
 * response rather than one type with both flags optional, so a fixture check
 * cannot pass by omitting whichever flag it happens not to carry.
 */
export interface TransportStopResponse extends TransportStateSnapshot {
  stopped: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  picture_url: string | null;
  teams: TeamMembershipBrief[];
}

export interface AuthSection {
  logged_in: boolean;
  oauth_configured: boolean;
  user: AuthUser | null;
}

export interface NewSessionDefaults {
  title_prefix: string;
  default_frame_rate: number;
}

export interface AdminInfo {
  restart_supported: boolean;
  restart_needs_token: boolean;
}

export interface ProfilePayload {
  active_studio_id: string;
  active_show_id: string;
  active_studio: { id: string; name: string; categories: ActiveStudioCategory[] };
  studios: StudioBrief[];
  studio_settings: Record<string, Record<string, unknown>>;
  shows: Show[];
  new_session_defaults: NewSessionDefaults;
  admin: AdminInfo;
  auth: AuthSection;
}

// ---------------------------------------------------------------------------
// Transcript words + Topics
// ---------------------------------------------------------------------------

export interface TranscriptWord {
  id: string;
  session_id: string;
  session_time: string;
  speaker: string;
  word: string;
  /** Already present on the wire (the server spreads its own `TranscriptWord`
   * row verbatim — `server/src/routers/transcribe.ts`'s
   * `words.map((w) => ({ ...w, session_id: sessionId }))`) but omitted from
   * this type until ai-v2-dashboards task 5.6 needed typed access for
   * client-side aggregation (`0.0` for manually-entered/anchorless words —
   * see `server/src/aiV2/aggregates.ts`'s degenerate-timing discipline, D2a).
   * Declaring it here is a type-only fix, not a wire-shape change. */
  start_sec: number;
  end_sec: number;
  ordinal: number;
  created_at_utc: string;
}

export interface SessionTopic {
  id: string;
  session_id: string;
  session_time: string;
  duration_sec: number;
  topic_level: number;
  summary: string;
  ordinal: number;
  created_at_utc: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  title: string;
  deck_title: string;
  show_id: string;
  show_code: string;
  show_name: string;
  episode: string;
  notes: string;
  session_status: 'active' | 'archived' | 'deleted';
  frame_rate: number;
  start_offset_frames: number;
  created_at_utc: string;
  episode_date: string | null;
  event_count: number;
  is_rolling: boolean;
  current_take: number;
  rolling_timecode: string | null;
  total_runtime_hms: string;
  archived: boolean;
}

export interface SessionsResponse {
  active: Session[];
  archived: Session[];
}

/**
 * `GET /api/sessions/:id/status`. The handler (`server/src/routers/events.ts`)
 * emits exactly 21 keys — the 20 below plus `audio_recording_lease_age_sec`,
 * which no consumer reads and which stays undeclared here (additive tolerance).
 *
 * It does **not** emit `timecode_total_frames`, `start_offset_frames`, or
 * `audio_segment_count`; those three were declared here and never read
 * anywhere in `web/src` (web-api-shape-conformance audit CW-3). Don't
 * reintroduce them without checking the handler — `timecode_total_frames` in
 * particular exists on `LogEvent`, which is a different shape.
 */
export interface SessionStatus {
  is_rolling: boolean;
  timecode: string;
  session_timecode: string;
  master_timecode: string;
  frame_rate: number;
  current_take: number;
  audio_recording_lease_alive: boolean;
  audio_recording_lease_holder_id: string | null;
  event_count: number;
  logged_event_count: number;
  // Session identity fields (from /status response)
  title: string;
  deck_title: string;
  show_name: string | null;
  show_code: string | null;
  episode: string;
  session_created_at_utc: string | null;
  now_utc: string;
  notes: string;
  show_id: string | null;
  events_stream_revision: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface LogEvent {
  event_id: string;
  session_id: string;
  category: string;
  category_label: string;
  category_color: string;
  message: string;
  timecode: string;
  timecode_hms: string;
  timecode_total_frames: number | null;
  frame_rate: number | null;
  wall_time_utc: string | null;
  metadata: Record<string, unknown>;
}

export interface EventsResponse {
  events: LogEvent[];
  total: number;
  logged_event_count: number;
  offset: number;
  limit: number;
}

export interface ShowCategoriesResponse {
  categories: Category[];
  show_name: string;
  show_code: string;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface AudioSegment {
  id: string;
  session_id: string;
  ordinal: number;
  recording_ordinal: number | null;
  started_at_utc: string | null;
  ended_at_utc: string | null;
  duration_sec: number | null;
  file_path: string;
  mime_type: string;
  url: string;
  waveform_peaks: number[] | null;
  waveform_db_floor: number | null;
}

export interface AudioSegmentsResponse {
  segments: AudioSegment[];
  has_audio: boolean;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface NewSessionBody {
  title?: string | null;
  frame_rate: number;
  start_offset_frames: number;
  show_id: string;
  episode: string;
  notes?: string | null;
}

export interface SessionUpdateBody {
  title: string;
  start_offset_frames: number;
}

export interface LogBody {
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
  marked_at_utc?: string | null;
}

export interface EventUpdateBody {
  category: string;
  message: string;
  wall_time_utc: string;
  timecode_hms: string;
}

export interface AudioRecordingLeaseBody {
  client_id: string;
}

export interface AudioSegmentWaveformBody {
  peaks: number[];
}

export interface ShowUpdateEntry {
  show_id: string;
  name?: string | null;
  show_code?: string | null;
  next_episode?: number | null;
  categories?: ShowCategory[] | null;
  event_palette?: string[] | null;
  event_palette_preset?: string | null;
  event_palette_custom?: string[] | null;
}

export interface ProfileUpdateBody {
  active_studio_id?: string | null;
  active_show_id?: string | null;
  settings?: Record<string, unknown> | null;
  show_updates?: ShowUpdateEntry[] | null;
  given_name?: string | null;
  family_name?: string | null;
}

export interface ShowCreateBody {
  studio_id: string;
  name: string;
  show_code?: string | null;
}

// Admin
export interface AdminStudioCreateBody {
  id: string;
  display_name: string;
}

export interface AdminStudio {
  id: string;
  name: string;
  builtin: boolean;
}

export interface AdminUser {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  disabled: boolean;
  studios: StudioBrief[];
}

export interface AdminDataResponse {
  studios_catalog: AdminStudio[];
  users: AdminUser[];
}

// Companion (Stream Deck) remote control
export type CompanionCommandType = 'record-start' | 'record-stop' | 'record-toggle' | 'play-toggle';

export interface CompanionRemoteCommand {
  id: string;
  type: CompanionCommandType;
  created_at_utc: string;
}

export interface CompanionCommandsWaitResponse {
  commands: CompanionRemoteCommand[];
}
