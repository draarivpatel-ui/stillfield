// Test helpers: write proof clips to real media files (H.264 yuv420p MP4, GIF, PNG folder) under test/.out.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { CLIPS, generateClip } from '../src/core/index.ts';
import type { ClipSpec } from '../src/core/index.ts';
import { encodeVideo } from '../src/node/ffmpeg.ts';

export const OUT = join(import.meta.dirname, '.out');
mkdirSync(OUT, { recursive: true });

export function clip(name: string): ClipSpec {
  const c = CLIPS.find((x) => x.name === name);
  if (!c) throw new Error(`no clip ${name}`);
  return c;
}

export async function writeClip(name: string, ext: '.mp4' | '.gif'): Promise<string> {
  const spec = clip(name);
  const file = join(OUT, `${name}${ext}`);
  if (existsSync(file)) return file;
  const enc = encodeVideo(file, spec.width, spec.height, spec.fps);
  for (const f of generateClip(spec)) await enc.write(f.data);
  await enc.close();
  return file;
}

export function writePngFolder(name: string): string {
  const spec = clip(name);
  const dir = join(OUT, `${name}-png`);
  if (existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true });
  let i = 0;
  for (const f of generateClip(spec)) {
    const png = new PNG({ width: spec.width, height: spec.height });
    for (let p = 0, q = 0; p < f.data.length; p += 3, q += 4) {
      png.data[q] = f.data[p];
      png.data[q + 1] = f.data[p + 1];
      png.data[q + 2] = f.data[p + 2];
      png.data[q + 3] = 255;
    }
    writeFileSync(join(dir, `frame${i++}.png`), PNG.sync.write(png));
  }
  return dir;
}

export const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

export function runCli(args: string[], env: Record<string, string> = {}, timeoutMs?: number): { code: number; stdout: string; stderr: string; timedOut: boolean } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 << 20, timeout: timeoutMs, killSignal: 'SIGKILL' });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, timedOut: r.error?.message.includes('ETIMEDOUT') ?? false };
}
