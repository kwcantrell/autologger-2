// Events + transport + status routes — ported from web/routers/events.py.
// Each handler resolves the session hub, calls RPC, mirrors the returned live
// projection onto the catalog sessions row, and enriches events in the router
// layer using the show profile (keeping show logic out of the hub).

import { Hono } from 'hono';
import { showCategoriesApiShape } from '../db/catalog';
import {
  aiChatConfigured,
  aiChatMaxConcurrent,
  aiChatOpenNetworkRefused,
  eventGenerateMaxBudgetUsd,
  eventGenerateMaxCreatedEvents,
  eventGenerateMaxInstructionBytes,
  eventGenerateMaxInstructionEntries,
  eventGenerateTimeoutSec,
} from '../env';
import {
  audioRecordingLeaseBodySchema,
  type EventGenerateBody,
  eventGenerateBodySchema,
  eventUpdateBodySchema,
  logBodySchema,
} from '../schemas';
import {
  type CategoryKind,
  categoryIsInstructionBearing,
  type EventRpc,
  enrichEventRpc,
  mergeCategoryUiSnapshotsIntoMetadata,
  normalizeEventButtonNameForRelink,
  type StudioProfile,
  sessionDeckDisplayTitle,
  stripCategoryUiSnapshots,
} from '../studio';
import { formatSmpte, fromTotalFrames, isoZ } from '../timecode';
import type { AppEnv } from '../types';
import {
  ApiError,
  getSessionHub,
  parseOptionalMarkedAt,
  requireSession,
  timecodeCtx,
} from './_helpers';
import { aiChatTurns } from './aiChatRegistry';
import type {
  AiGenerationRunContext,
  AiGenerationSnapshotCategory,
  AiGenerationSnapshotOption,
  AiMcpToolName,
} from './aiMcpServer';
import { driveAiTurn } from './aiTurn';
import {
  buildEventGenerateMessage,
  EVENT_GENERATE_SYSTEM_PROMPT,
  type EventGenerateExistingEvent,
} from './eventGeneratePrompt';

export const eventsRouter = new Hono<AppEnv>();

function relinkMaps(profile: StudioProfile): {
  validIds: string[];
  labelToIds: Record<string, string[]>;
} {
  const validIds: string[] = [];
  const labelToIds: Record<string, string[]> = {};
  for (const c of profile.categories) {
    const cid = c.id.trim();
    const name = c.label.trim();
    if (cid) validIds.push(cid);
    if (cid && name) {
      const key = normalizeEventButtonNameForRelink(name);
      if (!labelToIds[key]) labelToIds[key] = [];
      labelToIds[key].push(cid);
    }
  }
  return { validIds, labelToIds };
}

eventsRouter.get('/api/sessions/:sessionId/show-categories', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const raw = c.get('catalog').sessions.getSessionShowCategories(sessionId);
  if (raw === null) throw new ApiError(404, 'Session or show not found.');
  return c.json({
    categories: showCategoriesApiShape(raw.categories),
    show_name: raw.showName,
    show_code: raw.showCode,
    // Additive top-level boolean (auto-generate-event-logs delta): true iff any
    // of the show's categories is instruction-bearing per the single definition
    // in `categoryIsInstructionBearing`. Computed here in the router — the
    // shared `showCategoriesApiShape` projection (also serving Companion) is
    // deliberately NOT extended, and the `categories` entries carry no
    // instruction fields.
    auto_instructions_present: raw.categories.some(categoryIsInstructionBearing),
  });
});

eventsRouter.get('/api/sessions/:sessionId/status', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const catalog = c.get('catalog');
  const row = catalog.sessions.getSessionJoinedRow(sessionId, { includeHidden: false });
  if (row === null) throw new ApiError(404, 'Session not found.');
  const ctx = timecodeCtx(row);
  const hub = getSessionHub(c, sessionId);
  const live = hub.statusLive(ctx);
  const lease = hub.leaseStatus();

  const now = new Date(c.env.ports.clock.now());
  const startedMs = row.started_at_utc ? Date.parse(String(row.started_at_utc)) : Number.NaN;
  const sec = Number.isNaN(startedMs) ? 0 : Math.max(0, (now.getTime() - startedMs) / 1000);
  const masterTc = fromTotalFrames(Math.round(sec * ctx.frameRate), ctx.frameRate);
  const episode = String(row.episode ?? '');
  const showCode = (row.show_code as string | null) ?? null;
  const deck = sessionDeckDisplayTitle({ showCode, episode, storedTitle: String(row.title ?? '') });

  return c.json({
    timecode: live.session_timecode,
    master_timecode: formatSmpte(masterTc),
    session_timecode: live.session_timecode,
    now_utc: isoZ(now),
    session_created_at_utc: row.created_at_utc ? isoZ(new Date(String(row.created_at_utc))) : null,
    frame_rate: ctx.frameRate,
    event_count: live.event_count,
    logged_event_count: live.logged_event_count,
    events_stream_revision: live.events_stream_revision,
    title: String(row.title ?? ''),
    deck_title: deck,
    show_id: (row.show_id as string | null) ?? null,
    show_name: (row.show_name as string | null) ?? null,
    show_code: showCode,
    episode,
    notes: String(row.notes ?? ''),
    is_rolling: live.is_rolling,
    current_take: live.current_take,
    audio_recording_lease_holder_id: lease.holder_client_id,
    audio_recording_lease_alive: lease.lease_alive,
    audio_recording_lease_age_sec: lease.lease_age_sec,
  });
});

eventsRouter.post('/api/sessions/:sessionId/audio-recording-lease', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const body = audioRecordingLeaseBodySchema.parse(await c.req.json());
  const ok = getSessionHub(c, sessionId).claimLease(body.client_id.trim());
  if (!ok) {
    throw new ApiError(
      409,
      'Another window, tab, or user is already recording audio for this session.',
    );
  }
  return c.json({ ok: true });
});

eventsRouter.post('/api/sessions/:sessionId/audio-recording-lease/heartbeat', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const body = audioRecordingLeaseBodySchema.parse(await c.req.json());
  const ok = getSessionHub(c, sessionId).heartbeatLease(body.client_id.trim());
  return c.json({ ok });
});

eventsRouter.post('/api/sessions/:sessionId/audio-recording-lease/release', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const body = audioRecordingLeaseBodySchema.parse(await c.req.json());
  getSessionHub(c, sessionId).releaseLease(body.client_id.trim());
  return c.json({ ok: true });
});

eventsRouter.post('/api/sessions/:sessionId/transport/start', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = requireSession(c, sessionId);
  const { state, projection } = getSessionHub(c, sessionId).startTake(timecodeCtx(row));
  c.get('catalog').sessions.projectSessionLive(sessionId, projection);
  return c.json(state);
});

eventsRouter.post('/api/sessions/:sessionId/transport/stop', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = requireSession(c, sessionId);
  const { state, projection } = getSessionHub(c, sessionId).stopTake(timecodeCtx(row));
  c.get('catalog').sessions.projectSessionLive(sessionId, projection);
  return c.json(state);
});

eventsRouter.get('/api/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const catalog = c.get('catalog');
  const limit = clampInt(c.req.query('limit'), 200, 1, 2000);
  const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const profile = catalog.sessions.studioProfileForSession(sessionId);
  const hub = getSessionHub(c, sessionId);
  if (offset === 0) {
    hub.maybeRelinkOrphans(relinkMaps(profile));
  }
  const res = hub.listEvents({ limit, offset });
  return c.json({
    events: res.events.map((e) => enrichEventRpc(e, profile)),
    total: res.total,
    logged_event_count: res.loggedTotal,
    offset,
    limit,
  });
});

eventsRouter.post('/api/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = requireSession(c, sessionId);
  const body = logBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  const profile = catalog.sessions.studioProfileForSession(sessionId);
  const validIds = new Set(profile.categories.map((cat) => cat.id));
  if (!validIds.has(body.category) && body.category !== 'internal') {
    throw new ApiError(400, 'Unknown category for this studio profile.');
  }
  let meta: Record<string, unknown> = { ...body.metadata };
  if (body.category.toLowerCase() !== 'internal') {
    const catDef = profile.categories.find((cat) => cat.id === body.category) ?? null;
    if (catDef !== null) meta = mergeCategoryUiSnapshotsIntoMetadata(meta, catDef);
  }
  const marked = parseOptionalMarkedAt(body.marked_at_utc);
  const { event, projection } = getSessionHub(c, sessionId).addEvent({
    category: body.category,
    message: body.message,
    metadataJson: JSON.stringify(meta),
    markedAtUtc: marked,
    ctx: timecodeCtx(row),
  });
  catalog.sessions.projectSessionLive(sessionId, projection);
  return c.json(enrichEventRpc(event, profile));
});

// ── Event auto-generation (auto-generate-event-logs, design D2/D3, task 4.3) ─
// POST …/events/generate — a synchronous JSON route mirroring topics/
// generate's guard ladder, run through the same locked-down driveAiTurn
// one-shot (paid-spend endpoint). New frozen surface authorized by the
// auto-event-generation delta. Guard ORDER (spec "Gated generation endpoint
// with pre-spawn preconditions" — nothing spawns, and no MCP registration
// exists, until every guard passes): session 404-mask → CLAUDE_CLI_PATH 503 →
// open-network 503 → anchored-transcript 400 → no-instructions 400 →
// aggregate-instruction-bound 400 → shared AI slot 409. The slot is acquired
// HERE and released in this handler's own `finally` (router-owned slot
// lifecycle, the transcribe.ts pattern).

const EVENT_GENERATE_NOT_CONFIGURED_DETAIL =
  'Event generation is not configured on this deployment. Set CLAUDE_CLI_PATH to the claude CLI to enable it.';
const EVENT_GENERATE_OPEN_NETWORK_DETAIL =
  'Event generation is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no ' +
  'IP_ALLOWLIST. Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before using a paid AI endpoint.';
const EVENT_GENERATE_NO_TRANSCRIPT_DETAIL =
  'This session has no transcript words to generate events from. Generate or import a transcript first.';
const EVENT_GENERATE_NO_ANCHORS_DETAIL =
  "This session's transcript has no words with session-time anchors, so generated events could not be placed on " +
  'the timeline. Regenerate the transcript so its words carry timecodes first.';
const EVENT_GENERATE_NO_INSTRUCTIONS_DETAIL =
  "No event button on this session's show carries a generation instruction. Add auto-generate instructions to " +
  'event buttons (or dropdown options) in settings first.';
// Same holder set as the shared registry's reworded busy details (ai.ts /
// aiV2.ts / transcribe.ts), with this endpoint's own next action.
const EVENT_GENERATE_SESSION_BUSY_DETAIL =
  'A turn (AI chat, AI v2, topic generation, or event generation) is already in progress for this session; ' +
  'wait for it to finish before generating events. These features share one per-session AI slot by design.';
const EVENT_GENERATE_AT_CAPACITY_DETAIL =
  'The server is at its AI turn concurrency limit (AI_CHAT_MAX_CONCURRENT, shared between AI chat, AI v2, ' +
  'topic generation, and event generation); try again shortly.';
// Fixed, handler-owned — never the CLI's raw output or its internal outcome
// token (the topics/generate opaque-502 pattern; spec "A CLI/turn failure
// after spawn SHALL map to the same opaque scrubbed failure mechanics").
const EVENT_GENERATE_FAILURE_DETAIL = 'Event generation failed.';

/** The generation turn's tool surface (design D3): argv allowlist AND
 * server-side MCP registration both name exactly these two. */
const EVENT_GENERATE_ALLOWED_TOOLS = [
  'get_transcript_words',
  'create_event',
] as const satisfies readonly AiMcpToolName[];

/** Map ONE raw (possibly legacy-loose) show-category JSON entry to the run
 * snapshot's category shape (ledger registration shape: id, name, type,
 * color, auto_instruction?, dropdown_options[{label, needs_context,
 * auto_instruction?}]). Defensive `String(...)`/shape guards mirror the other
 * raw-categories readers — stored categories normally come out of
 * `validateCategoriesList` normalization, but legacy JSON may be looser. */
function toGenerationSnapshotCategory(raw: unknown): AiGenerationSnapshotCategory {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const instr = typeof rec.auto_instruction === 'string' ? rec.auto_instruction.trim() : '';
  const optsRaw = Array.isArray(rec.dropdown_options) ? rec.dropdown_options : [];
  const dropdownOptions = optsRaw.flatMap((o): AiGenerationSnapshotOption[] => {
    if (typeof o === 'string') {
      const label = o.trim();
      return label ? [{ label, needs_context: false }] : [];
    }
    if (!o || typeof o !== 'object') return [];
    const or = o as Record<string, unknown>;
    const label = String(or.label ?? or.name ?? '').trim();
    if (!label) return [];
    const optInstr = typeof or.auto_instruction === 'string' ? or.auto_instruction.trim() : '';
    return [
      {
        label,
        needs_context: Boolean(or.needs_context ?? false),
        ...(optInstr ? { auto_instruction: optInstr } : {}),
      },
    ];
  });
  return {
    id: String(rec.id ?? ''),
    name: String(rec.name ?? ''),
    type: String(rec.type ?? '')
      .toUpperCase()
      .trim() as CategoryKind,
    color: String(rec.color ?? ''),
    ...(instr ? { auto_instruction: instr } : {}),
    dropdown_options: dropdownOptions,
  };
}

/** Aggregate pre-spawn instruction size over the snapshot (design D8, guard
 * 6): `entries` = instruction-bearing categories + instruction-bearing
 * options (DROPDOWN only — the single definition ignores stale option
 * instructions on other types, and so does the prompt enumeration); `bytes` =
 * total UTF-8 bytes of every counted instruction. */
function instructionAggregate(categories: readonly AiGenerationSnapshotCategory[]): {
  bytes: number;
  entries: number;
} {
  let bytes = 0;
  let entries = 0;
  for (const cat of categories) {
    if (cat.auto_instruction) {
      entries += 1;
      bytes += Buffer.byteLength(cat.auto_instruction, 'utf8');
    }
    if (cat.type !== 'DROPDOWN') continue;
    for (const opt of cat.dropdown_options) {
      if (!opt.auto_instruction) continue;
      entries += 1;
      bytes += Buffer.byteLength(opt.auto_instruction, 'utf8');
    }
  }
  return { bytes, entries };
}

function filterGenerationCategories(
  categories: readonly AiGenerationSnapshotCategory[],
  selection: EventGenerateBody['selection'],
): AiGenerationSnapshotCategory[] {
  if (!selection || selection.length === 0) return [...categories];

  const buttonIds = new Set(
    selection
      .filter((entry) => entry.option_label === undefined || entry.option_label === null)
      .map((entry) => entry.category_id),
  );
  const optionLabelsByCategory = new Map<string, Set<string>>();
  for (const entry of selection) {
    if (typeof entry.option_label !== 'string') continue;
    const labels = optionLabelsByCategory.get(entry.category_id) ?? new Set<string>();
    labels.add(entry.option_label);
    optionLabelsByCategory.set(entry.category_id, labels);
  }

  return categories.flatMap((category): AiGenerationSnapshotCategory[] => {
    const { auto_instruction: autoInstruction, ...base } = category;
    const selectedLabels = optionLabelsByCategory.get(category.id);
    const dropdownOptions =
      category.type === 'DROPDOWN' && selectedLabels
        ? category.dropdown_options.filter(
            (option) => selectedLabels.has(option.label) && Boolean(option.auto_instruction),
          )
        : [];
    const filtered: AiGenerationSnapshotCategory = {
      ...base,
      ...(buttonIds.has(category.id) && autoInstruction
        ? { auto_instruction: autoInstruction }
        : {}),
      dropdown_options: dropdownOptions,
    };
    return categoryIsInstructionBearing(filtered) ? [filtered] : [];
  });
}

/** Project the session's COMPLETE existing events for the snapshot categories
 * into the message builder's dedup-basis shape, in the feed's order
 * (`wall_time_utc ASC, id ASC`). Timecodes arrive already rendered by
 * `eventRowToRpc`'s `formatSmpte` path — the same rendering every event read
 * surface serves; `isAuto` reads `metadata_json.auto_generated`. */
function existingEventsForGenerate(
  events: readonly EventRpc[],
  categoryIds: ReadonlySet<string>,
): Record<string, EventGenerateExistingEvent[]> {
  const byCategory: Record<string, EventGenerateExistingEvent[]> = {};
  const sorted = [...events].sort((a, b) => {
    if (a.wall_time_utc !== b.wall_time_utc) return a.wall_time_utc < b.wall_time_utc ? -1 : 1;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  for (const e of sorted) {
    if (!categoryIds.has(e.category)) continue;
    let isAuto = false;
    try {
      const meta = JSON.parse(e.metadata_json || '{}') as Record<string, unknown> | null;
      isAuto = meta !== null && typeof meta === 'object' && meta.auto_generated === true;
    } catch {
      isAuto = false;
    }
    const rows = byCategory[e.category] ?? [];
    byCategory[e.category] = rows;
    rows.push({
      timecode: e.timecode ?? '',
      message: e.message,
      isAuto,
    });
  }
  return byCategory;
}

eventsRouter.post('/api/sessions/:sessionId/events/generate', async (c) => {
  const sessionId = c.req.param('sessionId');
  // 1. Session resolution — unknown/out-of-studio masks as 404 before any
  // configuration state below can leak (sibling-route pattern).
  const row = requireSession(c, sessionId);
  const rawBody = await c.req.text();
  const parsedBody = eventGenerateBodySchema.safeParse(
    rawBody.trim() === '' ? {} : JSON.parse(rawBody),
  );
  if (!parsedBody.success) {
    throw new ApiError(400, 'Invalid event generation request.');
  }
  const body = parsedBody.data;

  // 2 + 3. Configuration gate + open-network refusal — both 503, before any
  // spawn (a run spends the operator's Anthropic budget and writes into the
  // session).
  if (!aiChatConfigured(c.env.config)) {
    throw new ApiError(503, EVENT_GENERATE_NOT_CONFIGURED_DETAIL);
  }
  if (aiChatOpenNetworkRefused(c.env.config)) {
    throw new ApiError(503, EVENT_GENERATE_OPEN_NETWORK_DETAIL);
  }

  // 4. Anchored-transcript precondition — a run without session-time anchors
  // could only invent timecodes. This read doubles as the run's WORD SNAPSHOT
  // (spec "snapshot at run start"; Phase-3 review carry): no `await` occurs
  // between here and the turn registration, so nothing can interleave.
  const transcriptWords = getSessionHub(c, sessionId).listTranscriptWords();
  if (transcriptWords.length === 0) {
    throw new ApiError(400, EVENT_GENERATE_NO_TRANSCRIPT_DETAIL);
  }
  if (!transcriptWords.some((w) => String(w.session_time ?? '').trim() !== '')) {
    throw new ApiError(400, EVENT_GENERATE_NO_ANCHORS_DETAIL);
  }

  // 5. Instruction-bearing categories (the single imported definition, never
  // re-derived) — a show with none has nothing to detect.
  const catalog = c.get('catalog');
  const rawCategories = catalog.sessions.getSessionShowCategories(sessionId)?.categories ?? [];
  const bearing = rawCategories.filter(categoryIsInstructionBearing);
  if (bearing.length === 0) {
    throw new ApiError(400, EVENT_GENERATE_NO_INSTRUCTIONS_DETAIL);
  }
  const categories = filterGenerationCategories(
    bearing.map(toGenerationSnapshotCategory),
    body.selection,
  );
  if ((body.selection?.length ?? 0) > 0 && categories.length === 0) {
    throw new ApiError(400, EVENT_GENERATE_NO_INSTRUCTIONS_DETAIL);
  }

  // 6. Aggregate pre-spawn instruction bound (design D8) — either half
  // tripping fails fast, before the CLI ever spawns.
  const { bytes, entries } = instructionAggregate(categories);
  const maxBytes = eventGenerateMaxInstructionBytes(c.env.config);
  const maxEntries = eventGenerateMaxInstructionEntries(c.env.config);
  if (bytes > maxBytes || entries > maxEntries) {
    throw new ApiError(
      400,
      `The show's generation instructions exceed the configured bound (${bytes} instruction bytes vs max ` +
        `${maxBytes}; ${entries} instruction-bearing entries vs max ${maxEntries}). Shorten or remove some ` +
        'instructions, or raise EVENT_GENERATE_MAX_INSTRUCTION_BYTES / EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES.',
    );
  }

  // 7. Single-flight (per session) + process-wide ceiling — 409, spawning
  // nothing. Same registry as AI chat/AI v2/topics; released in this
  // handler's own finally (release BEFORE the projection — see the finally).
  const slot = aiChatTurns.tryAcquire(sessionId, aiChatMaxConcurrent(c.env.config));
  if (!slot.ok) {
    throw new ApiError(
      409,
      slot.reason === 'session-busy'
        ? EVENT_GENERATE_SESSION_BUSY_DETAIL
        : EVENT_GENERATE_AT_CAPACITY_DETAIL,
    );
  }

  try {
    const hub = getSessionHub(c, sessionId);
    const deleted = body.regenerate === true ? hub.deleteAutoGeneratedEvents() : undefined;

    // The RUN SNAPSHOT (spec "Single orchestrator turn"; ledger registration
    // shape), built ONCE pre-spawn. The SAME object feeds both the MCP turn
    // registration (create_event's allowlist/cap/anchoring inputs + the
    // rendering's word snapshot) and the message builder's enumeration —
    // mid-run show/session edits cannot affect the in-flight run.
    const ctx = timecodeCtx(row);
    const cap = eventGenerateMaxCreatedEvents(c.env.config);
    const generation: AiGenerationRunContext = {
      runId: crypto.randomUUID(),
      frameRate: ctx.frameRate,
      startOffsetFrames: ctx.startOffsetFrames,
      startedAtUtc: String(row.started_at_utc ?? ''),
      cap,
      categories,
      words: transcriptWords.map((w) => ({
        word: String(w.word ?? ''),
        session_time: String(w.session_time ?? ''),
        speaker: String(w.speaker ?? ''),
      })),
    };
    const message = buildEventGenerateMessage({
      categories,
      existingEventsByCategoryId: existingEventsForGenerate(
        hub.exportEvents(),
        new Set(categories.map((cat) => cat.id)),
      ),
    });

    const outcome = await driveAiTurn({
      registry: c.env.ports.sessions,
      cliPath: c.env.config.CLAUDE_CLI_PATH.trim(),
      sessionId,
      message,
      systemPrompt: EVENT_GENERATE_SYSTEM_PROMPT,
      allowedTools: EVENT_GENERATE_ALLOWED_TOOLS,
      mcpContext: { tools: EVENT_GENERATE_ALLOWED_TOOLS, generation },
      maxBudgetUsd: eventGenerateMaxBudgetUsd(c.env.config),
      timeoutMs: eventGenerateTimeoutSec(c.env.config) * 1000,
      emit: () => {},
      // NO abortSignal — spec: a run always completes server-side regardless
      // of the initiating client's connection (the topics/generate D2
      // precedent); events land via event.changed broadcasts either way.
    });

    if (outcome.ok) {
      return c.json({
        created: outcome.createdEvents,
        cap_hit: outcome.createdEvents >= cap,
        ...(deleted === undefined ? {} : { deleted }),
      });
    }
    // Operator-facing diagnostic only — the 502 body stays a fixed opaque
    // string carrying no raw subprocess output and NO created-count (spec:
    // events inserted before the failure persist and are reported nowhere in
    // the error body).
    console.warn(
      `[events/generate] session=${sessionId}: generation failed — CLI turn failed (${outcome.detail})`,
    );
    throw new ApiError(502, EVENT_GENERATE_FAILURE_DETAIL);
  } finally {
    // Slot release FIRST, unconditionally (Phase-4 review): a throw from the
    // hub re-acquire/ensure() or the catalog UPDATE below must never leak the
    // per-session slot — a leaked slot wedges every later AI turn for this
    // session behind a 409 until restart. Releasing before the mirror is safe:
    // both statements are synchronous (no await), so no other request can
    // interleave between them.
    slot.release();
    // Post-run catalog mirror on success AND failure paths (spec "the run
    // SHALL leave the catalog projection current by the time the route
    // responds") — the run's inserts persist either way. The hub is
    // RE-ACQUIRED after the potentially multi-minute turn (idle hubs close
    // their DB handles and reopen lazily).
    catalog.sessions.projectSessionLive(sessionId, getSessionHub(c, sessionId).ensure());
  }
});

eventsRouter.put('/api/sessions/:sessionId/events/:eventId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const eventId = c.req.param('eventId');
  const row = requireSession(c, sessionId);
  const body = eventUpdateBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  const profile = catalog.sessions.studioProfileForSession(sessionId);
  const catDef = profile.categories.find((cat) => cat.id === body.category) ?? null;
  if (catDef === null) throw new ApiError(400, 'Unknown category for this studio profile.');
  const dt = parseOptionalMarkedAt(body.wall_time_utc);
  if (dt === null) throw new ApiError(400, 'wall_time_utc is required.');
  const parts = body.timecode_hms.split(':');
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) {
    throw new ApiError(400, 'timecode_hms must be HH:MM:SS.');
  }
  const [hh, mm, ss] = parts.map((x) => Number(x));
  if (mm > 59 || ss > 59 || hh < 0) throw new ApiError(400, 'Invalid timecode_hms.');
  const fps = Math.round(Number(row.frame_rate));
  const totalFrames = (hh * 3600 + mm * 60 + ss) * fps;

  const hub = getSessionHub(c, sessionId);
  const old = hub.getEvent(eventId);
  if (old === null) throw new ApiError(404, 'Event not found.');
  let oldMeta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(old.metadata_json || '{}');
    if (parsed && typeof parsed === 'object') oldMeta = parsed as Record<string, unknown>;
  } catch {
    oldMeta = {};
  }
  let meta = { ...oldMeta };
  // FROZEN edge (api-contract-freeze): this `internal` branch is REACHABLE, not
  // dead — category-id validation (validateCategoriesList) reserves no ids, so
  // a studio profile MAY define a category whose id case-insensitively equals
  // 'internal'; the profile-membership 400 above then passes and this branch
  // strips the UI snapshots. The PUT-vs-POST asymmetry is deliberate frozen
  // behavior: POST admits the built-in 'internal' category even when the
  // profile does not define it, PUT requires profile membership first. Do not
  // remove this branch as dead code, and do not align PUT to POST — either is
  // an observable contract change (pinned by events.putInternal.int.test.ts).
  if (body.category.toLowerCase() === 'internal') meta = stripCategoryUiSnapshots(meta);
  else meta = mergeCategoryUiSnapshotsIntoMetadata(meta, catDef);

  const result = hub.updateEvent({
    eventId,
    category: body.category,
    message: body.message,
    wallTimeUtc: dt,
    timecodeTotalFrames: totalFrames,
    metadataJson: JSON.stringify(meta),
  });
  if (result === null) throw new ApiError(404, 'Event not found.');
  catalog.sessions.projectSessionLive(sessionId, result.projection);
  return c.json(enrichEventRpc(result.event, profile));
});

eventsRouter.delete('/api/sessions/:sessionId/events/:eventId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const eventId = c.req.param('eventId');
  requireSession(c, sessionId);
  const { ok, projection } = getSessionHub(c, sessionId).deleteEvent(eventId);
  if (!ok) throw new ApiError(404, 'Event not found.');
  c.get('catalog').sessions.projectSessionLive(sessionId, projection);
  return c.json({ ok: true });
});

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
