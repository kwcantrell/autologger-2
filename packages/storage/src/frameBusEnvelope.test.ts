// The frame bus's signed envelope (session-frame-bus D2, D8): a sealed message opens with the same
// secret; a tampered field, a wrong key, an unknown version, a bad frame type, an unknown command
// or a bad close code is dropped with its reason; the size limit counts bytes; every seal carries
// a new sequence number.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkFrameBusSecret,
  FRAME_BUS_MAX_PAYLOAD_BYTES,
  type FrameBusMessage,
  FrameBusPayloadTooLargeError,
  FrameBusSealer,
  openFrameBusMessage,
} from './frameBusEnvelope';

const SECRET = 'a'.repeat(32);
const RULES = {
  frameTypes: ['event.changed', 'transport.changed', 'audio.changed', 'lease.changed', 'command'],
  commands: ['record-start', 'record-stop', 'record-toggle', 'play-toggle'],
};
const FRAME: FrameBusMessage = { k: 'frame', s: 's1', f: '{"type":"event.changed","revision":3}' };
const CLOSE: FrameBusMessage = { k: 'close', u: 'user-m', s: ['s1', 's2'], c: 4403 };

/** Re-signs `body` with `secret` as the sealer does (keys sorted), for crafted messages. */
function signed(body: Record<string, unknown>, secret = SECRET): string {
  const canonical = (o: Record<string, unknown>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, o[k]]),
      ),
    );
  const h = createHmac('sha256', secret).update(canonical(body)).digest('hex');
  return canonical({ ...body, h });
}

const reason = (payload: string, secret = SECRET) => {
  const r = openFrameBusMessage(payload, secret, RULES);
  return r.ok ? 'ok' : r.reason;
};

describe('the frame bus envelope (session-frame-bus D2)', () => {
  it('a sealed frame, command and close open with the same secret', () => {
    const sealer = new FrameBusSealer(SECRET);
    const command: FrameBusMessage = {
      k: 'frame',
      s: 's1',
      f: '{"type":"command","command":"record-start"}',
    };
    for (const msg of [FRAME, command, CLOSE, { ...CLOSE, s: 'all' as const }]) {
      expect(openFrameBusMessage(sealer.seal(msg), SECRET, RULES)).toEqual({ ok: true, msg });
    }
  });

  it('a tampered field or a wrong key is dropped as a bad signature', () => {
    const payload = new FrameBusSealer(SECRET).seal(FRAME);
    const tampered = (patch: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(payload), ...patch });
    expect(reason(tampered({ s: 's2' }))).toBe('bad signature');
    expect(reason(tampered({ f: '{"type":"event.changed","revision":4}' }))).toBe('bad signature');
    expect(reason(tampered({ n: 999 }))).toBe('bad signature');
    expect(reason(tampered({ extra: 1 }))).toBe('bad signature');
    expect(reason(payload, 'b'.repeat(32))).toBe('bad signature');
    expect(reason(tampered({ h: undefined }))).toBe('unsigned message');
    expect(reason('not json')).toBe('malformed payload');
  });

  it('an unknown version, frame type, command or close code is dropped even when signed', () => {
    expect(reason(signed({ v: 2, n: 1, k: 'frame', s: 's1', f: FRAME.f }))).toBe('unknown version');
    expect(reason(signed({ v: 1, n: 1, k: 'frame', s: 's1', f: '{"type":"admin.changed"}' }))).toBe(
      'bad frame type',
    );
    expect(reason(signed({ v: 1, n: 1, k: 'frame', s: 's1', f: 'nope' }))).toBe('malformed frame');
    expect(
      reason(
        signed({
          v: 1,
          n: 1,
          k: 'frame',
          s: 's1',
          f: '{"type":"command","command":"format-disk"}',
        }),
      ),
    ).toBe('unknown command');
    expect(reason(signed({ v: 1, n: 1, k: 'close', u: 'm', s: ['s1'], c: 1000 }))).toBe(
      'bad close code',
    );
    expect(reason(signed({ v: 1, n: 1, k: 'shout', s: 's1' }))).toBe('unknown message kind');
    // The crafted form is the sealer's own: the same body with the code that passes opens.
    expect(reason(signed({ v: 1, n: 1, k: 'close', u: 'm', s: ['s1'], c: 4403 }))).toBe('ok');
  });

  it('the size limit counts bytes, not characters', () => {
    const sealer = new FrameBusSealer(SECRET);
    const sized = (text: string): FrameBusMessage => ({
      k: 'frame',
      s: 's1',
      f: JSON.stringify({ type: 'event.changed', text }),
    });
    const overhead = Buffer.byteLength(sealer.seal(sized('')), 'utf8');
    const room = FRAME_BUS_MAX_PAYLOAD_BYTES - overhead;
    // `é` is 1 character and 2 bytes: within the limit counted as characters, over it as bytes.
    expect(() => sealer.seal(sized('é'.repeat(Math.ceil(room / 2) + 10)))).toThrow(
      FrameBusPayloadTooLargeError,
    );
    expect(() => sealer.seal(sized('e'.repeat(room - 10)))).not.toThrow();
  });

  it('every seal carries a new sequence number, so equal messages never give equal payloads', () => {
    const sealer = new FrameBusSealer(SECRET);
    const payloads = Array.from({ length: 100 }, () => sealer.seal(FRAME));
    expect(new Set(payloads).size).toBe(100);
    expect(new Set(payloads.map((p) => JSON.parse(p).n)).size).toBe(100);
  });

  it('a secret under 32 characters is refused', () => {
    expect(() => checkFrameBusSecret(undefined)).toThrow(/FRAME_BUS_SECRET/);
    expect(() => checkFrameBusSecret('a'.repeat(31))).toThrow(/FRAME_BUS_SECRET/);
    expect(() => new FrameBusSealer('short')).toThrow(/FRAME_BUS_SECRET/);
    expect(checkFrameBusSecret(SECRET)).toBe(SECRET);
  });
});
