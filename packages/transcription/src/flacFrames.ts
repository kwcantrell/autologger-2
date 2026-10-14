// FLAC frame-header rewriting for packet-copy concatenation (supabase-11a-legacy-import
// follow-up C). A FLAC frame header carries its position in the stream: the frame number
// (fixed-block-size streams, the encoders' default) or the first sample number (variable
// block size). Copying the frames of several files back to back leaves those numbers restarting
// at 0 per file and a short last block mid-stream, which RFC 9639 forbids in a fixed-block-size
// stream; mediabunny's demuxer then drops the frames that do not follow on, and ffmpeg warns
// about non-monotonic timestamps. So every copied frame is rewritten to the variable-block-size
// form with its running sample number: the header is re-encoded, its CRC-8 and the frame's
// CRC-16 recomputed, and the subframe bytes (the audio) are copied unchanged. Lossless and
// conformant (RFC 9639 §9.1).

/** One parsed frame header (only the fields the rewrite needs). */
export interface FlacFrameHeader {
  variableBlockSize: boolean;
  /** Frame number (fixed block size) or first sample number (variable). */
  codedNumber: number;
  blockSize: number;
  /** Bytes from the sync code through the CRC-8, inclusive. */
  headerLength: number;
  /** Offset of the coded number and of the bytes after it (uncommon size/rate fields). */
  codedNumberStart: number;
  codedNumberEnd: number;
}

/** RFC 9639 §9.1.1: polynomial x^8 + x^2 + x + 1, initial value 0. */
export function crc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** RFC 9639 §9.3: polynomial x^16 + x^15 + x^2 + 1, initial value 0. */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** RFC 9639 §9.1.5 coded number (UTF-8-like, up to 36 bits in 7 bytes). Note: sample numbers
 * of 2^31 and above (the 7-byte form, and 6-byte values past 31 bits) are rejected by ffmpeg's
 * decoder (GET_UTF8) and overflow mediabunny's readCodedNumber (32-bit `|`), so a FLAC group must
 * stay below 2^31 samples (~12.4 h at 48 kHz); audioMerge's run partition starts a new group
 * before that (DeepGram's 2 GB cap usually comes first). A single source file that long cannot
 * be split and stays undecodable past that point. */
export function encodeCodedNumber(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** 36) {
    throw new Error(`FLAC coded number out of range: ${value}`);
  }
  if (value < 0x80) return Uint8Array.of(value);
  // Total bytes n (2..7) holds 5n+1 payload bits (n=7: 36).
  let n = 2;
  while (n < 7 && value >= 2 ** (5 * n + 1)) n++;
  const out = new Uint8Array(n);
  let v = value;
  for (let i = n - 1; i >= 1; i--) {
    out[i] = 0x80 | (v % 64);
    v = Math.floor(v / 64);
  }
  const lead = n === 7 ? 0xfe : (0xff << (8 - n)) & 0xff;
  out[0] = lead | v;
  return out;
}

function decodeCodedNumber(bytes: Uint8Array, at: number): { value: number; end: number } {
  const first = bytes[at];
  if (first === undefined) throw new Error('FLAC frame header truncated');
  if (first < 0x80) return { value: first, end: at + 1 };
  let n = 0;
  while (n < 8 && first & (0x80 >> n)) n++;
  if (n < 2 || n > 7) throw new Error('FLAC frame header: invalid coded number');
  let value = n === 7 ? 0 : first & (0xff >> (n + 1));
  for (let i = 1; i < n; i++) {
    const b = bytes[at + i];
    if (b === undefined || (b & 0xc0) !== 0x80)
      throw new Error('FLAC frame header: invalid coded number');
    value = value * 64 + (b & 0x3f);
  }
  return { value, end: at + n };
}

/** Parses and CRC-checks a frame header. Throws on anything that is not a valid header. */
export function parseFlacFrameHeader(frame: Uint8Array): FlacFrameHeader {
  if (frame.length < 6 || frame[0] !== 0xff || (frame[1] & 0xfe) !== 0xf8) {
    throw new Error('not a FLAC frame (no sync code)');
  }
  const variableBlockSize = (frame[1] & 1) === 1;
  const bsBits = frame[2] >> 4;
  const srBits = frame[2] & 0x0f;
  if (bsBits === 0 || srBits === 15) throw new Error('FLAC frame header: reserved value');
  const coded = decodeCodedNumber(frame, 4);
  let p = coded.end;
  let blockSize: number;
  if (bsBits === 1) blockSize = 192;
  else if (bsBits <= 5) blockSize = 576 * 2 ** (bsBits - 2);
  else if (bsBits === 6) blockSize = frame[p++] + 1;
  else if (bsBits === 7) {
    blockSize = ((frame[p] << 8) | frame[p + 1]) + 1;
    p += 2;
  } else blockSize = 256 * 2 ** (bsBits - 8);
  if (srBits === 12) p += 1;
  else if (srBits === 13 || srBits === 14) p += 2;
  if (p >= frame.length || Number.isNaN(blockSize)) throw new Error('FLAC frame header truncated');
  if (crc8(frame.subarray(0, p)) !== frame[p]) throw new Error('FLAC frame header CRC mismatch');
  return {
    variableBlockSize,
    codedNumber: coded.value,
    blockSize,
    headerLength: p + 1,
    codedNumberStart: 4,
    codedNumberEnd: coded.end,
  };
}

/**
 * The frame without bytes that follow it. mediabunny sizes a file's last packet to the end of the
 * file, so an ID3v1 tag (`TAG` + 125 bytes), an APE tag or zero padding after the last frame ends
 * up inside it; recomputing the CRC-16 over that would bury the real one mid-frame. The CRC-16
 * register over a frame including its own footer is 0, so the end is the LAST position where the
 * register is 0 (an earlier zero inside the audio is a 2^-16-per-byte coincidence that a
 * shortest-prefix rule would hit on large frames), moved back over trailing zero bytes (zero
 * padding keeps the register at 0). Returns `frame` itself when it already ends at its footer;
 * throws when no position checks.
 */
export function trimFlacFrame(frame: Uint8Array): Uint8Array {
  const h = parseFlacFrameHeader(frame);
  const zeroAt: boolean[] = new Array(frame.length + 1).fill(false);
  let crc = 0;
  for (let k = 0; k < frame.length; k++) {
    crc ^= frame[k] << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    zeroAt[k + 1] = crc === 0;
  }
  const minEnd = h.headerLength + 2;
  let end = -1;
  for (let k = frame.length; k >= minEnd; k--) {
    if (zeroAt[k]) {
      end = k;
      break;
    }
  }
  if (end < 0) throw new Error('FLAC frame CRC-16 mismatch');
  while (end - 1 >= minEnd && zeroAt[end - 1] && frame[end - 1] === 0) end--;
  return end === frame.length ? frame : frame.subarray(0, end);
}

/**
 * The same frame in variable-block-size form, starting at `sampleNumber`: blocking bit set,
 * coded number replaced, header CRC-8 and frame CRC-16 recomputed. Subframes are untouched.
 */
export function renumberFlacFrame(input: Uint8Array, sampleNumber: number): Uint8Array {
  const frame = trimFlacFrame(input);
  const h = parseFlacFrameHeader(frame);
  if (frame.length < h.headerLength + 2) throw new Error('FLAC frame truncated');
  const coded = encodeCodedNumber(sampleNumber);
  const tail = frame.subarray(h.codedNumberEnd, h.headerLength - 1); // uncommon size/rate
  const body = frame.subarray(h.headerLength, frame.length - 2); // subframes + padding
  const headerLength = 4 + coded.length + tail.length + 1;
  const out = new Uint8Array(headerLength + body.length + 2);
  out.set(frame.subarray(0, 4), 0);
  out[1] |= 1;
  out.set(coded, 4);
  out.set(tail, 4 + coded.length);
  out[headerLength - 1] = crc8(out.subarray(0, headerLength - 1));
  out.set(body, headerLength);
  const crc = crc16(out.subarray(0, out.length - 2));
  out[out.length - 2] = crc >> 8;
  out[out.length - 1] = crc & 0xff;
  return out;
}
