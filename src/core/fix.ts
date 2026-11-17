// Reduced flash filter (SPEC.md section 7): adaptive temporal filtering in the sense of ITU-R BT.1702 Annex 4.
// Where a cell has flashed in the last second, the output follows a slow moving average of the input instead of
// the input itself. Elsewhere the input passes through unchanged.
import { FlashAnalyzer } from './analyzer.ts';
import { LINEAR_TO_SRGB_4096, SRGB_TO_LINEAR } from './color.ts';

export interface FixOptions {
  width: number;
  height: number;
  format?: 'rgb' | 'rgba';
  displayWidth?: number;
  displayHeight?: number;
  /** Time constant of the moving average, seconds (default 1). */
  tau?: number;
  /** Transitions in the last second that switch the filter on for a cell (default 2, one flash). */
  trigger?: number;
  /** Seconds for the filter to fade out after a cell stops flashing (default 1). */
  release?: number;
  /** Neighbourhood, in analysis cells, that a flashing cell switches on (default 4 cells = 8 CSS px). */
  spread?: number;
  fps?: number;
}

export class ReducedFlashFilter {
  private readonly w: number;
  private readonly h: number;
  private readonly stride: number;
  private readonly tau: number;
  private readonly trigger: number;
  private readonly release: number;
  private readonly spread: number;
  private readonly analyzer: FlashAnalyzer;
  private readonly ema: Float32Array;
  private readonly weight: Float32Array; // per cell
  private readonly target: Uint8Array;
  private readonly tmp: Uint8Array;
  private readonly cellOfX: Int32Array;
  private readonly cellOfY: Int32Array;
  private lastT: number | null = null;
  private readonly fps: number;
  /** Fraction of output pixels that were filtered in the last frame, for reporting. */
  lastCoverage = 0;
  framesTouched = 0;

  constructor(o: FixOptions) {
    this.w = o.width;
    this.h = o.height;
    this.stride = o.format === 'rgba' ? 4 : 3;
    this.tau = o.tau ?? 1;
    this.trigger = o.trigger ?? 2;
    this.release = o.release ?? 1;
    this.spread = o.spread ?? 4;
    this.fps = o.fps ?? 30;
    this.analyzer = new FlashAnalyzer({
      width: o.width,
      height: o.height,
      format: o.format ?? 'rgb',
      displayWidth: o.displayWidth ?? o.width,
      displayHeight: o.displayHeight ?? o.height,
      timeline: false,
    });
    const { gridW, gridH } = this.analyzer;
    this.ema = new Float32Array(o.width * o.height * 3);
    this.weight = new Float32Array(gridW * gridH);
    this.target = new Uint8Array(gridW * gridH);
    this.tmp = new Uint8Array(gridW * gridH);
    this.cellOfX = new Int32Array(o.width);
    this.cellOfY = new Int32Array(o.height);
    for (let x = 0; x < o.width; x++) this.cellOfX[x] = Math.min(gridW - 1, Math.floor((x * gridW) / o.width));
    for (let y = 0; y < o.height; y++) this.cellOfY[y] = Math.min(gridH - 1, Math.floor((y * gridH) / o.height)) * gridW;
  }

  /** Filters one frame. Returns a new buffer in the same layout. */
  process(data: Uint8Array, t?: number): Uint8Array {
    const time = t ?? (this.lastT === null ? 0 : this.lastT + 1 / this.fps);
    const dt = this.lastT === null ? 1 / this.fps : Math.max(1e-4, time - this.lastT);
    const first = this.lastT === null;
    this.lastT = time;
    this.analyzer.push(data, time);
    const { general, red, gridW, gridH } = this.analyzer.cellCounts();
    // which cells are flashing
    const trig = this.trigger;
    const target = this.target;
    for (let i = 0; i < target.length; i++) target[i] = general[i] >= trig || (red.length && red[i] >= trig) ? 1 : 0;
    // spread with a separable max filter
    const r = this.spread;
    const tmp = this.tmp;
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        let m = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(gridW - 1, x + r) && !m; k++) m = target[y * gridW + k];
        tmp[y * gridW + x] = m;
      }
    }
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        let m = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(gridH - 1, y + r) && !m; k++) m = tmp[k * gridW + x];
        target[y * gridW + x] = m;
      }
    }
    // weights ramp in over 2 frames and fade out over `release` seconds
    const wt = this.weight;
    const down = dt / this.release;
    let on = 0;
    for (let i = 0; i < wt.length; i++) {
      wt[i] = target[i] ? Math.min(1, wt[i] + 0.5) : Math.max(0, wt[i] - down);
      if (wt[i] > 0) on++;
    }
    this.lastCoverage = on / wt.length;
    if (on) this.framesTouched++;
    const a = first ? 1 : 1 - Math.exp(-dt / this.tau);
    const out = new Uint8Array(data.length);
    const lut = SRGB_TO_LINEAR;
    const enc = LINEAR_TO_SRGB_4096;
    const ema = this.ema;
    const s = this.stride;
    const W = this.w;
    for (let y = 0; y < this.h; y++) {
      const cy = this.cellOfY[y];
      for (let x = 0; x < W; x++) {
        const pi = y * W + x;
        const p = pi * s;
        const e = pi * 3;
        const w = wt[cy + this.cellOfX[x]];
        for (let c = 0; c < 3; c++) {
          const lin = lut[data[p + c]];
          const m = ema[e + c] + a * (lin - ema[e + c]);
          ema[e + c] = m;
          if (w > 0) {
            const v = w * m + (1 - w) * lin;
            out[p + c] = enc[Math.max(0, Math.min(4096, Math.round(v * 4096)))];
          } else out[p + c] = data[p + c];
        }
        if (s === 4) out[p + 3] = data[p + 3];
      }
    }
    return out;
  }
}
