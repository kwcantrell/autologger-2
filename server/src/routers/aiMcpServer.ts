// ai-topics-chat (design D3) — the in-process, loopback-only MCP listener.
//
// This is the transport/auth/registration SEAM for the session-scoped MCP
// toolset. It runs INSIDE the existing Node process (single-process invariant
// holds — a second listener, not a second process), bound to 127.0.0.1 on an
// ephemeral port, speaking Streamable HTTP via `@modelcontextprotocol/sdk`.
//
// Security posture (D3, the deliberate loopback invariant — mirror of the Vite
// `server.host` pin):
//   - NEVER binds a non-loopback address (hardcoded 127.0.0.1). "Helpfully"
//     binding it to LAN, or folding it onto the public :8787 app, re-opens
//     exactly the surface this design closes.
//   - Each chat turn registers with a per-turn ≥128-bit bearer token; the token
//     is validated AT THE HTTP LAYER, before any transport dispatch. An unknown
//     or dropped token gets 401 and never reaches the MCP transport.
//   - The autologger :sessionId a turn operates on is bound by the turn
//     REGISTRATION (token → sessionId), never by a tool parameter — the model
//     cannot address another session.
//   - Concurrent turns share the one listener via per-connection (per-request)
//     transport instantiation, so two turns on distinct sessions never share
//     transport state.
//   - Tool bodies resolve the hub at CALL TIME (`registry.get(sessionId)`),
//     never holding a handle across an await, so the idle-eviction sweeper can't
//     close it underneath a long turn.
//
// This listener is loopback-internal infrastructure — it adds NOTHING to the
// public :8787 HTTP/WS contract.
//
// Scope: this file owns the listener + registration + bearer/session resolution
// (task 2.1) AND the session-scoped MCP toolset (task 2.2) — the tool bodies
// in `TOOL_BUILDERS`: `get_transcript_words` and `list_topics`
// read hub rows at call time; `create_topic` validates with `topicCreateSchema`
// and writes through the transactional `SessionHub.insertTopic` path;
// `create_event` (auto-generate-event-logs task 3.2, design D4) writes a
// transcript-anchored event through the transactional `SessionHub.addEvent`
// explicit-anchor path, gated by the generation run snapshot.
// Registration is PER TURN (auto-generate-event-logs D6): each turn's
// registration carries its tool set, plus — on a turn that reads the
// transcript at generation density — a word snapshot (the event run's
// `generation.words`, or the topic one-shot's `pagedWords`;
// topic-generate-paged-transcript D1) whose pagination and served-page
// bookkeeping live on the registration. `buildSessionMcpServer` registers only
// that tool set — chat passes its three tools explicitly (D7, task 3.4), a
// context-less turn still gets the pinned default three, and either way a chat
// turn can never reach `create_event`.

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { topicCreateSchema } from '../schemas';
import { timecodeWallAnchors, wallTimeUtcForTimecode } from '../session/eventAnchors';
import type { SessionHubRegistry } from '../session/SessionHub';
import {
  type CategoryDef,
  type CategoryKind,
  mergeCategoryUiSnapshotsIntoMetadata,
} from '../studio';
import { parseTimecodeString, toTotalFrames } from '../timecode';

const LOOPBACK = '127.0.0.1';
const MCP_PATH = '/mcp';
/** 32 bytes = 256 bits, comfortably over the ≥128-bit requirement (D3). */
const TOKEN_BYTES = 32;
const BEARER_PREFIX = 'Bearer ';

/** MCP server name — tool wire names are `mcp__autologger__<tool>` (spec). */
const MCP_SERVER_NAME = 'autologger';

/** The registry of tool short names exposed to the model (spec: Session-scoped
 * MCP toolset + auto-generate-event-logs `create_event`). Wire names are
 * `mcp__${MCP_SERVER_NAME}__${name}`. Growing this list NEVER widens a chat
 * turn — see `DEFAULT_TURN_TOOLS`. */
export const AI_MCP_TOOL_NAMES = [
  'get_transcript_words',
  'list_topics',
  'create_topic',
  'create_event',
] as const;

/** One of the short tool names above — the type callers use to
 * restrict `--allowedTools` for a turn (topic-generation design D7/D3). */
export type AiMcpToolName = (typeof AI_MCP_TOOL_NAMES)[number];

/** The DEFAULT tool set for a context-less turn registration — pinned
 * explicitly to today's three chat tools, deliberately NOT derived from
 * `AI_MCP_TOOL_NAMES`: when the registry grows (`create_event`,
 * auto-generate-event-logs D6/D7), a turn that passes no context must keep
 * registering exactly these three, byte-identical to today. */
const DEFAULT_TURN_TOOLS: readonly AiMcpToolName[] = [
  'get_transcript_words',
  'list_topics',
  'create_topic',
];

/** One dropdown option in a generation run's category snapshot
 * (auto-generate-event-logs D6) — label + `needs_context` + optional
 * per-option instruction, mirroring the normalized `DropdownOptionRecord`. */
export interface AiGenerationSnapshotOption {
  readonly label: string;
  readonly needs_context: boolean;
  readonly auto_instruction?: string;
}

/** One instruction-bearing category in a generation run's snapshot
 * (auto-generate-event-logs D6): the fields `create_event` (task 3.2) needs
 * for its allowlist check and metadata UI snapshots, frozen at run start. */
export interface AiGenerationSnapshotCategory {
  readonly id: string;
  readonly name: string;
  readonly type: CategoryKind;
  readonly color: string;
  readonly auto_instruction?: string;
  readonly dropdown_options: readonly AiGenerationSnapshotOption[];
}

/** One transcript-word row in a generation run's word snapshot
 * (auto-generate-event-logs task 4.3, Phase-3 review carry): exactly the
 * fields the generation-density rendering reads. */
export interface AiGenerationSnapshotWord {
  readonly word: string;
  readonly session_time: string;
  readonly speaker: string;
}

/** A generation run's per-turn snapshot (auto-generate-event-logs spec
 * "Single orchestrator turn"): captured at run start and CARRIED on the turn
 * registration so mid-run show/session edits never affect the in-flight run.
 * The registration only carries it — `create_event` (task 3.2) consumes it. */
export interface AiGenerationRunContext {
  /** Per-run id, stamped into each generated event's metadata. */
  readonly runId: string;
  /** Session frame rate at run start (timecode parsing/arithmetic). */
  readonly frameRate: number;
  /** Session start-offset in frames at run start (zero-anchor fallback). */
  readonly startOffsetFrames: number;
  /** Session `started_at_utc` at run start (zero-anchor fallback). */
  readonly startedAtUtc: string;
  /** Per-run created-events cap (ceiling; counting is 3.2's concern). */
  readonly cap: number;
  /** The instruction-bearing categories — `create_event`'s allowlist. */
  readonly categories: readonly AiGenerationSnapshotCategory[];
  /** Transcript words frozen at run start (task 4.3, Phase-3 review carry —
   * BINDING): when present, the generation-density `get_transcript_words`
   * rendering reads THIS snapshot instead of the live hub, so a concurrent
   * transcript regeneration cannot reshuffle the paged rendering (content or
   * page boundaries) mid-run. Absent ⇒ live hub read (3.3's behavior). */
  readonly words?: readonly AiGenerationSnapshotWord[];
}

/** Per-turn registration context (auto-generate-event-logs D6): the turn's
 * tool set, plus at most ONE transcript word snapshot — the event run's
 * (`generation.words`) or the topic one-shot's (`pagedWords`;
 * topic-generate-paged-transcript D1). `ai/chat` and `topics/generate` pass
 * explicit `{tools}` matching their argv allowlists (D7, task 3.4); a
 * context-less registration still gets the pinned default three chat tools. */
export interface AiMcpTurnContext {
  /** Tool names the per-request MCP server registers for this turn — and
   * ONLY these; anything else in the registry is denied at the server. */
  readonly tools: readonly AiMcpToolName[];
  /** The EVENT run's snapshot — present on event-generation turns only, and
   * the only carrier of event-run fields (`create_event`'s allowlist, cap,
   * frame rate, run id). It is no longer the sole key for paged transcript
   * delivery: `pagedWords` below keys it for turns that have no event run. */
  readonly generation?: AiGenerationRunContext;
  /** SEAM (topic-generate-paged-transcript D1) — the turn's paged-transcript
   * word snapshot, carrying ONLY words: the session's COMPLETE transcript word
   * list, captured by the caller and materialized as an immutable fresh copy
   * synchronously — before the caller's first `await` — so later transcript
   * mutation can reach neither it nor this run's page boundaries, and
   * projected to the 3-field
   * `AiGenerationSnapshotWord` shape. Its presence KEYS the paged
   * generation-density `get_transcript_words` rendering on a turn that has no
   * event-generation run (the topic one-shot), and the page-coverage
   * bookkeeping below counts pages of THIS list and no other.
   *
   * Chat turns SHALL NOT carry it (spec `ai-topics-chat`, "Chat turns keep the
   * unpaged rendering"): a chat registration keeps the zero-arg compact
   * rendering. It carries no event-run fields, and `create_event` registration
   * stays keyed by `tools`, never by a snapshot's presence. */
  readonly pagedWords?: readonly AiGenerationSnapshotWord[];
}

/** How much of a turn's transcript snapshot the model actually fetched
 * (topic-generate-paged-transcript D6) — mechanical page bookkeeping the
 * server owns, never model-output inference. `totalPages` is 0 for a
 * registration with no word snapshot (chat turns, and generation turns reading
 * the live hub): such a turn makes no coverage claim and can never fail the
 * gate. `servedPages` counts DISTINCT snapshot pages actually returned to the
 * model — a repeated page counts once, and an out-of-range page (a tool error)
 * counts not at all. */
export interface AiMcpPageCoverage {
  readonly totalPages: number;
  readonly servedPages: number;
}

/** The page-coverage gate (D6): did the run fetch EVERY page of its snapshot?
 * Served pages are always a subset of `0..totalPages-1`, so equality is full
 * coverage; a snapshot-less turn (`totalPages` 0) trivially passes. */
export function allTranscriptPagesServed(coverage: AiMcpPageCoverage): boolean {
  return coverage.servedPages >= coverage.totalPages;
}

/** A registered chat turn's MCP coordinates. The CLI runner (task 3.2) consumes
 * this: `url` + `token` build the generated `--mcp-config`, and `dispose()` is
 * called in the turn's `finally` to drop the registration + retire the token. */
export interface AiMcpTurn {
  /** Loopback URL (127.0.0.1 + ephemeral port + /mcp) for `--mcp-config`. */
  readonly url: string;
  /** Per-turn bearer token (≥128-bit), sent as `Authorization: Bearer <token>`
   * and validated at the HTTP layer before dispatch. */
  readonly token: string;
  /** Events created by this turn's `create_event` calls so far
   * (auto-generate-event-logs task 3.2): ONE mutable counter per turn
   * registration — never global — incremented only on successful insert. The
   * generate route (task 4.3) reads it after the run to report
   * `{created, cap_hit}`. Always 0 on chat turns. */
  createdEvents(): number;
  /** How many pages of this turn's transcript snapshot the model has been
   * served, against the snapshot's total (topic-generate-paged-transcript D6).
   * Same ONE-counter-per-registration discipline as `createdEvents`; the
   * `topics/generate` route reads it after the run to decide whether the
   * crash-safe swap may replace the prior topic set. `{totalPages: 0}` on any
   * registration without a word snapshot (every chat turn). */
  pageCoverage(): AiMcpPageCoverage;
  /** Drop the registration (idempotent). After this, the token gets 401. */
  dispose(): void;
}

/** The turn's mutable paged-transcript state (D1/D6). Lives on the
 * REGISTRATION — the per-request MCP servers a turn builds share it, which is
 * what makes both the pagination memo and the served-page set span a turn's
 * calls instead of resetting on every HTTP request. */
interface TurnPageState {
  /** The registration's word snapshot (`generation.words ?? pagedWords`), or
   * undefined for chat turns and snapshot-less generation turns (live hub). */
  readonly words: readonly AiGenerationSnapshotWord[] | undefined;
  /** Lazily memoized pagination of `words` — computed at most once per turn
   * (the snapshot is immutable), never re-packed per page call. */
  pages: readonly string[] | null;
  /** DISTINCT snapshot page indices actually served (D6's coverage counter). */
  readonly served: Set<number>;
}

interface TurnRegistration {
  readonly sessionId: string;
  /** Per-turn context (D6); undefined ⇒ default chat tool set, no snapshot. */
  readonly context: AiMcpTurnContext | undefined;
  /** The turn's mutable created-events counter (task 3.2). Lives on the
   * REGISTRATION — per-request MCP servers share it across a turn's calls. */
  readonly createdEvents: { count: number };
  /** The turn's paged-transcript memo + coverage counter (D1/D6). */
  readonly pageState: TurnPageState;
}

/** The registration's memoized pagination of its word snapshot — packed on
 * first need (a tool call, or the end-of-run coverage read on a turn that never
 * called the tool) and reused thereafter. */
function snapshotPages(state: TurnPageState): readonly string[] {
  if (state.words === undefined) return [];
  state.pages ??= paginateGenerationTranscript(state.words);
  return state.pages;
}

/**
 * The `create_topic` parameter surface advertised to the model. This declares
 * only field NAMES/TYPES for discoverability — the authoritative BOUNDS
 * (`session_time` ≤ 20, `duration_sec` ≥ 0, `topic_level` 1–10 int, `summary`
 * ≤ 8000) are NOT re-derived here: they live solely in `topicCreateSchema`,
 * applied inside the handler so a violation returns an `isError` tool result to
 * the model rather than a thrown JSON-RPC error (SDK schema validation throws
 * `McpError` before the handler runs — spec: "a violation SHALL return a tool
 * error to the model, no insert, no crash"). Fields are optional because
 * `topicCreateSchema` defaults each one.
 */
const createTopicToolShape = {
  session_time: z
    .string()
    .optional()
    .describe('Timecode into the session, HH:MM:SS-style (≤ 20 chars).'),
  duration_sec: z.number().optional().describe('Topic duration in seconds (≥ 0).'),
  topic_level: z.number().optional().describe('Topic depth/level, integer 1–10.'),
  summary: z.string().optional().describe('Concise topic summary (≤ 8000 chars).'),
};

/**
 * The `create_event` parameter surface advertised to the model (task 3.2).
 * Same discipline as `createTopicToolShape`: names/types only, all optional —
 * the authoritative bounds live in `createEventArgsSchema`, applied inside the
 * handler so a violation returns an `isError` tool result instead of an
 * SDK-thrown `McpError` (spec: tool error, no insert, no crash). No session
 * parameter exists — the session is bound by the turn registration.
 */
const createEventToolShape = {
  category: z
    .string()
    .optional()
    .describe("Category id — must be one of this generation run's allowed category ids."),
  message: z.string().optional().describe('Event message text (1–8000 chars).'),
  session_time: z
    .string()
    .optional()
    .describe(
      'Session timecode: HH:MM:SS, HH:MM:SS:FF, or drop-frame HH:MM:SS;FF — ' +
        'echo the form the transcript rendering shows.',
    ),
};

/** Handler-side bounds for `create_event` (task 3.2): `category` and
 * `message` MIRROR the manual log path's `logBodySchema` fields (min 1 /
 * max 200 and min 1 / max 8000, no trimming — the manual path applies none).
 * The `session_time` GRAMMAR and timecode bounds are owned by
 * `parseTimecodeString`, not re-derived in zod. */
const createEventArgsSchema = z.object({
  category: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
  session_time: z.string().min(1),
});

/** An `isError` tool result — the never-throw shape every `create_event`
 * failure path returns to the model (the run continues; nothing is inserted). */
function toolError(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Build the per-request McpServer bound to one autologger session, registering
 * ONLY the turn's tool set (auto-generate-event-logs D6; no context ⇒ the
 * default three chat tools). Every tool resolves the hub at call time via the
 * registry (never held across an await, so the idle-eviction sweeper can't
 * close it underneath a long turn) and can address ONLY `sessionId` — no tool
 * parameter names a session.
 *
 * `get_transcript_words` / `list_topics` return the hub row fields verbatim;
 * `get_transcript_words` therefore OMITS the per-word `session_id` the HTTP read
 * surface adds (redundant here — the session is fixed by the registration).
 * `create_topic` validates with `topicCreateSchema` and writes through the
 * transactional, ordinal-assigning `SessionHub.insertTopic` — the identical code
 * path a manual insert takes (no WS emission: topics have none).
 */
/** Render transcript words as compact, readable text for the model. Groups
 * consecutive words by speaker into lines, each prefixed with the segment's
 * first available timecode (`[HH:MM:SS] speaker N: words…`). Empty timecodes
 * (anchorless transcripts) and blank speakers are omitted from the prefix. A
 * ~20x reduction vs `JSON.stringify(words)`, which kept the model from ever
 * reading a real (multi-thousand-word) transcript. */
function formatTranscriptForModel(
  words: Array<{ word: string; session_time: string; speaker: string }>,
): string {
  if (words.length === 0) return '(this session has no transcript)';
  const lines: string[] = [];
  let curSpeaker: string | null = null;
  let segTime = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const timePrefix = segTime ? `[${segTime}] ` : '';
    const speakerPrefix = curSpeaker ? `speaker ${curSpeaker}: ` : '';
    lines.push(`${timePrefix}${speakerPrefix}${buf.join(' ')}`.trim());
    buf = [];
  };
  for (const w of words) {
    const speaker = w.speaker ?? '';
    if (speaker !== curSpeaker) {
      flush();
      curSpeaker = speaker;
      segTime = w.session_time || '';
    } else if (!segTime && w.session_time) {
      segTime = w.session_time;
    }
    buf.push(w.word);
  }
  flush();
  return lines.join('\n');
}

// ── Generation-density paged rendering (auto-generate-event-logs 3.3, D5) ──
//
// The chat rendering above collapses a single-speaker session to ONE
// timestamp (one anchor per speaker turn), which makes per-utterance event
// placement impossible. For GENERATION-DENSITY turns — event generation and
// the topic one-shot (topic-generate-paged-transcript D1), the two consumers
// of this one shared pager — `get_transcript_words` instead renders a new
// anchored line at every speaker change AND every ≤ N words, and pages
// deterministically on line boundaries once a page would exceed the hard
// rendered-size cap below — never silently truncated. Chat turns keep
// `formatTranscriptForModel` byte-identical.

/** N — max words per rendered line (spec: "bounded word count", small enough
 * that an utterance can be placed to within a few seconds: at ~150 wpm,
 * 10 words ≈ 4 seconds). N drives the LINE shape only; what bounds a page is
 * `GENERATION_PAGE_MAX_CHARS` below, since a smaller N means more anchored
 * lines and so more rendered chars for the same words. */
export const GENERATION_LINE_MAX_WORDS = 10;

/** SECONDARY page bound in WORDS for generation-density paging, split on line
 * boundaries (topic-generate-paged-transcript D4 demoted it: the primary bound
 * is the rendered-size cap below). Retained so a page of very short lines is
 * still bounded in words, not only in chars; on realistic and adversarial
 * fixtures alike the char cap binds first. A word cap can never be a size
 * bound on its own — see `GENERATION_PAGE_MAX_CHARS`. */
export const GENERATION_PAGE_SIZE_WORDS = 8000;

/** HARD cap on ONE rendered page's size in CHARACTERS, marker line included
 * (topic-generate-paged-transcript D4) — the primary page bound; the word cap
 * above is retained only as a secondary bound.
 *
 * A word-count cap is not a size bound: each anchored line carries a
 * fixed-size `[<time>] speaker <S>: ` prefix and a new line starts at every
 * speaker change, so rendered chars per word are unbounded under diarization
 * churn (measured: a speaker-flip-every-word page renders ~5x a realistic
 * one at the same word count). Both generation-density consumers therefore
 * pack by rendered size.
 *
 * 45,000 sits under the Claude CLI's STABLE 50,000-char short-circuit, below
 * which it accepts an MCP tool result unconditionally (its `len/4` estimator
 * against the tool-output token cap). Above that threshold the CLI calls the
 * real token counter and, over the cap, diverts the payload to a file the
 * tool-locked one-shots cannot read — and that token cap is remotely
 * configurable, so the char threshold is the only guarantee worth sizing to
 * (read from CLI 2.1.220; re-check on a CLI bump). */
export const GENERATION_PAGE_MAX_CHARS = 45_000;

/** The trailing continuation-marker line (its leading newline included) — the
 * ONLY marker a rendered page may contain (body lines are neutralized). */
function continuationMarker(nextPage: number, totalPages: number): string {
  return `\n--- transcript continues: call get_transcript_words with page=${nextPage} of ${totalPages} ---`;
}

/** Chars the packer holds back from the body so a page STAYS under the cap
 * once its marker is appended. Page numbers are not known while packing (they
 * depend on the packing), so the reserve is the marker's width at absurdly
 * large page numbers — an over-estimate by a few chars on every real page,
 * which is the safe direction. */
const CONTINUATION_MARKER_RESERVE = continuationMarker(9_999_999_999, 9_999_999_999).length;

/** Rewrite any run of 3+ hyphens in rendered body text so it can never
 * contain the continuation marker's `---` sentinel (D5) — the marker is
 * trustworthy FRAMING, not data the transcript can reproduce.
 *
 * Transcript text is untrusted third-party input: DeepGram output of arbitrary
 * audio, YouTube imports, and direct transcript-word CRUD that restricts
 * neither charset nor word shape (a "word" may be thousands of chars,
 * newlines included). Without this, a spoken or pasted marker line could tell
 * the model it had reached the end of the transcript pages early. Mirrors
 * `eventGeneratePrompt.ts`'s `neutralizeDelimiterTokens` for its own `<<<…>>>`
 * sentinel — same discipline, different sentinel, so the two stay separate.
 * Content is preserved (the model is meant to read it); only the sentinel is
 * defanged, and ordinary hyphenation (`well-known`, `pause--then`) is
 * untouched. */
function neutralizeMarkerTokens(text: string): string {
  return text.replace(/-{3,}/g, '--');
}

/** One generation-density line + its word count (paging splits on lines). */
interface GenerationLine {
  readonly text: string;
  readonly wordCount: number;
}

/** Build generation-density lines: flush at every speaker change AND when the
 * current line reaches `GENERATION_LINE_MAX_WORDS`. Each line is prefixed
 * `[<time>] speaker <S>: ` using the FIRST anchored word's `session_time` in
 * THAT line; words with empty `session_time` never get an invented timestamp
 * (a line whose words are all unanchored renders un-prefixed), and a blank
 * speaker omits the speaker prefix — both matching the chat rendering's
 * prefix conventions. */
function generationDensityLines(
  words: ReadonlyArray<{ word: string; session_time: string; speaker: string }>,
): GenerationLine[] {
  const lines: GenerationLine[] = [];
  let curSpeaker: string | null = null;
  let lineTime = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const timePrefix = lineTime ? `[${lineTime}] ` : '';
    const speakerPrefix = curSpeaker ? `speaker ${curSpeaker}: ` : '';
    lines.push({
      // Neutralized over the WHOLE composed line: the word text, the speaker,
      // and the session_time are all untrusted (the renderer's own literals
      // carry no hyphens, so this can only ever touch transcript content).
      text: neutralizeMarkerTokens(`${timePrefix}${speakerPrefix}${buf.join(' ')}`.trim()),
      wordCount: buf.length,
    });
    buf = [];
    lineTime = '';
  };
  for (const w of words) {
    const speaker = w.speaker ?? '';
    if (speaker !== curSpeaker) {
      flush();
      curSpeaker = speaker;
    } else if (buf.length >= GENERATION_LINE_MAX_WORDS) {
      flush();
    }
    if (buf.length === 0) {
      lineTime = w.session_time || '';
    } else if (!lineTime && w.session_time) {
      lineTime = w.session_time;
    }
    buf.push(w.word);
  }
  flush();
  return lines;
}

/** Split any line wider than `bodyCap` HARD at the cap (D4) so a single
 * pathological line can never render an over-cap page — a transcript "word"
 * is untrusted input with no length or charset restriction, and one 100k-char
 * word is one line. Chunks after the first carry zero words: the word cap is
 * secondary and the char cap already bounds these pages. Lines within the cap
 * pass through untouched, so ordinary transcripts are unaffected. */
function splitOverCapLines(lines: GenerationLine[], bodyCap: number): GenerationLine[] {
  if (lines.every((l) => l.text.length <= bodyCap)) return lines;
  const out: GenerationLine[] = [];
  for (const line of lines) {
    if (line.text.length <= bodyCap) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < line.text.length; i += bodyCap) {
      out.push({
        text: line.text.slice(i, i + bodyCap),
        wordCount: i === 0 ? line.wordCount : 0,
      });
    }
  }
  return out;
}

/** The rendered result of ONE page request. */
type GenerationPageResult =
  | { ok: true; text: string; totalPages: number }
  | { ok: false; error: string };

function invalidPageError(page: number): string {
  return `Invalid page ${page}: expected a non-negative integer.`;
}

/**
 * Paginate the whole generation-density rendering into EVERY page's final
 * text, continuation marker included on all pages but the last (task 3.3,
 * design D5; packed by rendered size in topic-generate-paged-transcript D4).
 * Deterministic: a pure function of the word list, so repeated calls compute
 * identical boundaries. Pages are packed greedily on LINE boundaries to the
 * `maxPageChars` rendered-size cap — the primary bound, applied to the page AS
 * THE MODEL RECEIVES IT (the packer reserves the trailing marker's width out
 * of the body) — with `pageSizeWords` retained as a secondary bound. A page
 * always takes at least one line, a line wider than the cap is split hard at
 * it, and the result always has at least one page (an empty transcript renders
 * the placeholder as its single page).
 *
 * Whole-transcript pagination is the unit a turn registration MEMOIZES
 * (topic-generate-paged-transcript D1): a snapshot-backed registration packs
 * once and then serves page N by index, instead of re-packing the transcript
 * on every tool call.
 */
function paginateGenerationTranscript(
  words: ReadonlyArray<{ word: string; session_time: string; speaker: string }>,
  pageSizeWords: number = GENERATION_PAGE_SIZE_WORDS,
  maxPageChars: number = GENERATION_PAGE_MAX_CHARS,
): string[] {
  const bodyCap = Math.max(1, maxPageChars - CONTINUATION_MARKER_RESERVE);
  const lines = splitOverCapLines(generationDensityLines(words), bodyCap);
  const pages: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  let curWords = 0;
  for (const line of lines) {
    // Cost of appending this line to the current page: its own chars, plus the
    // '\n' the join will put in front of it when the page is non-empty.
    const cost = cur.length === 0 ? line.text.length : line.text.length + 1;
    if (
      cur.length > 0 &&
      (curChars + cost > bodyCap || curWords + line.wordCount > pageSizeWords)
    ) {
      pages.push(cur);
      cur = [];
      curChars = 0;
      curWords = 0;
    }
    curChars += cur.length === 0 ? line.text.length : line.text.length + 1;
    cur.push(line.text);
    curWords += line.wordCount;
  }
  if (cur.length > 0) pages.push(cur);
  // The empty transcript renders the chat path's placeholder as its one page.
  if (pages.length === 0) pages.push(['(this session has no transcript)']);
  return pages.map((linesOfPage, i) => {
    const body = linesOfPage.join('\n');
    return i < pages.length - 1 ? `${body}${continuationMarker(i + 1, pages.length)}` : body;
  });
}

/** Select one page out of an already-paginated transcript. An out-of-range,
 * negative, or non-integer page is an error (`ok: false`), never empty text. */
function selectGenerationTranscriptPage(
  pages: readonly string[],
  page: number,
): GenerationPageResult {
  if (!Number.isInteger(page) || page < 0) return { ok: false, error: invalidPageError(page) };
  if (page >= pages.length) {
    return {
      ok: false,
      error:
        `Page ${page} is out of range: this transcript has ${pages.length} page(s), ` +
        `0-based (last page is ${pages.length - 1}).`,
    };
  }
  return { ok: true, text: pages[page], totalPages: pages.length };
}

/**
 * Render ONE page of the generation-density transcript: paginate, then select
 * (the pagination semantics live in `paginateGenerationTranscript` above).
 * Every page except the last ends with an explicit continuation marker naming
 * the next page and the total — never silent truncation.
 *
 * This whole-transcript-per-call form is the LIVE-hub path (a generation
 * registration carrying no word snapshot); snapshot-backed registrations page
 * through the memoized pagination instead.
 *
 * `pageSizeWords` / `maxPageChars` are parameterized FOR TESTS ONLY — the tool
 * always calls with the `GENERATION_PAGE_SIZE_WORDS` / `GENERATION_PAGE_MAX_CHARS`
 * defaults.
 */
export function renderGenerationTranscriptPage(
  words: ReadonlyArray<{ word: string; session_time: string; speaker: string }>,
  page: number,
  pageSizeWords: number = GENERATION_PAGE_SIZE_WORDS,
  maxPageChars: number = GENERATION_PAGE_MAX_CHARS,
): GenerationPageResult {
  // Checked BEFORE paginating: a bad page number never pays for the packing.
  if (!Number.isInteger(page) || page < 0) return { ok: false, error: invalidPageError(page) };
  return selectGenerationTranscriptPage(
    paginateGenerationTranscript(words, pageSizeWords, maxPageChars),
    page,
  );
}

/** The generation turn's `get_transcript_words` input surface — chat turns
 * keep the zero-arg shape (the builder registers a different shape per
 * context). Type-only here; range validation happens in the handler so a bad
 * page returns an `isError` tool result, not an SDK-thrown `McpError`. */
const generationTranscriptToolShape = {
  page: z
    .number()
    .optional()
    .describe(
      '0-based page number (default 0). Fetch pages sequentially until a page ' +
        'has no continuation marker.',
    ),
};

/** Everything a tool builder may bind into its handlers. `generation` is the
 * EVENT run's snapshot (undefined on chat turns AND on the topic one-shot),
 * and `createdEvents` the registration's per-run counter — both consumed by
 * `create_event` (task 3.2). */
interface ToolBuildContext {
  readonly registry: SessionHubRegistry;
  readonly sessionId: string;
  readonly generation: AiGenerationRunContext | undefined;
  readonly createdEvents: { count: number };
  /** The topic one-shot's paged word snapshot (D1) — the OTHER key for the
   * paged `get_transcript_words` registration; carries no event-run fields. */
  readonly pagedWords: readonly AiGenerationSnapshotWord[] | undefined;
  /** The registration's pagination memo + served-page set (D1/D6). */
  readonly pageState: TurnPageState;
}

/**
 * The tool registry (auto-generate-event-logs D6): one builder per registry
 * tool name, keyed by `AiMcpToolName`. `buildSessionMcpServer` registers ONLY
 * the turn's tool set, by looking each name up here — so "chat turns cannot
 * write events" is enforced at the SERVER, not just by CLI argv.
 *
 * EXTENSION POINT (task 3.2): add `create_event` to `AI_MCP_TOOL_NAMES` and a
 * builder entry here — the `Record<AiMcpToolName, …>` type then forces the
 * entry, and no registration plumbing changes. Its handlers read
 * `ctx.generation` (the run snapshot) for the category allowlist, frame rate,
 * run id, and cap.
 */
const TOOL_BUILDERS: Record<AiMcpToolName, (server: McpServer, ctx: ToolBuildContext) => void> = {
  get_transcript_words: (server, { registry, sessionId, generation, pagedWords, pageState }) => {
    // GENERATION-DENSITY turns: event generation (task 3.3, design D5 — keyed
    // by the run snapshot) and the topic one-shot (topic-generate-paged-
    // transcript D1 — keyed by the words-only `pagedWords` snapshot). Both get
    // the paged rendering with a `page` input. Chat turns fall through to the
    // byte-identical zero-arg chat rendering below — pinned by the
    // pre-existing tests ('get_transcript_words returns COMPACT readable
    // text' in aiMcpServer.test.ts).
    if (generation !== undefined || pagedWords !== undefined) {
      server.tool(
        'get_transcript_words',
        "Returns this session's transcript as readable text at generation " +
          'density: speaker- and timecode-anchored lines, delivered in ' +
          'sequential size-capped pages. ' +
          'Long transcripts span multiple pages: start at page=0 (the ' +
          'default); every page except the last ends with a continuation ' +
          'marker naming the next page — keep calling with the named page ' +
          'until the marker is absent, and never treat one page as the whole ' +
          'transcript.',
        generationTranscriptToolShape,
        async (args) => {
          const page = args.page ?? 0;
          // Word snapshot when the registration carries one — the event run's
          // (task 4.3, Phase-3 carry) or the topic one-shot's `pagedWords`
          // (D1), in that precedence. A mid-run replaceTranscriptWords can
          // then never change this turn's page content or boundaries, and the
          // pagination is packed ONCE per registration. Snapshot-less
          // registrations keep 3.3's live hub read, resolved at call time
          // (D3) — never held across an await, and never memoized (live is
          // live) nor counted as page coverage (no snapshot to cover).
          if (pageState.words !== undefined) {
            const res = selectGenerationTranscriptPage(snapshotPages(pageState), page);
            if (!res.ok) return toolError(res.error);
            // Coverage (D6) is marked only for a page actually SERVED: a tool
            // error above returns before this line.
            pageState.served.add(page);
            return { content: [{ type: 'text', text: res.text }] };
          }
          const words = registry.get(sessionId).listTranscriptWords();
          const res = renderGenerationTranscriptPage(words, page);
          if (!res.ok) return toolError(res.error);
          return { content: [{ type: 'text', text: res.text }] };
        },
      );
      return;
    }
    server.tool(
      'get_transcript_words',
      "Returns this session's transcript as readable text (speaker- and " +
        'timecode-annotated), for reading and summarizing.',
      {},
      async () => {
        // Hub resolved at call time (D3) — never held across an await.
        const words = registry.get(sessionId).listTranscriptWords();
        // Return COMPACT, readable text — NOT the verbose per-word JSON. A real
        // transcript is thousands of 8-field word rows (~180 chars each); the
        // raw `JSON.stringify(words)` produced a single ~300KB line that
        // overflowed the CLI's tool-output token limit, so the model could not
        // read it at all and generated no usable topics. Grouping words into
        // speaker/timecode-prefixed lines drops that ~20x while preserving what
        // the model needs to read and to place topics on the timeline.
        return { content: [{ type: 'text', text: formatTranscriptForModel(words) }] };
      },
    );
  },

  list_topics: (server, { registry, sessionId }) => {
    server.tool('list_topics', "Returns this session's topics.", {}, async () => {
      // Hub resolved at call time (D3) — never held across an await.
      const topics = registry.get(sessionId).listTopics();
      return { content: [{ type: 'text', text: JSON.stringify(topics) }] };
    });
  },

  create_topic: (server, { registry, sessionId }) => {
    server.tool(
      'create_topic',
      'Create one topic on this session. The ordinal is assigned by the server.',
      createTopicToolShape,
      async (args) => {
        // Bounds enforced ONLY by topicCreateSchema (no re-derivation). On
        // violation return an isError tool result — NOT a thrown crash — and do
        // not insert (spec: "Out-of-bounds tool input is rejected safely").
        const parsed = topicCreateSchema.safeParse(args);
        if (!parsed.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid topic input: ${parsed.error.issues
                  .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                  .join('; ')}`,
              },
            ],
            isError: true,
          };
        }
        // Hub resolved at call time (D3). insertTopic is the transactional,
        // server-assigned-ordinal manual-insert path; topics have no WS emission,
        // and this path introduces none.
        const topic = registry.get(sessionId).insertTopic(parsed.data);
        return { content: [{ type: 'text', text: JSON.stringify(topic) }] };
      },
    );
  },

  create_event: (server, { registry, sessionId, generation, createdEvents }) => {
    server.tool(
      'create_event',
      'Create one log event on this session at a transcript timecode. Only ' +
        "this run's allowed category ids are accepted; the event is appended " +
        'at the supplied session_time, never at the current clock.',
      createEventToolShape,
      async (args) => {
        // EVERY failure path below returns an isError tool result — the tool
        // never throws (spec: "no insert, no crash"; the run continues).
        try {
          // Defensive: create_event is only meaningful under a generation run
          // snapshot (D6). A snapshot-less registration gets a tool error.
          if (generation === undefined) {
            return toolError('create_event is only available on generation turns.');
          }
          const parsed = createEventArgsSchema.safeParse(args);
          if (!parsed.success) {
            return toolError(
              `Invalid event input: ${parsed.error.issues
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                .join('; ')}`,
            );
          }
          const { category, message, session_time } = parsed.data;
          // `internal` denial in ANY casing, BEFORE the allowlist — belt and
          // braces even if a snapshot ever carried such an id (internal rows
          // are transport anchors; a model-authored one corrupts remapping).
          if (category.toLowerCase() === 'internal') {
            return toolError("Category 'internal' is reserved and can never be written.");
          }
          const cat = generation.categories.find((c) => c.id === category);
          if (cat === undefined) {
            const allowed = generation.categories
              .filter((c) => c.id.toLowerCase() !== 'internal')
              .map((c) => c.id)
              .join(', ');
            return toolError(`Unknown category '${category}': must be one of: ${allowed}.`);
          }
          // TRUST BOUNDARY (D4): the parser gates EVERY insert. A null parse
          // (grammar violation, ≥ 24h, frames ≥ rate) is a tool error, and
          // `wallTimeUtcForTimecode` is never called with an unbounded value —
          // parser-bounded timecodes (< 24h) stay inside Date's range.
          const tc = parseTimecodeString(session_time, generation.frameRate);
          if (tc === null) {
            return toolError(
              `Invalid session_time '${session_time}': expected HH:MM:SS, HH:MM:SS:FF, ` +
                'or drop-frame HH:MM:SS;FF, below 24:00:00 with frames under the session rate.',
            );
          }
          if (createdEvents.count >= generation.cap) {
            return toolError(
              `Per-run event cap reached (${generation.cap} events): no further events ` +
                'can be created by this run.',
            );
          }
          const totalFrames = toTotalFrames(tc);
          // Metadata composition (spec "bounded and attributable"): attribution
          // pair + the SAME category label/color UI snapshot keys the manual
          // route writes, sourced from the RUN SNAPSHOT (never a catalog read).
          const snapshotDef: CategoryDef = {
            id: cat.id,
            label: cat.name,
            color: cat.color,
            kind: cat.type,
            dropdown_options: cat.dropdown_options.map((o) => o.label),
            on_label: '',
            off_label: '',
          };
          const metadata = mergeCategoryUiSnapshotsIntoMetadata(
            { auto_generated: true, auto_generate_run_id: generation.runId },
            snapshotDef,
          );
          // Hub resolved AT CALL TIME (D3) — the read + insert below are one
          // synchronous block, never held across an await. Anchors are rebuilt
          // FRESH each call: events accrue during the run, and re-reading them
          // keeps generated events sorting among themselves in timecode order
          // (each insert becomes an anchor for the next, monotone-clamped).
          const hub = registry.get(sessionId);
          const anchors = timecodeWallAnchors(hub.exportEvents());
          const wallTimeUtc = wallTimeUtcForTimecode(totalFrames, anchors, {
            frameRate: generation.frameRate,
            startOffsetFrames: generation.startOffsetFrames,
            startedAtUtc: generation.startedAtUtc,
          });
          // One insert path (D4): the transactional manual-path addEvent with
          // the explicit anchor — same metadata handling, and its single
          // event.changed broadcast per insert is deliberately NOT suppressed.
          const { event } = hub.addEvent({
            category,
            message,
            metadataJson: JSON.stringify(metadata),
            markedAtUtc: null,
            ctx: {
              frameRate: generation.frameRate,
              startOffsetFrames: generation.startOffsetFrames,
            },
            explicitAnchor: { timecodeTotalFrames: totalFrames, wallTimeUtc },
          });
          createdEvents.count += 1; // ONLY on successful insert
          return { content: [{ type: 'text', text: JSON.stringify(event) }] };
        } catch {
          // Never throw out of the handler (spec). Kept opaque — raw internal
          // errors are not surfaced to the model.
          return toolError('create_event failed: internal error; no event was created.');
        }
      },
    );
  },
};

function buildSessionMcpServer(registry: SessionHubRegistry, reg: TurnRegistration): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
  // Register ONLY the turn's tool set (D6). No context ⇒ the pinned default
  // three chat tools — byte-identical to the pre-context behavior. The Set
  // guards against a duplicate name in a caller-supplied set (McpServer.tool
  // throws on re-registration).
  const ctx: ToolBuildContext = {
    registry,
    sessionId: reg.sessionId,
    generation: reg.context?.generation,
    createdEvents: reg.createdEvents,
    pagedWords: reg.context?.pagedWords,
    pageState: reg.pageState,
  };
  for (const name of new Set(reg.context?.tools ?? DEFAULT_TURN_TOOLS)) {
    TOOL_BUILDERS[name](server, ctx);
  }
  return server;
}

/**
 * The loopback-only, ephemeral-port Streamable-HTTP MCP listener. One instance
 * per Node process (see `getAiMcpListener`); tests may construct it directly.
 */
export class AiMcpListener {
  private httpServer: http.Server | null = null;
  private startPromise: Promise<void> | null = null;
  /** token → registration. The bearer allowlist: unknown token ⇒ 401. */
  private readonly turns = new Map<string, TurnRegistration>();

  constructor(private readonly registry: SessionHubRegistry) {}

  /** Start the listener (idempotent). Binds 127.0.0.1 on an ephemeral port —
   * NEVER a non-loopback address. Resolves once listening. */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.httpServer = server;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(0, LOOPBACK, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    return this.startPromise;
  }

  /** The bound address, or null before `start()` resolves. */
  get address(): AddressInfo | null {
    const a = this.httpServer?.address();
    return a && typeof a === 'object' ? a : null;
  }

  private get port(): number {
    const a = this.address;
    if (a === null) throw new Error('AiMcpListener not started');
    return a.port;
  }

  /**
   * Register a turn: mint a ≥128-bit bearer token bound to `sessionId` and
   * return the URL + token for the generated `--mcp-config`. The returned
   * `dispose()` (idempotent) drops the registration and retires the token — call
   * it in the turn's `finally`.
   *
   * `context` (optional, auto-generate-event-logs D6) carries the turn's tool
   * set and, on a generation-density turn, its transcript word snapshot — the
   * event run's `generation.words` or the topic one-shot's `pagedWords`
   * (topic-generate-paged-transcript D1), whichever the caller passes.
   * `ai/chat` and `topics/generate` pass explicit `{tools}` (D7, task 3.4);
   * omitted ⇒ the pinned default three chat tools.
   */
  registerTurn(sessionId: string, context?: AiMcpTurnContext): AiMcpTurn {
    if (this.httpServer === null) throw new Error('AiMcpListener not started');
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    // One created-events counter PER REGISTRATION (task 3.2) — shared by the
    // turn's per-request MCP servers, readable after the run via the returned
    // `createdEvents()` (the generate route's `{created, cap_hit}` source).
    const createdEvents = { count: 0 };
    // One paged-transcript memo + coverage counter PER REGISTRATION (D1/D6),
    // on the same terms. The snapshot is the event run's words when present,
    // else the topic one-shot's `pagedWords`; neither ⇒ no snapshot, no
    // memoization, no coverage claim.
    const pageState: TurnPageState = {
      words: context?.generation?.words ?? context?.pagedWords,
      pages: null,
      served: new Set<number>(),
    };
    this.turns.set(token, { sessionId, context, createdEvents, pageState });
    const url = `http://${LOOPBACK}:${this.port}${MCP_PATH}`;
    let disposed = false;
    return {
      url,
      token,
      createdEvents: (): number => createdEvents.count,
      // Forces the pagination if nothing else has (a run that created topics
      // without ever calling the tool must report 0-of-N, not 0-of-0).
      pageCoverage: (): AiMcpPageCoverage => ({
        totalPages: snapshotPages(pageState).length,
        servedPages: pageState.served.size,
      }),
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        this.turns.delete(token);
      },
    };
  }

  /** In-flight registration count (introspection / tests). */
  get registrationCount(): number {
    return this.turns.size;
  }

  /** Stop the listener and drop all registrations. */
  async close(): Promise<void> {
    this.turns.clear();
    const server = this.httpServer;
    this.httpServer = null;
    this.startPromise = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // ── Bearer check AT THE HTTP LAYER, before any transport dispatch (D3). ──
    const reg = this.resolveTurn(req);
    if (reg === null) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Per-connection (per-request) transport instantiation (D3): stateless,
    // so concurrent turns never share transport state. The tools are bound to
    // this turn's sessionId — resolved from the registration, not a param.
    try {
      const server = buildSessionMcpServer(this.registry, reg);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  }

  /** Extract the bearer token and resolve its registration, or null (⇒ 401). */
  private resolveTurn(req: http.IncomingMessage): TurnRegistration | null {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith(BEARER_PREFIX)) return null;
    const token = auth.slice(BEARER_PREFIX.length);
    if (token.length === 0) return null;
    return this.turns.get(token) ?? null;
  }
}

/** Read the full request body as parsed JSON, or undefined for a bodiless GET. */
async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  let raw = '';
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

// ── Process-wide singleton (the shared home task 3.2 consumes) ───────────────

let singletonPromise: Promise<AiMcpListener> | null = null;

/**
 * Get the process-wide MCP listener, starting it on first use with the app's
 * `SessionHubRegistry`. Single Node process ⇒ one registry ⇒ one listener; the
 * CLI runner (task 3.2) calls this, then `registerTurn` / `dispose` per turn.
 * The STARTED promise is cached (not the bare instance), so concurrent first
 * callers all await the same completed `start()` — never an unstarted listener
 * whose `port` getter would throw. A failed start clears the cache so a later
 * call can retry.
 */
export function getAiMcpListener(registry: SessionHubRegistry): Promise<AiMcpListener> {
  singletonPromise ??= (async () => {
    const listener = new AiMcpListener(registry);
    await listener.start();
    return listener;
  })().catch((err) => {
    singletonPromise = null;
    throw err;
  });
  return singletonPromise;
}

/** Test-only: close and clear the singleton so it doesn't leak across cases. */
export async function __resetAiMcpListenerForTests(): Promise<void> {
  const p = singletonPromise;
  singletonPromise = null;
  if (p !== null) {
    const listener = await p.catch(() => null);
    if (listener !== null) await listener.close();
  }
}
