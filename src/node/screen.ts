// High level Node API: screen a file or URL, write a reduced flash version, build SARIF.
import { extname, basename, dirname, join, relative, resolve } from 'node:path';
import { FlashAnalyzer } from '../core/analyzer.ts';
import { ReducedFlashFilter } from '../core/fix.ts';
import { decodeGif, loopGifFrames } from '../core/gif.ts';
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { AreaRule, Reason, Report } from '../core/types.ts';
import { decodeVideo, encodeVideo, probe } from './ffmpeg.ts';
import type { DecodeStatus } from './ffmpeg.ts';
import { openSource } from './sources.ts';
import type { OpenOptions, Source } from './sources.ts';

export interface ScreenOptions extends OpenOptions {
  areaRule?: AreaRule;
  redBlackFloor?: number;
  timeline?: boolean;
  onProgress?: (frames: number, t: number) => void;
}

export async function screen(input: string, opts: ScreenOptions = {}): Promise<Report> {
  const src = await openSource(input, opts);
  const a = new FlashAnalyzer({
    width: src.width,
    height: src.height,
    format: src.format,
    displayWidth: src.display.width,
    displayHeight: src.display.height,
    fps: src.fps,
    areaRule: opts.areaRule,
    redBlackFloor: opts.redBlackFloor,
    timeline: opts.timeline ?? true,
    sampled: src.sampled,
  });
  let last = 0;
  for await (const f of src.frames) {
    a.push(f.data, f.t);
    last = f.t;
    if (opts.onProgress && a.frames % 30 === 0) opts.onProgress(a.frames, f.t);
  }
  if (a.frames === 0) throw new Error(`no frames could be read from ${input}`);
  for (const r of coverageReasons(src, a.frames, last)) a.addReason(r);
  for (const r of src.reasons ?? []) a.addReason(r);
  const r = a.finish();
  r.media.source = input;
  r.media.kind = src.kind;
  r.media.notes = [...src.notes, ...r.media.notes];
  r.media.width = src.mediaSize?.width ?? src.width;
  r.media.height = src.mediaSize?.height ?? src.height;
  return r;
}

/**
 * Checks after decoding that the whole file was read: ffmpeg exits 0 on many truncated or damaged files and simply
 * stops early, so the frames read are compared with what the file says it holds.
 */
export function coverageReasons(src: Source, frames: number, lastT: number): Reason[] {
  const out: Reason[] = [];
  const st = src.status;
  const exp = src.expected;
  if (exp?.capped && exp.duration !== null) {
    out.push({
      code: 'incomplete',
      level: 'warn',
      message: `Only the first ${exp.duration} s were screened (a length limit was set); the rest of the file was not read.`,
    });
  }
  if (st && st.errors.length) {
    out.push({
      code: 'incomplete',
      level: 'warn',
      message: `ffmpeg reported damaged or missing data (${st.errors.length} message${st.errors.length === 1 ? '' : 's'}, first: ${st.errors[0]}); frames may be missing from the screen.`,
    });
  }
  if (exp && !exp.capped) {
    // The end of what was read is the last frame's timestamp plus its own duration when ffmpeg gives it: a variable
    // frame rate file (a screen recording, a slideshow) can hold its last frame for seconds, far longer than the
    // average frame. Without that duration, one average frame is assumed.
    const frameDur = src.fps > 0 ? 1 / src.fps : 0;
    const ownEnd = src.status?.lastEnd ?? null;
    const readSeconds = ownEnd !== null && ownEnd >= lastT ? ownEnd : lastT + frameDur;
    const missingS = exp.duration !== null ? exp.duration - readSeconds : 0;
    const missingFrames = exp.frames !== null ? exp.frames - frames : 0;
    // Without each frame's own duration (ffmpeg before 5.0), a long held last frame looks like a gap; then reading
    // every stated frame counts as no gap. Only then: a fragmented MP4 states the frame count of its first fragment
    // only, so this would hide a real gap whenever the durations are known.
    const allFrames = ownEnd === null && exp.frames !== null && frames >= exp.frames;
    // The frame count is used only when the length is unknown: an edit list (a stream copy cut) hides frames
    // that the count still includes.
    if ((!allFrames && missingS > 0.5) || (exp.duration === null && exp.frames !== null && missingFrames > Math.max(2, 0.5 * src.fps))) {
      out.push({
        code: 'incomplete',
        level: 'warn',
        start: round3(readSeconds),
        end: exp.duration !== null ? round3(exp.duration) : undefined,
        message:
          `Decoding stopped early: ${frames} frames (${readSeconds.toFixed(2)} s) were read, but the file says it holds ` +
          `${[exp.frames !== null ? `${exp.frames} frames` : '', exp.duration !== null ? `${exp.duration.toFixed(2)} s` : ''].filter(Boolean).join(', ')}. ` +
          'The rest was not screened; the file may be truncated or damaged.',
      });
    }
  }
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export interface FixResult {
  output: string;
  before: Report;
  after: Report;
  tries: { tau: number; wcag231: Report['wcag231']; verdict: Report['verdict'] }[];
}

export function defaultFixPath(input: string): string {
  const ext = extname(input).toLowerCase() === '.gif' ? '.gif' : '.mp4';
  return join(dirname(input), `${basename(input, extname(input))}.reduced${ext}`);
}

/**
 * Writes a reduced flash version of a video or GIF, then screens the written file again. The time constant of the
 * filter doubles while the output still fails, up to `maxTries`. Never claims the output is safe.
 */
export async function fix(
  input: string,
  output: string | undefined,
  opts: ScreenOptions & { maxTries?: number; tau?: number } = {},
): Promise<FixResult> {
  const out = output ?? defaultFixPath(input);
  if (sameFile(out, input)) throw new Error('--fix-out is the same file as the input; refusing to overwrite the original');
  const outExt = extname(out).toLowerCase();
  const isGif = extname(input).toLowerCase() === '.gif';
  if (isGif ? outExt !== '.gif' : !['.mp4', '.mov', '.m4v', '.mkv'].includes(outExt)) {
    throw new Error(`--fix-out must end in ${isGif ? '.gif for a GIF input' : '.mp4, .mov, .m4v or .mkv for a video input'} (got "${out}")`);
  }
  const before = await screen(input, opts);
  if (!before.complete) throw new Error('the input could not be read in full (see the warnings), so no reduced flash version was written');
  if (isGif) {
    const g = decodeGif(new Uint8Array(readFileSync(input)), { background: opts.background });
    if (g.frames.length < 2) throw new Error('the GIF has a single frame; there is no flashing to reduce, so nothing was written');
  }
  const tries: FixResult['tries'] = [];
  let tau = opts.tau ?? 1;
  let after = before;
  const maxTries = opts.maxTries ?? 3;
  // Write to a new file of this run's own next to the output (same extension, so ffmpeg picks the same muxer), and
  // move it into place only once it is written and screened. Cleanup only ever deletes that file, never `out`.
  const tmp = join(dirname(out), `.${basename(out, extname(out))}.stillfield-tmp-${process.pid}-${randomBytes(4).toString('hex')}${extname(out)}`);
  if (existsSync(tmp)) throw new Error(`temporary file ${tmp} already exists`);
  try {
    for (let i = 0; i < maxTries; i++) {
      if (isGif) await fixGif(input, tmp, before, tau, opts);
      else await fixVideo(input, tmp, before, tau);
      // screen the written file, at the same display size and rules as the input
      after = await screen(tmp, { ...opts, display: before.settings.display, loop: true });
      after.media.source = out;
      tries.push({ tau, wcag231: after.wcag231, verdict: after.verdict });
      // a written file that could not be screened in full is not retried: a stronger filter would not help
      if (after.wcag231 === 'pass' || !after.complete) break;
      tau *= 2;
    }
    // checked again just before the move, in case `out` appeared as a link to the input meanwhile
    if (sameFile(out, input)) throw new Error('--fix-out is the same file as the input; refusing to overwrite the original');
    renameSync(tmp, out);
  } catch (e) {
    // never leave a half written file behind that looks like a finished one
    rmSync(tmp, { force: true });
    throw e;
  }
  return { output: out, before, after, tries };
}

/**
 * True when two paths name the same file: the same device and inode. This catches a case variant on a case
 * insensitive volume (macOS and Windows defaults), a symlink and a hard link, which a string compare misses.
 */
export function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  const sa = statSync(a, { bigint: true });
  const sb = statSync(b, { bigint: true });
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

async function fixVideo(input: string, out: string, before: Report, tau: number): Promise<void> {
  const info = probe(input);
  // process at the source size, capped at 1920 px wide to keep memory reasonable
  const k = Math.min(1, 1920 / info.width);
  const w = Math.max(2, Math.round((info.width * k) / 2) * 2);
  const h = Math.max(2, Math.round((info.height * k) / 2) * 2);
  const filter = new ReducedFlashFilter({
    width: w,
    height: h,
    format: 'rgb',
    displayWidth: before.settings.display.width,
    displayHeight: before.settings.display.height,
    tau,
    fps: info.fps,
  });
  const enc = encodeVideo(out, w, h, Math.round(info.fps * 1000) / 1000, {
    audioFrom: info.hasAudio ? input : undefined,
    audioCodec: info.audioCodec,
  });
  const status: DecodeStatus = { frames: 0, lastT: 0, lastEnd: null, exitCode: null, errors: [] };
  try {
    for await (const f of decodeVideo(input, w, h, { fps: info.fps, status })) await enc.write(filter.process(f.data, f.t));
  } finally {
    await enc.close();
  }
  if (status.exitCode !== 0) throw new Error(`ffmpeg stopped while reading ${input}: ${status.errors.join('; ')}`);
}

async function fixGif(input: string, out: string, before: Report, tau: number, opts: ScreenOptions): Promise<void> {
  const gif = decodeGif(new Uint8Array(readFileSync(input)), { background: opts.background });
  // A looping GIF: run three loops so the filter is in its steady state, and write the last loop (its wrap then
  // matches its start). A GIF that plays once is filtered and written once, from its start, and still plays once.
  const total = gif.delays.reduce((a, b) => a + b, 0);
  const once = gif.loopCount === null;
  const seq = loopGifFrames(once ? gif : { ...gif, loopCount: 0 }, once ? 0 : 3 * total, once ? 1 : 3).filter((_, i, arr) => i < arr.length - 1);
  const filter = new ReducedFlashFilter({
    width: gif.width,
    height: gif.height,
    format: 'rgba',
    displayWidth: before.settings.display.width,
    displayHeight: before.settings.display.height,
    tau,
  });
  // constant frame rate from the shortest delay (GIF delays are whole hundredths of a second)
  const minDelay = Math.max(0.02, Math.min(...gif.delays));
  const fps = Math.round(1 / minDelay);
  // ffmpeg's GIF muxer: -1 plays once, 0 loops forever, n repeats n more times (as the NETSCAPE loop count)
  const enc = encodeVideo(out, gif.width, gif.height, fps, { loop: once ? -1 : gif.loopCount! });
  const loops = Math.round(seq.length / gif.frames.length);
  const rgb = new Uint8Array(gif.width * gif.height * 3);
  let written = 0;
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    const res = filter.process(gif.frames[s.frame], s.t);
    if (i >= (loops - 1) * gif.frames.length) {
      for (let p = 0, q = 0; p < res.length; p += 4, q += 3) {
        rgb[q] = res[p];
        rgb[q + 1] = res[p + 1];
        rgb[q + 2] = res[p + 2];
      }
      const loopStart = (loops - 1) * total;
      const endT = (i + 1 < seq.length ? seq[i + 1].t : loops * total) - loopStart;
      while (written < Math.round(endT * fps)) {
        await enc.write(rgb);
        written++;
      }
    }
  }
  await enc.close();
}

// ---------------------------------------------------------------- SARIF 2.1.0

const RULES: Record<string, { name: string; text: string }> = {
  'general-flash': { name: 'GeneralFlash', text: 'More than three general flashes in one second over the area limit (WCAG 2.2 SC 2.3.1).' },
  'red-flash': { name: 'RedFlash', text: 'More than three red flashes in one second over the area limit (WCAG 2.2 SC 2.3.1).' },
  'general-at-limit': { name: 'GeneralFlashAtLimit', text: 'Exactly three general flashes in one second over the area limit.' },
  'red-at-limit': { name: 'RedFlashAtLimit', text: 'Exactly three red flashes in one second over the area limit.' },
  'general-near-area': { name: 'GeneralFlashNearArea', text: 'Fast general flashing over 80% to 100% of the area limit.' },
  'red-near-area': { name: 'RedFlashNearArea', text: 'Fast red flashing over 80% to 100% of the area limit.' },
  'extended-flashing': { name: 'ExtendedFlashing', text: 'Two or more flashes a second sustained for 4 s within 5 s (not a WCAG rule).' },
  'low-frame-rate': { name: 'LowFrameRate', text: 'Frame rate under 20 fps can hide flashes.' },
  'too-short': { name: 'TooShort', text: 'Less than one second of content was screened.' },
  'small-frame': { name: 'SmallFrame', text: 'The frame is smaller than the area limit at the size screened, so it cannot fail there, but it flashes fast.' },
  'incomplete': { name: 'Incomplete', text: 'Part of the content was not screened (decoding stopped early, or a length cap was reached).' },
  'sample-rate': { name: 'SampleRate', text: 'The content was sampled at a lower frame rate than it plays at, or its frame rate is unknown.' },
  'uncontrolled-content': { name: 'UncontrolledContent', text: 'Part of a page plays in real time outside the controlled clock, so it was not reliably screened.' },
  'no-frames': { name: 'NoFrames', text: 'No frames were screened.' },
};

/** Every reason code has a SARIF rule (checked by the tests). */
export const SARIF_RULE_IDS = Object.keys(RULES);

export function toSarif(reports: Report[], baseDir = process.cwd()): object {
  const ids = Object.keys(RULES);
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'stillfield',
            version: reports[0]?.tool.version ?? '0.0.0',
            informationUri: 'https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html',
            rules: ids.map((id) => ({
              id,
              name: RULES[id].name,
              shortDescription: { text: RULES[id].text },
              helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html',
            })),
          },
        },
        results: reports.flatMap((r) =>
          r.reasons.map((x) => ({
            ruleId: x.code,
            ruleIndex: ids.indexOf(x.code),
            level: x.level === 'fail' ? 'error' : x.level === 'warn' ? 'warning' : 'note',
            message: {
              text:
                (x.start !== undefined ? `${x.start.toFixed(2)} s to ${(x.end ?? x.start).toFixed(2)} s: ` : '') +
                x.message +
                ' Screening result, not a certification.',
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: /^[a-z]+:\/\//i.test(r.media.source)
                      ? r.media.source
                      : relative(baseDir, r.media.source).split('\\').join('/'),
                  },
                },
              },
            ],
            properties: { start: x.start, end: x.end, peakFlashesPerSecond: x.peakFlashesPerSecond, peakArea: x.peakArea },
          })),
        ),
      },
    ],
  };
}
