// Reads a video's own frame timing from its container without playing it: MP4 and MOV (stts sample durations) and
// WebM or Matroska (the video track's DefaultDuration). Returns null when the file does not say (fragmented MP4,
// WebM from MediaRecorder, other containers); the page then warns that frames may have been missed.

export interface FrameRate {
  /** Typical frame rate (from the median frame duration). */
  fps: number;
  /** Fastest rate held for at least 3 frames in a row; above fps for variable frame rate. */
  maxFps: number;
  container: 'mp4' | 'webm';
}

const MAX_MOOV = 64 << 20;

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let head = 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = u64(b, p + 8);
      head = 16;
    } else if (size === 0) size = to - p;
    if (size < head || p + size > to) break;
    out.push({ type, start: p + head, end: p + size });
    p += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box, type: string) => boxes(b, box.start, box.end).find((x) => x.type === type);

/** Frame durations of the first video track of an MP4 or MOV, in its timescale. */
export function mp4Rate(moov: Uint8Array): FrameRate | null {
  const top = { type: 'moov', start: 0, end: moov.length };
  for (const trak of boxes(moov, top.start, top.end).filter((x) => x.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = child(moov, mdia, 'hdlr');
    if (!hdlr || fourcc(moov, hdlr.start + 8) !== 'vide') continue;
    const mdhd = child(moov, mdia, 'mdhd');
    if (!mdhd) return null;
    const timescale = moov[mdhd.start] === 1 ? u32(moov, mdhd.start + 20) : u32(moov, mdhd.start + 12);
    const stbl = (() => {
      const minf = child(moov, mdia, 'minf');
      return minf ? child(moov, minf, 'stbl') : undefined;
    })();
    const stts = stbl ? child(moov, stbl, 'stts') : undefined;
    if (!timescale || !stts) return null;
    const n = u32(moov, stts.start + 4);
    const entries: { count: number; delta: number }[] = [];
    let frames = 0;
    for (let i = 0; i < n && stts.start + 8 + i * 8 + 8 <= stts.end; i++) {
      const count = u32(moov, stts.start + 8 + i * 8);
      const delta = u32(moov, stts.start + 12 + i * 8);
      if (count && delta) {
        entries.push({ count, delta });
        frames += count;
      }
    }
    if (!frames) return null; // fragmented MP4: the sample table lives in the fragments
    // Fastest rate held for at least 3 frames in a row: over every run of 3 consecutive frames, the longest of the
    // three durations, and the shortest such run. A short burst counts however rare it is; one glitch does not.
    // Cutting each stts entry to at most 3 frames keeps every distinct run of 3.
    const seq: number[] = [];
    for (const e of entries) for (let i = 0; i < Math.min(e.count, 3); i++) seq.push(e.delta);
    let fastest = Infinity;
    for (let i = 0; i + 3 <= seq.length; i++) fastest = Math.min(fastest, Math.max(seq[i], seq[i + 1], seq[i + 2]));
    if (!Number.isFinite(fastest)) fastest = Math.min(...seq);
    entries.sort((a, b) => a.delta - b.delta);
    const at = (q: number): number => {
      const k = Math.floor(q * (frames - 1));
      let seen = 0;
      for (const e of entries) {
        seen += e.count;
        if (seen > k) return e.delta;
      }
      return entries[entries.length - 1].delta;
    };
    const fps = timescale / at(0.5);
    return { fps, maxFps: Math.max(fps, timescale / fastest), container: 'mp4' };
  }
  return null;
}

// ---------------------------------------------------------------- EBML (WebM, Matroska)

function vint(b: Uint8Array, p: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || p + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const DEFAULT_DURATION = 0x23e383;
const CLUSTER = 0x1f43b675;

export function webmRate(b: Uint8Array): FrameRate | null {
  const walk = (from: number, to: number): FrameRate | null | 'stop' => {
    let p = from;
    while (p < to) {
      const id = vint(b, p, true);
      if (!id) return 'stop';
      const size = vint(b, p + id.len, false);
      if (!size) return 'stop';
      const start = p + id.len + size.len;
      const end = size.unknown ? to : Math.min(to, start + size.value);
      if (id.value === CLUSTER) return 'stop';
      if (id.value === SEGMENT || id.value === TRACKS) {
        const r = walk(start, end);
        if (r) return r;
      } else if (id.value === TRACK_ENTRY) {
        let type = 0;
        let dur = 0;
        let q = start;
        while (q < end) {
          const cid = vint(b, q, true);
          const cs = cid && vint(b, q + cid.len, false);
          if (!cid || !cs || cs.unknown) break;
          const cstart = q + cid.len + cs.len;
          let v = 0;
          for (let i = 0; i < cs.value && i < 8; i++) v = v * 256 + b[cstart + i];
          if (cid.value === TRACK_TYPE) type = v;
          if (cid.value === DEFAULT_DURATION) dur = v;
          q = cstart + cs.value;
        }
        if (type === 1) return dur > 0 ? { fps: 1e9 / dur, maxFps: 1e9 / dur, container: 'webm' } : 'stop';
      }
      if (size.unknown) return 'stop';
      p = end;
    }
    return null;
  };
  const r = walk(0, b.length);
  return r === 'stop' ? null : r;
}

export async function detectFrameRate(blob: Blob): Promise<FrameRate | null> {
  try {
    const head = await bytes(blob, 0, 16);
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      return webmRate(await bytes(blob, 0, 4 << 20));
    }
    if (fourcc(head, 4) !== 'ftyp' && fourcc(head, 4) !== 'moov' && fourcc(head, 4) !== 'wide' && fourcc(head, 4) !== 'mdat') return null;
    // walk the top level boxes by reading only their headers, then read moov whole
    let p = 0;
    while (p + 8 <= blob.size) {
      const h = await bytes(blob, p, p + 16);
      let size = u32(h, 0);
      const type = fourcc(h, 4);
      let head2 = 8;
      if (size === 1) {
        size = u64(h, 8);
        head2 = 16;
      } else if (size === 0) size = blob.size - p;
      if (size < head2) return null;
      if (type === 'moov') {
        if (size > MAX_MOOV) return null;
        return mp4Rate(await bytes(blob, p + head2, p + size));
      }
      p += size;
    }
    return null;
  } catch {
    return null;
  }
}
