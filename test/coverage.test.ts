// Regressions: no path may report a pass for content it did not screen. Real files through the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { OUT, runCli, writeClip } from './helpers.ts';
import { SARIF_RULE_IDS } from '../src/node/screen.ts';
import { passthroughArgs, probe } from '../src/node/ffmpeg.ts';
import { isApng } from '../src/node/sources.ts';

const ff = (...a: string[]) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const codes = (rep: { reasons: { code: string }[] }) => rep.reasons.map((x) => x.code).join(', ');

test('a truncated video is not a pass: exit 2, incomplete, not complete', async () => {
  // a calm 12 s clip (passes in full), cut to half its bytes: ffmpeg decodes the first part and exits 0
  const full = join(OUT, 'long-pass.mp4');
  ff('-stream_loop', '1', '-i', await writeClip('pass-slow-fade', '.mp4'), '-c', 'copy', '-movflags', '+faststart', full);
  const cut = join(OUT, 'truncated-pass.mp4');
  const buf = readFileSync(full);
  writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
  const r = runCli([cut, '--json']);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.complete, false, codes(rep));
  assert.notEqual(rep.verdict, 'pass');
  assert.ok(rep.reasons.some((x: { code: string }) => x.code === 'incomplete'), codes(rep));
  assert.equal(r.code, 2);
  // the text output says so too
  assert.match(runCli([cut, '--no-color']).stdout, /Not fully screened/);
  // the full file still passes, complete
  const ok = JSON.parse(runCli([full, '--json']).stdout);
  assert.equal(ok.verdict, 'pass');
  assert.equal(ok.complete, true);
});

test('a truncated video that already fails in the part read still fails (exit 1)', async () => {
  const full = join(OUT, 'long-fail.mp4');
  ff('-stream_loop', '3', '-i', await writeClip('fail-full-4hz', '.mp4'), '-c', 'copy', '-movflags', '+faststart', full);
  const cut = join(OUT, 'truncated-fail.mp4');
  const buf = readFileSync(full);
  writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
  const r = runCli([cut, '--json']);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.verdict, 'fail');
  assert.equal(rep.complete, false);
  assert.equal(r.code, 1);
});

test('a truncated Matroska file (no frame count, length in a tag) is caught too', async () => {
  const mp4 = await writeClip('pass-full-2hz', '.mp4');
  const mkv = join(OUT, 'pass-full-2hz.mkv');
  ff('-i', mp4, '-c', 'copy', mkv);
  const cut = join(OUT, 'truncated.mkv');
  const buf = readFileSync(mkv);
  writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
  assert.ok(probe(mkv).videoDuration! > 2.9);
  const r = runCli([cut, '--json']);
  assert.equal(r.code, 2, r.stdout.slice(0, 400) + r.stderr);
  assert.equal(JSON.parse(r.stdout).complete, false);
});

test('an animated PNG is refused, never passed', () => {
  const apng = join(OUT, 'strobe.png');
  // 10 Hz black and white for 1 s, looping
  ff('-f', 'lavfi', '-i', 'color=c=black:s=400x300:r=20,geq=lum=if(mod(N\\,2)\\,235\\,16):cb=128:cr=128', '-t', '1', '-plays', '0', '-f', 'apng', apng);
  assert.ok(isApng(readFileSync(apng)));
  const r = runCli([apng, '--json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /animated PNG/);
  // and inside a PNG folder
  const dir = join(OUT, 'apng-folder');
  mkdirSync(dir, { recursive: true });
  copyFileSync(apng, join(dir, 'frame0.png'));
  assert.equal(runCli([dir, '--json']).code, 2);
});

test('PNG frames are composited over the background: a black shape blinking on transparency fails on white', () => {
  const dir = join(OUT, 'alpha-png');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 60; i++) {
    const png = new PNG({ width: 400, height: 300 });
    png.data.fill(0); // fully transparent black
    if (i % 4 < 2) for (let p = 3; p < png.data.length; p += 4) png.data[p] = 255; // opaque black on, then off
    writeFileSync(join(dir, `f${i}.png`), PNG.sync.write(png));
  }
  const rep = JSON.parse(runCli([dir, '--json', '--fps', '30']).stdout);
  assert.equal(rep.wcag231, 'fail', codes(rep));
  assert.ok(rep.media.notes.some((n: string) => /transparent/.test(n)));
  // over a black background the same frames do not change
  const onBlack = JSON.parse(runCli([dir, '--json', '--fps', '30', '--background', '000000']).stdout);
  assert.equal(onBlack.wcag231, 'pass');
});

test('a slow GIF with no flashing passes, with the low frame rate only noted', async () => {
  const dir = join(OUT, 'slow-gif');
  mkdirSync(dir, { recursive: true });
  const gif = join(dir, 'slow.gif');
  ff('-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=10', '-t', '3', gif);
  const rep = JSON.parse(runCli([gif, '--json']).stdout);
  assert.equal(rep.verdict, 'pass', codes(rep));
  const lf = rep.reasons.find((x: { code: string }) => x.code === 'low-frame-rate');
  assert.equal(lf?.level, 'info');
});

test('a small GIF that strobes warns that it cannot fail at its own size', () => {
  const gif = join(OUT, 'small-strobe.gif');
  ff('-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=20,geq=lum=if(mod(N\\,2)\\,235\\,16):cb=128:cr=128', '-t', '2', gif);
  const r = runCli([gif, '--json']);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.wcag231, 'pass');
  assert.equal(rep.verdict, 'warn');
  assert.ok(rep.reasons.some((x: { code: string }) => x.code === 'small-frame'), codes(rep));
  assert.equal(JSON.parse(runCli([gif, '--json', '--display', '1024x768']).stdout).wcag231, 'fail');
});

test('--out writes every report, with or without --json', async () => {
  const a = await writeClip('fail-full-4hz', '.mp4');
  const b = await writeClip('pass-full-2hz', '.gif');
  const out = join(OUT, 'out-multi.json');
  rmSync(out, { force: true });
  runCli([a, b, '-q', '--out', out]);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(j.length, 2);
  assert.equal(j[0].verdict, 'fail');
  assert.equal(j[1].media.kind, 'gif');
  const one = join(OUT, 'out-one.json');
  runCli([b, '-q', '--out', one]);
  assert.equal(JSON.parse(readFileSync(one, 'utf8')).media.kind, 'gif');
});

test('--fix never overwrites its input and takes --fix-out for one input only', async () => {
  const src = await writeClip('fail-full-4hz', '.gif');
  const copy = join(OUT, 'fix-self.gif');
  copyFileSync(src, copy);
  const before = statSync(copy).size;
  const r = runCli([copy, '--fix', '--fix-out', copy]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /overwrite/);
  assert.equal(statSync(copy).size, before);
  const mp4 = await writeClip('fail-full-4hz', '.mp4');
  const two = runCli([mp4, copy, '--fix', '--fix-out', join(OUT, 'one.mp4')]);
  assert.equal(two.code, 2);
  assert.match(two.stderr, /one file/);
  assert.equal(existsSync(join(OUT, 'one.mp4')), false);
  assert.equal(runCli([mp4, '--fix', '--fix-out', join(OUT, 'wrong.webm')]).code, 2);
});

test('--fix keeps audio from a PCM .mov and keeps a play once GIF playing once', async () => {
  const mp4 = await writeClip('fail-full-4hz', '.mp4');
  const mov = join(OUT, 'pcm.mov');
  ff('-i', mp4, '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'pcm_s16le', '-shortest', mov);
  const out = join(OUT, 'pcm.reduced.mp4');
  const r = runCli([mov, '--fix', '--fix-out', out, '--json']);
  assert.equal(r.code, 1, r.stderr);
  assert.ok(probe(out).hasAudio);
  // play once GIF: no NETSCAPE loop block
  const once = join(OUT, 'once.gif');
  ff('-i', await writeClip('fail-full-4hz', '.gif'), '-loop', '-1', once);
  const fixed = join(OUT, 'once.reduced.gif');
  const g = runCli([once, '--fix', '--fix-out', fixed, '--json']);
  assert.ok(existsSync(fixed), g.stderr);
  assert.ok(!readFileSync(fixed).includes(Buffer.from('NETSCAPE2.0')), 'written GIF plays once');
  assert.ok(readFileSync(await writeClip('fail-full-4hz', '.gif')).includes(Buffer.from('NETSCAPE2.0')));
});

test('--fix on a single frame GIF writes nothing and says why', () => {
  const gif = join(OUT, 'single.gif');
  ff('-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', gif);
  const out = join(OUT, 'single.reduced.gif');
  rmSync(out, { force: true });
  const r = runCli([gif, '--fix']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /single frame/);
  assert.equal(existsSync(out), false);
});

test('input validation: --fps and --duration must be above 0', () => {
  assert.match(runCli(['x.gif', '--fps', '0']).stderr, /positive/);
  assert.equal(runCli(['x.gif', '--duration', '0']).code, 2);
});

test('every reason code has a SARIF rule', () => {
  const types = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'types.ts'), 'utf8');
  const union = types.slice(types.indexOf('code:'), types.indexOf('level:', types.indexOf('code:')));
  const all = [...union.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(all.length >= 14);
  assert.deepEqual([...all].sort(), [...SARIF_RULE_IDS].sort());
});

test('older ffmpeg builds get -vsync instead of -fps_mode', () => {
  assert.deepEqual(passthroughArgs([4, 4]), ['-vsync', 'passthrough']);
  assert.deepEqual(passthroughArgs([5, 0]), ['-vsync', 'passthrough']);
  assert.deepEqual(passthroughArgs([5, 1]), ['-fps_mode', 'passthrough']);
  assert.deepEqual(passthroughArgs(null), ['-fps_mode', 'passthrough']);
});

test('the stillfield/node entry point exports the Node API', async () => {
  const m = await import('../src/node/index.ts');
  for (const k of ['screen', 'fix', 'toSarif', 'openSource', 'probe']) assert.equal(typeof (m as Record<string, unknown>)[k], 'function', k);
});

test('a GIF cut at a frame boundary (no trailer) is not a pass', async () => {
  const d = readFileSync(await writeClip('pass-full-2hz', '.gif'));
  let gce = -1;
  for (let i = Math.floor(d.length / 2); i < d.length - 1; i++) if (d[i] === 0x21 && d[i + 1] === 0xf9) { gce = i; break; }
  assert.ok(gce > 0);
  const cut = join(OUT, 'boundary-cut.gif');
  writeFileSync(cut, d.subarray(0, gce));
  const r = runCli([cut, '--json']);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.complete, false, codes(rep));
  assert.equal(r.code, 2);
  // the whole file is complete
  assert.equal(JSON.parse(runCli([await writeClip('pass-full-2hz', '.gif'), '--json']).stdout).complete, true);
});

test('good files are not flagged: a path containing "corrupt", a stream copy cut, audio longer than video', async () => {
  const ok = join(OUT, 'corrupt-but-fine.mp4');
  copyFileSync(await writeClip('pass-full-2hz', '.mp4'), ok);
  const a = runCli([ok, '--json']);
  assert.equal(a.code, 0, codes(JSON.parse(a.stdout)));
  const long = await writeClip('pass-slow-fade', '.mp4');
  const cut = join(OUT, 'stream-copy-cut.mp4');
  ff('-ss', '0.7', '-i', long, '-c', 'copy', cut);
  const b = JSON.parse(runCli([cut, '--json']).stdout);
  assert.equal(b.complete, true, codes(b));
  const withAudio = join(OUT, 'long-audio.mp4');
  ff('-i', long, '-f', 'lavfi', '-i', 'sine=d=12', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', withAudio);
  const c = JSON.parse(runCli([withAudio, '--json']).stdout);
  assert.equal(c.complete, true, codes(c));
});

test('an .apng file is refused like an animated .png', () => {
  const apng = join(OUT, 'strobe2.apng');
  ff('-f', 'lavfi', '-i', 'color=c=black:s=400x300:r=20,geq=lum=if(mod(N\\,2)\\,235\\,16):cb=128:cr=128', '-t', '0.5', '-plays', '0', '-f', 'apng', apng);
  const r = runCli([apng, '-q']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /animated PNG/);
});
