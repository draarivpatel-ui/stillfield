// The Stillfield page. Media is decoded here frame by frame (seeking, never playing) and screened in a worker.
import { decodeGif, loopGifFrames, CLIPS } from '../../src/core/index.ts';
import type { Report, WorstWindow } from '../../src/core/index.ts';
import type { FieldSnapshot, FromWorker, Still, ToWorker } from './protocol.ts';
import { areaChart, fixChart, rateChart, setChartWidth } from './charts.ts';
import { drawField, drawStill } from './field.ts';
import { detectFrameRate } from './framerate.ts';
import type { Reason } from '../../src/core/index.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MAX_SECONDS = 300;
/** Fastest rate the page samples a video at (each sample is one seek). */
const MAX_SAMPLE_FPS = 60;
const REFERENCE = { width: 1024, height: 768 };

const SAMPLES: { name: string; label: string }[] = [
  { name: 'fail-full-4hz', label: '4 flashes a second, full screen' },
  { name: 'fail-red-4hz', label: 'Saturated red and grey, 4 a second' },
  { name: 'borderline-area-over', label: '4 a second over 117% of the area limit' },
  { name: 'borderline-area-under', label: '4 a second over 85% of the area limit' },
  { name: 'fail-counterphase-halves', label: 'Two halves flashing in counter phase' },
  { name: 'borderline-3hz-full', label: 'Exactly 3 a second, full screen' },
  { name: 'pass-full-2hz', label: '2 a second, full screen' },
  { name: 'pass-slow-fade', label: 'Slow fade, 1 a second' },
];

interface Result {
  before: Report;
  after: Report;
  stills: Still[];
  snaps: FieldSnapshot[];
  name: string;
  synthetic: boolean;
}

let worker: Worker | null = null;
let cancelled = false;
let current: Result | null = null;
let selected = 0;

function newWorker(): Worker {
  worker?.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}

// ------------------------------------------------------------------ view states

let lastState = 'empty';
function show(state: 'empty' | 'busy' | 'error' | 'report'): void {
  for (const id of ['empty', 'busy', 'error', 'report']) $(id).hidden = id !== state;
  $('result').setAttribute('aria-busy', String(state === 'busy'));
  // on narrow screens the result sits under the intake column: bring it into view when the state changes
  if (state !== lastState && state !== 'empty' && window.matchMedia('(max-width: 860px)').matches) {
    $('result').scrollIntoView({ block: 'start' });
  }
  lastState = state;
}

function busy(name: string, frac: number, detail: string): void {
  show('busy');
  $('busy-title').textContent = 'Screening';
  $('busy-name').textContent = name;
  const p = Math.max(0, Math.min(1, frac));
  $('meter-fill').style.width = `${(p * 100).toFixed(1)}%`;
  $('busy-title').parentElement!.querySelector('.meter')!.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  $('busy-detail').textContent = detail;
}

function fail(message: string, cli?: string): void {
  show('error');
  $('error-text').textContent = message;
  const pre = $('error-cli');
  pre.hidden = !cli;
  pre.textContent = cli ?? '';
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};
const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const rate = (v: number, min = false) => `${Number.isInteger(v) ? v : v.toFixed(1)}${min ? '+' : ''}`;

// ------------------------------------------------------------------ settings

function settings() {
  return {
    display: ($('display') as HTMLSelectElement).value,
    area: ($('area') as HTMLSelectElement).value,
    fps: ($('fps') as HTMLSelectElement).value,
  };
}

function displayFor(spec: string, w: number, h: number, kind: 'video' | 'gif'): { width: number; height: number } {
  const fit = () => {
    const k = Math.min(REFERENCE.width / w, REFERENCE.height / h);
    return { width: Math.max(2, Math.round(w * k)), height: Math.max(2, Math.round(h * k)) };
  };
  if (spec === 'native') return { width: w, height: h };
  if (spec === 'fullscreen') return fit();
  const m = /^(\d+)x(\d+)$/.exec(spec);
  if (m) {
    // fit the media inside the chosen screen, keeping its shape
    const W = Number(m[1]);
    const H = Number(m[2]);
    const k = Math.min(W / w, H / h);
    return { width: Math.round(w * k), height: Math.round(h * k) };
  }
  return kind === 'video' ? fit() : { width: w, height: h };
}

// ------------------------------------------------------------------ running a job

function runJob(start: (w: Worker) => Promise<void>, name: string, synthetic: boolean, expectSeconds: number): void {
  cancelled = false;
  const w = newWorker();
  const t0 = performance.now();
  busy(name, 0, 'Starting');
  w.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'progress') {
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      busy(name, expectSeconds ? m.t / expectSeconds : 0, `${fmt(m.t)} of ${fmt(expectSeconds)} screened, ${m.frames} frames, ${secs} s`);
    } else if (m.type === 'done') {
      current = { before: m.before, after: m.after, stills: m.stills, snaps: m.snaps, name, synthetic };
      render(current);
    } else if (m.type === 'error') {
      fail(m.message);
    }
  };
  w.onerror = (e) => fail(`The analysis stopped: ${e.message}`);
  start(w).catch((err) => {
    if (!cancelled) fail(err instanceof Error ? err.message : String(err));
  });
}

function post(w: Worker, m: ToWorker, transfer: Transferable[] = []): void {
  w.postMessage(m, transfer);
}

async function screenVideo(blob: Blob, name: string): Promise<void> {
  const s = settings();
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  try {
    await new Promise<void>((res, rej) => {
      v.addEventListener('loadeddata', () => res(), { once: true });
      v.addEventListener('error', () => rej(new Error('This browser cannot decode this video. Try an MP4 (H.264) or WebM file, or use the command line, which reads anything ffmpeg reads.')), { once: true });
    });
    const W = v.videoWidth;
    const H = v.videoHeight;
    if (!W || !H) throw new Error('The file has no video picture.');
    // A WebM from MediaRecorder has no length in its header (duration Infinity); seeking far past the end makes the
    // browser read to the end and find it. Then back to the start.
    let duration = v.duration;
    if (!Number.isFinite(duration)) {
      const seekTo = (t: number) =>
        new Promise<void>((res) => {
          const timer = setTimeout(res, 10000);
          v.addEventListener('seeked', () => (clearTimeout(timer), res()), { once: true });
          v.currentTime = t;
        });
      await seekTo(1e101);
      duration = v.duration;
      await seekTo(0);
    }
    const lengthKnown = Number.isFinite(duration) && duration > 0;
    const total = lengthKnown ? Math.min(duration, MAX_SECONDS) : MAX_SECONDS;
    // The page never plays the video, so it reads the frame rate from the container and samples at that rate.
    const rate = await detectFrameRate(blob);
    const fps = s.fps === 'auto' ? (rate ? Math.min(rate.fps, MAX_SAMPLE_FPS) : MAX_SAMPLE_FPS) : Number(s.fps);
    const reasons: Reason[] = [];
    const cli = 'Screen the file with the command line, which reads every frame with its own timing.';
    if (!rate) {
      reasons.push({
        code: 'sample-rate',
        level: 'warn',
        message: `The video's frame rate could not be read from the file, so it was sampled at ${fps} fps by seeking; a video with more frames a second can hide flashing between the samples. ${cli}`,
      });
    } else if (rate.maxFps > fps * 1.001) {
      const own = rate.maxFps > rate.fps * 1.001 ? `up to ${rate.maxFps.toFixed(2)}` : rate.fps.toFixed(2);
      reasons.push({
        code: 'sample-rate',
        level: 'warn',
        message: `The video has ${own} frames a second (its frame rate) but was sampled at ${fps} fps, so flashing between the samples can be missed. ${cli}`,
      });
    }
    if (!lengthKnown) {
      reasons.push({
        code: 'incomplete',
        level: 'warn',
        message: `The video's length could not be read, so up to ${MAX_SECONDS} s were screened in the browser and anything after that was not. ${cli}`,
      });
    } else if (duration > MAX_SECONDS) {
      reasons.push({
        code: 'incomplete',
        level: 'warn',
        start: MAX_SECONDS,
        end: duration,
        message: `Only the first ${MAX_SECONDS} s of ${duration.toFixed(1)} s were screened in the browser; the rest was not. ${cli}`,
      });
    }
    const display = displayFor(s.display, W, H, 'video');
    // frames are drawn at the display size, capped at 1280 px wide (the analysis grid follows the display size)
    const k = Math.min(1, 1280 / display.width);
    const fw = Math.max(2, Math.round(display.width * k));
    const fh = Math.max(2, Math.round(display.height * k));
    const canvas = new OffscreenCanvas(fw, fh);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const notes = [
      `Decoded by this browser and sampled at ${Number.isInteger(fps) ? fps : fps.toFixed(3)} fps by seeking, aiming at the middle of each frame${rate ? ` (frame rate ${rate.fps.toFixed(3)} fps, read from the ${rate.container === 'mp4' ? 'MP4' : 'WebM'} file)` : ''}.`,
    ];
    runJob(async (w) => {
      post(w, { type: 'start', width: fw, height: fh, format: 'rgba', displayWidth: display.width, displayHeight: display.height, fps, areaRule: s.area, media: { source: name, kind: 'video', width: W, height: H, notes }, sampled: !(rate && fps >= rate.maxFps * 0.999), reasons });
      const n = Math.floor(total * fps + 1e-6);
      for (let i = 0; i < n; i++) {
        if (cancelled) return;
        const t = i / fps;
        const end = Number.isFinite(v.duration) ? v.duration : total;
        if (!lengthKnown && t >= end) break;
        const target = Math.min(end - 1e-3, t + 0.5 / fps);
        await new Promise<void>((res) => {
          v.addEventListener('seeked', () => res(), { once: true });
          v.currentTime = target;
        });
        ctx.drawImage(v, 0, 0, fw, fh);
        const img = ctx.getImageData(0, 0, fw, fh);
        post(w, { type: 'frame', data: img.data.buffer, t }, [img.data.buffer]);
      }
      post(w, { type: 'end' });
    }, name, false, total);
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function screenGif(blob: Blob, name: string): Promise<void> {
  const s = settings();
  const gif = decodeGif(new Uint8Array(await blob.arrayBuffer()));
  const seq = loopGifFrames(gif);
  const display = displayFor(s.display, gif.width, gif.height, 'gif');
  const total = seq[seq.length - 1]?.t ?? 0;
  const notes: string[] = [];
  if (gif.loopCount !== null && gif.frames.length > 1) notes.push(`Screened while looping, ${total.toFixed(2)} s.`);
  if (gif.delayClamped) notes.push('Some frame delays were 0 or 0.01 s; screened at 0.1 s as browsers play them.');
  if (gif.transparent) notes.push('Transparent pixels were screened over white.');
  const reasons: Reason[] = gif.truncated
    ? [{ code: 'incomplete', level: 'warn', message: `The GIF does not end with its trailer, so it was probably cut short; ${gif.frames.length} frames were read and later frames may be missing.` }]
    : [];
  runJob(async (w) => {
    post(w, { type: 'start', width: gif.width, height: gif.height, format: 'rgba', displayWidth: display.width, displayHeight: display.height, fps: 30, areaRule: s.area, media: { source: name, kind: 'gif', width: gif.width, height: gif.height, notes }, sampled: false, reasons });
    for (let i = 0; i < seq.length; i++) {
      if (cancelled) return;
      const copy = gif.frames[seq[i].frame].slice();
      post(w, { type: 'frame', data: copy.buffer, t: seq[i].t }, [copy.buffer]);
      if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
    }
    post(w, { type: 'end' });
  }, name, false, total);
}

async function screenBlob(blob: Blob, name: string): Promise<void> {
  const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;
  if (isGif) return screenGif(blob, name);
  return screenVideo(blob, name);
}

async function screenUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('That is not a full URL. It should start with https://.');
    return;
  }
  const cli = `stillfield ${url.href}`;
  busy(url.href, 0, 'Fetching');
  let res: Response;
  try {
    res = await fetch(url.href, { mode: 'cors' });
  } catch {
    fail('The file could not be fetched: the server is unreachable, or it does not let other pages read its files (cross origin). Download the file and drop it here, or screen the URL with the command line:', cli);
    return;
  }
  if (!res.ok) {
    fail(`The server answered ${res.status} ${res.statusText}.`, cli);
    return;
  }
  const type = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) {
    fail('That is a web page. A page cannot record another site, so web pages are screened with the command line, which records the page in Chromium under a controlled clock:', cli);
    return;
  }
  const blob = await res.blob();
  const name = decodeURIComponent(url.pathname.split('/').pop() || url.hostname);
  await screenBlob(blob, name);
}

// ------------------------------------------------------------------ rendering

const VERDICT_WORD = { pass: 'Pass', warn: 'Warning', fail: 'Fail' } as const;

function render(r: Result): void {
  const rep = r.before;
  show('report');
  const v = $('verdict');
  v.textContent = VERDICT_WORD[rep.verdict];
  v.className = `verdict ${rep.verdict}`;
  const g = rep.general;
  const red = rep.red;
  const areaPct = Math.round(Math.max(g.maxAreaRatio, red.maxAreaRatio) * 100);
  const failS = Math.max(g.failSeconds, red.failSeconds);
  $('figures').innerHTML = [
    ['General flashes a second', rate(g.maxFlashesPerSecond, g.rateIsMinimum), ''],
    ['Red flashes a second', rate(red.maxFlashesPerSecond, red.rateIsMinimum), ''],
    ['Fast flashing area', String(areaPct), '% of limit'],
    ['Time over the rule', failS.toFixed(1), 's'],
  ]
    .map(([dt, dd, unit]) => `<div><dt>${dt}</dt><dd>${dd}${unit ? `<small>${unit}</small>` : ''}</dd></div>`)
    .join('');
  const reasons = rep.reasons.length
    ? rep.reasons
    : [{ level: 'pass', message: `No flashing over the thresholds was found. WCAG 2.2 SC 2.3.1: passes this screen.`, start: undefined, end: undefined }];
  $('reasons').innerHTML = reasons
    .map((x) => {
      const when = x.start !== undefined && x.end !== undefined ? `${fmt(x.start)} to ${fmt(x.end)}` : '';
      return `<li><span class="badge ${x.level === 'info' ? 'warn' : x.level}">${x.level === 'pass' ? 'pass' : x.level}</span><span class="when">${when}</span><span class="msg">${esc(x.message)}</span></li>`;
    })
    .join('');
  const m = rep.media;
  const s = rep.settings;
  $('media-line').textContent = [
    m.source,
    `${m.width} x ${m.height}`,
    `${m.duration.toFixed(2)} s`,
    `${m.frames} frames`,
    `screened at ${s.display.width} x ${s.display.height} CSS px`,
    `area rule ${s.areaRule}, limit ${n0(s.areaLimit)} CSS px`,
    ...m.notes,
  ].join('  ·  ');

  $('rate-legend').innerHTML = `<span><i class="area"></i>General</span><span style="color:var(--series-red)"><i></i>Red</span><span style="color:var(--fail)"><i class="dash"></i>Limit, 3 a second</span>`;
  $('fix-legend').innerHTML = `<span><i class="area"></i>Before</span><span style="color:var(--series-after)"><i></i>After, general</span><span style="color:var(--series-after)"><i class="dash"></i>After, red</span>`;

  // windows table
  const tbody = ($('windows') as HTMLTableElement).tBodies[0];
  tbody.innerHTML = rep.worstWindows
    .map(
      (w, i) => `<tr tabindex="0" data-i="${i}" aria-selected="false"><td>${fmt(w.start)}</td><td>${fmt(w.end)}</td><td><span class="lvl ${w.level}" title="${w.level}"></span><span class="kind">${w.kind === 'general' ? 'General' : 'Red'}</span><span class="sr-only">, ${w.level}</span></td><td class="num">${rate(w.peakFlashesPerSecond, w.rateIsMinimum)}</td><td class="num">${n0(w.peakArea)}</td><td class="num">${Math.round((100 * w.peakArea) / s.areaLimit)}%</td></tr>`,
    )
    .join('');
  ($('windows') as HTMLTableElement).hidden = rep.worstWindows.length === 0;
  $('windows-empty').hidden = rep.worstWindows.length > 0;
  tbody.querySelectorAll('tr').forEach((tr) => {
    const pick = () => select(Number(tr.dataset.i));
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = tr[e.key === 'ArrowDown' ? 'nextElementSibling' : 'previousElementSibling'] as HTMLElement | null;
        next?.focus();
        if (next) select(Number(next.dataset.i));
      }
    });
  });

  // reduced flash filter
  const a = r.after;
  const af = a.general.maxFlashesPerSecond;
  const ar = a.red.maxFlashesPerSecond;
  $('fix-verdict').innerHTML =
    rep.verdict === 'pass' && rep.reasons.length === 0
      ? `The screen found nothing over the thresholds, so there is nothing the filter needs to fix. After the filter: <strong>${VERDICT_WORD[a.verdict].toLowerCase()}</strong>.`
      : `After the filter: <strong>${VERDICT_WORD[a.verdict].toLowerCase()}</strong>, WCAG 2.3.1 ${a.wcag231 === 'fail' ? 'still fails' : 'passes this screen'}. Peak ${rate(af)} general and ${rate(ar)} red flashes a second over an area above the limit.`;
  $('fix-cli').textContent = r.synthetic ? 'stillfield clip.mp4 --fix' : `stillfield "${r.name.replace(/"/g, '\\"')}" --fix`;
  select(0);
}

/**
 * The report gives the first window that holds the most fast flashing area. For the picture, slide that window so
 * the fast flashing cells sit around its centre, as long as it still holds all of them.
 */
function centred(r: WorstWindow['region'], snap: FieldSnapshot, display: { width: number; height: number }): WorstWindow['region'] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let by = 0; by < snap.bh; by++) {
    for (let bx = 0; bx < snap.bw; bx++) {
      if (snap.blocks[by * snap.bw + bx] < 7) continue;
      const cx = bx * snap.blockCssW;
      const cy = by * snap.blockCssH;
      // cells in and around the reported window (half a window each side)
      if (cx + snap.blockCssW <= r.x - r.width / 2 || cx >= r.x + 1.5 * r.width || cy + snap.blockCssH <= r.y - r.height / 2 || cy >= r.y + 1.5 * r.height) continue;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx + snap.blockCssW); y1 = Math.max(y1, cy + snap.blockCssH);
    }
  }
  if (!Number.isFinite(x0)) return r;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // centre on the fast flashing cells; when they are larger than the window, keep it inside them
  const fit = (lo: number, hi: number, size: number, max: number) => {
    const c = Math.round((lo + hi) / 2 - size / 2);
    return hi - lo > size ? clamp(c, 0, max - size) : clamp(c, Math.max(0, hi - size), Math.min(lo, max - size));
  };
  const nx = fit(x0, x1, r.width, display.width);
  const ny = fit(y0, y1, r.height, display.height);
  return { ...r, x: Math.max(0, nx), y: Math.max(0, ny) };
}

/**
 * The still to show for a moment: among the stills in the second before it, the one where the marked region is
 * brightest, so a flash is shown in its bright state rather than its dark one.
 */
function nearestStill(stills: Still[], t: number, region: WorstWindow['region'] | null = null, display?: { width: number; height: number }, kind: 'general' | 'red' = 'general'): Still | null {
  let best: Still | null = null;
  let bestScore = -1;
  for (const s of stills) {
    if (s.t > t + 1e-6 || s.t < t - 1) continue;
    let sum = 0;
    let n = 0;
    const k = display ? s.width / display.width : 1;
    const x0 = region ? Math.floor(region.x * k) : 0;
    const y0 = region ? Math.floor(region.y * k) : 0;
    const x1 = region ? Math.min(s.width, Math.ceil((region.x + region.width) * k)) : s.width;
    const y1 = region ? Math.min(s.height, Math.ceil((region.y + region.height) * k)) : s.height;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const p = (y * s.width + x) * 4;
      const r = s.before[p], g = s.before[p + 1], b = s.before[p + 2];
      sum += kind === 'red' ? r - (g + b) / 2 : r + g + b;
      n++;
    }
    const score = n ? sum / n : 0;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (best) return best;
  for (const s of stills) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
}

function select(i: number): void {
  if (!current) return;
  const rep = current.before;
  selected = i;
  const w: WorstWindow | undefined = rep.worstWindows[i];
  ($('windows') as HTMLTableElement).tBodies[0].querySelectorAll('tr').forEach((tr) => tr.setAttribute('aria-selected', String(Number(tr.dataset.i) === i)));
  const peak = w ? w.peakTime : (rep.general.worstTime ?? rep.red.worstTime ?? rep.media.duration / 2);
  const kind = w?.kind ?? 'general';
  // field snapshot nearest the peak, same kind
  let snap: FieldSnapshot | null = null;
  for (const s of current.snaps) if (s.kind === kind && (!snap || Math.abs(s.t - peak) < Math.abs(snap.t - peak))) snap = s;
  const region = w && snap ? centred(w.region, snap, rep.settings.display) : (w?.region ?? null);
  const still = nearestStill(current.stills, peak, region, rep.settings.display, kind);
  drawStill($('still') as HTMLCanvasElement, still?.before ?? null, still, region, rep.settings.display);
  drawField($('fieldmap') as HTMLCanvasElement, snap, region, rep.settings);
  $('field-caption').textContent = w
    ? `${w.kind === 'general' ? 'General' : 'Red'} flashes at ${fmt(w.peakTime)}  ·  ${n0(w.peakArea)} CSS px flashing more than 3 times a second, ${Math.round((100 * w.peakArea) / rep.settings.areaLimit)}% of the limit  ·  field ${w.region.width} x ${w.region.height} CSS px around the fast flashing area`
    : 'No stretch came near the thresholds, so there is no field to map. The still is from the moment with the most flashing.';
  setChartWidth($('rate-chart').clientWidth);
  $('rate-chart').innerHTML = rateChart(rep, selected);
  $('area-chart').innerHTML = areaChart(rep, selected);
  setChartWidth($('fix-chart').clientWidth);
  $('fix-chart').innerHTML = fixChart(rep, current.after);
  // before and after are compared in the middle of the window, once the filter has had time to act
  const mid = w ? (w.start + w.end) / 2 : peak;
  const pair = nearestStill(current.stills, Math.max(mid, Math.min(peak + 0.5, w?.end ?? peak)), region, rep.settings.display, kind);
  drawStill($('still-before') as HTMLCanvasElement, pair?.before ?? null, pair, null, rep.settings.display);
  drawStill($('still-after') as HTMLCanvasElement, pair?.after ?? null, pair, null, rep.settings.display);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ------------------------------------------------------------------ wiring

function start(blob: Blob, name: string): void {
  screenBlob(blob, name).catch((e) => fail(e instanceof Error ? e.message : String(e)));
}

function setup(): void {
  const file = $('file') as HTMLInputElement;
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) start(f, f.name);
    file.value = '';
  });
  const drop = $('drop');
  const over = (on: boolean) => (e: DragEvent) => {
    e.preventDefault();
    drop.classList.toggle('is-over', on);
  };
  for (const t of [drop, document.body]) {
    t.addEventListener('dragover', over(true) as EventListener);
    t.addEventListener('dragleave', over(false) as EventListener);
    t.addEventListener('drop', ((e: DragEvent) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) start(f, f.name);
    }) as EventListener);
  }
  $('url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const u = ($('url') as HTMLInputElement).value.trim();
    if (u) screenUrl(u);
  });
  $('cancel').addEventListener('click', () => {
    cancelled = true;
    worker?.terminate();
    worker = null;
    show(current ? 'report' : 'empty');
  });
  $('again').addEventListener('click', () => {
    current = null;
    show('empty');
    file.click();
  });
  $('download-json').addEventListener('click', () => {
    if (!current) return;
    const blob = new Blob([JSON.stringify(current.before, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${current.name.replace(/[^\w.-]+/g, '_')}.stillfield.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const list = $('samples');
  list.innerHTML = SAMPLES.map((s) => {
    const spec = CLIPS.find((c) => c.name === s.name)!;
    const ex = spec.expect!.verdict;
    return `<li><button type="button" data-name="${s.name}" aria-pressed="false"><span>${s.label}</span><span class="expect ${ex}" aria-label="expected result ${ex}">${ex}</span></button></li>`;
  }).join('');
  list.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      list.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const name = b.dataset.name!;
      const spec = CLIPS.find((c) => c.name === name)!;
      runJob(async (w) => post(w, { type: 'synthetic', name, areaRule: settings().area }), `${name}`, true, spec.duration);
    }),
  );
  // a synthetic clip can be preselected for screenshots and demos: #sample=<name>
  const m = /sample=([\w.-]+)/.exec(location.hash);
  if (m) (list.querySelector(`button[data-name="${m[1]}"]`) as HTMLButtonElement | null)?.click();
}

setup();
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => current && !$('report').hidden && select(selected), 150);
});
