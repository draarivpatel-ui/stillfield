// Synthetic clips with known answers (the proof set). Pure, and runs in the browser: frames are generated in memory.
// Rates are chosen so every toggle lands on a whole frame (no rounding is being tested by accident).
import { SRGB_TO_LINEAR, linearToSrgb8 } from './color.ts';

export type RGB = [number, number, number];

export interface Region {
  /** Rectangle in CSS px at the clip's display size. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** What the region does. */
  kind: 'square' | 'sine' | 'cut' | 'noise' | 'stripes-pan' | 'text-scroll' | 'static';
  a: RGB;
  b?: RGB;
  /** Flashes per second (square, sine), cut time in seconds (cut), pan or scroll speed in CSS px per s. */
  rate?: number;
  /** Phase offset in half periods (square), e.g. 1 = counter phase. */
  phase?: number;
  /** Noise amplitude in 8 bit steps (noise), stripe width in CSS px (stripes-pan). */
  amount?: number;
  /** Seed for noise. */
  seed?: number;
  /** Draw the region only while t < until (seconds). */
  until?: number;
}

export interface ClipSpec {
  name: string;
  description: string;
  /** Native pixel size of the generated frames. */
  width: number;
  height: number;
  /** Size the clip is screened at, CSS px. */
  displayWidth: number;
  displayHeight: number;
  fps: number;
  duration: number;
  background: RGB;
  regions: Region[];
  /** Expected result; `null` for characterisation clips whose result is recorded, not asserted. */
  expect: { wcag231: 'pass' | 'fail'; verdict: 'pass' | 'warn' | 'fail'; codes?: string[] } | null;
}

export interface ClipFrame {
  data: Uint8Array; // RGB
  t: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixLinear(a: RGB, b: RGB, w: number): RGB {
  return [0, 1, 2].map((i) => linearToSrgb8(SRGB_TO_LINEAR[a[i]] * (1 - w) + SRGB_TO_LINEAR[b[i]] * w)) as RGB;
}

/** Generates the frames of a clip as RGB at its native size. */
export function* generateClip(spec: ClipSpec): Generator<ClipFrame> {
  const { width: W, height: H, fps } = spec;
  const sx = W / spec.displayWidth;
  const sy = H / spec.displayHeight;
  const n = Math.round(spec.duration * fps);
  const rngs = spec.regions.map((r) => mulberry32(r.seed ?? 1));
  for (let f = 0; f < n; f++) {
    const t = f / fps;
    const data = new Uint8Array(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      data[p * 3] = spec.background[0];
      data[p * 3 + 1] = spec.background[1];
      data[p * 3 + 2] = spec.background[2];
    }
    spec.regions.forEach((r, ri) => {
      if (r.until !== undefined && t >= r.until - 1e-9) return;
      const x0 = Math.round(r.x * sx);
      const y0 = Math.round(r.y * sy);
      const x1 = Math.round((r.x + r.w) * sx);
      const y1 = Math.round((r.y + r.h) * sy);
      const b = r.b ?? r.a;
      let solid: RGB | null = null;
      if (r.kind === 'static') solid = r.a;
      else if (r.kind === 'square') {
        // a flash is two toggles: the state flips 2 * rate times a second
        const state = Math.floor(t * 2 * (r.rate ?? 1) + 1e-9 + (r.phase ?? 0)) % 2;
        solid = state === 0 ? r.a : b;
      } else if (r.kind === 'sine') {
        const w = (1 - Math.cos(2 * Math.PI * (r.rate ?? 1) * t + Math.PI * (r.phase ?? 0))) / 2;
        solid = mixLinear(r.a, b, w);
      } else if (r.kind === 'cut') {
        solid = t < (r.rate ?? 1) ? r.a : b;
      }
      const rng = rngs[ri];
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const p = (y * W + x) * 3;
          let c: RGB;
          if (solid) c = solid;
          else if (r.kind === 'noise') {
            const amt = r.amount ?? 4;
            c = [0, 1, 2].map((i) => clamp8(r.a[i] + Math.round((rng() * 2 - 1) * amt))) as RGB;
            if (r.b) c = [rng() < 0.5 ? r.a[0] : clamp8(r.a[0] + 1 + Math.floor(rng() * amt)), r.a[1], r.a[2]];
          } else if (r.kind === 'stripes-pan') {
            const sw = r.amount ?? 16; // stripe width, CSS px
            const cssX = x / sx + (r.rate ?? 100) * t;
            c = Math.floor(cssX / sw) % 2 === 0 ? r.a : b;
          } else {
            // text-scroll: rows of "glyph" blocks (3 x 5 CSS px strokes) scrolling up
            const cssX = x / sx;
            const cssY = y / sy + (r.rate ?? 200) * t;
            const line = Math.floor(cssY / 16);
            const inLine = cssY - line * 16;
            const col = Math.floor(cssX / 8);
            const h = mulberry32((line * 7919 + col * 104729) >>> 0)();
            const glyph = inLine >= 3 && inLine < 13 && cssX - col * 8 < 6 && h < 0.8;
            const stroke = glyph && (Math.floor(cssX) + Math.floor(cssY)) % 3 !== 0;
            c = stroke ? b : r.a;
          }
          data[p] = c[0];
          data[p + 1] = c[1];
          data[p + 2] = c[2];
        }
      }
    });
    yield { data, t };
  }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];
const RED: RGB = [255, 0, 0];
/** Grey with relative luminance close to pure red's 0.2126, so red to grey is a red flash but not a general one. */
const RED_MATCH_GREY: RGB = [127, 127, 127];

/** Full screen at the WCAG reference: 1024 x 768 CSS px, generated at a quarter size. */
const FULL = { width: 256, height: 192, displayWidth: 1024, displayHeight: 768 };
const full = (r: Partial<Region> & Pick<Region, 'kind' | 'a'>): Region => ({ x: 0, y: 0, w: 1024, h: 768, ...r });

/** The proof set. Expectations follow SPEC.md; `expect: null` clips are characterised, not asserted. */
export const CLIPS: ClipSpec[] = [
  {
    name: 'pass-full-2hz',
    description: 'Full screen black and white, 2 flashes a second, 3 s',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [full({ kind: 'square', a: BLACK, b: WHITE, rate: 2 })],
    expect: { wcag231: 'pass', verdict: 'pass' },
  },
  {
    name: 'fail-full-4hz',
    description: 'Full screen black and white, 4 flashes a second, 3 s',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [full({ kind: 'square', a: BLACK, b: WHITE, rate: 4 })],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['general-flash'] },
  },
  {
    name: 'fail-full-5hz-30fps',
    description: 'Full screen black and white, 5 flashes a second at 30 fps, 3 s',
    ...FULL, fps: 30, duration: 3, background: BLACK,
    regions: [full({ kind: 'square', a: BLACK, b: WHITE, rate: 5 })],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['general-flash'] },
  },
  {
    name: 'pass-small-4hz',
    description: '4 flashes a second in a 100 x 100 CSS px square (10,000 CSS px, 46% of the limit)',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [{ x: 400, y: 300, w: 100, h: 100, kind: 'square', a: BLACK, b: WHITE, rate: 4 }],
    expect: { wcag231: 'pass', verdict: 'pass' },
  },
  {
    name: 'fail-red-4hz',
    description: 'Saturated red and a grey of the same luminance, 4 flashes a second: red rule only',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [full({ kind: 'square', a: RED, b: RED_MATCH_GREY, rate: 4 })],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['red-flash'] },
  },
  {
    name: 'fail-red-pink-start',
    description: 'Red and grey at 4 flashes a second, starting on one pink frame that is within 0.2 u\'v\' of both',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [full({ kind: 'square', a: RED, b: RED_MATCH_GREY, rate: 4 }), full({ kind: 'static', a: [255, 100, 100], until: 1 / 24 })],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['red-flash'] },
  },
  {
    name: 'fail-red-smooth-4hz',
    description: 'Smooth (sine) fades between saturated red and grey at 4 flashes a second: multi frame red transitions',
    ...FULL, fps: 48, duration: 3, background: BLACK,
    regions: [full({ kind: 'sine', a: RED, b: RED_MATCH_GREY, rate: 4 })],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['red-flash'] },
  },
  {
    name: 'pass-slow-fade',
    description: 'Full screen smooth fade black to white and back, 1 flash a second, 6 s',
    ...FULL, fps: 30, duration: 6, background: BLACK,
    regions: [full({ kind: 'sine', a: BLACK, b: WHITE, rate: 1 })],
    expect: { wcag231: 'pass', verdict: 'pass' },
  },
  {
    name: 'fail-smooth-4hz',
    description: 'Full screen smooth (sine) fades at 4 flashes a second: each transition spans several frames',
    ...FULL, fps: 48, duration: 3, background: BLACK,
    regions: [full({ kind: 'sine', a: BLACK, b: WHITE, rate: 4 })],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['general-flash'] },
  },
  {
    name: 'borderline-3hz-full',
    description: 'Full screen, exactly 3 flashes a second: allowed by WCAG, flagged as at the limit',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [full({ kind: 'square', a: BLACK, b: WHITE, rate: 3 })],
    expect: { wcag231: 'pass', verdict: 'warn', codes: ['general-at-limit'] },
  },
  {
    name: 'borderline-area-under',
    description: '4 flashes a second over 136 x 136 CSS px (18,496 CSS px, 85% of the limit)',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [{ x: 400, y: 300, w: 136, h: 136, kind: 'square', a: BLACK, b: WHITE, rate: 4 }],
    expect: { wcag231: 'pass', verdict: 'warn', codes: ['general-near-area'] },
  },
  {
    name: 'borderline-area-over',
    description: '4 flashes a second over 160 x 160 CSS px (25,600 CSS px, 117% of the limit)',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [{ x: 400, y: 300, w: 160, h: 160, kind: 'square', a: BLACK, b: WHITE, rate: 4 }],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['general-flash'] },
  },
  {
    name: 'fail-counterphase',
    description: 'Two 120 x 120 CSS px squares side by side, 4 flashes a second in counter phase (frame mean stays flat)',
    ...FULL, fps: 24, duration: 3, background: [128, 128, 128],
    regions: [
      { x: 300, y: 300, w: 120, h: 120, kind: 'square', a: BLACK, b: WHITE, rate: 4 },
      { x: 420, y: 300, w: 120, h: 120, kind: 'square', a: BLACK, b: WHITE, rate: 4, phase: 1 },
    ],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['general-flash'] },
  },
  {
    name: 'fail-counterphase-halves',
    description: 'Left and right halves of the screen flashing 4 times a second in counter phase: the frame mean never changes',
    ...FULL, fps: 24, duration: 3, background: BLACK,
    regions: [
      { x: 0, y: 0, w: 512, h: 768, kind: 'square', a: BLACK, b: WHITE, rate: 4 },
      { x: 512, y: 0, w: 512, h: 768, kind: 'square', a: BLACK, b: WHITE, rate: 4, phase: 1 },
    ],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['general-flash'] },
  },
  {
    name: 'fail-half-field',
    description: '4 flashes a second over 344 x 128 CSS px (half of one 10 degree field) in a static 1024 x 768 frame',
    ...FULL, fps: 24, duration: 3, background: [40, 40, 40],
    regions: [{ x: 100, y: 100, w: 344, h: 128, kind: 'square', a: BLACK, b: WHITE, rate: 4 }],
    expect: { wcag231: 'fail', verdict: 'fail', codes: ['general-flash'] },
  },
  {
    name: 'pass-bright-flicker',
    description: 'Full screen flicker between luminance 0.85 and 1.0 at 5 flashes a second: darker state above 0.8',
    ...FULL, fps: 30, duration: 3, background: BLACK,
    regions: [full({ kind: 'square', a: [237, 237, 237], b: WHITE, rate: 5 })],
    expect: { wcag231: 'pass', verdict: 'pass' },
  },
  {
    name: 'pass-small-change',
    description: 'Full screen flicker with a luminance change of about 0.08 at 5 flashes a second',
    ...FULL, fps: 30, duration: 3, background: BLACK,
    regions: [full({ kind: 'square', a: [100, 100, 100], b: [125, 125, 125], rate: 5 })],
    expect: { wcag231: 'pass', verdict: 'pass' },
  },
  {
    name: 'pass-single-cut',
    description: 'A single hard cut from black to white',
    ...FULL, fps: 30, duration: 3, background: BLACK,
    regions: [full({ kind: 'cut', a: BLACK, b: WHITE, rate: 1.5 })],
    expect: { wcag231: 'pass', verdict: 'pass' },
  },
  {
    name: 'pass-dark-chroma-noise',
    description: 'Near black with random red tinted noise (H.264 style), every frame: must not read as red flashing',
    ...FULL, fps: 30, duration: 3, background: BLACK,
    regions: [full({ kind: 'noise', a: [0, 0, 0], b: [0, 0, 0], amount: 6, seed: 7 })],
    expect: { wcag231: 'pass', verdict: 'pass' },
  },
  {
    name: 'pass-film-grain',
    description: 'Mid grey with random grain of plus or minus 6 steps every frame',
    ...FULL, fps: 30, duration: 3, background: BLACK,
    regions: [full({ kind: 'noise', a: [128, 128, 128], amount: 6, seed: 3 })],
    expect: { wcag231: 'pass', verdict: 'pass' },
  },
  {
    name: 'warn-extended-2.5hz',
    description: 'Full screen, 2.5 flashes a second for 8 s: passes WCAG, sustained flashing warning (IRIS fails it)',
    ...FULL, fps: 30, duration: 8, background: BLACK,
    regions: [full({ kind: 'square', a: BLACK, b: WHITE, rate: 2.5 })],
    expect: { wcag231: 'pass', verdict: 'warn', codes: ['extended-flashing'] },
  },
  {
    name: 'char-pan-stripes',
    description: 'Characterisation: full screen 16 CSS px black and white stripes panning at 160 CSS px per s',
    ...FULL, fps: 30, duration: 3, background: BLACK,
    regions: [full({ kind: 'stripes-pan', a: BLACK, b: WHITE, rate: 160, amount: 16 })],
    expect: null,
  },
  {
    name: 'char-text-scroll',
    description: 'Characterisation: full screen dark text on white scrolling at 600 CSS px per s',
    ...FULL, width: 512, height: 384, fps: 30, duration: 3, background: WHITE,
    regions: [full({ kind: 'text-scroll', a: WHITE, b: [20, 20, 20], rate: 600 })],
    expect: null,
  },
];
