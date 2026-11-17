// Regressions: Node side fixes, through the CLI on real files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, linkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { OUT, runCli, writeClip } from './helpers.ts';
import { parseDisplay } from '../src/node/sources.ts';
import { decodeGif } from '../src/core/gif.ts';
import { FlashAnalyzer } from '../src/core/analyzer.ts';

const ff = (...a: string[]) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const codes = (rep: { reasons: { code: string }[] }) => rep.reasons.map((x) => x.code).join(', ');
const hash = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

test('a variable frame rate video that holds its last frame for 4 s is read in full, not truncated', () => {
  // 60 frames at 30 fps, then the last frame's own duration set to 4 s (as screen recorders write a final hold)
  const cfr = join(OUT, 'vfr-base.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30', '-t', '2', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', cfr);
  const held = join(OUT, 'vfr-held.mp4');
  ff('-i', cfr, '-c', 'copy', '-bsf:v', "setts=duration='if(eq(N\\,59)\\,DURATION*120\\,DURATION)'", held);
  const r = runCli([held, '--json']);
  const rep = JSON.parse(r.stdout);
  assert.ok(!rep.reasons.some((x: { code: string }) => x.code === 'incomplete'), codes(rep) + ' ' + JSON.stringify(rep.reasons));
  assert.equal(rep.complete, true);
  assert.equal(r.code, 0, r.stderr);
  // and the same file cut in half is still caught
  const cut = join(OUT, 'vfr-held-cut.mp4');
  ff('-i', held, '-c', 'copy', '-movflags', '+faststart', join(OUT, 'vfr-held-fs.mp4'));
  const buf = readFileSync(join(OUT, 'vfr-held-fs.mp4'));
  writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
  const c = runCli([cut, '--json']);
  assert.equal(c.code, 2, c.stdout.slice(0, 300) + c.stderr);
  assert.equal(JSON.parse(c.stdout).complete, false);
});

test('a fragmented MP4 cut mid fragment still gets the length check (its frame count covers one fragment only)', async () => {
  const calm = join(OUT, 'frag-calm.mp4');
  ff('-stream_loop', '2', '-i', await writeClip('pass-slow-fade', '.mp4'), '-c', 'copy', '-movflags', 'frag_keyframe', '-frag_duration', '1000000', calm);
  const cut = join(OUT, 'frag-calm-cut.mp4');
  const buf = readFileSync(calm);
  writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
  const rep = JSON.parse(runCli([cut, '--json']).stdout);
  assert.equal(rep.complete, false);
  assert.ok(rep.reasons.some((x: { message: string }) => /Decoding stopped early/.test(x.message)), JSON.stringify(rep.reasons));
});

test('--fix-out that names the input by another spelling or link is refused, input untouched', async () => {
  const src = await writeClip('fail-full-4hz', '.gif');
  const copy = join(OUT, 'alias-in.gif');
  copyFileSync(src, copy);
  const h = hash(copy);
  const tries: string[] = [];
  // a case variant, on a case insensitive volume (the macOS default)
  const upper = join(OUT, 'ALIAS-IN.GIF');
  if (existsSync(upper)) tries.push(upper);
  const sym = join(OUT, 'alias-sym.gif');
  rmSync(sym, { force: true });
  symlinkSync(copy, sym);
  tries.push(sym);
  const hard = join(OUT, 'alias-hard.gif');
  rmSync(hard, { force: true });
  linkSync(copy, hard);
  tries.push(hard);
  for (const out of tries) {
    const r = runCli([copy, '--fix', '--fix-out', out]);
    assert.equal(r.code, 2, `${out}: ${r.stderr}`);
    assert.match(r.stderr, /same file|overwrite/);
    assert.equal(hash(copy), h, `input changed by --fix-out ${out}`);
  }
  // the other way round: the input given through the link, the output as the real file
  const r = runCli([sym, '--fix', '--fix-out', copy]);
  assert.equal(r.code, 2);
  assert.equal(hash(copy), h);
});

test('a failed --fix write deletes only its own file, never one already at --fix-out', async () => {
  const src = await writeClip('fail-full-4hz', '.gif');
  const input = join(OUT, 'fail-enc-in.gif');
  copyFileSync(src, input);
  const h = hash(input);
  const out = join(OUT, 'fail-enc-out.gif');
  writeFileSync(out, 'keep me');
  // an ffmpeg that answers -version but fails on every encode (any run that reads frames from a pipe)
  const wrapper = join(OUT, 'ffmpeg-fails-encode.sh');
  const real = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(wrapper, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "pipe:0" ] && { echo "simulated encode failure" >&2; exit 1; }; done\nexec "${real}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const r = runCli([input, '--fix', '--fix-out', out], { FFMPEG_PATH: wrapper });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), 'keep me');
  assert.equal(hash(input), h);
  // no temporary file left behind
  const left = spawnSync('ls', ['-a', OUT], { encoding: 'utf8' }).stdout.split('\n').filter((f) => /stillfield-tmp/.test(f));
  assert.deepEqual(left, []);
});

test('--fix reports that the written file was not fully screened when its screen is incomplete', async () => {
  // simulated by an ffprobe that claims the written file holds 60 s and 1800 frames, far more than it does
  const src = await writeClip('fail-full-4hz', '.mp4');
  const out = join(OUT, 'fix-after-incomplete.mp4');
  const realProbe = spawnSync('sh', ['-c', 'command -v ffprobe'], { encoding: 'utf8' }).stdout.trim();
  const wrapper = join(OUT, 'ffprobe-lies.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nlast=""; for a in "$@"; do last="$a"; done\ncase "$last" in *stillfield-tmp*) "${realProbe}" "$@" | sed -e 's/"duration": "[0-9.]*"/"duration": "60.000000"/' -e 's/"nb_frames": "[0-9]*"/"nb_frames": "1800"/' ;; *) exec "${realProbe}" "$@" ;; esac\n`,
  );
  chmodSync(wrapper, 0o755);
  const r = runCli([src, '--fix', '--fix-out', out, '--no-color'], { FFPROBE_PATH: wrapper });
  assert.equal(r.code, 2, r.stdout.slice(-600) + r.stderr);
  assert.match(r.stdout, /not fully screened/i);
  assert.doesNotMatch(r.stdout, /screened without a WCAG 2\.3\.1 failure/);
});

test('--display needs a width and height of at least 1', () => {
  assert.throws(() => parseDisplay('0x0'), /at least 1/);
  assert.throws(() => parseDisplay('640x0'), /at least 1/);
  assert.deepEqual(parseDisplay('1x1'), { width: 1, height: 1 });
});

test('a GIF with bytes after its trailer is complete; one cut before the trailer is not', async () => {
  const gif = readFileSync(await writeClip('fail-full-4hz', '.gif'));
  const joined = new Uint8Array(Buffer.concat([gif, Buffer.from('appended data, not part of the GIF')]));
  assert.equal(decodeGif(joined).truncated, false);
  assert.equal(decodeGif(new Uint8Array(gif)).truncated, false);
  // cut the trailer off: the last frame is whole, the end marker is missing
  assert.equal(decodeGif(new Uint8Array(gif.subarray(0, gif.length - 1))).truncated, true);
});

test('a coverage reason is never below warn, so complete false never comes with a plain pass', () => {
  const a = new FlashAnalyzer({ width: 64, height: 64, format: 'rgb', displayWidth: 64, displayHeight: 64, fps: 30 });
  const f = new Uint8Array(64 * 64 * 3);
  for (let i = 0; i < 45; i++) a.push(f, i / 30);
  a.addReason({ code: 'incomplete', level: 'info', message: 'part not read' });
  const r = a.finish();
  assert.equal(r.complete, false);
  assert.notEqual(r.verdict, 'pass');
});
