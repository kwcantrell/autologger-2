// The frame bus's signed envelope (session-frame-bus D2, ADR 0021 slice 9a). Any database login
// role can `pg_notify` on the bus's channel, so every message carries an HMAC-SHA256 keyed by the
// server-only `FRAME_BUS_SECRET`, and a receiver drops a message that fails any check: the
// signature (compared with `timingSafeEqual`), the version, the frame type, the command and the
// close code. A drop is logged by its reason, never with the payload.
//
// Storage does not import session-core or the contract (package-architecture: L1 packages are
// siblings, and storage speaks only ports), so the message shape is declared here structurally and
// the allowed frame types and commands are given by the composition root.

import { createHmac, timingSafeEqual } from 'node:crypto';

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

/** Seals messages for one process: `n` is a per-process sequence number, so no two payloads are
 * equal and Postgres never folds two frames of one transaction into one (session-frame-bus D2). */
export class FrameBusSealer {
  private seq = 0;
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = checkFrameBusSecret(secret);
  }

  /** The signed payload; throws `FrameBusPayloadTooLargeError` above the byte limit. */
  seal(msg: FrameBusMessage): string {
    this.seq += 1;
    const body = { ...msg, v: FRAME_BUS_VERSION, n: this.seq };
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

/** Verifies and checks one received payload (session-frame-bus D2). */
export function openFrameBusMessage(
  payload: string,
  secret: string,
  rules: FrameBusRules,
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
