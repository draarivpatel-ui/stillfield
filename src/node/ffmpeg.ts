// Thin wrappers around the system ffmpeg and ffprobe (run as separate programs; nothing is linked).
import { spawn, spawnSync } from 'node:child_process';

export class ToolMissingError extends Error {}

function bin(name: 'ffmpeg' | 'ffprobe'): string {
  return (name === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH) || name;
}

export function hasTool(name: 'ffmpeg' | 'ffprobe'): boolean {
  const r = spawnSync(bin(name), ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

export function requireFfmpeg(): void {
  if (!hasTool('ffmpeg') || !hasTool('ffprobe')) {
    throw new ToolMissingError(
      'ffmpeg and ffprobe are needed to read video (ffmpeg 4.4 or newer). Install ffmpeg (https://ffmpeg.org/download.html, or ' +
        '`brew install ffmpeg`, `apt install ffmpeg`, `winget install ffmpeg`), or set FFMPEG_PATH and FFPROBE_PATH. ' +
        'GIFs, PNG sequences and web pages work without it.',
    );
  }
}

let versionCache: [number, number] | null | undefined;

/** ffmpeg major and minor version, or null for a build that does not say (git builds are treated as new). */
export function ffmpegVersion(): [number, number] | null {
  if (versionCache !== undefined) return versionCache;
  const out = spawnSync(bin('ffmpeg'), ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout ?? '';
  const m = /ffmpeg version n?(\d+)\.(\d+)/.exec(out);
  versionCache = m ? [Number(m[1]), Number(m[2])] : null;
  return versionCache;
}

/** `-fps_mode` arrived in ffmpeg 5.1; older builds take `-vsync`. */
export function passthroughArgs(v = ffmpegVersion()): string[] {
  if (v && (v[0] < 5 || (v[0] === 5 && v[1] < 1))) return ['-vsync', 'passthrough'];
  return ['-fps_mode', 'passthrough'];
}

export interface Probe {
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Length of the video stream itself when the file says (not the container, which can include longer audio). */
  videoDuration: number | null;
  frames: number | null;
  codec: string;
  pixFmt: string;
  transfer: string;
  primaries: string;
  hasAudio: boolean;
  /** Codec of the first audio stream ('' when there is none). */
  audioCodec: string;
  /** Display rotation in degrees from the stream's display matrix (ffmpeg applies it when decoding). */
  rotation: number;
}

function ratio(s: string | undefined): number {
  if (!s) return 0;
  const [a, b] = s.split('/').map(Number);
  return b ? a / b : a || 0;
}

export function probe(file: string): Probe {
  requireFfmpeg();
  const r = spawnSync(
    bin('ffprobe'),
    ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,duration,pix_fmt,color_transfer,color_primaries:stream_side_data=rotation:stream_tags=rotate,DURATION:format=duration', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 16 << 20 },
  );
  if (r.status !== 0) throw new Error(`ffprobe could not read ${file}: ${(r.stderr || '').trim().split('\n').pop()}`);
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'video');
  if (!v) throw new Error(`${file} has no video stream`);
  const fps = ratio(v.avg_frame_rate) || ratio(v.r_frame_rate) || 30;
  const sideRot = (v.side_data_list || []).find((d: { rotation?: number }) => typeof d.rotation === 'number')?.rotation;
  const rotation = Number(sideRot ?? v.tags?.rotate ?? 0) || 0;
  // ffmpeg rotates frames while decoding, so a quarter turn swaps the picture's width and height
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const audio = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'audio');
  const hasAudio = !!audio;
  const frames = v.nb_frames ? Number(v.nb_frames) : null;
  // Matroska keeps the stream length in a DURATION tag (HH:MM:SS.fraction)
  const tag = /^(\d+):(\d+):([\d.]+)$/.exec(String(v.tags?.DURATION ?? ''));
  const tagDuration = tag ? Number(tag[1]) * 3600 + Number(tag[2]) * 60 + Number(tag[3]) : NaN;
  const streamDuration = Number(v.duration);
  const videoDuration =
    Number.isFinite(streamDuration) && streamDuration > 0
      ? streamDuration
      : Number.isFinite(tagDuration) && tagDuration > 0
        ? tagDuration
        : frames && fps
          ? frames / fps
          : !hasAudio && Number(j.format?.duration) > 0
            ? Number(j.format.duration)
            : null;
  return {
    width: quarter ? v.height : v.width,
    height: quarter ? v.width : v.height,
    rotation,
    fps,
    duration: Number(v.duration || j.format?.duration || 0),
    videoDuration,
    frames,
    codec: v.codec_name || '',
    pixFmt: v.pix_fmt || '',
    transfer: v.color_transfer || '',
    primaries: v.color_primaries || '',
    hasAudio,
    audioCodec: audio?.codec_name || '',
  };
}

export interface DecodedFrame {
  data: Uint8Array;
  t: number;
}

/** What a decode run found besides frames: filled in as decoding goes, final once the generator has ended. */
export interface DecodeStatus {
  frames: number;
  lastT: number;
  /**
   * End of the last frame read (its timestamp plus its own duration, from showinfo), or null when ffmpeg did not
   * give the duration (ffmpeg before 5.0, or a frame without one).
   */
  lastEnd: number | null;
  /** ffmpeg exit code (null until it has exited). */
  exitCode: number | null;
  /** Decoder or demuxer errors ffmpeg reported (damaged or missing data). */
  errors: string[];
}

/**
 * ffmpeg's own error lines: they start with a component tag like `[h264 @ 0x...]` (or, in ffmpeg 4.x, with
 * "Error while decoding"). Other stderr lines (input name, metadata) are never matched, whatever they contain.
 */
const DECODE_ERROR = /^(?:(?:\[[^\]]+\]\s*)+.*(?:Decoding error|Invalid data found|partial file|File ended prematurely|corrupt|error while decoding|concealing|Invalid NAL|missing picture)|Error while decoding)/i;

/**
 * Decodes a video to rgb24 frames at `width` x `height` with presentation timestamps (seconds, from showinfo).
 * Frames keep their own timing (variable frame rate is preserved).
 */
export async function* decodeVideo(
  file: string,
  width: number,
  height: number,
  opts: { maxSeconds?: number; fps?: number; status?: DecodeStatus } = {},
): AsyncGenerator<DecodedFrame> {
  requireFfmpeg();
  const status = opts.status ?? { frames: 0, lastT: 0, lastEnd: null, exitCode: null, errors: [] };
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-i', file];
  if (opts.maxSeconds) args.push('-t', String(opts.maxSeconds));
  args.push(
    '-an', '-sn', '-dn',
    '-vf', `scale=${width}:${height}:flags=area,showinfo`,
    ...passthroughArgs(),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  );
  const p = spawn(bin('ffmpeg'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const frameBytes = width * height * 3;
  const times: number[] = [];
  const durations: number[] = [];
  let errTail = '';
  let errBuf = '';
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (s: string) => {
    errBuf += s;
    let nl: number;
    while ((nl = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, nl);
      errBuf = errBuf.slice(nl + 1);
      const m = /Parsed_showinfo.*\bpts_time:\s*(-?[\d.]+)/.exec(line);
      if (m) {
        times.push(Number(m[1]));
        const d = /\bduration_time:\s*([\d.]+)/.exec(line);
        durations.push(d ? Number(d[1]) : NaN);
      }
      else if (line.trim()) {
        errTail = line;
        if (DECODE_ERROR.test(line) && status.errors.length < 20) status.errors.push(line.trim());
      }
    }
  });
  const exit = new Promise<number>((res) => p.on('close', (code) => res(code ?? 1)));
  let pending: Buffer[] = [];
  let have = 0;
  let index = 0;
  let firstPts: number | null = null;
  const waitTime = async (i: number): Promise<number | undefined> => {
    for (let k = 0; k < 200 && times.length <= i; k++) await new Promise((r) => setTimeout(r, 5));
    return times[i];
  };
  for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
    pending.push(chunk);
    have += chunk.length;
    while (have >= frameBytes) {
      const all = Buffer.concat(pending);
      const data = new Uint8Array(all.buffer, all.byteOffset, frameBytes).slice();
      const rest = all.subarray(frameBytes);
      pending = rest.length ? [rest] : [];
      have = rest.length;
      let t = await waitTime(index);
      if (t === undefined || !Number.isFinite(t)) t = index / fps;
      if (firstPts === null) firstPts = t;
      index++;
      status.frames = index;
      status.lastT = t - firstPts;
      const own = durations[index - 1];
      status.lastEnd = own !== undefined && Number.isFinite(own) && own > 0 ? status.lastT + own : null;
      yield { data, t: t - firstPts };
    }
  }
  const code = await exit;
  status.exitCode = code;
  if (code !== 0 && index === 0) throw new Error(`ffmpeg could not decode ${file}: ${errTail}`);
  if (code !== 0) status.errors.push(`ffmpeg stopped with exit code ${code}: ${errTail.trim()}`);
}

const MP4_AUDIO = new Set(['aac', 'mp3', 'alac', 'ac3', 'eac3']);

export interface Encoder {
  write(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Encodes rgb24 frames at a constant frame rate. `.gif` outputs use a generated palette. */
export function encodeVideo(
  out: string,
  width: number,
  height: number,
  fps: number,
  opts: { audioFrom?: string; audioCodec?: string; loop?: number } = {},
): Encoder {
  requireFfmpeg();
  const gif = out.toLowerCase().endsWith('.gif');
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'];
  if (gif) {
    // GIF muxer: -loop 0 loops forever, -1 plays once, n repeats n times
    args.push('-vf', 'split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', String(opts.loop ?? 0), out);
  } else {
    // audio is copied when MP4 takes it everywhere, otherwise re-encoded to AAC (PCM, Vorbis and others are not
    // allowed in MP4 by older ffmpeg builds and many players)
    if (opts.audioFrom) {
      const copy = MP4_AUDIO.has(opts.audioCodec ?? '');
      args.push('-i', opts.audioFrom, '-map', '0:v', '-map', '1:a?', ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']));
    }
    const x264 = spawnSync(bin('ffmpeg'), ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264');
    if (x264) args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '16');
    else args.push('-c:v', 'mpeg4', '-q:v', '2');
    args.push('-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-movflags', '+faststart', out);
  }
  const p = spawn(bin('ffmpeg'), args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (s: string) => (err += s));
  const done = new Promise<number>((res) => p.on('close', (c) => res(c ?? 1)));
  let failed = false;
  p.stdin.on('error', () => (failed = true));
  return {
    write(frame: Uint8Array) {
      if (failed) return Promise.reject(new Error(`ffmpeg encoder stopped: ${err.trim()}`));
      return new Promise((res, rej) => {
        p.stdin.write(frame, (e) => (e ? rej(e) : res()));
      });
    },
    async close() {
      p.stdin.end();
      const code = await done;
      if (code !== 0) throw new Error(`ffmpeg could not write ${out}: ${err.trim()}`);
    },
  };
}
