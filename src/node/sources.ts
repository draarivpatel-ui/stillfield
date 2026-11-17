// Opens a video, GIF, PNG sequence or web page as a stream of frames with the display size to screen it at.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { PNG } from 'pngjs';
import { decodeGif, loopGifFrames } from '../core/gif.ts';
import type { MediaInfo, Reason } from '../core/types.ts';
import { decodeVideo, probe } from './ffmpeg.ts';
import type { DecodeStatus } from './ffmpeg.ts';

export type DisplaySpec = 'auto' | 'native' | 'fullscreen' | { width: number; height: number };

export interface OpenOptions {
  display?: DisplaySpec;
  /** Frame rate for PNG sequences and web pages. */
  fps?: number;
  /** Seconds to record a web page. */
  duration?: number;
  /** Seconds to let a web page settle before recording. */
  settle?: number;
  /** Analyse GIFs while looping (default true). */
  loop?: boolean;
  /** Background for transparent GIF and PNG pixels (default white). */
  background?: [number, number, number];
  /** Stop reading a video after this many seconds. */
  maxSeconds?: number;
}

export interface Source {
  kind: MediaInfo['kind'];
  source: string;
  /** Size of the frames this source yields. */
  width: number;
  height: number;
  format: 'rgb' | 'rgba';
  /** Size to screen at, CSS px. */
  display: { width: number; height: number };
  fps: number;
  /** Pixel size of the media itself (after display rotation), for the report. */
  mediaSize?: { width: number; height: number };
  notes: string[];
  /** True when the frames are samples Stillfield took (page capture); false when they are the content's own frames. */
  sampled: boolean;
  /** What the file says it holds, to check after decoding that nothing is missing. */
  expected?: { duration: number | null; frames: number | null; capped: boolean };
  /** Filled in while decoding (video only). */
  status?: DecodeStatus;
  /** Reasons the source found while producing frames (read after the frames have been consumed). */
  reasons?: import('../core/types.ts').Reason[];
  frames: AsyncIterable<{ data: Uint8Array; t: number }>;
}

export const REFERENCE = { width: 1024, height: 768 };

export function parseDisplay(s: string | undefined): DisplaySpec {
  if (!s || s === 'auto') return 'auto';
  if (s === 'native' || s === 'fullscreen') return s;
  const m = /^(\d+)\s*[x,]\s*(\d+)$/i.exec(s.trim());
  if (!m) throw new Error(`--display must be WIDTHxHEIGHT, native, fullscreen or auto (got "${s}")`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 1 || height < 1) throw new Error(`--display width and height must be at least 1 CSS px (got "${s}")`);
  return { width, height };
}

/** Largest size with the same aspect ratio that fits inside the 1024 x 768 reference screen. */
export function fitReference(w: number, h: number): { width: number; height: number } {
  const k = Math.min(REFERENCE.width / w, REFERENCE.height / h);
  return { width: Math.max(2, Math.round(w * k)), height: Math.max(2, Math.round(h * k)) };
}

function resolveDisplay(spec: DisplaySpec, w: number, h: number, kind: MediaInfo['kind']): { width: number; height: number } {
  if (typeof spec === 'object') return spec;
  if (spec === 'native') return { width: w, height: h };
  if (spec === 'fullscreen') return fitReference(w, h);
  // auto: video full screen at the reference size; GIFs and images at their own size (SPEC.md section 4)
  return kind === 'video' ? fitReference(w, h) : { width: w, height: h };
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^file:\/\//i.test(s);
}

const IMAGE_EXT = new Set(['.png', '.apng']);

export async function openSource(input: string, opts: OpenOptions = {}): Promise<Source> {
  const display = opts.display ?? 'auto';
  if (isUrl(input) || /\.html?$/i.test(input)) {
    const { openUrl } = await import('./url.ts');
    return openUrl(input, opts);
  }
  const st = statSync(input);
  if (st.isDirectory()) return openPngSequence(input, display, opts.fps ?? 30, opts.background);
  const ext = extname(input).toLowerCase();
  if (ext === '.gif') return openGif(input, display, opts);
  if (IMAGE_EXT.has(ext)) return openPngSequence(input, display, opts.fps ?? 30, opts.background);
  return openVideo(input, display, opts);
}

async function openVideo(file: string, display: DisplaySpec, opts: OpenOptions): Promise<Source> {
  const info = probe(file);
  const d = resolveDisplay(display, info.width, info.height, 'video');
  // decode straight at the display size (even numbers keep every pixel format happy)
  const width = Math.max(2, Math.round(d.width / 2) * 2);
  const height = Math.max(2, Math.round(d.height / 2) * 2);
  const notes: string[] = [];
  if (/smpte2084|arib-std-b67/i.test(info.transfer) || /bt2020/i.test(info.primaries)) {
    notes.push(
      `HDR or wide gamut source (${info.transfer || info.primaries}); converted to sRGB by ffmpeg without tone mapping, so luminance values are approximate. WCAG asks for HDR to be tested against ITU-R BT.1702.`,
    );
  }
  if (info.rotation) notes.push(`The video carries a ${info.rotation} degree display rotation; it was screened as shown (${info.width} x ${info.height}).`);
  notes.push('Decoded by ffmpeg and treated as sRGB.');
  const status: DecodeStatus = { frames: 0, lastT: 0, lastEnd: null, exitCode: null, errors: [] };
  const capped = !!opts.maxSeconds && info.videoDuration !== null && info.videoDuration > opts.maxSeconds;
  return {
    kind: 'video',
    source: file,
    width,
    height,
    format: 'rgb',
    display: d,
    fps: info.fps,
    mediaSize: { width: info.width, height: info.height },
    notes,
    sampled: false,
    expected: {
      duration: capped ? opts.maxSeconds! : info.videoDuration,
      frames: capped ? null : info.frames,
      capped,
    },
    status,
    frames: decodeVideo(file, width, height, { maxSeconds: opts.maxSeconds, fps: info.fps, status }),
  };
}

function openGif(file: string, display: DisplaySpec, opts: OpenOptions): Source {
  const gif = decodeGif(new Uint8Array(readFileSync(file)), { background: opts.background });
  const d = resolveDisplay(display, gif.width, gif.height, 'gif');
  const loop = opts.loop ?? true;
  const seq = loop
    ? loopGifFrames(gif)
    : (() => {
        let t = 0;
        const s = gif.frames.map((_, i) => {
          const e = { frame: i, t };
          t += gif.delays[i];
          return e;
        });
        if (gif.frames.length > 1) s.push({ frame: gif.frames.length - 1, t: t - 1e-3 });
        return s;
      })();
  const notes: string[] = [];
  const total = gif.delays.reduce((a, b) => a + b, 0);
  if (loop && gif.loopCount !== null && gif.frames.length > 1) {
    notes.push(`GIF screened while looping: ${(seq[seq.length - 1].t).toFixed(2)} s, ${Math.round(seq[seq.length - 1].t / total)} loops of ${total.toFixed(2)} s.`);
  } else if (gif.frames.length > 1) {
    notes.push(`GIF plays once (${total.toFixed(2)} s).`);
  }
  if (gif.delayClamped) {
    notes.push('Some frame delays were 0 or 0.01 s; screened at 0.1 s as browsers play them. Other players may show them faster.');
  }
  if (gif.transparent) notes.push('The GIF has transparent pixels; they were screened over the background colour (white unless --background is set).');
  const reasons: Reason[] = [];
  if (gif.truncated) {
    reasons.push({
      code: 'incomplete',
      level: 'warn',
      message: `The GIF does not end with its trailer, so it was probably cut short; ${gif.frames.length} frames were read and later frames may be missing.`,
    });
  }
  const frames = (async function* () {
    for (const s of seq) yield { data: gif.frames[s.frame], t: s.t };
  })();
  const fps = gif.frames.length / Math.max(total, 1e-3);
  return { kind: 'gif', source: file, width: gif.width, height: gif.height, format: 'rgba', display: d, fps, notes, sampled: false, reasons, frames };
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * True when a PNG file is an animated PNG (an acTL chunk before the first IDAT). pngjs decodes only the default
 * image of an APNG, so its animation would go unscreened.
 */
export function isApng(buf: Uint8Array): boolean {
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    p += 12 + len;
  }
  return false;
}

function readPng(file: string): PNG {
  const buf = readFileSync(file);
  if (isApng(buf)) {
    throw new Error(
      `${basename(file)} is an animated PNG (APNG). Stillfield cannot screen APNG animation yet; it does not report a ` +
        'result for it. Convert it to a looping GIF (for example `ffmpeg -f apng -i in.png -loop 0 out.gif`) and screen that.',
    );
  }
  return PNG.sync.read(buf);
}

/** Composites RGBA over a background colour; returns RGB and whether any pixel was not opaque. */
function flatten(rgba: Uint8Array, bg: [number, number, number]): { rgb: Uint8Array; transparent: boolean } {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  let transparent = false;
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    const a = rgba[p + 3];
    if (a === 255) {
      rgb[q] = rgba[p];
      rgb[q + 1] = rgba[p + 1];
      rgb[q + 2] = rgba[p + 2];
    } else {
      transparent = true;
      // straight alpha over the background, in sRGB values as browsers composite images
      rgb[q] = Math.round((rgba[p] * a + bg[0] * (255 - a)) / 255);
      rgb[q + 1] = Math.round((rgba[p + 1] * a + bg[1] * (255 - a)) / 255);
      rgb[q + 2] = Math.round((rgba[p + 2] * a + bg[2] * (255 - a)) / 255);
    }
  }
  return { rgb, transparent };
}

function openPngSequence(path: string, display: DisplaySpec, fps: number, background?: [number, number, number]): Source {
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort(naturalSort).map((f) => join(path, f))
    : [path];
  if (!files.length) throw new Error(`no .png files in ${path}`);
  const first = readPng(files[0]);
  const d = resolveDisplay(display, first.width, first.height, 'images');
  const bg = background ?? [255, 255, 255];
  const notes = [`${files.length} PNG file${files.length === 1 ? '' : 's'} at ${fps} fps.`];
  let noted = false;
  const frames = (async function* () {
    for (let i = 0; i < files.length; i++) {
      const png = i === 0 ? first : readPng(files[i]);
      if (png.width !== first.width || png.height !== first.height) {
        throw new Error(`${basename(files[i])} is ${png.width} x ${png.height}, expected ${first.width} x ${first.height}`);
      }
      const f = flatten(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), bg);
      if (f.transparent && !noted) {
        noted = true;
        notes.push(
          `The PNG files have transparent pixels; they were screened over ${background ? `#${bg.map((v) => v.toString(16).padStart(2, '0')).join('')}` : 'white'} (set the colour they are shown on with --background).`,
        );
      }
      yield { data: f.rgb, t: i / fps };
    }
  })();
  return {
    kind: 'images',
    source: path,
    width: first.width,
    height: first.height,
    format: 'rgb',
    display: d,
    fps,
    notes,
    sampled: false,
    frames,
  };
}
