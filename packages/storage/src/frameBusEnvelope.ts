// The frame bus's signed envelope (session-frame-bus D2, ADR 0021 slice 9a). Any database login
// role can `pg_notify` on the bus's channel, so every message carries an HMAC-SHA256 keyed by the
// server-only `FRAME_BUS_SECRET`, and a receiver drops a message that fails any check: the
// signature (compared with `timingSafeEqual`), the version, the frame type, the command and the
// close code. A drop is logged by its reason, never with the payload.
//
// Replay (D2): any login role can also capture a signed message and send it again, so each message
// carries its sending bus's id `b` (a random UUID per bus, so two buses in one process never share
// it) and its send time `t` from the bus's Clock, both under the signature. A receiver's
// `FrameBusReplayGuard` drops a message sent before its own first LISTEN, a message other than a
// close sent more than 30 s before or after its clock, and a `(b, n)` it accepted in the last 60 s.
// Processes keep their clocks within a few seconds of each other (NTP).
//
// Storage does not import session-core or the contract (package-architecture: L1 packages are
// siblings, and storage speaks only ports), so the message shape is declared here structurally and
// the allowed frame types and commands are given by the composition root.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@autologger/ports';

/** A bus message, as session-core's `BusMessage` (the composition root's assignment is the type
 * check): a frame for session `s`, or a close of user `u`'s sockets on sessions `s` with code `c`. */
export type FrameBusMessage =
  | { k: 'frame'; s: string; f: string }
  | { k: 'close'; u: string; s: readonly string[] | 'all'; c: number };

/** What a receiver accepts beyond the signature (session-frame-bus D2). */
export interface FrameBusRules {
  /** The frame types a session socket receives. */
  frameTypes: readonly string[];
  /** The contract's command values. */
  commands: readonly string[];
}

export const FRAME_BUS_VERSION = 1;
/** The secret's minimum length (session-frame-bus D2). */
export const FRAME_BUS_SECRET_MIN_LENGTH = 32;
/** A payload over this many bytes is refused at publish time; Postgres's limit is just under 8000
 * bytes (session-frame-bus D2). */
export const FRAME_BUS_MAX_PAYLOAD_BYTES = 7900;
/** The only close code a bus message may carry: access lost (show-grants D20). */
const ACCESS_LOST_CLOSE_CODE = 4403;
/** A message other than a close is dropped when its send time is further than this from the
 * receiver's clock (session-frame-bus D2). */
export const FRAME_BUS_MAX_SKEW_MS = 30_000;
/** How long a receiver remembers an accepted `(b, n)` (session-frame-bus D2). */
export const FRAME_BUS_REPLAY_WINDOW_MS = 60_000;

/** The real clock, when a bus is given none; storage has no adapter of its own to import. */
const realClock: Clock = { now: () => Date.now() };

export class FrameBusPayloadTooLargeError extends Error {
  override name = 'FrameBusPayloadTooLargeError';
}

/** JSON with every object's keys sorted, so the signed text does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mac(secret: string, text: string): Buffer {
  return createHmac('sha256', secret).update(text).digest();
}

/** `FRAME_BUS_SECRET` is missing or too short; the message names the variable, never its value. */
export class FrameBusSecretError extends Error {
  override name = 'FrameBusSecretError';
}

export function checkFrameBusSecret(secret: string | undefined): string {
  if (!secret || secret.length < FRAME_BUS_SECRET_MIN_LENGTH) {
    throw new FrameBusSecretError(
      `FRAME_BUS_SECRET must be set to at least ${FRAME_BUS_SECRET_MIN_LENGTH} characters`,
    );
  }
  return secret;
}

/** Seals messages for one bus: `n` is the bus's sequence number, so no two payloads are equal and
 * Postgres never folds two frames of one transaction into one; `b` is the bus's own id and `t` the
 * send time, for the receivers' replay checks (session-frame-bus D2). */
export class FrameBusSealer {
  /** A random UUID per sealer, generated alongside its `n` counter (session-frame-bus D2). */
  readonly busId = randomUUID();
  private seq = 0;
  private readonly secret: string;
  private readonly clock: Clock;

  constructor(secret: string, clock: Clock = realClock) {
    this.secret = checkFrameBusSecret(secret);
    this.clock = clock;
  }

  /** The signed payload; throws `FrameBusPayloadTooLargeError` above the byte limit. */
  seal(msg: FrameBusMessage): string {
    this.seq += 1;
    const body = { ...msg, v: FRAME_BUS_VERSION, n: this.seq, b: this.busId, t: this.clock.now() };
    const h = mac(this.secret, canonicalJson(body)).toString('hex');
    const payload = canonicalJson({ ...body, h });
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > FRAME_BUS_MAX_PAYLOAD_BYTES) {
      throw new FrameBusPayloadTooLargeError(
        `frame bus: a ${msg.k} message of ${bytes} bytes is over the ${FRAME_BUS_MAX_PAYLOAD_BYTES}-byte limit`,
      );
    }
    return payload;
  }
}

export type OpenedFrameBusMessage =
  | { ok: true; msg: FrameBusMessage }
  | { ok: false; reason: string };

const isString = (x: unknown): x is string => typeof x === 'string';

/** One receiver's replay checks (session-frame-bus D2). Only validly signed, well-formed messages
 * reach `admit`, so the accepted set is bounded by the legitimate message rate. */
export class FrameBusReplayGuard {
  private listenedAt: number | null = null;
  /** `b:n` -> when it was accepted, in arrival order. Messages from one bus arrive in commit order,
   * not `n` order, so this is a set rather than a high-water mark. */
  private readonly accepted = new Map<string, number>();

  constructor(private readonly clock: Clock = realClock) {}

  /** The receiver's LISTEN succeeded; only the first one counts (a re-listen after a loss closes
   * the sockets instead, D6). */
  listening(): void {
    this.listenedAt ??= this.clock.now();
  }

  /** Null to accept (and remember `(b, n)`), or the drop reason. */
  admit(kind: FrameBusMessage['k'], b: string, n: number, t: number): string | null {
    const now = this.clock.now();
    if (this.listenedAt === null || t < this.listenedAt) return 'sent before the listener started';
    // A validly signed close is harmless to repeat and must not be lost to clock skew.
    if (kind !== 'close' && Math.abs(now - t) > FRAME_BUS_MAX_SKEW_MS) {
      return `stale message (skew ${now - t} ms)`;
    }
    for (const [key, at] of this.accepted) {
      if (now - at <= FRAME_BUS_REPLAY_WINDOW_MS) break;
      this.accepted.delete(key);
    }
    const key = `${b}:${n}`;
    if (this.accepted.has(key)) return 'replayed message';
    this.accepted.set(key, now);
    return null;
  }
}

/** Verifies and checks one received payload (session-frame-bus D2); with a `guard`, also against
 * replays, after every other check. */
export function openFrameBusMessage(
  payload: string,
  secret: string,
  rules: FrameBusRules,
  guard?: FrameBusReplayGuard,
): OpenedFrameBusMessage {
  const drop = (reason: string): OpenedFrameBusMessage => ({ ok: false, reason });
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return drop('malformed payload');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return drop('malformed payload');
  }
  const { h, ...body } = parsed as Record<string, unknown>;
  if (!isString(h) || !/^[0-9a-f]{64}$/.test(h)) return drop('unsigned message');
  const expected = mac(secret, canonicalJson(body));
  if (!timingSafeEqual(Buffer.from(h, 'hex'), expected)) return drop('bad signature');
  if (body.v !== FRAME_BUS_VERSION) return drop('unknown version');
  const checked = checkMessage(body, rules);
  if (!checked.ok) return checked;
  const { b, n, t } = body;
  if (!isString(b) || !b || !Number.isSafeInteger(n) || !Number.isSafeInteger(t)) {
    return drop('malformed envelope');
  }
  const replay = guard?.admit(checked.msg.k, b, n as number, t as number) ?? null;
  return replay === null ? checked : drop(replay);
}

/** The message's own checks: frame type, command, close shape and code. */
function checkMessage(body: Record<string, unknown>, rules: FrameBusRules): OpenedFrameBusMessage {
  const drop = (reason: string): OpenedFrameBusMessage => ({ ok: false, reason });
  if (body.k === 'frame') {
    if (!isString(body.s) || !body.s || !isString(body.f)) return drop('malformed frame');
    let frame: unknown;
    try {
      frame = JSON.parse(body.f);
    } catch {
      return drop('malformed frame');
    }
    const type = (frame as { type?: unknown } | null)?.type;
    if (!isString(type) || !rules.frameTypes.includes(type)) return drop('bad frame type');
    if (type === 'command') {
      const command = (frame as { command?: unknown }).command;
      if (!isString(command) || !rules.commands.includes(command)) return drop('unknown command');
    }
    return { ok: true, msg: { k: 'frame', s: body.s, f: body.f } };
  }
  if (body.k === 'close') {
    const s = body.s;
    if (!isString(body.u) || !body.u) return drop('malformed close');
    if (s !== 'all' && !(Array.isArray(s) && s.every(isString))) return drop('malformed close');
    if (body.c !== ACCESS_LOST_CLOSE_CODE) return drop('bad close code');
    return { ok: true, msg: { k: 'close', u: body.u, s, c: body.c } };
  }
  return drop('unknown message kind');
}
