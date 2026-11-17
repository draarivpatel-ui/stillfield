// The web page in Chromium: real files through the drop input, and the page screened by stillfield itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { OUT, writeClip } from './helpers.ts';
import { screen } from '../src/node/screen.ts';

const root = join(import.meta.dirname, '..', 'web');
let server: Server;
let base = '';
let browser: Browser;
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

before(async () => {
  const b = spawnSync('npm', ['run', 'build:web', '--silent'], { cwd: join(root, '..'), encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  server = createServer(async (req, res) => {
    const p = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(root, p));
      res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function dropFile(file: string, fps?: string, init?: string): Promise<{ verdict: string; rows: number; errors: string[]; played: boolean; reasons: string }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (init) await page.addInitScript(init);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`);
  // record any attempt to play media
  await page.evaluate(() => {
    const w = window as unknown as { __played: boolean };
    w.__played = false;
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      w.__played = true;
      return orig.call(this);
    };
  });
  if (fps) await page.selectOption('#fps', fps);
  await page.setInputFiles('#file', file);
  await page.waitForSelector('#report:not([hidden]), #error:not([hidden])', { timeout: 90000 });
  const verdict = (await page.textContent('#verdict')) ?? '';
  const rows = await page.locator('#windows tbody tr').count();
  const played = await page.evaluate(() => (window as unknown as { __played: boolean }).__played);
  const err = await page.locator('#error:not([hidden])').count();
  if (err) errors.push((await page.textContent('#error-text')) ?? 'error');
  const reasons = (await page.textContent('#reasons')) ?? '';
  await page.close();
  return { verdict, rows, errors, played, reasons };
}

test('a failing MP4 dropped on the page fails, and nothing is played', async () => {
  const r = await dropFile(await writeClip('fail-full-4hz', '.mp4'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.verdict, 'Fail');
  assert.ok(r.rows >= 1);
  assert.equal(r.played, false);
});

test('a passing MP4 passes and a looping failing GIF fails', async () => {
  assert.equal((await dropFile(await writeClip('pass-full-2hz', '.mp4'))).verdict, 'Pass');
  assert.equal((await dropFile(await writeClip('fail-red-4hz', '.gif'))).verdict, 'Fail');
});

test('the page passes its own screen while showing a failing result', async () => {
  const r = await screen(`${base}/index.html#sample=fail-full-4hz`, { duration: 6, settle: 0.5, fps: 30, display: { width: 1440, height: 900 }, timeline: false });
  assert.equal(r.wcag231, 'pass', r.reasons.map((x) => x.message).join(' | '));
  assert.equal(r.verdict, 'pass', r.reasons.map((x) => x.message).join(' | '));
});

/** A 60 fps video whose every frame alternates black and white (a 30 Hz full screen strobe), 3 s. */
function strobe60(rate = '60'): string {
  const f = join(OUT, `strobe-${rate.replace('/', '_')}fps.mp4`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=320x240:r=${rate},geq=lum=if(mod(N\\,2)\\,235\\,16):cb=128:cr=128`, '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return f;
}

test('a 60 fps frame alternating strobe is never a pass: it fails at the video own rate, and warns when sampled slower', async () => {
  for (const rate of ['60', '60000/1001']) {
    const f = strobe60(rate);
    const auto = await dropFile(f);
    assert.deepEqual(auto.errors, []);
    assert.equal(auto.verdict, 'Fail', `${rate}: ${auto.reasons}`);
    assert.equal(auto.played, false);
    const slow = await dropFile(f, '30');
    assert.notEqual(slow.verdict, 'Pass', `${rate}: ${slow.reasons}`);
    assert.match(slow.reasons, /frame rate/, `${rate}`);
  }
});

test('a video whose frame rate cannot be read is never a pass', async () => {
  const frag = join(OUT, 'pass-frag.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', await writeClip('pass-full-2hz', '.mp4'), '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov', frag], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = await dropFile(frag);
  assert.equal(d.verdict, 'Warning', d.reasons);
  assert.match(d.reasons, /frame rate/);
});

test('a video longer than the page screens says so as a warning, not a note', async () => {
  const long = join(OUT, 'long-1fps.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=2', '-t', '302', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', long], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = await dropFile(long);
  assert.equal(d.verdict, 'Warning', d.reasons);
  assert.match(d.reasons, /Only the first 300 s/);
});

test('a low frame rate video sampled at its own rate, every frame once, is not warned about', async () => {
  const f = join(OUT, 'calm-15fps.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=15', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = await dropFile(f);
  assert.deepEqual(d.errors, []);
  assert.equal(d.verdict, 'Pass', d.reasons);
});

test('a video whose length reads Infinity until its end is read is screened to its real end', async () => {
  // Older Chromium builds report duration Infinity for MediaRecorder WebM until the end has been read; Chromium
  // 1223 estimates the length itself, so that behaviour is simulated here: duration is Infinity until a seek past
  // the real end.
  const init = `(() => {
    const dur = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
    const ct = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    const known = new WeakSet();
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() { return ct.get.call(this); },
      set(v) { if (v > dur.get.call(this)) known.add(this); ct.set.call(this, v); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get() { return known.has(this) ? dur.get.call(this) : Infinity; },
    });
  })();`;
  const f = await writeClip('pass-full-2hz', '.mp4');
  const t0 = Date.now();
  const d = await dropFile(f, undefined, init);
  assert.deepEqual(d.errors, []);
  assert.equal(d.verdict, 'Pass', d.reasons);
  assert.doesNotMatch(d.reasons, /Infinity|300 s/);
  assert.ok(Date.now() - t0 < 45000, `took ${Date.now() - t0} ms`);
});
