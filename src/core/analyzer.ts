// The Stillfield analyzer: frames in, report out. Algorithm and every threshold: SPEC.md sections 2 to 5.
import { D65_UV, DEFAULT_RED_BLACK_FLOOR } from './color.ts';
import { GridResampler } from './resample.ts';
import type {
  AnalyzerOptions,
  AreaRule,
  ChannelSummary,
  MediaInfo,
  Reason,
  Rect,
  Report,
  Settings,
  Timeline,
  Verdict,
  WorstWindow,
} from './types.ts';

export const VERSION = '0.1.0';

export const DISCLAIMER =
  'Stillfield screens content against the WCAG 2.2 SC 2.3.1 flash thresholds. It is not medical advice and not a ' +
  'certification. A pass means no flashing over the thresholds was found under the tested conditions; it does ' +
  'not guarantee that content cannot trigger a seizure.';

/** Thresholds (SPEC.md). */
export const GENERAL_DELTA = 0.1;
export const DARK_LIMIT = 0.8;
export const RED_RATIO = 0.8;
export const RED_UV_DELTA = 0.2;
/** 7 transitions in one second is more than three flashes. */
export const FAIL_TRANSITIONS = 7;
export const LIMIT_TRANSITIONS = 6;
export const EXTENDED_TRANSITIONS = 4;
export const EXTENDED_SECONDS = 4;
export const EXTENDED_WINDOW = 5;
/** 10 degree field at the WCAG reference (Note 1), in CSS px. */
export const FIELD_W = 341;
export const FIELD_H = 256;
/** Analysis cell size in CSS px, and block size in cells for the area search. */
export const CELL_CSS = 2;
const BLOCK_CELLS = 2;
/** Transition history kept per cell. Rates above RING / 2 flashes per second are reported as minimums. */
const RING = 16;
const EPS = 1e-6;
/** Reason codes that mean part of the content was not screened (the report is then not complete). */
export const COVERAGE_CODES: readonly Reason['code'][] = ['incomplete', 'sample-rate', 'uncontrolled-content', 'no-frames'];
/** u'v' of pure sRGB red. */
const PURE_RED_UV: readonly [number, number] = (() => {
  const X = 0.4124564, Y = 0.2126729, Z = 0.0193339;
  const d = X + 15 * Y + 3 * Z;
  return [(4 * X) / d, (9 * Y) / d] as const;
})();

export function areaLimitFor(rule: AreaRule, displayW: number, displayH: number): number {
  if (rule === 'frame') return 0.25 * displayW * displayH;
  if (rule === 'understanding') return FIELD_W * FIELD_H;
  return 0.25 * FIELD_W * FIELD_H; // 21,824
}

interface Segment {
  kind: 'general' | 'red';
  level: 'fail' | 'warn';
  code: Reason['code'];
  firstT: number;
  lastT: number;
  peakRate: number;
  peakArea: number;
  peakTime: number;
  rateIsMinimum: boolean;
  region: Rect;
}

/** Per channel (general or red) counting and area state. */
class Channel {
  readonly kind: 'general' | 'red';
  readonly ring: Int32Array; // frame indices of recent transitions
  readonly head: Uint8Array;
  readonly count: Uint8Array;
  readonly hist: Uint16Array; // [(level) * nBlocks + block]
  readonly levelTotal: Int32Array;
  maxLevel = 0;
  /** Highest per cell transition count in any one second window, whatever the area. */
  peakCell = 0;
  // results
  maxRate = 0;
  maxRateMin = false;
  maxAreaOverRate = 0;
  worstTime: number | null = null;
  failSeconds = 0;
  segments: Segment[] = [];
  open: Map<string, Segment> = new Map();
  extendedQueue: { t: number; dt: number }[] = [];
  extendedSum = 0;
  constructor(kind: 'general' | 'red', cells: number, blocks: number) {
    this.kind = kind;
    this.ring = new Int32Array(cells * RING);
    this.head = new Uint8Array(cells);
    this.count = new Uint8Array(cells);
    this.hist = new Uint16Array((RING + 1) * blocks);
    this.levelTotal = new Int32Array(RING + 1);
  }
  push(cell: number, frame: number): void {
    const c = this.count[cell];
    const base = cell * RING;
    if (c < RING) {
      this.ring[base + ((this.head[cell] + c) % RING)] = frame;
      this.count[cell] = c + 1;
    } else {
      // history full: drop the oldest, keep the count saturated
      this.ring[base + this.head[cell]] = frame;
      this.head[cell] = (this.head[cell] + 1) % RING;
    }
  }
  expire(cell: number, times: Float64Array, cutoff: number): number {
    let c = this.count[cell];
    if (c === 0) return 0;
    const base = cell * RING;
    let h = this.head[cell];
    while (c > 0 && times[this.ring[base + h]] <= cutoff) {
      h = (h + 1) % RING;
      c--;
    }
    this.head[cell] = h;
    this.count[cell] = c;
    return c;
  }
}

export class FlashAnalyzer {
  readonly opts: Required<Omit<AnalyzerOptions, 'media' | 'areaLimit'>> & { media?: Partial<MediaInfo> };
  readonly gridW: number;
  readonly gridH: number;
  readonly cellArea: number;
  readonly cellCssW: number;
  readonly cellCssH: number;
  readonly areaLimit: number;
  readonly windowCss: { width: number; height: number };
  private resampler: GridResampler;
  private nCells: number;
  private bW: number;
  private bH: number;
  private winBW: number;
  private winBH: number;
  private sat: Float64Array;
  private cum: Float64Array;
  // luminance zigzag state
  private lAnchor: Float32Array;
  private lExt: Float32Array;
  private lDir: Int8Array;
  private lCounted: Uint8Array;
  // red state: the reference saturated red of the current red run, the non red state farthest from it, the side of
  // the last counted transition (0 none, 1 red, 2 other) and whether the next red sample starts a new red run
  private rRedU: Float32Array;
  private rRedV: Float32Array;
  private rHasRed: Uint8Array;
  private rOthU: Float32Array;
  private rOthV: Float32Array;
  private rHasOth: Uint8Array;
  private rSide: Uint8Array;
  private rFresh: Uint8Array;
  private readonly doRed: boolean;
  private general: Channel;
  private red: Channel;
  private times: Float64Array = new Float64Array(1024);
  private frame = 0;
  private lastT = -Infinity;
  private notes: string[] = [];
  private extra: Reason[] = [];
  private tl: Timeline;
  private perSecond = new Map<number, { general: number; red: number }>();
  private finished: Report | null = null;
  /** Summary of the most recent frame: field rates (transitions) and level 7 areas (CSS px^2). */
  last = { t: 0, generalRate: 0, redRate: 0, generalArea: 0, redArea: 0 };

  constructor(options: AnalyzerOptions) {
    const width = Math.floor(options.width);
    const height = Math.floor(options.height);
    if (!(width > 0 && height > 0)) throw new Error('width and height must be positive');
    const format = options.format ?? 'rgba';
    const displayWidth = options.displayWidth ?? width;
    const displayHeight = options.displayHeight ?? height;
    if (!(displayWidth > 0 && displayHeight > 0)) throw new Error('display size must be positive');
    this.opts = {
      width,
      height,
      format,
      displayWidth,
      displayHeight,
      fps: options.fps ?? 30,
      areaRule: options.areaRule ?? 'wcag',
      redBlackFloor: options.redBlackFloor ?? DEFAULT_RED_BLACK_FLOOR,
      timeline: options.timeline ?? true,
      sampled: options.sampled ?? true,
      media: options.media,
    };
    this.gridW = Math.max(1, Math.ceil(displayWidth / CELL_CSS));
    this.gridH = Math.max(1, Math.ceil(displayHeight / CELL_CSS));
    this.cellCssW = displayWidth / this.gridW;
    this.cellCssH = displayHeight / this.gridH;
    this.cellArea = this.cellCssW * this.cellCssH;
    this.areaLimit = options.areaLimit ?? areaLimitFor(this.opts.areaRule, displayWidth, displayHeight);
    this.nCells = this.gridW * this.gridH;
    this.resampler = new GridResampler(width, height, this.gridW, this.gridH, format);
    this.bW = Math.ceil(this.gridW / BLOCK_CELLS);
    this.bH = Math.ceil(this.gridH / BLOCK_CELLS);
    const blockCssW = this.cellCssW * BLOCK_CELLS;
    const blockCssH = this.cellCssH * BLOCK_CELLS;
    if (this.opts.areaRule === 'frame') {
      this.winBW = this.bW;
      this.winBH = this.bH;
    } else {
      // rounded up to whole blocks, so the search window is never smaller than the field (conservative)
      this.winBW = Math.min(this.bW, Math.max(1, Math.ceil(FIELD_W / blockCssW - 1e-9)));
      this.winBH = Math.min(this.bH, Math.max(1, Math.ceil(FIELD_H / blockCssH - 1e-9)));
    }
    this.windowCss = {
      width: Math.min(displayWidth, this.winBW * blockCssW),
      height: Math.min(displayHeight, this.winBH * blockCssH),
    };
    const nBlocks = this.bW * this.bH;
    this.sat = new Float64Array((this.bW + 1) * (this.bH + 1));
    this.cum = new Float64Array(nBlocks);
    const n = this.nCells;
    this.lAnchor = new Float32Array(n);
    this.lExt = new Float32Array(n);
    this.lDir = new Int8Array(n);
    this.lCounted = new Uint8Array(n);
    this.doRed = format !== 'luminance';
    const rn = this.doRed ? n : 0;
    this.rRedU = new Float32Array(rn);
    this.rRedV = new Float32Array(rn);
    this.rHasRed = new Uint8Array(rn);
    this.rOthU = new Float32Array(rn);
    this.rOthV = new Float32Array(rn);
    this.rHasOth = new Uint8Array(rn);
    this.rSide = new Uint8Array(rn);
    this.rFresh = new Uint8Array(rn);
    this.general = new Channel('general', n, nBlocks);
    this.red = new Channel('red', this.doRed ? n : 0, this.doRed ? nBlocks : 0);
    this.tl = { t: [], generalFlashes: [], redFlashes: [], generalArea: [], redArea: [], meanLuminance: [] };
    if (!this.doRed) this.notes.push('Luminance only input: red flashes were not checked.');
  }

  /**
   * Adds a reason found outside the analyzer (by the source that produced the frames), for example that decoding
   * stopped early or that part of a page could not be controlled. Call before finish(). A `warn` reason makes the
   * verdict at least `warn`; a coverage reason (COVERAGE_CODES) also marks the report as not complete.
   */
  addReason(r: Reason): void {
    if (this.finished) throw new Error('analyzer already finished');
    // a reason that says part of the content was not screened is at least a warning, so a report that is not
    // complete never reads as a plain pass
    this.extra.push(COVERAGE_CODES.includes(r.code) && r.level === 'info' ? { ...r, level: 'warn' } : r);
  }

  /** Number of frames pushed so far. */
  get frames(): number {
    return this.frame;
  }

  /** Per cell transition counts in the last second for the most recent frame (used by the reduced flash filter). */
  cellCounts(): { general: Uint8Array; red: Uint8Array; gridW: number; gridH: number; cellCssW: number; cellCssH: number } {
    return {
      general: this.general.count,
      red: this.red.count,
      gridW: this.gridW,
      gridH: this.gridH,
      cellCssW: this.cellCssW,
      cellCssH: this.cellCssH,
    };
  }

  /**
   * Adds one frame. `t` is its presentation time in seconds; omit it to use frame index / fps.
   * Frames must arrive in time order.
   */
  push(data: ArrayLike<number>, t?: number): void {
    if (this.finished) throw new Error('analyzer already finished');
    let time = t ?? this.frame / this.opts.fps;
    if (!Number.isFinite(time)) throw new Error('frame time must be a finite number');
    if (time <= this.lastT) {
      if (!this.notes.includes('Some frames had non increasing timestamps; they were nudged forward.')) {
        this.notes.push('Some frames had non increasing timestamps; they were nudged forward.');
      }
      time = this.lastT + 1e-4;
    }
    const prevT = this.lastT;
    this.lastT = time;
    const f = this.frame++;
    if (f >= this.times.length) {
      const grown = new Float64Array(this.times.length * 2);
      grown.set(this.times);
      this.times = grown;
    }
    this.times[f] = time;

    this.resampler.run(data);
    const { L, R, G, B } = this.resampler;
    const n = this.nCells;
    const cutoff = time - 1 + EPS;
    const gen = this.general;
    const red = this.red;
    const doRed = this.doRed;
    const floor = this.opts.redBlackFloor;
    const lA = this.lAnchor;
    const lE = this.lExt;
    const lD = this.lDir;
    const lC = this.lCounted;
    const bW = this.bW;
    const gW = this.gridW;
    const nB = bW * this.bH;
    gen.hist.fill(0);
    gen.levelTotal.fill(0);
    gen.maxLevel = 0;
    if (doRed) {
      red.hist.fill(0);
      red.levelTotal.fill(0);
      red.maxLevel = 0;
    }
    let lumSum = 0;
    for (let i = 0; i < n; i++) {
      const v = L[i];
      lumSum += v;
      // ---- general flash: zigzag with onset counting
      if (f === 0) {
        lA[i] = v; // lowest so far while direction unknown
        lE[i] = v; // highest so far
        lD[i] = 0;
        lC[i] = 0;
      } else {
        const d = lD[i];
        if (d === 0) {
          if (v < lA[i]) lA[i] = v;
          if (v > lE[i]) lE[i] = v;
          if (lE[i] - lA[i] >= GENERAL_DELTA) {
            if (v >= lE[i]) {
              lD[i] = 1; // rising from the low
            } else {
              lD[i] = -1; // falling from the high
              const hi = lE[i];
              lE[i] = lA[i];
              lA[i] = hi;
            }
            lC[i] = 0;
          }
        } else if (d === 1) {
          if (v > lE[i]) lE[i] = v;
          else if (lE[i] - v >= GENERAL_DELTA) {
            lA[i] = lE[i];
            lE[i] = v;
            lD[i] = -1;
            lC[i] = 0;
          }
        } else {
          if (v < lE[i]) lE[i] = v;
          else if (v - lE[i] >= GENERAL_DELTA) {
            lA[i] = lE[i];
            lE[i] = v;
            lD[i] = 1;
            lC[i] = 0;
          }
        }
        if (lD[i] !== 0 && lC[i] === 0) {
          const span = lD[i] === 1 ? lE[i] - lA[i] : lA[i] - lE[i];
          const darker = lD[i] === 1 ? lA[i] : lE[i];
          if (span >= GENERAL_DELTA && darker < DARK_LIMIT) {
            lC[i] = 1;
            gen.push(i, f);
          }
        }
      }
      const gc = gen.expire(i, this.times, cutoff);
      const block = ((((i / gW) | 0) / BLOCK_CELLS) | 0) * bW + (((i % gW) / BLOCK_CELLS) | 0);
      gen.hist[gc * nB + block]++;
      gen.levelTotal[gc]++;
      if (gc > gen.maxLevel) gen.maxLevel = gc;

      // ---- red flash: anchor state, WCAG 2.2 working definition
      if (doRed) {
        const r = R[i];
        const g = G[i];
        const b = B[i];
        const s = r + g + b;
        let u: number;
        let w: number;
        let isRed = 0;
        if (s <= 0 || s < floor) {
          u = D65_UV[0];
          w = D65_UV[1];
        } else {
          const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
          const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
          const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
          const den = X + 15 * Y + 3 * Z;
          u = den > 0 ? (4 * X) / den : D65_UV[0];
          w = den > 0 ? (9 * Y) / den : D65_UV[1];
          isRed = r / s >= RED_RATIO ? 1 : 0;
        }
        // A red transition (WCAG 2.2 working definition): a move of more than 0.2 in u'v' between a saturated red
        // state and another state. Each side keeps its extreme (the most saturated red; the other state farthest
        // from that red), and a transition is counted each time the colour crosses to the other side.
        const T2 = RED_UV_DELTA * RED_UV_DELTA;
        if (isRed) {
          const du = u - this.rOthU[i];
          const dv = w - this.rOthV[i];
          if (this.rHasOth[i] && this.rSide[i] !== 1 && du * du + dv * dv > T2) {
            red.push(i, f);
            this.rSide[i] = 1;
            this.rRedU[i] = u;
            this.rRedV[i] = w;
            this.rHasRed[i] = 1;
            this.rFresh[i] = 0;
          } else if (!this.rHasRed[i] || this.rFresh[i]) {
            this.rRedU[i] = u;
            this.rRedV[i] = w;
            this.rHasRed[i] = 1;
            this.rFresh[i] = 0;
          } else {
            const su = u - D65_UV[0], sv = w - D65_UV[1];
            const ou = this.rRedU[i] - D65_UV[0], ov = this.rRedV[i] - D65_UV[1];
            if (su * su + sv * sv > ou * ou + ov * ov) {
              this.rRedU[i] = u;
              this.rRedV[i] = w;
            }
          }
        } else {
          const du = u - this.rRedU[i];
          const dv = w - this.rRedV[i];
          const d2 = du * du + dv * dv;
          if (this.rHasRed[i] && this.rSide[i] !== 2 && d2 > T2) {
            red.push(i, f);
            this.rSide[i] = 2;
            this.rOthU[i] = u;
            this.rOthV[i] = w;
            this.rHasOth[i] = 1;
            this.rFresh[i] = 1;
          } else if (!this.rHasOth[i]) {
            this.rOthU[i] = u;
            this.rOthV[i] = w;
            this.rHasOth[i] = 1;
          } else {
            // keep the other state farthest from the red reference (or from pure red before any red is seen)
            const refU = this.rHasRed[i] ? this.rRedU[i] : PURE_RED_UV[0];
            const refV = this.rHasRed[i] ? this.rRedV[i] : PURE_RED_UV[1];
            const a = (u - refU) ** 2 + (w - refV) ** 2;
            const b = (this.rOthU[i] - refU) ** 2 + (this.rOthV[i] - refV) ** 2;
            if (a > b) {
              this.rOthU[i] = u;
              this.rOthV[i] = w;
            }
          }
        }
        const rc = red.expire(i, this.times, cutoff);
        red.hist[rc * nB + block]++;
        red.levelTotal[rc]++;
        if (rc > red.maxLevel) red.maxLevel = rc;
      }
    }

    if (gen.maxLevel > gen.peakCell) gen.peakCell = gen.maxLevel;
    if (doRed && red.maxLevel > red.peakCell) red.peakCell = red.maxLevel;
    const dt = f === 0 ? 1 / this.opts.fps : time - prevT;
    const g = this.evaluate(gen, time, dt);
    const r = doRed ? this.evaluate(red, time, dt) : { rate: 0, area7: 0 };
    this.last = { t: time, generalRate: g.rate, redRate: r.rate, generalArea: g.area7, redArea: r.area7 };
    if (this.opts.timeline) {
      this.tl.t.push(round(time, 4));
      this.tl.generalFlashes.push(g.rate / 2);
      this.tl.redFlashes.push(r.rate / 2);
      this.tl.generalArea.push(Math.round(g.area7));
      this.tl.redArea.push(Math.round(r.area7));
      this.tl.meanLuminance.push(round(lumSum / n, 4));
    }
    const sec = Math.floor(time + EPS);
    const ps = this.perSecond.get(sec) ?? { general: 0, red: 0 };
    ps.general = Math.max(ps.general, g.rate / 2);
    ps.red = Math.max(ps.red, r.rate / 2);
    this.perSecond.set(sec, ps);
  }

  /** Largest window area of cells with count >= level; fills `best` with its block position. */
  private windowMax(ch: Channel, best: { x: number; y: number }): number {
    const { bW, bH, winBW, winBH, sat, cum } = this;
    const W1 = bW + 1;
    for (let y = 0; y < bH; y++) {
      let row = 0;
      const o = (y + 1) * W1;
      const p = y * W1;
      for (let x = 0; x < bW; x++) {
        row += cum[y * bW + x];
        sat[o + x + 1] = sat[p + x + 1] + row;
      }
    }
    let max = -1;
    for (let y = 0; y + winBH <= bH; y++) {
      for (let x = 0; x + winBW <= bW; x++) {
        const s = sat[(y + winBH) * W1 + x + winBW] - sat[y * W1 + x + winBW] - sat[(y + winBH) * W1 + x] + sat[y * W1 + x];
        if (s > max) {
          max = s;
          best.x = x;
          best.y = y;
        }
      }
    }
    void ch;
    return Math.max(0, max) * this.cellArea;
  }

  private evaluate(ch: Channel, time: number, dt: number): { rate: number; area7: number } {
    const limit = this.areaLimit;
    const nB = this.bW * this.bH;
    const cum = this.cum;
    cum.fill(0);
    let total = 0;
    let rate = 0;
    let area7 = 0;
    const pos = { x: 0, y: 0 };
    let rect7: Rect = { x: 0, y: 0, width: 0, height: 0 };
    let rateRect: Rect = rect7;
    for (let k = ch.maxLevel; k >= 1; k--) {
      const base = k * nB;
      for (let b = 0; b < nB; b++) cum[b] += ch.hist[base + b];
      total += ch.levelTotal[k];
      // Area is needed at level 7 (the WCAG area), and at any level while the field rate is still unknown and the
      // cells at this level could in total exceed the limit.
      const needArea7 = k === FAIL_TRANSITIONS;
      const canExceed = total * this.cellArea > limit;
      if ((rate === 0 && canExceed) || needArea7) {
        const area = total > 0 ? this.windowMax(ch, pos) : 0;
        const rect = this.blockRect(pos.x, pos.y);
        if (k === FAIL_TRANSITIONS) {
          area7 = area;
          rect7 = rect;
        }
        if (rate === 0 && area > limit) {
          rate = k;
          rateRect = rect;
        }
      }
      if (rate !== 0 && k <= FAIL_TRANSITIONS) break;
    }
    // When the rate is found above level 7 the loop still runs down to 7 for the area; below 7 area7 stays 0.
    const rateIsMinimum = rate >= RING;
    if (rate > ch.maxRate) {
      ch.maxRate = rate;
      ch.maxRateMin = rateIsMinimum;
      ch.worstTime = time;
    }
    if (rate >= FAIL_TRANSITIONS) {
      ch.failSeconds += dt;
      if (area7 > ch.maxAreaOverRate) {
        ch.maxAreaOverRate = area7;
        ch.worstTime = time;
      }
    } else if (area7 > ch.maxAreaOverRate) {
      ch.maxAreaOverRate = area7;
    }
    const peak = { rate, area: area7, rect: rate >= FAIL_TRANSITIONS ? rect7 : rateRect, rateIsMinimum };
    // segments
    const kind = ch.kind;
    this.track(ch, `${kind}-flash`, rate >= FAIL_TRANSITIONS, 'fail', time, peak);
    this.track(ch, `${kind}-at-limit`, rate === LIMIT_TRANSITIONS, 'warn', time, peak);
    this.track(ch, `${kind}-near-area`, rate < FAIL_TRANSITIONS && area7 > 0.8 * limit, 'warn', time, {
      ...peak,
      rect: rect7,
    });
    // extended flashing (IRIS extended failure, BT.1702 five second note): warn only
    const q = ch.extendedQueue;
    if (rate >= EXTENDED_TRANSITIONS) {
      q.push({ t: time, dt });
      ch.extendedSum += dt;
    }
    while (q.length && q[0].t <= time - EXTENDED_WINDOW + EPS) ch.extendedSum -= q.shift()!.dt;
    this.track(ch, 'extended-flashing', ch.extendedSum >= EXTENDED_SECONDS - EPS, 'warn', time, peak);
    return { rate, area7 };
  }

  private blockRect(bx: number, by: number): Rect {
    const bw = this.cellCssW * BLOCK_CELLS;
    const bh = this.cellCssH * BLOCK_CELLS;
    const x = bx * bw;
    const y = by * bh;
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(Math.min(this.opts.displayWidth - x, this.winBW * bw)),
      height: Math.round(Math.min(this.opts.displayHeight - y, this.winBH * bh)),
    };
  }

  private track(
    ch: Channel,
    code: string,
    active: boolean,
    level: 'fail' | 'warn',
    time: number,
    peak: { rate: number; area: number; rect: Rect; rateIsMinimum: boolean },
  ): void {
    const open = ch.open.get(code);
    if (active) {
      if (open && time - open.lastT <= 0.5 + EPS) {
        open.lastT = time;
        if (peak.rate > open.peakRate || (peak.rate === open.peakRate && peak.area > open.peakArea)) {
          open.peakRate = peak.rate;
          open.peakArea = peak.area;
          open.peakTime = time;
          open.region = peak.rect;
          open.rateIsMinimum = peak.rateIsMinimum;
        }
      } else {
        const seg: Segment = {
          kind: ch.kind,
          level,
          code: code as Reason['code'],
          firstT: time,
          lastT: time,
          peakRate: peak.rate,
          peakArea: peak.area,
          peakTime: time,
          rateIsMinimum: peak.rateIsMinimum,
          region: peak.rect,
        };
        ch.segments.push(seg);
        ch.open.set(code, seg);
      }
    }
  }

  /** Finishes the analysis and returns the report. */
  finish(): Report {
    if (this.finished) return this.finished;
    const frames = this.frame;
    const first = frames ? this.times[0] : 0;
    const last = frames ? this.times[frames - 1] : 0;
    const duration = frames > 1 ? last - first + (last - first) / (frames - 1) : frames ? 1 / this.opts.fps : 0;
    const fps = frames > 1 ? (frames - 1) / (last - first) : this.opts.fps;
    const reasons: Reason[] = [];
    const windows: WorstWindow[] = [];
    const describe = (s: Segment): string => {
      const fl = fmtRate(s.peakRate, s.rateIsMinimum);
      const area = Math.round(s.peakArea).toLocaleString('en-US');
      const lim = Math.round(this.areaLimit).toLocaleString('en-US');
      const what = s.kind === 'general' ? 'general (luminance) flashes' : 'red flashes';
      switch (s.code) {
        case 'general-flash':
        case 'red-flash':
          return `${fl} ${what} per second over ${area} CSS px (limit ${lim} CSS px in any ${this.windowLabel()}).`;
        case 'general-at-limit':
        case 'red-at-limit':
          return `Exactly 3 ${what} per second over an area above the limit. WCAG allows 3; timing differences can push this over.`;
        case 'general-near-area':
        case 'red-near-area':
          return `More than 3 ${what} per second over ${area} CSS px, ${Math.round((100 * s.peakArea) / this.areaLimit)}% of the area limit.`;
        case 'extended-flashing':
          return `Two or more ${what} per second for 4 s or more within 5 s. Not a WCAG rule (IRIS and ITU-R BT.1702 treat sustained flashing as a risk).`;
        default:
          return s.code;
      }
    };
    for (const ch of [this.general, this.red]) {
      // "At the limit" and "near the area limit" warnings inside or next to a failing stretch only repeat it
      // (the rate passes through 3 flashes a second on its way up), so they are dropped there.
      const fails = ch.segments.filter((s) => s.level === 'fail');
      const segments = ch.segments.filter(
        (s) =>
          s.level === 'fail' ||
          s.code === 'extended-flashing' ||
          !fails.some((f) => s.firstT <= f.lastT + 1 + EPS && s.lastT >= f.firstT - 1 - EPS),
      );
      for (const s of segments) {
        // a condition seen at time t is about the second (or, for extended flashing, the 5 s) before t
        const start = Math.max(first, s.firstT - (s.code === 'extended-flashing' ? EXTENDED_SECONDS + 1 : 1));
        const code: Reason['code'] = s.code === 'extended-flashing' ? 'extended-flashing' : s.code;
        reasons.push({
          code,
          level: s.level,
          message: describe(s),
          start: round(start, 3),
          end: round(s.lastT, 3),
          peakFlashesPerSecond: s.peakRate / 2,
          peakArea: Math.round(s.peakArea),
        });
        if (s.code !== 'extended-flashing') {
          windows.push({
            kind: s.kind,
            level: s.level,
            start: round(start, 3),
            end: round(s.lastT, 3),
            peakFlashesPerSecond: s.peakRate / 2,
            rateIsMinimum: s.rateIsMinimum,
            peakArea: Math.round(s.peakArea),
            peakTime: round(s.peakTime, 3),
            region: s.region,
          });
        }
      }
    }
    const extendedCount = reasons.filter((r) => r.code === 'extended-flashing').length;
    if (extendedCount > 1) {
      // keep the reasons, they are per channel; nothing to merge
    }
    if (frames > 1 && fps < 20) {
      reasons.push(
        this.opts.sampled
          ? {
              code: 'low-frame-rate',
              level: 'warn',
              message: `Sampled at ${fps.toFixed(1)} fps, under 20 fps; flashing between the samples can be missed.`,
            }
          : {
              code: 'low-frame-rate',
              level: 'info',
              message: `The content has ${fps.toFixed(1)} frames a second; every frame was screened.`,
            },
      );
    }
    // A frame smaller than the area limit can never fail at the size it was screened at, however hard it flashes.
    // Shown larger (chat apps, full width images, lightboxes) the same flashing can fail.
    // The warning fires only when the area that flashed fast, scaled up to the largest likely display size (the
    // frame fitted into 1024 x 768), would exceed the limit: one tiny blinking detail does not trigger it.
    const displayArea = this.opts.displayWidth * this.opts.displayHeight;
    const peakCell = Math.max(this.general.peakCell, this.red.peakCell);
    const grow = Math.min(1024 / this.opts.displayWidth, 768 / this.opts.displayHeight) ** 2;
    const fastArea = Math.max(this.general.maxAreaOverRate, this.red.maxAreaOverRate);
    const scaledArea = fastArea * Math.max(1, grow);
    if (displayArea <= this.areaLimit && peakCell >= FAIL_TRANSITIONS && scaledArea > this.areaLimit) {
      const which = this.general.maxAreaOverRate >= this.red.maxAreaOverRate ? 'general' : 'red';
      reasons.push({
        code: 'small-frame',
        level: 'warn',
        message:
          `The whole frame (${this.opts.displayWidth} x ${this.opts.displayHeight} CSS px, ` +
          `${Math.round(displayArea).toLocaleString('en-US')} CSS px) is smaller than the area limit ` +
          `(${Math.round(this.areaLimit).toLocaleString('en-US')} CSS px), so it cannot fail at this size, but ${which} ` +
          `flashing reached ${fmtRate(peakCell, peakCell >= RING)} a second over ${Math.round(fastArea).toLocaleString('en-US')} CSS px; ` +
          `fitted to a 1024 x 768 screen that would be up to about ${Math.round(scaledArea).toLocaleString('en-US')} CSS px. ` +
          `Screen it at the size it is shown (--display WIDTHxHEIGHT).`,
        peakFlashesPerSecond: peakCell / 2,
      });
    }
    if (frames === 0) {
      reasons.push({ code: 'no-frames', level: 'warn', message: 'No frames were screened.' });
    } else if (duration < 1) {
      reasons.push({
        code: 'too-short',
        level: 'info',
        message: `Only ${duration.toFixed(2)} s of content was screened; the per second rule needs at least 1 s (loop short clips).`,
      });
    }
    reasons.push(...this.extra);
    const levelRank = { fail: 0, warn: 1, info: 2 } as const;
    reasons.sort((a, b) => levelRank[a.level] - levelRank[b.level] || (a.start ?? 0) - (b.start ?? 0));
    windows.sort(
      (a, b) =>
        levelRank[a.level] - levelRank[b.level] ||
        b.peakFlashesPerSecond - a.peakFlashesPerSecond ||
        b.peakArea - a.peakArea,
    );
    const wcagFail = this.general.segments.some((s) => s.level === 'fail') || this.red.segments.some((s) => s.level === 'fail');
    let verdict: Verdict = 'pass';
    if (wcagFail) verdict = 'fail';
    else if (reasons.some((r) => r.level === 'warn')) verdict = 'warn';
    const summary = (ch: Channel): ChannelSummary => ({
      maxFlashesPerSecond: ch.maxRate / 2,
      rateIsMinimum: ch.maxRateMin,
      maxAreaOverRate: Math.round(ch.maxAreaOverRate),
      maxAreaRatio: round(ch.maxAreaOverRate / this.areaLimit, 3),
      worstTime: ch.worstTime === null ? null : round(ch.worstTime, 3),
      failSeconds: round(ch.failSeconds, 3),
    });
    const settings: Settings = {
      areaRule: this.opts.areaRule,
      areaLimit: Math.round(this.areaLimit),
      window: { width: Math.round(this.windowCss.width), height: Math.round(this.windowCss.height) },
      display: { width: this.opts.displayWidth, height: this.opts.displayHeight },
      grid: { width: this.gridW, height: this.gridH, cellCss: CELL_CSS },
      thresholds: {
        generalDelta: GENERAL_DELTA,
        darkLimit: DARK_LIMIT,
        redRatio: RED_RATIO,
        redUvDelta: RED_UV_DELTA,
        redBlackFloor: this.opts.redBlackFloor,
        failTransitions: FAIL_TRANSITIONS,
        extendedTransitions: EXTENDED_TRANSITIONS,
        extendedSeconds: EXTENDED_SECONDS,
        extendedWindow: EXTENDED_WINDOW,
      },
    };
    const m = this.opts.media ?? {};
    const media: MediaInfo = {
      source: m.source ?? 'frames',
      kind: m.kind ?? 'frames',
      width: m.width ?? this.opts.width,
      height: m.height ?? this.opts.height,
      fps: round(m.fps ?? fps, 3),
      frames: m.frames ?? frames,
      duration: round(m.duration ?? duration, 3),
      notes: [...(m.notes ?? []), ...this.notes],
    };
    const perSecond = [...this.perSecond.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([second, v]) => ({ second, general: v.general, red: v.red }));
    this.finished = {
      schema: 'stillfield/report@1',
      tool: { name: 'stillfield', version: VERSION },
      verdict,
      wcag231: wcagFail ? 'fail' : 'pass',
      complete: !reasons.some((r) => COVERAGE_CODES.includes(r.code)),
      reasons,
      general: summary(this.general),
      red: summary(this.red),
      worstWindows: windows,
      perSecond,
      timeline: this.opts.timeline ? this.tl : undefined,
      settings,
      media,
      disclaimer: DISCLAIMER,
    };
    return this.finished;
  }

  private windowLabel(): string {
    if (this.opts.areaRule === 'frame') return 'frame';
    return `${FIELD_W} x ${FIELD_H} CSS px field`;
  }
}

function round(v: number, d: number): number {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}

function fmtRate(transitions: number, min: boolean): string {
  const f = transitions / 2;
  const s = Number.isInteger(f) ? String(f) : f.toFixed(1);
  return min ? `${s} or more` : s;
}

/** Convenience: analyse an array of frames. */
export function analyzeFrames(
  frames: Iterable<{ data: ArrayLike<number>; t?: number }>,
  options: AnalyzerOptions,
): Report {
  const a = new FlashAnalyzer(options);
  for (const fr of frames) a.push(fr.data, fr.t);
  return a.finish();
}
