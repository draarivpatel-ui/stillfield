// The web page reads a video's own frame rate from its container (it never plays dropped media).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { OUT } from './helpers.ts';
import { detectFrameRate } from '../web/src/framerate.ts';

function make(name: string, rate: string, extra: string[]): string {
  const f = join(OUT, name);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=${rate}`, '-t', '2', ...extra, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return f;
}

for (const rate of ['24', '30', '30000/1001', '60000/1001', '60']) {
  const want = rate.includes('/') ? Number(rate.split('/')[0]) / Number(rate.split('/')[1]) : Number(rate);
  test(`frame rate from MP4 and WebM containers: ${rate}`, async () => {
    const tag = rate.replace('/', '_');
    for (const [ext, args] of [
      ['.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
      ['.mov', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
      ['.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']],
      ['.webm', ['-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime']],
    ] as const) {
      const f = make(`rate-${tag}-${args.length}${ext}`, rate, [...args]);
      const r = await detectFrameRate(await openAsBlob(f));
      assert.ok(r, `${ext} ${rate}: no rate`);
      assert.ok(Math.abs(r!.fps - want) < 0.01, `${ext} ${rate}: ${r!.fps}`);
      assert.ok(r!.maxFps >= r!.fps - 1e-9);
    }
  });
}

test('fragmented MP4 and unknown containers give no rate (the page then warns)', async () => {
  const frag = make('rate-frag.mp4', '30', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov']);
  assert.equal(await detectFrameRate(await openAsBlob(frag)), null);
  assert.equal(await detectFrameRate(new Blob([new Uint8Array(64)])), null);
});

test('a short burst of fast frames in a variable frame rate MP4 sets the fastest rate', async () => {
  // 60 s at 30 fps with 12 frames at 60 fps after 10 s: under 1% of the frames, so a percentile missed it
  const base = make('rate-burst-base.mp4', '30', ['-t', '60', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', '-video_track_timescale', '600']);
  const f = join(OUT, 'rate-burst.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', base, '-c', 'copy', '-bsf:v', "setts=ts='if(lt(N\\,300)\\,N/30\\,if(lt(N\\,312)\\,10+(N-300)/60\\,10.2+(N-312)/30))/TB'", f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rate = await detectFrameRate(await openAsBlob(f));
  assert.ok(rate);
  assert.ok(Math.abs(rate!.fps - 30) < 0.01, String(rate!.fps));
  assert.ok(Math.abs(rate!.maxFps - 60) < 0.01, String(rate!.maxFps));
  // a single short frame (a timestamp glitch) is not a sustained rate
  const g = join(OUT, 'rate-glitch.mp4');
  const r2 = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', base, '-c', 'copy', '-bsf:v', "setts=ts='if(lt(N\\,300)\\,N/30\\,(N+0.5)/30)/TB'", g], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  const gl = await detectFrameRate(await openAsBlob(g));
  assert.ok(gl && Math.abs(gl.maxFps - 30) < 0.01, String(gl?.maxFps));
});
