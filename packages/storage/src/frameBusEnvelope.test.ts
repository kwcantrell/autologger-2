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
  FrameBusReplayGuard,
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
    expect(
      reason(signed({ v: 1, n: 1, b: 'b1', t: 1, k: 'close', u: 'm', s: ['s1'], c: 4403 })),
    ).toBe('ok');
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

describe('the frame bus envelope against replays (session-frame-bus D2)', () => {
  const COMMAND: FrameBusMessage = {
    k: 'frame',
    s: 's1',
    f: '{"type":"command","command":"record-start"}',
  };
  /** A settable clock; the sender and the receiver each get their own. */
  const clockAt = (ms: number) => {
    const c = { ms, now: () => c.ms };
    return c;
  };
  /** A receiver whose first LISTEN was at `ms`. */
  const listeningAt = (ms: number) => {
    const clock = clockAt(ms);
    const guard = new FrameBusReplayGuard(clock);
    guard.listening();
    return { clock, guard };
  };
  const open = (payload: string, guard: FrameBusReplayGuard) => {
    const r = openFrameBusMessage(payload, SECRET, RULES, guard);
    return r.ok ? 'ok' : r.reason;
  };
  const T0 = 1_750_000_000_000;

  it('a message sent more than 30 s before or after the receiver’s clock is dropped as stale', () => {
    const sender = clockAt(T0);
    const sealer = new FrameBusSealer(SECRET, sender);
    const stale = sealer.seal(COMMAND);
    sender.ms = T0 + 62_000;
    const future = sealer.seal(COMMAND);
    const rx = listeningAt(T0 - 1000);
    rx.clock.ms = T0 + 31_000;
    expect(open(stale, rx.guard)).toBe('stale message (skew 31000 ms)');
    expect(open(future, rx.guard)).toBe('stale message (skew -31000 ms)');
    sender.ms = T0 + 30_000;
    expect(open(sealer.seal(COMMAND), rx.guard)).toBe('ok');
  });

  it('a stale close is still accepted', () => {
    const payload = new FrameBusSealer(SECRET, clockAt(T0)).seal(CLOSE);
    const rx = listeningAt(T0 - 1000);
    rx.clock.ms = T0 + 31_000;
    expect(open(payload, rx.guard)).toBe('ok');
  });

  it('a message sent before the receiver’s first LISTEN is dropped, a close too', () => {
    const sealer = new FrameBusSealer(SECRET, clockAt(T0 - 1));
    const rx = listeningAt(T0);
    expect(open(sealer.seal(COMMAND), rx.guard)).toBe('sent before the listener started');
    expect(open(sealer.seal(CLOSE), rx.guard)).toBe('sent before the listener started');
    // A later LISTEN (after a loss, D6) does not move the start.
    rx.clock.ms = T0 + 5000;
    rx.guard.listening();
    expect(open(new FrameBusSealer(SECRET, clockAt(T0 + 1)).seal(COMMAND), rx.guard)).toBe('ok');
    // Nothing is accepted before the first LISTEN at all.
    const notYet = new FrameBusReplayGuard(clockAt(T0));
    expect(open(sealer.seal(COMMAND), notYet)).toBe('sent before the listener started');
  });

  it('a repeated (b, n) within 60 s is dropped, and accepted again once pruned past 60 s', () => {
    const sealer = new FrameBusSealer(SECRET, clockAt(T0));
    const command = sealer.seal(COMMAND);
    const close = sealer.seal(CLOSE);
    const rx = listeningAt(T0);
    expect(open(command, rx.guard)).toBe('ok');
    expect(open(close, rx.guard)).toBe('ok');
    expect(open(command, rx.guard)).toBe('replayed message');
    rx.clock.ms = T0 + 60_000;
    expect(open(close, rx.guard)).toBe('replayed message');
    // Past 60 s the pair is pruned; only a close is still fresh enough to show it (D2).
    rx.clock.ms = T0 + 60_001;
    expect(open(close, rx.guard)).toBe('ok');
    expect(open(command, rx.guard)).toBe('stale message (skew 60001 ms)');
  });

  it('two buses in one process are both accepted with the same n', () => {
    const [one, two] = [
      new FrameBusSealer(SECRET, clockAt(T0)),
      new FrameBusSealer(SECRET, clockAt(T0)),
    ];
    expect(one.busId).not.toBe(two.busId);
    const [p1, p2] = [one.seal(COMMAND), two.seal(COMMAND)];
    expect(JSON.parse(p1).n).toBe(1);
    expect(JSON.parse(p2).n).toBe(1);
    const rx = listeningAt(T0);
    expect(open(p1, rx.guard)).toBe('ok');
    expect(open(p2, rx.guard)).toBe('ok');
  });

  it('every seal carries its bus id and send time, and a tampered b or t fails the signature', () => {
    const sealer = new FrameBusSealer(SECRET, clockAt(T0));
    const payload = sealer.seal(FRAME);
    expect(JSON.parse(payload)).toMatchObject({ b: sealer.busId, t: T0, n: 1 });
    const tampered = (patch: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(payload), ...patch });
    const rx = listeningAt(T0);
    expect(open(tampered({ b: crypto.randomUUID() }), rx.guard)).toBe('bad signature');
    expect(open(tampered({ t: T0 + 1 }), rx.guard)).toBe('bad signature');
    // A signed message without a bus id or send time is malformed.
    expect(reason(signed({ v: 1, n: 1, k: 'frame', s: 's1', f: FRAME.f, b: 'x' }))).toBe(
      'malformed envelope',
    );
    expect(reason(signed({ v: 1, n: 1, k: 'frame', s: 's1', f: FRAME.f, t: T0 }))).toBe(
      'malformed envelope',
    );
  });
});
