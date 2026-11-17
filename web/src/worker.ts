// Analysis worker: screens frames, runs the reduced flash filter on the same frames and screens its output,
// keeps small still frames and per cell flash counts at the worst moments. Nothing leaves the browser.
import { FlashAnalyzer, ReducedFlashFilter, CLIPS, generateClip } from '../../src/core/index.ts';
import type { AreaRule, Report } from '../../src/core/index.ts';
import type { FieldSnapshot, Still, ToWorker, FromWorker } from './protocol.ts';

const THUMB_W = 320;
const THUMB_EVERY = 1 / 8;
const MAX_STILLS = 1200;

let job: Job | null = null;

class Job {
  before: FlashAnalyzer;
  after: FlashAnalyzer;
  filter: ReducedFlashFilter;
  w: number;
  h: number;
  format: 'rgb' | 'rgba';
  stills: Still[] = [];
  nextThumb = 0;
  snaps: FieldSnapshot[] = [];
  open: Record<'general' | 'red', FieldSnapshot | null> = { general: null, red: null };
  limit: number;
  constructor(m: Extract<ToWorker, { type: 'start' }>) {
    this.w = m.width;
    this.h = m.height;
    this.format = m.format;
    const base = {
      width: m.width,
      height: m.height,
      format: m.format,
      displayWidth: m.displayWidth,
      displayHeight: m.displayHeight,
      fps: m.fps,
      areaRule: m.areaRule as AreaRule,
      media: m.media,
      sampled: m.sampled ?? true,
    };
    this.before = new FlashAnalyzer(base);
    this.after = new FlashAnalyzer(base);
    for (const r of m.reasons ?? []) {
      this.before.addReason(r);
      this.after.addReason(r);
    }
    this.filter = new ReducedFlashFilter({ ...base, format: m.format });
    this.limit = this.before.areaLimit;
  }

  thumb(data: Uint8Array | Uint8ClampedArray): Uint8ClampedArray {
    const tw = Math.min(THUMB_W, this.w);
    const th = Math.max(1, Math.round((this.h * tw) / this.w));
    const out = new Uint8ClampedArray(tw * th * 4);
    const s = this.format === 'rgba' ? 4 : 3;
    for (let y = 0; y < th; y++) {
      const sy0 = Math.floor((y * this.h) / th);
      const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * this.h) / th));
      for (let x = 0; x < tw; x++) {
        const sx0 = Math.floor((x * this.w) / tw);
        const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * this.w) / tw));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = sy0; yy < sy1; yy += 1) {
          for (let xx = sx0; xx < sx1; xx += 1) {
            const p = (yy * this.w + xx) * s;
            r += data[p];
            g += data[p + 1];
            b += data[p + 2];
            n++;
          }
        }
        const q = (y * tw + x) * 4;
        out[q] = r / n;
        out[q + 1] = g / n;
        out[q + 2] = b / n;
        out[q + 3] = 255;
      }
    }
    return out;
  }

  /** Keeps per cell counts (as 4 x 4 CSS px blocks, max) at the peak of each stretch of fast flashing. */
  snapshot(t: number): void {
    const last = this.before.last;
    for (const kind of ['general', 'red'] as const) {
      const rate = kind === 'general' ? last.generalRate : last.redRate;
      const area = kind === 'general' ? last.generalArea : last.redArea;
      const interesting = rate >= 6 || area > 0.5 * this.limit;
      let cur = this.open[kind];
      if (cur && t - cur.lastT > 0.5) {
        this.open[kind] = cur = null;
      }
      if (!interesting) continue;
      const score = rate * 1e9 + area;
      if (cur && score <= cur.score) {
        cur.lastT = t;
        continue;
      }
      const c = this.before.cellCounts();
      const counts = kind === 'general' ? c.general : c.red;
      const bw = Math.ceil(c.gridW / 2);
      const bh = Math.ceil(c.gridH / 2);
      const blocks = new Uint8Array(bw * bh);
      for (let y = 0; y < c.gridH; y++) {
        for (let x = 0; x < c.gridW; x++) {
          const v = counts[y * c.gridW + x];
          const b = (y >> 1) * bw + (x >> 1);
          if (v > blocks[b]) blocks[b] = v;
        }
      }
      const snap: FieldSnapshot = {
        kind,
        t,
        lastT: t,
        score,
        rate,
        area,
        blocks,
        bw,
        bh,
        blockCssW: c.cellCssW * 2,
        blockCssH: c.cellCssH * 2,
      };
      if (cur) Object.assign(cur, snap);
      else {
        this.snaps.push(snap);
        this.open[kind] = snap;
      }
    }
  }

  push(data: Uint8Array | Uint8ClampedArray, t: number): void {
    this.before.push(data, t);
    const fixed = this.filter.process(data as Uint8Array, t);
    this.after.push(fixed, t);
    this.snapshot(t);
    if (t >= this.nextThumb - 1e-6 && this.stills.length < MAX_STILLS) {
      const tw = Math.min(THUMB_W, this.w);
      this.stills.push({ t, width: tw, height: Math.max(1, Math.round((this.h * tw) / this.w)), before: this.thumb(data), after: this.thumb(fixed) });
      this.nextThumb = t + THUMB_EVERY;
    }
  }

  finish(): { before: Report; after: Report } {
    const before = this.before.finish();
    const after = this.after.finish();
    after.media.notes.push('Reduced flash filter applied to the analysed frames in this browser; the file written by `stillfield --fix` is screened again after encoding.');
    return { before, after };
  }
}

function post(m: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(m, transfer);
}

function done(): void {
  if (!job) return;
  const { before, after } = job.finish();
  const transfer: Transferable[] = [];
  for (const s of job.stills) transfer.push(s.before.buffer, s.after.buffer);
  for (const s of job.snaps) transfer.push(s.blocks.buffer);
  post({ type: 'done', before, after, stills: job.stills, snaps: job.snaps }, transfer);
  job = null;
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'start') {
      job = new Job(m);
    } else if (m.type === 'frame') {
      if (!job) return;
      job.push(new Uint8ClampedArray(m.data), m.t);
      if (job.before.frames % 15 === 0) post({ type: 'progress', frames: job.before.frames, t: m.t });
    } else if (m.type === 'end') {
      done();
    } else if (m.type === 'synthetic') {
      const spec = CLIPS.find((c) => c.name === m.name);
      if (!spec) throw new Error(`no synthetic clip ${m.name}`);
      job = new Job({
        type: 'start',
        width: spec.width,
        height: spec.height,
        format: 'rgb',
        displayWidth: spec.displayWidth,
        displayHeight: spec.displayHeight,
        fps: spec.fps,
        areaRule: m.areaRule,
        media: { source: `${spec.name} (synthetic)`, kind: 'frames', notes: [`Synthetic test clip: ${spec.description}.`] },
        sampled: false,
      });
      for (const f of generateClip(spec)) {
        job.push(f.data, f.t);
        if (job.before.frames % 15 === 0) post({ type: 'progress', frames: job.before.frames, t: f.t });
      }
      done();
    }
  } catch (err) {
    job = null;
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
