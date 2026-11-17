// Analyzer behaviour on the synthetic proof set and on hand built edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIPS, generateClip, FlashAnalyzer, ReducedFlashFilter } from '../src/core/index.ts';
import type { AnalyzerOptions, ClipSpec, Report } from '../src/core/index.ts';

function run(spec: ClipSpec, extra: Partial<AnalyzerOptions> = {}): Report {
  const a = new FlashAnalyzer({
    width: spec.width,
    height: spec.height,
    format: 'rgb',
    displayWidth: spec.displayWidth,
    displayHeight: spec.displayHeight,
    fps: spec.fps,
    ...extra,
  });
  for (const fr of generateClip(spec)) a.push(fr.data, fr.t);
  return a.finish();
}

const clip = (name: string) => {
  const c = CLIPS.find((x) => x.name === name);
  if (!c) throw new Error(name);
  return c;
};

for (const spec of CLIPS.filter((c) => c.expect)) {
  test(`proof clip ${spec.name}: ${spec.description}`, () => {
    const r = run(spec);
    const e = spec.expect!;
    assert.equal(r.wcag231, e.wcag231, `wcag231 for ${spec.name}`);
    assert.equal(r.verdict, e.verdict, `verdict for ${spec.name}: ${r.reasons.map((x) => x.code).join(', ')}`);
    for (const code of e.codes ?? []) assert.ok(r.reasons.some((x) => x.code === code), `${spec.name} has ${code}`);
    if (e.verdict === 'pass') assert.equal(r.reasons.filter((x) => x.level !== 'info').length, 0);
  });
}

/** A uniform frame sequence from a luminance list (0 to 255 grey levels), one value per frame. */
function greys(levels: number[], fps: number, size = 64): { data: Uint8Array; t: number }[] {
  return levels.map((v, i) => ({ data: new Uint8Array(size * size * 3).fill(v), t: i / fps }));
}

function runFrames(frames: { data: Uint8Array; t: number }[], o: Partial<AnalyzerOptions> = {}): Report {
  const a = new FlashAnalyzer({ width: 64, height: 64, format: 'rgb', displayWidth: 1024, displayHeight: 768, ...o });
  for (const f of frames) a.push(f.data, f.t);
  return a.finish();
}

test('6 transitions in one second is at the limit, 7 fails', () => {
  // 10 fps: toggles on frames 1..6 then hold: transitions at 0.1 .. 0.6 s
  const six = [0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0];
  const seven = [0, 255, 0, 255, 0, 255, 0, 255, 255, 255, 255, 255, 255];
  const r6 = runFrames(greys(six, 10), { fps: 10 });
  const r7 = runFrames(greys(seven, 10), { fps: 10 });
  assert.equal(r6.wcag231, 'pass');
  assert.ok(r6.reasons.some((x) => x.code === 'general-at-limit'));
  assert.equal(r7.wcag231, 'fail');
  assert.equal(r7.general.maxFlashesPerSecond, 3.5);
});

test('the one second window is half open: transitions exactly 1 s apart are not in one window', () => {
  // 7 transitions spread so the first and the seventh are exactly 1.0 s apart (frames at 0..1.0 s, step 1/6)
  const frames = greys([0, 255, 0, 255, 0, 255, 0, 255, 255, 255], 6);
  const r = runFrames(frames, { fps: 6 });
  // transitions at 1/6 .. 7/6 s; any window (t - 1, t] holds at most 6 of them
  assert.equal(r.wcag231, 'pass');
  assert.equal(r.general.maxFlashesPerSecond, 3);
});

test('variable frame rate timestamps are used, not frame indices', () => {
  // the same 8 toggles, once squeezed into 0.8 s and once spread over 2.4 s
  const lv = [0, 255, 0, 255, 0, 255, 0, 255, 0];
  const fast = lv.map((v, i) => ({ data: new Uint8Array(64 * 64 * 3).fill(v), t: i * 0.1 }));
  const slow = lv.map((v, i) => ({ data: new Uint8Array(64 * 64 * 3).fill(v), t: i * 0.3 }));
  assert.equal(runFrames(fast).wcag231, 'fail');
  assert.equal(runFrames(slow).wcag231, 'pass');
});

test('a fall from above 0.8 counts once it goes below 0.8; changes entirely above 0.8 never count', () => {
  // 255 (L=1) to 200 (L=0.578): darker below 0.8, counts
  const r = runFrames(greys([255, 200, 255, 200, 255, 200, 255, 200, 255], 24), { fps: 24 });
  assert.equal(r.wcag231, 'fail');
  // 255 to 240 (L=0.871): darker above 0.8, never a flash
  const q = runFrames(greys([255, 240, 255, 240, 255, 240, 255, 240, 255], 24), { fps: 24 });
  assert.equal(q.wcag231, 'pass');
  assert.equal(q.general.maxFlashesPerSecond, 0);
});

test('wobbles under 0.1 inside a slow ramp do not add transitions', () => {
  const lv: number[] = [];
  for (let i = 0; i < 60; i++) lv.push(Math.round(40 + i * 3 + (i % 2 ? 4 : 0)));
  const r = runFrames(greys(lv, 30), { fps: 30 });
  assert.equal(r.general.maxFlashesPerSecond, 0.5);
});

test('area rules: understanding reading and frame reading are selectable', () => {
  const over = clip('borderline-area-over'); // 25,600 CSS px
  assert.equal(run(over).wcag231, 'fail');
  assert.equal(run(over, { areaRule: 'understanding' }).wcag231, 'pass');
  const half = clip('fail-half-field'); // 43,520 CSS px inside a 1024 x 768 frame
  assert.equal(run(half, { areaRule: 'frame' }).wcag231, 'pass');
  const r = run(half);
  assert.equal(r.settings.areaLimit, 21824);
  assert.equal(r.settings.window.width, 344);
  assert.equal(r.settings.window.height, 256);
});

test('display size scales the area: a passing small flash fails when shown four times larger', () => {
  const small = clip('pass-small-4hz');
  assert.equal(run(small).wcag231, 'pass');
  assert.equal(run(small, { displayWidth: 2048, displayHeight: 1536 }).wcag231, 'fail');
});

test('black floor: without it, dark chroma noise reads as red flashing', () => {
  const noise = clip('pass-dark-chroma-noise');
  assert.equal(run(noise).wcag231, 'pass');
  assert.equal(run(noise, { redBlackFloor: 0 }).wcag231, 'fail');
});

test('luminance only input skips red and says so', () => {
  const spec = clip('fail-full-4hz');
  const a = new FlashAnalyzer({ width: spec.width, height: spec.height, format: 'luminance', displayWidth: 1024, displayHeight: 768 });
  for (const fr of generateClip(spec)) {
    const l = new Float32Array(spec.width * spec.height);
    for (let i = 0; i < l.length; i++) l[i] = fr.data[i * 3] / 255;
    a.push(l, fr.t);
  }
  const r = a.finish();
  assert.equal(r.wcag231, 'fail');
  assert.ok(r.media.notes.some((n) => n.includes('red flashes were not checked')));
});

test('worst window locates the flashing square', () => {
  const r = run(clip('borderline-area-over')); // square at 400,300 size 160
  const w = r.worstWindows[0];
  assert.equal(w.kind, 'general');
  assert.equal(w.level, 'fail');
  assert.ok(w.region.x <= 400 && w.region.x + w.region.width >= 560, JSON.stringify(w.region));
  assert.ok(w.region.y <= 300 && w.region.y + w.region.height >= 460, JSON.stringify(w.region));
  assert.ok(w.start >= 0 && w.end <= 3);
});

test('report has schema, disclaimer, per second counts and a timeline', () => {
  const r = run(clip('fail-full-4hz'));
  assert.equal(r.schema, 'stillfield/report@1');
  assert.match(r.disclaimer, /not medical advice/);
  assert.equal(r.perSecond.length, 3);
  assert.equal(r.perSecond[1].general, 4);
  assert.equal(r.timeline!.t.length, 72);
  assert.ok(r.general.failSeconds > 1.5);
});

test('reduced flash filter: a failing clip passes after filtering, a calm clip is untouched', () => {
  for (const name of ['fail-full-4hz', 'fail-red-4hz', 'fail-smooth-4hz', 'borderline-area-over']) {
    const spec = clip(name);
    const f = new ReducedFlashFilter({ width: spec.width, height: spec.height, displayWidth: 1024, displayHeight: 768 });
    const a = new FlashAnalyzer({ width: spec.width, height: spec.height, format: 'rgb', displayWidth: 1024, displayHeight: 768 });
    for (const fr of generateClip(spec)) a.push(f.process(fr.data, fr.t), fr.t);
    const r = a.finish();
    assert.equal(r.wcag231, 'pass', `${name} after filtering: ${r.reasons.map((x) => x.message).join(' | ')}`);
  }
  const calm = clip('pass-single-cut');
  const f = new ReducedFlashFilter({ width: calm.width, height: calm.height, displayWidth: 1024, displayHeight: 768 });
  let changed = 0;
  for (const fr of generateClip(calm)) {
    const out = f.process(fr.data, fr.t);
    for (let i = 0; i < out.length; i++) if (out[i] !== fr.data[i]) changed++;
  }
  assert.equal(changed, 0);
});

// ---------------------------------------------------------------- regressions

function square(size: number, levels: number[], fps: number): { data: Uint8Array; t: number }[] {
  return levels.map((v, i) => ({ data: new Uint8Array(size * size * 3).fill(v), t: i / fps }));
}

const strobe = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? 255 : 0));

test('a frame smaller than the area limit that flashes fast warns that it cannot fail at this size', () => {
  // 128 x 128 = 16,384 CSS px at its own size, full frame black and white at 10 Hz (20 fps, every frame toggles)
  const r = runFrames(square(128, strobe(60), 20), { width: 128, height: 128, displayWidth: 128, displayHeight: 128, fps: 20 });
  assert.equal(r.wcag231, 'pass');
  assert.equal(r.verdict, 'warn');
  const w = r.reasons.find((x) => x.code === 'small-frame');
  assert.ok(w && w.level === 'warn', r.reasons.map((x) => x.code).join(', '));
  assert.match(w!.message, /--display/);
  // the same frame shown at 1024 x 768 fails
  assert.equal(runFrames(square(128, strobe(60), 20), { width: 128, height: 128, fps: 20 }).wcag231, 'fail');
  // a small frame that does not flash fast gets no such warning
  const calm = runFrames(square(128, strobe(60).map((v, i) => (Math.floor(i / 10) % 2 ? 255 : 0)), 20), {
    width: 128, height: 128, displayWidth: 128, displayHeight: 128, fps: 20,
  });
  assert.ok(!calm.reasons.some((x) => x.code === 'small-frame'));
});

test('a tiny blinking detail in a small frame does not trigger the small frame warning', () => {
  // 128 x 128 grey frame with a 4 x 4 px dot blinking at 10 Hz: even shown at 768 x 768 it covers about 576 CSS px
  const size = 128;
  const frames = strobe(60).map((v, i) => {
    const d = new Uint8Array(size * size * 3).fill(128);
    for (let y = 60; y < 64; y++) for (let x = 60; x < 64; x++) d.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3);
    return { data: d, t: i / 20 };
  });
  const r = runFrames(frames, { width: size, height: size, displayWidth: size, displayHeight: size, fps: 20 });
  assert.equal(r.wcag231, 'pass');
  assert.ok(!r.reasons.some((x) => x.code === 'small-frame'), r.reasons.map((x) => x.message).join(' | '));
  assert.equal(r.verdict, 'pass');
});

test('low frame rate warns only for sampled frames; native frames are noted', () => {
  const still = square(64, new Array(30).fill(128), 10);
  const sampled = runFrames(still, { fps: 10 });
  assert.equal(sampled.verdict, 'warn');
  assert.equal(sampled.reasons.find((x) => x.code === 'low-frame-rate')!.level, 'warn');
  const native = runFrames(still, { fps: 10, sampled: false });
  assert.equal(native.verdict, 'pass');
  assert.equal(native.reasons.find((x) => x.code === 'low-frame-rate')!.level, 'info');
});

test('no frames is not a pass', () => {
  const r = new FlashAnalyzer({ width: 8, height: 8, format: 'rgb' }).finish();
  assert.equal(r.verdict, 'warn');
  assert.equal(r.complete, false);
  assert.ok(r.reasons.some((x) => x.code === 'no-frames'));
});

test('a coverage reason from the source makes the report incomplete and at least a warning', () => {
  const pass = new FlashAnalyzer({ width: 64, height: 64, format: 'rgb', displayWidth: 1024, displayHeight: 768, sampled: false });
  for (const f of square(64, new Array(60).fill(128), 30)) pass.push(f.data, f.t);
  assert.equal(pass.finish().complete, true);
  const a = new FlashAnalyzer({ width: 64, height: 64, format: 'rgb', displayWidth: 1024, displayHeight: 768, sampled: false });
  for (const f of square(64, new Array(60).fill(128), 30)) a.push(f.data, f.t);
  a.addReason({ code: 'incomplete', level: 'warn', message: 'Decoding stopped at 2.00 s of 10.00 s.' });
  const r = a.finish();
  assert.equal(r.verdict, 'warn');
  assert.equal(r.wcag231, 'pass');
  assert.equal(r.complete, false);
  // a failure found in the part that was read stays a failure
  const b = new FlashAnalyzer({ width: 64, height: 64, format: 'rgb', displayWidth: 1024, displayHeight: 768 });
  for (const f of square(64, strobe(48), 24)) b.push(f.data, f.t);
  b.addReason({ code: 'incomplete', level: 'warn', message: 'x' });
  assert.equal(b.finish().verdict, 'fail');
});
