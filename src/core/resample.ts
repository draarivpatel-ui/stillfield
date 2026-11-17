// Area averaging resampler from frame pixels to the analysis grid, in linear light.
import { SRGB_TO_LINEAR } from './color.ts';
import type { PixelFormat } from './types.ts';

interface Axis {
  /** For each source index: start offset into `targets`/`weights`. */
  start: Int32Array;
  count: Int32Array;
  targets: Int32Array;
  weights: Float32Array;
}

/** Builds source to target contributions for one axis (box filter, exact fractional coverage). */
function buildAxis(src: number, dst: number): Axis {
  const per: { t: number; w: number }[][] = Array.from({ length: src }, () => []);
  const scale = src / dst;
  for (let t = 0; t < dst; t++) {
    const a = t * scale;
    const b = (t + 1) * scale;
    for (let s = Math.floor(a); s < Math.ceil(b) && s < src; s++) {
      const w = Math.min(b, s + 1) - Math.max(a, s);
      if (w > 1e-9) per[s].push({ t, w: w / scale });
    }
  }
  const start = new Int32Array(src);
  const count = new Int32Array(src);
  let n = 0;
  for (let s = 0; s < src; s++) {
    start[s] = n;
    count[s] = per[s].length;
    n += per[s].length;
  }
  const targets = new Int32Array(n);
  const weights = new Float32Array(n);
  for (let s = 0, k = 0; s < src; s++) for (const c of per[s]) {
    targets[k] = c.t;
    weights[k++] = c.w;
  }
  return { start, count, targets, weights };
}

export class GridResampler {
  readonly srcW: number;
  readonly srcH: number;
  readonly gridW: number;
  readonly gridH: number;
  readonly format: PixelFormat;
  private ax: Axis;
  private ay: Axis;
  private rowR: Float32Array;
  private rowG: Float32Array;
  private rowB: Float32Array;
  /** Output, linear light per cell. For `luminance` input only `L` is filled. */
  readonly R: Float32Array;
  readonly G: Float32Array;
  readonly B: Float32Array;
  readonly L: Float32Array;

  constructor(srcW: number, srcH: number, gridW: number, gridH: number, format: PixelFormat) {
    this.srcW = srcW;
    this.srcH = srcH;
    this.gridW = gridW;
    this.gridH = gridH;
    this.format = format;
    this.ax = buildAxis(srcW, gridW);
    this.ay = buildAxis(srcH, gridH);
    this.rowR = new Float32Array(gridW);
    this.rowG = new Float32Array(gridW);
    this.rowB = new Float32Array(gridW);
    const n = gridW * gridH;
    this.R = new Float32Array(n);
    this.G = new Float32Array(n);
    this.B = new Float32Array(n);
    this.L = new Float32Array(n);
  }

  /** Resamples one frame. `data` is Uint8 RGBA/RGB (sRGB) or Float32 linear luminance. */
  run(data: ArrayLike<number>): void {
    const { srcW, srcH, gridW, ax, ay, rowR, rowG, rowB, R, G, B, L } = this;
    const lut = SRGB_TO_LINEAR;
    const lumOnly = this.format === 'luminance';
    const stride = this.format === 'rgba' ? 4 : this.format === 'rgb' ? 3 : 1;
    if (data.length < srcW * srcH * stride) {
      throw new Error(`frame has ${data.length} values, expected ${srcW * srcH * stride}`);
    }
    R.fill(0);
    G.fill(0);
    B.fill(0);
    L.fill(0);
    for (let sy = 0; sy < srcH; sy++) {
      rowR.fill(0);
      if (!lumOnly) {
        rowG.fill(0);
        rowB.fill(0);
      }
      let p = sy * srcW * stride;
      for (let sx = 0; sx < srcW; sx++, p += stride) {
        const s0 = ax.start[sx];
        const s1 = s0 + ax.count[sx];
        if (lumOnly) {
          const v = data[p];
          for (let k = s0; k < s1; k++) rowR[ax.targets[k]] += v * ax.weights[k];
        } else {
          const r = lut[data[p]];
          const g = lut[data[p + 1]];
          const b = lut[data[p + 2]];
          for (let k = s0; k < s1; k++) {
            const t = ax.targets[k];
            const w = ax.weights[k];
            rowR[t] += r * w;
            rowG[t] += g * w;
            rowB[t] += b * w;
          }
        }
      }
      const y0 = ay.start[sy];
      const y1 = y0 + ay.count[sy];
      for (let k = y0; k < y1; k++) {
        const base = ay.targets[k] * gridW;
        const w = ay.weights[k];
        if (lumOnly) {
          for (let x = 0; x < gridW; x++) L[base + x] += rowR[x] * w;
        } else {
          for (let x = 0; x < gridW; x++) {
            R[base + x] += rowR[x] * w;
            G[base + x] += rowG[x] * w;
            B[base + x] += rowB[x] * w;
          }
        }
      }
    }
    if (!lumOnly) {
      for (let i = 0; i < L.length; i++) L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    }
  }
}
