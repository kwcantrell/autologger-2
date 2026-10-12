// FLAC frame-header rewriting for packet-copy concatenation (supabase-11a-legacy-import
// follow-up C). Fixtures: ./fixturesDir.ts (seg-flac*.flac are ffmpeg-encoded, fixed block size).

import { join } from 'node:path';
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { TRANSCRIPTION_FIXTURES_DIR } from './fixturesDir';
import {
  crc8,
  crc16,
  encodeCodedNumber,
  parseFlacFrameHeader,
  renumberFlacFrame,
  trimFlacFrame,
} from './flacFrames';

const fixtures = join(TRANSCRIPTION_FIXTURES_DIR, 'audio');

async function framesOf(name: string): Promise<Uint8Array[]> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new FilePathSource(join(fixtures, name)),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('no track');
    const out: Uint8Array[] = [];
    for await (const p of new EncodedPacketSink(track).packets()) out.push(p.data);
    return out;
  } finally {
    input.dispose();
  }
}

describe('coded numbers', () => {
  it('encodes the RFC 9639 UTF-8-like forms, 1 to 7 bytes', () => {
    expect([...encodeCodedNumber(0)]).toEqual([0x00]);
    expect([...encodeCodedNumber(0x7f)]).toEqual([0x7f]);
    expect([...encodeCodedNumber(0x80)]).toEqual([0xc2, 0x80]);
    expect([...encodeCodedNumber(4096)]).toEqual([0xe1, 0x80, 0x80]);
    expect(encodeCodedNumber(0x7fffffff)).toHaveLength(6);
    expect([...encodeCodedNumber(2 ** 36 - 1)]).toEqual([0xfe, 0xbf, 0xbf, 0xbf, 0xbf, 0xbf, 0xbf]);
    expect(() => encodeCodedNumber(2 ** 36)).toThrow();
    expect(() => encodeCodedNumber(-1)).toThrow();
  });
});

describe('parseFlacFrameHeader / renumberFlacFrame', () => {
  it('reads the fixture frames: fixed blocking, 1024-sample blocks, valid CRCs', async () => {
    const frames = await framesOf('seg-flac.flac');
    const h0 = parseFlacFrameHeader(frames[0]);
    expect(h0.variableBlockSize).toBe(false);
    expect(h0.codedNumber).toBe(0);
    expect(h0.blockSize).toBe(1024);
    expect(crc8(frames[0].subarray(0, h0.headerLength - 1))).toBe(frames[0][h0.headerLength - 1]);
    const last = frames.at(-1) as Uint8Array;
    expect(parseFlacFrameHeader(last).codedNumber).toBe(frames.length - 1);
    // 0.5 s at 48 kHz: the last block is the remainder.
    const total = frames.reduce((n, f) => n + parseFlacFrameHeader(f).blockSize, 0);
    expect(total).toBe(24_000);
  });

  it('rewrites a frame to variable blocking at a given sample number, CRCs recomputed', async () => {
    const frames = await framesOf('seg-flac2.flac');
    for (const sampleNumber of [0, 100, 70_000, 2 ** 33 + 5]) {
      const out = renumberFlacFrame(frames[1], sampleNumber);
      const h = parseFlacFrameHeader(out);
      expect(h.variableBlockSize).toBe(true);
      expect(h.codedNumber).toBe(sampleNumber);
      expect(h.blockSize).toBe(parseFlacFrameHeader(frames[1]).blockSize);
      expect(crc8(out.subarray(0, h.headerLength - 1))).toBe(out[h.headerLength - 1]);
      const footer = (out[out.length - 2] << 8) | out[out.length - 1];
      expect(crc16(out.subarray(0, out.length - 2))).toBe(footer);
      // Everything after the header (subframes) is byte-identical.
      const oldHeader = parseFlacFrameHeader(frames[1]).headerLength;
      expect(Buffer.from(out.subarray(h.headerLength, -2))).toEqual(
        Buffer.from(frames[1].subarray(oldHeader, -2)),
      );
    }
  });

  it('refuses bytes that are not a FLAC frame or whose header CRC is wrong', async () => {
    expect(() => parseFlacFrameHeader(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/sync/);
    const [frame] = await framesOf('seg-flac.flac');
    const bad = Uint8Array.from(frame);
    bad[4] ^= 0x01;
    expect(() => parseFlacFrameHeader(bad)).toThrow(/CRC/);
  });

  it('crc16 matches the footer of an untouched encoder frame', async () => {
    for (const f of await framesOf('seg-flac-mismatch.flac')) {
      expect(crc16(f.subarray(0, f.length - 2))).toBe((f[f.length - 2] << 8) | f[f.length - 1]);
    }
  });

  it('trims bytes after the frame (ID3v1 tag, padding) to the frame whose CRC-16 checks', async () => {
    const frames = await framesOf('seg-flac.flac');
    const frame = frames.at(-1) as Uint8Array;
    const tag = new Uint8Array(128);
    tag.set(Buffer.from('TAGsome title'), 0);
    for (const junk of [tag, new Uint8Array(64), Uint8Array.of(0xff, 0xf8, 0x01)]) {
      const withJunk = new Uint8Array(frame.length + junk.length);
      withJunk.set(frame, 0);
      withJunk.set(junk, frame.length);
      expect(Buffer.from(trimFlacFrame(withJunk))).toEqual(Buffer.from(frame));
      const out = renumberFlacFrame(withJunk, 4096);
      expect(out.length).toBe(renumberFlacFrame(frame, 4096).length);
      expect(crc16(out.subarray(0, out.length - 2))).toBe(
        (out[out.length - 2] << 8) | out[out.length - 1],
      );
    }
    expect(trimFlacFrame(frame)).toBe(frame);
  });

  it('refuses a frame whose CRC-16 never checks', async () => {
    const [frame] = await framesOf('seg-flac.flac');
    const bad = Uint8Array.from(frame);
    bad[bad.length - 1] ^= 0xff;
    expect(() => renumberFlacFrame(bad, 0)).toThrow(/CRC-16/);
  });
});
