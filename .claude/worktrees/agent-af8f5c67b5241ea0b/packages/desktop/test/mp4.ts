// Reads what Record's checks need from an MP4: the video track's codec, size, frame count,
// keyframes and duration, straight from the boxes. Used by `record.test.ts` and by
// `scripts/record-check.mjs`, which records a real clip in Electron.

export interface Mp4Info {
  /** The `ftyp` major brand, such as `isom`. */
  brand: string;
  /** The sample entry of the video track, `avc1` for H.264. */
  codec: string;
  width: number;
  height: number;
  /** Video samples, one per frame. */
  frames: number;
  /** Sync samples (keyframes); equal to `frames` when the file has no `stss` box. */
  keyframes: number;
  /** The video track's duration in ms, from `mdhd`. */
  durationMs: number;
  /** Frames per second from the sample durations. */
  fps: number;
  /** True when `moov` comes before `mdat`, so players start before the whole file loads. */
  fastStart: boolean;
}

interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

function boxes(v: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = v.getUint32(at);
    const type = String.fromCharCode(
      v.getUint8(at + 4),
      v.getUint8(at + 5),
      v.getUint8(at + 6),
      v.getUint8(at + 7),
    );
    let body = at + 8;
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < 8 || at + size > end) throw new Error(`bad box ${type} at ${at}`);
    out.push({ type, start: at, end: at + size, body });
    at += size;
  }
  return out;
}

function child(v: DataView, parent: Box, type: string): Box {
  const found = boxes(v, parent.body, parent.end).find((b) => b.type === type);
  if (!found) throw new Error(`no ${type} in ${parent.type}`);
  return found;
}

/** Parses `bytes` as an MP4 and describes its first video track. Throws on a malformed file. */
export function mp4Info(bytes: Uint8Array): Mp4Info {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(v, 0, bytes.byteLength);
  const ftyp = top.find((b) => b.type === 'ftyp');
  if (!ftyp || top[0] !== ftyp) throw new Error('no ftyp box first');
  const brand = String.fromCharCode(...bytes.subarray(ftyp.body, ftyp.body + 4));
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  if (!moov || !mdat) throw new Error('no moov or mdat box');

  for (const trak of boxes(v, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = child(v, trak, 'mdia');
    const hdlr = child(v, mdia, 'hdlr');
    if (String.fromCharCode(...bytes.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'vide') continue;

    const tkhd = child(v, trak, 'tkhd');
    const tkVersion = v.getUint8(tkhd.body);
    // Width and height are 16.16 fixed point at the end of tkhd.
    const wAt = tkhd.body + (tkVersion === 1 ? 88 : 76);
    const width = v.getUint32(wAt) / 65536;
    const height = v.getUint32(wAt + 4) / 65536;

    const mdhd = child(v, mdia, 'mdhd');
    const mdVersion = v.getUint8(mdhd.body);
    const timescale = v.getUint32(mdhd.body + (mdVersion === 1 ? 20 : 12));
    const duration =
      mdVersion === 1 ? Number(v.getBigUint64(mdhd.body + 24)) : v.getUint32(mdhd.body + 16);

    const stbl = child(v, child(v, mdia, 'minf'), 'stbl');
    const stsd = child(v, stbl, 'stsd');
    const entry = boxes(v, stsd.body + 8, stsd.end)[0];
    if (!entry) throw new Error('no sample entry');
    const stsz = child(v, stbl, 'stsz');
    const frames = v.getUint32(stsz.body + 8);
    const stss = boxes(v, stbl.body, stbl.end).find((b) => b.type === 'stss');
    const keyframes = stss ? v.getUint32(stss.body + 4) : frames;

    const durationMs = (duration / timescale) * 1000;
    return {
      brand,
      codec: entry.type,
      width,
      height,
      frames,
      keyframes,
      durationMs,
      fps: durationMs > 0 ? Math.round((frames * 1000 * 100) / durationMs) / 100 : 0,
      fastStart: moov.start < mdat.start,
    };
  }
  throw new Error('no video track');
}
