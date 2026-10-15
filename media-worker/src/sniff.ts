// Container detection from the first bytes of a blob (media-worker design D4). The worker never
// lets ffmpeg probe: it forces the demuxer this returns, so a playlist (HLS), an ffconcat script,
// an SDP file or any other format ffmpeg would follow to a second file is refused here.

/** The demuxer allowlist: Matroska/WebM, Ogg, MP4/MOV, WAV, FLAC, MP3. */
export type Demuxer = 'matroska' | 'ogg' | 'mov' | 'wav' | 'flac' | 'mp3';
export const DEMUXERS: readonly Demuxer[] = ['matroska', 'ogg', 'mov', 'wav', 'flac', 'mp3'];

/** Bytes the sniff and the Opus header scan read. */
export const SNIFF_BYTES = 64 * 1024;

const ascii = (h: Uint8Array, at: number, s: string): boolean => {
  if (h.length < at + s.length) return false;
  for (let i = 0; i < s.length; i += 1) if (h[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** An MPEG audio frame header (MPEG 1/2/2.5, layer I-III) with a valid bitrate and rate index.
 * ADTS AAC shares the 12-bit sync but has layer bits 00, so it is not taken for MP3. */
function isMpegAudioFrame(h: Uint8Array): boolean {
  if (h.length < 4 || h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) return false;
  const version = (h[1] >> 3) & 3; // 01 reserved
  const layer = (h[1] >> 1) & 3; // 00 reserved (ADTS)
  const bitrate = h[2] >> 4; // 1111 bad
  const rate = (h[2] >> 2) & 3; // 11 reserved
  return version !== 1 && layer !== 0 && bitrate !== 0xf && rate !== 3;
}

/** The forced demuxer for a blob's first bytes, or null (refused: `decode-failed`). */
export function sniffContainer(head: Uint8Array): Demuxer | null {
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return 'matroska';
  }
  if (ascii(head, 0, 'OggS')) return 'ogg';
  if (ascii(head, 4, 'ftyp')) return 'mov';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return 'wav';
  if (ascii(head, 0, 'fLaC')) return 'flac';
  if (ascii(head, 0, 'ID3')) return 'mp3';
  if (isMpegAudioFrame(head)) return 'mp3';
  return null;
}

export type MoovOrder = 'moov-first' | 'moov-last' | 'no-moov';

/** Walks the top-level MP4 boxes: `moov` before any `mdat` can be demuxed from a pipe; `moov`
 * after `mdat` needs a seekable input (the `file:` exception, D4). A malformed box list or a file
 * without `moov` is `no-moov` (refused). `read(pos, len)` returns at most `len` bytes. */
export async function mp4MoovOrder(
  read: (pos: number, len: number) => Promise<Uint8Array>,
  size: number,
): Promise<MoovOrder> {
  let pos = 0;
  let sawMdat = false;
  for (let boxes = 0; pos + 8 <= size && boxes < 10_000; boxes += 1) {
    const h = await read(pos, 16);
    if (h.length < 8) return 'no-moov';
    const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let len = view.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (len === 1) {
      if (h.length < 16) return 'no-moov';
      const big = view.getBigUint64(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return 'no-moov';
      len = Number(big);
      if (len < 16) return 'no-moov';
    } else if (len === 0) {
      len = size - pos;
    } else if (len < 8) {
      return 'no-moov';
    }
    if (pos + len > size) return 'no-moov';
    if (type === 'moov') return sawMdat ? 'moov-last' : 'moov-first';
    if (type === 'mdat') sawMdat = true;
    pos += len;
  }
  return 'no-moov';
}

/** The OpusHead pre-skip (samples at 48 kHz the decoder drops at the start), found in the first
 * bytes of a WebM (CodecPrivate) or Ogg (first packet) file; null when there is no OpusHead. */
export function opusPreSkip(head: Uint8Array): number | null {
  const magic = 'OpusHead';
  outer: for (let i = 0; i + 19 <= head.length; i += 1) {
    for (let j = 0; j < magic.length; j += 1)
      if (head[i + j] !== magic.charCodeAt(j)) continue outer;
    return head[i + 10] | (head[i + 11] << 8);
  }
  return null;
}
