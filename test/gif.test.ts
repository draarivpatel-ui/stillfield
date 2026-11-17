// GIF decoding (disposal, looping, delays) and the browser delay assumption checked in Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import omggif from 'omggif';
import { decodeGif, loopGifFrames, FlashAnalyzer } from '../src/core/index.ts';

/** Writes a GIF of solid frames from a 4 colour palette. */
export function makeGif(w: number, h: number, frames: { color: number; delay: number; disposal?: number; rect?: [number, number, number, number]; transparent?: boolean }[], loop: number | null = 0): Uint8Array {
  const buf = new Uint8Array(1 << 20);
  const g = new omggif.GifWriter(buf as unknown as number[], w, h, loop === null ? {} : { loop });
  const palette = [0x000000, 0xffffff, 0xff0000, 0x808080];
  for (const f of frames) {
    const [x, y, fw, fh] = f.rect ?? [0, 0, w, h];
    const px = new Array(fw * fh).fill(f.color);
    g.addFrame(x, y, fw, fh, px, { palette, delay: f.delay, disposal: f.disposal ?? 0, transparent: f.transparent ? f.color : undefined });
  }
  return buf.slice(0, g.end());
}

test('decodes frames, delays and loop count', () => {
  const gif = decodeGif(makeGif(8, 8, [{ color: 0, delay: 5 }, { color: 1, delay: 7 }], 0));
  assert.equal(gif.frames.length, 2);
  assert.deepEqual(gif.delays, [0.05, 0.07]);
  assert.equal(gif.loopCount, 0);
  assert.equal(gif.frames[1][0], 255);
});

test('delays of 0 and 1 hundredth are raised to 0.1 s; 2 hundredths are kept', () => {
  const gif = decodeGif(makeGif(4, 4, [{ color: 0, delay: 0 }, { color: 1, delay: 1 }, { color: 0, delay: 2 }]));
  assert.deepEqual(gif.delays, [0.1, 0.1, 0.02]);
  assert.equal(gif.delayClamped, true);
});

test('disposal 2 restores to background (transparent, shown over the background colour)', () => {
  const gif = decodeGif(
    makeGif(4, 4, [
      { color: 1, delay: 10 },
      { color: 2, delay: 10, rect: [0, 0, 2, 2], disposal: 2 },
      { color: 3, delay: 10, rect: [2, 2, 2, 2] },
    ]),
    { background: [0, 0, 255] },
  );
  // frame 1: red square over white; frame 2: the red area was cleared to transparent, shown blue
  assert.deepEqual([...gif.frames[1].slice(0, 3)], [255, 0, 0]);
  assert.deepEqual([...gif.frames[2].slice(0, 3)], [0, 0, 255]);
  assert.equal(gif.transparent, true);
});

test('looping covers at least two loops and 6 s, including the wrap', () => {
  const gif = decodeGif(makeGif(4, 4, [{ color: 0, delay: 12 }, { color: 1, delay: 12 }], 0));
  const seq = loopGifFrames(gif);
  assert.ok(seq[seq.length - 1].t >= 5.9);
  // a 0.24 s two frame GIF looping is about 4 flashes a second; one pass alone is under a second and cannot fail
  const a = new FlashAnalyzer({ width: 4, height: 4, displayWidth: 1024, displayHeight: 768 });
  for (const s of seq) a.push(gif.frames[s.frame], s.t);
  assert.equal(a.finish().wcag231, 'fail');
  const once = decodeGif(makeGif(4, 4, [{ color: 0, delay: 25 }, { color: 1, delay: 25 }], null));
  assert.equal(loopGifFrames(once).length, 3);
});

test('Chromium plays 0 and 1 hundredth delays at about 100 ms, and 2 hundredths unchanged', async () => {
  // Headless Chromium advances GIFs only when it renders, so the page is sampled with screenshots (about 60 a second)
  const { chromium } = await import('playwright-core');
  const { PNG } = await import('pngjs');
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage();
    const rate = async (delay: number) => {
      const frames = Array.from({ length: 40 }, (_, i) => ({ color: i % 2, delay }));
      const src = 'data:image/gif;base64,' + Buffer.from(makeGif(16, 16, frames, 0)).toString('base64');
      await p.setContent(`<style>body{margin:0}</style><img src="${src}" width="16" height="16">`);
      await p.waitForTimeout(200);
      let last = -1;
      let changes = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 2000) {
        const png = PNG.sync.read(await p.screenshot({ clip: { x: 0, y: 0, width: 16, height: 16 } }));
        const v = png.data[(8 * 16 + 8) * 4];
        if (v !== last) {
          if (last >= 0) changes++;
          last = v;
        }
      }
      return changes / ((Date.now() - t0) / 1000);
    };
    const r0 = await rate(0);
    const r1 = await rate(1);
    const r2 = await rate(2);
    const r10 = await rate(10);
    for (const [d, r] of [[0, r0], [1, r1], [10, r10]]) assert.ok(r > 7 && r < 13, `${d} hundredths: ${r.toFixed(1)} changes a second`);
    assert.ok(r2 > 25, `2 hundredths: ${r2.toFixed(1)} changes a second`);
  } finally {
    await b.close();
  }
});
