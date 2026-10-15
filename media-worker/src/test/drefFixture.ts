// Builds `packages/transcription/fixtures/audio/seg-aac-dref.m4a` (media-worker task W.2): a
// moov-last AAC MP4 (seg-aac.m4a remuxed by the pinned ffmpeg, `-c copy`) plus a second audio
// track whose data reference is a Mac `alis` record naming `sentinel.m4a` one level relative to
// the file (`nlvl_from = nlvl_to = 1`). With external references enabled, ffmpeg's mov demuxer
// opens `<input dir>/sentinel.m4a`; the worker disables them, so a decode reads only the file.

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function box(type: string, payload: Buffer): Buffer {
  return Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);
}

interface Box {
  type: string;
  start: number;
  end: number;
}

function children(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    const size = buf.readUInt32BE(o);
    if (size < 8 || o + size > end) throw new Error('bad box');
    out.push({ type: buf.toString('latin1', o + 4, o + 8), start: o, end: o + size });
    o += size;
  }
  return out;
}

/** The `alis` dref entry ffmpeg's mov_read_dref parses (size > 150; a type-2 path TLV). */
function aliasEntry(filename: string): Buffer {
  const rec = Buffer.alloc(150);
  // offsets relative to the end of the entry's 12-byte header (size, 'alis', version/flags)
  // skip 10; volume len (1) + volume (27); skip 12; filename len (1) + filename (63); skip 16;
  // nlvl_from (2), nlvl_to (2); skip 16 → 150 bytes, then TLVs.
  rec.writeUInt8(0, 10);
  const name = Buffer.from(filename, 'latin1');
  rec.writeUInt8(name.length, 50);
  name.copy(rec, 51);
  rec.writeUInt16BE(1, 130);
  rec.writeUInt16BE(1, 132);
  const path = Buffer.from(`/fixture/${filename}`, 'latin1');
  const padded = path.length % 2 ? Buffer.concat([path, Buffer.alloc(1)]) : path;
  const tlv = Buffer.concat([
    Buffer.from([0, 2]),
    Buffer.from([path.length >> 8, path.length & 0xff]),
    padded,
    Buffer.from([0xff, 0xff, 0, 0]),
  ]);
  const body = Buffer.concat([u32(0), rec, tlv]); // version/flags 0 = not self-contained
  return Buffer.concat([u32(8 + body.length), Buffer.from('alis', 'latin1'), body]);
}

/** Rebuilds `trak` with `tkhd.track_id = trackId` and its `dref` replaced by one alias entry. */
function aliasTrak(buf: Buffer, trak: Box, trackId: number, filename: string): Buffer {
  const rebuild = (b: Box): Buffer => {
    const payload = buf.subarray(b.start + 8, b.end);
    if (b.type === 'tkhd') {
      const p = Buffer.from(payload);
      const version = p[0];
      p.writeUInt32BE(trackId, version === 1 ? 4 + 16 : 4 + 8);
      return box('tkhd', p);
    }
    if (b.type === 'dref') {
      return box('dref', Buffer.concat([u32(0), u32(1), aliasEntry(filename)]));
    }
    if (['trak', 'mdia', 'minf', 'dinf'].includes(b.type)) {
      return box(b.type, Buffer.concat(children(buf, b.start + 8, b.end).map(rebuild)));
    }
    return Buffer.from(buf.subarray(b.start, b.end));
  };
  return rebuild(trak);
}

/** `mp4` must be a non-fragmented file with `moov` after `mdat`, so offsets do not move. */
export function addAliasTrack(mp4: Buffer, filename = 'sentinel.m4a'): Buffer {
  const top = children(mp4, 0, mp4.length);
  const moovIdx = top.findIndex((b) => b.type === 'moov');
  const mdatIdx = top.findIndex((b) => b.type === 'mdat');
  if (moovIdx < 0 || mdatIdx < 0 || moovIdx < mdatIdx) throw new Error('need a moov-last MP4');
  const moov = top[moovIdx];
  const kids = children(mp4, moov.start + 8, moov.end);
  const trak = kids.find((k) => k.type === 'trak');
  if (!trak) throw new Error('no trak');
  const parts = kids.map((k) => {
    if (k.type !== 'mvhd') return Buffer.from(mp4.subarray(k.start, k.end));
    const p = Buffer.from(mp4.subarray(k.start + 8, k.end));
    p.writeUInt32BE(3, p.length - 4); // next_track_ID
    return box('mvhd', p);
  });
  const newMoov = box('moov', Buffer.concat([...parts, aliasTrak(mp4, trak, 2, filename)]));
  return Buffer.concat([mp4.subarray(0, moov.start), newMoov, mp4.subarray(moov.end)]);
}
