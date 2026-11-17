// SVG charts for the timeline. Static drawings; nothing animates.
import type { Report } from '../../src/core/index.ts';

let W = 1000;

/** Charts are drawn at the width they are shown at, so text keeps its size on every screen. */
export function setChartWidth(w: number): void {
  W = Math.max(280, Math.round(w));
}

interface Frame {
  t: number[];
  a: number[];
  b: number[];
}

/** Buckets long series to at most `max` points, keeping the highest value per bucket. */
function bucket(t: number[], a: number[], b: number[], max = 900): Frame {
  if (t.length <= max) return { t, a, b };
  const out: Frame = { t: [], a: [], b: [] };
  const step = t.length / max;
  for (let i = 0; i < max; i++) {
    const s = Math.floor(i * step);
    const e = Math.max(s + 1, Math.floor((i + 1) * step));
    let ma = 0;
    let mb = 0;
    for (let k = s; k < e; k++) {
      if (a[k] > ma) ma = a[k];
      if (b[k] > mb) mb = b[k];
    }
    out.t.push(t[s]);
    out.a.push(ma);
    out.b.push(mb);
  }
  return out;
}

function stepPath(t: number[], v: number[], x: (t: number) => number, y: (v: number) => number, close: boolean, end: number): string {
  if (!t.length) return '';
  let d = `M${x(t[0]).toFixed(1)},${y(close ? 0 : v[0]).toFixed(1)}`;
  if (close) d += `L${x(t[0]).toFixed(1)},${y(v[0]).toFixed(1)}`;
  for (let i = 1; i < t.length; i++) {
    d += `L${x(t[i]).toFixed(1)},${y(v[i - 1]).toFixed(1)}L${x(t[i]).toFixed(1)},${y(v[i]).toFixed(1)}`;
  }
  d += `L${x(end).toFixed(1)},${y(v[v.length - 1]).toFixed(1)}`;
  if (close) d += `L${x(end).toFixed(1)},${y(0).toFixed(1)}Z`;
  return d;
}

function timeTicks(duration: number): number[] {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const maxTicks = Math.max(3, Math.floor(W / 80));
  const step = steps.find((s) => duration / s <= maxTicks) ?? 600;
  const out: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

function fmtT(t: number): string {
  if (t < 60) return `${Number.isInteger(t) ? t : t.toFixed(1)} s`;
  const m = Math.floor(t / 60);
  return `${m}:${String(Math.round(t - m * 60)).padStart(2, '0')}`;
}

interface Frame2 {
  height: number;
  pad: { l: number; r: number; t: number; b: number };
}

function frame(duration: number, yMax: number, h: number, yTicks: number[], yFmt: (v: number) => string, lane: boolean) {
  const pad = { l: 44, r: 22, t: 8, b: lane ? 42 : 24 };
  const x = (t: number) => pad.l + (t / Math.max(duration, 1e-6)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - Math.min(v, yMax) / yMax) * (h - pad.t - pad.b);
  let svg = '';
  for (const v of yTicks) {
    svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="tick" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${yFmt(v)}</text>`;
  }
  const base = h - pad.b;
  svg += `<line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"/>`;
  for (const t of timeTicks(duration)) {
    svg += `<line class="axis" x1="${x(t)}" x2="${x(t)}" y1="${base}" y2="${base + 4}"/>`;
    svg += `<text class="tick" x="${x(t)}" y="${base + 16}" text-anchor="middle">${fmtT(t)}</text>`;
  }
  return { x, y, svg, pad, base };
}

function bands(rep: Report, selected: number, x: (t: number) => number, top: number, bottom: number): string {
  return rep.worstWindows
    .map((w, i) => `<rect class="band${i === selected ? ' sel' : ''}" x="${x(w.start)}" y="${top}" width="${Math.max(1.5, x(w.end) - x(w.start))}" height="${bottom - top}"/>`)
    .join('');
}

const wrap = (h: number, label: string, body: string) =>
  `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" role="img" aria-label="${label}">${body}</svg>`;

export function rateChart(rep: Report, selected: number): string {
  const tl = rep.timeline!;
  const dur = rep.media.duration;
  const f = bucket(tl.t, tl.generalFlashes, tl.redFlashes);
  const peak = Math.max(4, ...f.a, ...f.b);
  const yMax = Math.ceil(peak + 0.5);
  const ticks = Array.from({ length: yMax + 1 }, (_, i) => i).filter((v) => yMax <= 6 || v % 2 === 0);
  const h = 220;
  const { x, y, svg, pad, base } = frame(dur, yMax, h, ticks, (v) => String(v), true);
  let body = bands(rep, selected, x, pad.t, base) + svg;
  body += `<path class="general" d="${stepPath(f.t, f.a, x, y, true, dur)}"/>`;
  body += `<path class="red" d="${stepPath(f.t, f.b, x, y, false, dur)}"/>`;
  body += `<line class="limit" x1="${pad.l}" x2="${W - pad.r}" y1="${y(3)}" y2="${y(3)}"/>`;
  // worst windows at their exact duration, on a lane under the time axis
  rep.worstWindows.forEach((w, i) => {
    const x0 = x(w.start);
    const x1 = Math.max(x0 + 2, x(w.end));
    body += `<rect class="lane${w.level === 'warn' ? ' warn' : ''}" x="${x0}" y="${h - 14}" width="${x1 - x0}" height="${i === selected ? 8 : 5}" rx="1"/>`;
  });
  const label = `Flashes per second over an area above the limit across ${dur.toFixed(1)} s: general peak ${rep.general.maxFlashesPerSecond}, red peak ${rep.red.maxFlashesPerSecond}; the limit is 3.`;
  return wrap(h, label, body);
}

export function areaChart(rep: Report, selected: number): string {
  const tl = rep.timeline!;
  const lim = rep.settings.areaLimit;
  const dur = rep.media.duration;
  const f = bucket(
    tl.t,
    tl.generalArea.map((v) => (100 * v) / lim),
    tl.redArea.map((v) => (100 * v) / lim),
  );
  const peak = Math.max(120, ...f.a, ...f.b);
  const yMax = Math.ceil(peak / 50) * 50;
  const ticks = [0, 100, ...(yMax > 200 ? [yMax] : [])];
  const h = 130;
  const { x, y, svg, pad, base } = frame(dur, yMax, h, ticks, (v) => `${v}%`, false);
  let body = bands(rep, selected, x, pad.t, base) + svg;
  body += `<path class="general" d="${stepPath(f.t, f.a, x, y, true, dur)}"/>`;
  body += `<path class="red" d="${stepPath(f.t, f.b, x, y, false, dur)}"/>`;
  body += `<line class="limit" x1="${pad.l}" x2="${W - pad.r}" y1="${y(100)}" y2="${y(100)}"/>`;
  return wrap(h, `Area flashing more than 3 times a second as a share of the ${lim} CSS px limit; peak ${Math.round(Math.max(rep.general.maxAreaRatio, rep.red.maxAreaRatio) * 100)}%.`, body);
}

export function fixChart(before: Report, after: Report): string {
  const tb = before.timeline!;
  const ta = after.timeline!;
  const dur = before.media.duration;
  const fb = bucket(tb.t, tb.generalFlashes.map((g, i) => Math.max(g, tb.redFlashes[i])), tb.redFlashes);
  const fa = bucket(ta.t, ta.generalFlashes, ta.redFlashes);
  const yMax = Math.ceil(Math.max(4, ...fb.a, ...fa.a, ...fa.b) + 0.5);
  const ticks = [0, 3, yMax];
  const h = 150;
  const { x, y, svg, pad } = frame(dur, yMax, h, ticks, (v) => String(v), false);
  let body = svg;
  body += `<path class="general" style="fill-opacity:.18" d="${stepPath(fb.t, fb.a, x, y, true, dur)}"/>`;
  body += `<path class="after" d="${stepPath(fa.t, fa.a, x, y, false, dur)}"/>`;
  body += `<path class="after-red" d="${stepPath(fa.t, fa.b, x, y, false, dur)}"/>`;
  body += `<line class="limit" x1="${pad.l}" x2="${W - pad.r}" y1="${y(3)}" y2="${y(3)}"/>`;
  return wrap(h, `Flashes per second before and after the reduced flash filter: before peak ${Math.max(before.general.maxFlashesPerSecond, before.red.maxFlashesPerSecond)}, after peak ${Math.max(after.general.maxFlashesPerSecond, after.red.maxFlashesPerSecond)}.`, body);
}

export type { Frame2 };
