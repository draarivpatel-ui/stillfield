// End to end: real encoded files through the CLI. Failing clips are generated here and never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { OUT, clip, runCli, writeClip, writePngFolder } from './helpers.ts';

const MP4_CASES = [
  'fail-full-4hz',
  'pass-full-2hz',
  'fail-red-4hz',
  'borderline-area-over',
  'borderline-area-under',
  'pass-small-4hz',
  'pass-dark-chroma-noise',
  'fail-counterphase',
  'pass-single-cut',
  'warn-extended-2.5hz',
];

for (const name of MP4_CASES) {
  test(`H.264 yuv420p round trip keeps the result: ${name}`, async () => {
    const file = await writeClip(name, '.mp4');
    const r = runCli([file, '--json']);
    const rep = JSON.parse(r.stdout);
    const e = clip(name).expect!;
    assert.equal(rep.wcag231, e.wcag231, `${name}: ${rep.reasons.map((x: { message: string }) => x.message).join(' | ')}`);
    assert.equal(rep.verdict, e.verdict, `${name}: ${rep.reasons.map((x: { code: string }) => x.code).join(', ')}`);
    assert.equal(r.code, e.verdict === 'fail' ? 1 : 0);
    assert.equal(rep.settings.display.width, 1024);
    assert.equal(rep.media.kind, 'video');
  });
}

test('GIF round trip, screened while looping', async () => {
  const fail = await writeClip('fail-full-4hz', '.gif');
  const pass = await writeClip('pass-full-2hz', '.gif');
  const rf = JSON.parse(runCli([fail, '--json', '--display', '1024x768']).stdout);
  const rp = JSON.parse(runCli([pass, '--json', '--display', '1024x768']).stdout);
  assert.equal(rf.wcag231, 'fail');
  assert.equal(rp.wcag231, 'pass');
  assert.equal(rf.media.kind, 'gif');
  assert.ok(rf.media.duration >= 6, `looped duration ${rf.media.duration}`);
  // at its own size (256 x 192 = 49,152 CSS px), a full frame flash is still over the area limit
  assert.equal(JSON.parse(runCli([fail, '--json']).stdout).wcag231, 'fail');
});

test('PNG folder input', () => {
  const dir = writePngFolder('fail-full-5hz-30fps');
  const r = JSON.parse(runCli([dir, '--json', '--fps', '30', '--display', '1024x768']).stdout);
  assert.equal(r.wcag231, 'fail');
  assert.equal(r.media.kind, 'images');
});

test('text output, quiet output and exit codes', async () => {
  const file = await writeClip('fail-full-4hz', '.mp4');
  const t = runCli([file, '--no-color']);
  assert.equal(t.code, 1);
  assert.match(t.stdout, /FAIL/);
  assert.match(t.stdout, /not medical advice/);
  assert.doesNotMatch(t.stdout, /—|–/);
  const q = runCli([file, '-q']);
  assert.equal(q.stdout.trim(), `FAIL ${file}`);
  const w = await writeClip('borderline-area-under', '.mp4');
  assert.equal(runCli([w, '-q']).code, 0);
  assert.equal(runCli([w, '-q', '--strict']).code, 1);
});

test('SARIF 2.1.0 output', async () => {
  const file = await writeClip('fail-red-4hz', '.mp4');
  const out = join(OUT, 'red.sarif');
  runCli([file, '-q', '--sarif', out]);
  const s = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(s.version, '2.1.0');
  const res = s.runs[0].results;
  assert.ok(res.length >= 1);
  assert.equal(res[0].ruleId, 'red-flash');
  assert.equal(res[0].level, 'error');
  assert.equal(s.runs[0].tool.driver.rules[res[0].ruleIndex].id, 'red-flash');
  assert.match(res[0].message.text, /not a certification/);
});

test('missing ffmpeg gives a clear message and exit code 2', async () => {
  const file = await writeClip('pass-full-2hz', '.mp4');
  const r = runCli([file], { FFMPEG_PATH: '/nonexistent/ffmpeg', FFPROBE_PATH: '/nonexistent/ffprobe' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ffmpeg and ffprobe are needed/);
});

test('--fix writes a reduced flash video, screens the written file, and never says safe', async () => {
  const file = await writeClip('fail-full-4hz', '.mp4');
  const out = join(OUT, 'fixed-4hz.mp4');
  const r = runCli([file, '--fix', '--fix-out', out, '--json']);
  const j = JSON.parse(r.stdout);
  assert.ok(existsSync(out));
  assert.equal(j.before.wcag231, 'fail');
  assert.equal(j.after.wcag231, 'pass', j.after.reasons.map((x: { message: string }) => x.message).join(' | '));
  assert.equal(j.after.media.source, out);
  assert.equal(r.code, 1, 'exit code reflects the input, which fails');
  const t = runCli([file, '--fix', '--fix-out', out, '--no-color']);
  assert.match(t.stdout, /Screen of the written file/);
  assert.doesNotMatch(t.stdout, /\bsafe\b/i);
});

test('--fix on a GIF', async () => {
  const file = await writeClip('fail-red-4hz', '.gif');
  const out = join(OUT, 'fixed-red.gif');
  const j = JSON.parse(runCli([file, '--fix', '--fix-out', out, '--json', '--display', '1024x768']).stdout);
  assert.equal(j.before.wcag231, 'fail');
  assert.equal(j.after.wcag231, 'pass', j.after.reasons.map((x: { message: string }) => x.message).join(' | '));
});

test('a video with a 90 degree display rotation is screened upright, not squashed', async () => {
  const src = await writeClip('fail-half-field', '.mp4');
  const rot = join(OUT, 'rotated-half-field.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-display_rotation', '90', '-i', src, '-c', 'copy', rot]);
  assert.equal(r.status, 0);
  const rep = JSON.parse(runCli([rot, '--json']).stdout);
  assert.equal(rep.media.width, 192);
  assert.equal(rep.media.height, 256);
  assert.deepEqual(rep.settings.display, { width: 576, height: 768 });
  assert.equal(rep.wcag231, 'fail');
  assert.ok(rep.media.notes.some((n: string) => /rotation/.test(n)));
});
