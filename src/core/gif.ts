// GIF decoding with frame disposal, on top of omggif (MIT). Works in Node and the browser.
import omggif from 'omggif';

export interface GifFrames {
  width: number;
  height: number;
  /** Composited RGBA frames (straight alpha already flattened onto `background`). */
  frames: Uint8Array[];
  /** Display duration of each frame in seconds, after browser style clamping. */
  delays: number[];
  /** omggif loop count: null means play once, 0 means loop forever, n means n extra loops. */
  loopCount: number | null;
  /** True when at least one delay of 0 or 0.01 s was raised to 0.1 s. */
  delayClamped: boolean;
  /** True when any shown pixel was transparent (and so took the background colour). */
  transparent: boolean;
  /**
   * True when the block structure stops before the GIF trailer (0x3B): the file was probably cut short, possibly
   * at a frame boundary, so frames may be missing. Bytes after the trailer are ignored, as GIF readers do.
   */
  truncated: boolean;
}

/**
 * Decodes every frame of a GIF. Transparent pixels are composited onto `background` (sRGB, default white, the
 * usual page colour). Frame delays of 0 or 1 hundredth of a second are played at 100 ms by common browsers, so they
 * are raised to 0.1 s; pass `clampDelays: false` to keep the encoded values (0 becomes 0.1 s regardless).
 */
export function decodeGif(
  bytes: Uint8Array,
  opts: { background?: [number, number, number]; clampDelays?: boolean } = {},
): GifFrames {
  const bg = opts.background ?? [255, 255, 255];
  const clamp = opts.clampDelays ?? true;
  const reader = new omggif.GifReader(bytes as unknown as ConstructorParameters<typeof omggif.GifReader>[0]);
  const width = reader.width;
  const height = reader.height;
  const n = reader.numFrames();
  const canvas = new Uint8Array(width * height * 4); // transparent black
  let saved: Uint8Array | null = null;
  const frames: Uint8Array[] = [];
  const delays: number[] = [];
  let delayClamped = false;
  let transparent = false;
  for (let i = 0; i < n; i++) {
    const info = reader.frameInfo(i);
    if (info.disposal === 3) saved = canvas.slice();
    reader.decodeAndBlitFrameRGBA(i, canvas as unknown as number[]);
    // flatten onto the background
    const out = new Uint8Array(width * height * 4);
    for (let p = 0; p < canvas.length; p += 4) {
      const a = canvas[p + 3] / 255;
      if (a < 1) transparent = true;
      out[p] = Math.round(canvas[p] * a + bg[0] * (1 - a));
      out[p + 1] = Math.round(canvas[p + 1] * a + bg[1] * (1 - a));
      out[p + 2] = Math.round(canvas[p + 2] * a + bg[2] * (1 - a));
      out[p + 3] = 255;
    }
    frames.push(out);
    let cs = info.delay;
    if (cs <= 1 && (clamp || cs === 0)) {
      if (clamp) delayClamped = true;
      cs = 10;
    }
    delays.push(cs / 100);
    if (info.disposal === 2) {
      for (let y = info.y; y < info.y + info.height && y < height; y++) {
        for (let x = info.x; x < info.x + info.width && x < width; x++) {
          const p = (y * width + x) * 4;
          canvas[p] = canvas[p + 1] = canvas[p + 2] = canvas[p + 3] = 0;
        }
      }
    } else if (info.disposal === 3 && saved) {
      canvas.set(saved);
    }
  }
  let loopCount: number | null = null;
  try {
    const lc = reader.loopCount();
    loopCount = lc === undefined ? null : lc;
  } catch {
    loopCount = null;
  }
  const truncated = !reachesTrailer(bytes);
  return { width, height, frames, delays, loopCount, delayClamped, transparent, truncated };
}

/**
 * Timestamps for analysing a GIF while looping (Understanding 2.3.1). A looping GIF is played for at least
 * `minLoops` full loops and at least `minSeconds`, so the last to first frame wrap is included. A GIF that plays
 * once is played once.
 */
export function loopGifFrames(
  gif: GifFrames,
  minSeconds = 6,
  minLoops = 2,
): { frame: number; t: number }[] {
  const total = gif.delays.reduce((a, b) => a + b, 0);
  const loops = gif.loopCount === null || gif.frames.length < 2
    ? 1
    : gif.loopCount === 0
      ? Math.max(minLoops, Math.ceil(minSeconds / Math.max(total, 1e-3)))
      : Math.min(gif.loopCount + 1, Math.max(minLoops, Math.ceil(minSeconds / Math.max(total, 1e-3))));
  const out: { frame: number; t: number }[] = [];
  let t = 0;
  for (let l = 0; l < loops; l++) {
    for (let i = 0; i < gif.frames.length; i++) {
      out.push({ frame: i, t });
      t += gif.delays[i];
    }
  }
  // a final sample at the end of the last frame, so the last frame's display time is counted
  if (gif.frames.length > 1) out.push({ frame: gif.frames.length - 1, t: t - 1e-3 });
  return out;
}

/**
 * Walks the GIF block structure (header, colour tables, extensions, images) and says whether it reaches the trailer
 * block. Anything after the trailer is not looked at.
 */
export function reachesTrailer(b: Uint8Array): boolean {
  if (b.length < 13) return false;
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 0x07) + 1));
  const subBlocks = (): boolean => {
    while (p < b.length) {
      const n = b[p++];
      if (n === 0) return true;
      p += n;
    }
    return false;
  };
  while (p < b.length) {
    const id = b[p++];
    if (id === 0x3b) return true;
    if (id === 0x21) {
      p++; // label
      if (!subBlocks()) return false;
    } else if (id === 0x2c) {
      if (p + 9 > b.length) return false;
      const flags = b[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1));
      p++; // LZW minimum code size
      if (!subBlocks()) return false;
    } else {
      return false;
    }
  }
  return false;
}
