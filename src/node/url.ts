// Records a web page in Chromium (playwright-core) at a fixed frame rate under a controlled clock.
// Each step: advance the page clock by exactly one frame, step CSS and Web Animations and <video> elements to the
// same time, then take a screenshot. SPEC.md section 6.
import { pathToFileURL } from 'node:url';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { GifReader } from 'omggif';
import type { Reason } from '../core/types.ts';
import type { OpenOptions, Source } from './sources.ts';
import { isApng } from './sources.ts';

/**
 * What image bytes are: `animated` (GIF with more than one frame, APNG, animated WebP, AVIF image sequence, an SVG
 * with SMIL or CSS animation, or one that embeds an animated image), `still` (a format known not to animate), or
 * `unknown` (anything else, an HTML error page or gzip SVG for example). Browsers play animations in real time,
 * outside the page clock Stillfield controls, so only `still` may count as checked.
 */
export function imageKind(b: Uint8Array, depth = 0): 'animated' | 'still' | 'unknown' {
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length >= 6 && ascii(0, 3) === 'GIF') {
    try {
      return new GifReader(b as unknown as Buffer).numFrames() > 1 ? 'animated' : 'still';
    } catch {
      return 'animated'; // unreadable: assume it may animate
    }
  }
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return isApng(b) ? 'animated' : 'still';
  if (b.length >= 21 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    return ascii(12, 4) === 'VP8X' && (b[20] & 0x02) !== 0 ? 'animated' : 'still';
  }
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const box = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
    let avif = false;
    for (let o = 8; o + 4 <= box; o += 4) {
      if (ascii(o, 4) === 'avis') return 'animated';
      if (ascii(o, 4) === 'avif') avif = true;
    }
    return avif ? 'still' : 'unknown';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'still'; // JPEG
  if (b.length >= 2 && ascii(0, 2) === 'BM') return 'still';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'still'; // ICO, CUR
  return svgKind(Buffer.from(b.buffer, b.byteOffset, b.length).toString('utf8'), depth);
}

/** Bytes of a data: URI. */
function dataUriBytes(src: string): Uint8Array {
  const comma = src.indexOf(',');
  const meta = src.slice(5, comma);
  const body = src.slice(comma + 1);
  if (/;base64$/i.test(meta)) return new Uint8Array(Buffer.from(body, 'base64'));
  // %XX escapes are bytes; a stray % (width='100%') stays as it is
  return new Uint8Array(Buffer.from(body.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1'));
}

/** An SVG file: animated when it has SMIL or CSS animation; unknown when it embeds any data: URI not a known still. */
function svgKind(text: string, depth: number): 'animated' | 'still' | 'unknown' {
  // the root element must be <svg>, after an optional BOM, XML prolog, comments and doctype
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    let end = -1;
    if (text.startsWith('<?', i)) end = text.indexOf('?>', i) + 2;
    else if (text.startsWith('<!--', i)) end = text.indexOf('-->', i) + 3;
    else if (/^<!doctype/i.test(text.slice(i, i + 9))) {
      const gt = text.indexOf('>', i);
      const sub = text.indexOf('[', i);
      end = sub >= 0 && sub < gt ? text.indexOf(']', sub) + 1 : gt + 1;
      if (end > 0 && text[end - 1] === ']') end = text.indexOf('>', end) + 1;
    } else break;
    if (end <= i) return 'unknown';
    i = end;
  }
  if (!/^<(?:[^\s:<>/]+:)?svg[\s/>]/.test(text.slice(i, i + 64))) return 'unknown';
  // entities and CSS escapes can spell a marker in a way a plain search misses
  if (/<!ENTITY|\\/i.test(text)) return 'unknown';
  const t = text.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, n: string) => {
    const c = n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
    return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : '';
  });
  // an element named with any namespace prefix: <animate or <x:animate
  if (/[<:](?:animate|set[\s/>]|discard[\s/>]|video|audio)|keyframes|animation(?:-name)?\s*:/i.test(t)) return 'animated';
  let kind: 'still' | 'unknown' = 'still';
  // every data: URI, whatever its label (browsers sniff image bytes), wrapped base64 included
  for (const m of t.matchAll(/data:[^"'()<>]*/gi)) {
    if (depth >= 3) return 'unknown';
    let inner: 'animated' | 'still' | 'unknown';
    try {
      inner = imageKind(dataUriBytes(m[0]), depth + 1);
    } catch {
      inner = 'unknown';
    }
    if (inner === 'animated') return 'animated';
    if (inner === 'unknown') kind = 'unknown';
  }
  return kind;
}

/** Images checked for animation per page, and the time allowed for fetching them; the rest is named as unchecked. */
export const MAX_IMAGES = 200;
const IMAGE_BUDGET_MS = 60000;
/** Largest image file read to check for animation. */
export const MAX_IMAGE_BYTES = 64 << 20;

/**
 * Runs in the page before any of its scripts: keeps every shadow root (open or closed) the page makes, so the
 * inventory and the per frame stepping can reach videos, images and animations inside web components.
 */
const INIT_SCRIPT = `(() => {
  const made = [];
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { const r = orig.call(this, init); made.push(r); return r; };
  const roots = () => {
    const out = [document];
    const seen = new Set(out);
    const visit = (root) => {
      for (const el of root.querySelectorAll('*')) {
        const sr = el.shadowRoot;
        if (sr && !seen.has(sr)) { seen.add(sr); out.push(sr); visit(sr); }
      }
    };
    visit(document);
    for (const r of made) if (!seen.has(r) && r.host && r.host.isConnected) { seen.add(r); out.push(r); visit(r); }
    return out;
  };
  Object.defineProperty(window, '__fcRoots', { value: roots });
  Object.defineProperty(window, '__fcClosedMade', { value: () => made.filter((r) => r.mode === 'closed' && r.host && r.host.isConnected).length });
})();`;

interface Inventory {
  images: string[];
  videos: number;
  smil: number;
  frames: number;
  closedMade: number;
}

/** Lists, across the document and every shadow root it can reach, what the page clock may not control. */
function inventory(): Inventory {
  const w = window as unknown as { __fcRoots: () => (Document | ShadowRoot)[]; __fcClosedMade: () => number };
  const roots = w.__fcRoots();
  const images = new Set<string>();
  const urls = (v: string | null | undefined, base: string) => {
    if (!v || v === 'none' || v === 'normal') return;
    // Chromium serializes url("...") with \" and \\ escaped; a data: SVG holds quotes and brackets of its own
    for (const m of v.matchAll(/url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^"'()\s]+))\s*\)/g)) {
      const raw = (m[1] ?? m[2] ?? m[3]).replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, e: string) =>
        /^[0-9a-f]{1,6}\s?$/i.test(e) ? String.fromCodePoint(Math.min(parseInt(e, 16), 0x10ffff)) : e,
      );
      try {
        images.add(new URL(raw, base).href);
      } catch {
        /* not a URL */
      }
    }
  };
  let videos = 0;
  let smil = 0;
  for (const root of roots) {
    const base = document.baseURI;
    for (const img of Array.from(root.querySelectorAll('img'))) if (img.currentSrc || img.src) images.add(img.currentSrc || img.src);
    const attrs: [string, string][] = [
      ['image', 'href'],
      ['image', 'xlink:href'],
      ['object', 'data'],
      ['embed', 'src'],
      ['input[type=image]', 'src'],
    ];
    for (const [sel, attr] of attrs) for (const im of Array.from(root.querySelectorAll(sel))) {
      const href = im.getAttribute(attr);
      if (href) {
        try {
          images.add(new URL(href, base).href);
        } catch {
          /* not a URL */
        }
      }
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      urls(cs.backgroundImage, base);
      urls(cs.content, base);
      urls(cs.listStyleImage, base);
      urls(cs.borderImageSource, base);
      urls(cs.maskImage, base);
      for (const pseudo of ['::before', '::after', '::marker']) {
        const ps = getComputedStyle(el, pseudo);
        urls(ps.backgroundImage, base);
        urls(ps.content, base);
        urls(ps.listStyleImage, base);
      }
    }
    videos += root.querySelectorAll('video').length;
    smil += root.querySelectorAll('animate, animateMotion, animateTransform, set').length;
  }
  return { images: [...images], videos, smil, frames: window.frames.length, closedMade: w.__fcClosedMade() };
}

/**
 * Reads a local image for the animation check, only when it lies inside `rootDir` once links are resolved, is a
 * regular file and is at most MAX_IMAGE_BYTES. Opened without blocking, so a FIFO or device can never hang the run;
 * the checks are made on the open file itself. Returns null, with the reason, when it is not read.
 */
export function readLocalImage(file: string, rootDir: string | null): { bytes: Uint8Array | null; why?: string } {
  if (!rootDir) return { bytes: null, why: 'the page is not a local file' };
  let real: string;
  try {
    real = realpathSync.native(file);
  } catch {
    return { bytes: null, why: 'missing' };
  }
  const rel = relative(rootDir, real);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return { bytes: null, why: "outside the page's folder" };
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return { bytes: null, why: 'could not be opened' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { bytes: null, why: 'not a regular file' };
    if (st.size > MAX_IMAGE_BYTES) return { bytes: null, why: `larger than ${MAX_IMAGE_BYTES >> 20} MB` };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, off) };
  } finally {
    closeSync(fd);
  }
}

/** Closed shadow roots in the page (CDP sees them all), not counting user agent ones or those inside frames. */
async function closedShadowRoots(context: import('playwright-core').BrowserContext, page: import('playwright-core').Page): Promise<number | null> {
  try {
    const cdp = await context.newCDPSession(page);
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode };
    let n = 0;
    const walk = (node: CdpNode) => {
      for (const sr of node.shadowRoots ?? []) {
        if (sr.shadowRootType === 'closed') n++;
        walk(sr);
      }
      for (const c of node.children ?? []) walk(c);
    };
    walk(root);
    await cdp.detach();
    return n;
  } catch {
    return null;
  }
}
interface CdpNode {
  children?: CdpNode[];
  shadowRoots?: (CdpNode & { shadowRootType?: string })[];
}

export async function openUrl(input: string, opts: OpenOptions): Promise<Source> {
  let url = input;
  if (!/^[a-z]+:\/\//i.test(input) && existsSync(input)) url = pathToFileURL(resolve(input)).href;
  const fps = opts.fps ?? 30;
  const duration = opts.duration ?? 10;
  const settle = opts.settle ?? 1;
  const d = typeof opts.display === 'object' ? opts.display : { width: 1024, height: 768 };
  let pw: typeof import('playwright-core');
  try {
    pw = await import('playwright-core');
  } catch {
    throw new Error(
      'Screening a web page needs playwright-core and a Chromium build: `npm i playwright-core` then `npx playwright-core install chromium`.',
    );
  }
  const notes: string[] = [
    `Web page recorded in Chromium at ${d.width} x ${d.height} CSS px, device scale factor 1, ${fps} fps for ${duration} s after ${settle} s to settle.`,
  ];
  const reasons: Reason[] = [];
  const frames = (async function* () {
    const browser = await pw.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: d.width, height: d.height },
        deviceScaleFactor: 1,
        reducedMotion: 'no-preference',
      });
      const page = await context.newPage();
      await page.addInitScript(INIT_SCRIPT);
      // every image the page loads over the network while it runs, also ones added and removed during the capture,
      // with each status the browser got for it
      const loaded = new Map<string, Set<number>>();
      page.on('response', (res) => {
        if (res.request().resourceType() !== 'image') return;
        if (!loaded.has(res.url())) loaded.set(res.url(), new Set());
        loaded.get(res.url())!.add(res.status());
      });
      // install a fake clock and pause it: from here on page time moves only when we advance it
      const t0 = Date.parse('2026-01-01T00:00:00Z');
      await page.clock.install({ time: t0 });
      await page.clock.pauseAt(t0 + 1);
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.clock.runFor(Math.round(settle * 1000));
      // local images are read only for a local page, and only from inside the folder of the page given (links
      // resolved), wherever the page goes from there
      let rootDir: string | null = null;
      if (url.startsWith('file:')) {
        try {
          rootDir = realpathSync.native(dirname(fileURLToPath(url)));
        } catch {
          rootDir = null;
        }
      }
      await page.evaluate(() => {
        const w = window as unknown as { __fc: { base: WeakMap<object, number>; videos: WeakSet<object>; seen: number } };
        w.__fc = { base: new WeakMap(), videos: new WeakSet(), seen: 0 };
      });
      const first = await page.evaluate(inventory);
      let timeouts = 0;
      const n = Math.round(duration * fps);
      const dtMs = 1000 / fps;
      for (let k = 0; k < n; k++) {
        if (k > 0) await page.clock.runFor(dtMs);
        const step = page.evaluate(async (elapsed: number) => {
          const w = window as unknown as {
            __fc: { base: WeakMap<object, number>; videos: WeakSet<object>; seen: number };
            __fcRoots: () => (Document | ShadowRoot)[];
          };
          const fc = w.__fc;
          const roots = w.__fcRoots();
          // animations in shadow trees are not in document.getAnimations(), so each root is asked
          const anims = new Set<Animation>();
          for (const r of roots) for (const a of r.getAnimations()) anims.add(a);
          for (const a of anims) {
            if (!fc.base.has(a)) fc.base.set(a, Number(a.currentTime ?? 0) - elapsed);
            a.pause();
            a.currentTime = fc.base.get(a)! + elapsed;
          }
          const seeks: Promise<void>[] = [];
          for (const r of roots) {
            for (const v of Array.from(r.querySelectorAll('video'))) {
              if (!fc.videos.has(v)) {
                fc.videos.add(v);
                fc.seen++;
                v.muted = true;
              }
              if (!fc.base.has(v)) fc.base.set(v, v.currentTime - elapsed / 1000);
              v.pause();
              const target = fc.base.get(v)! + elapsed / 1000;
              const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
              const tt = v.loop && dur !== Infinity ? target % dur : Math.min(target, dur);
              if (Math.abs(v.currentTime - tt) > 1e-3) {
                // page timers are under the fake clock, so the time limit for a seek is kept on the Node side
                seeks.push(new Promise((res) => v.addEventListener('seeked', () => res(), { once: true })));
                v.currentTime = tt;
              }
            }
          }
          await Promise.all(seeks);
        }, k * dtMs);
        const settled = await Promise.race([step.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
        if (!settled) timeouts++;
        const png = PNG.sync.read(await page.screenshot({ type: 'png', animations: 'allow', caret: 'initial' }));
        yield { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), t: k / fps };
      }
      // look again after the capture: content added while it ran counts as much as content there at the start
      const last = await page.evaluate(inventory);
      const videosSeen = await page.evaluate(() => (window as unknown as { __fc: { seen: number } }).__fc.seen);
      const closedAll = await closedShadowRoots(context, page);
      const images = [...new Set([...first.images, ...last.images, ...loaded.keys()])];
      await checkImages(images, rootDir, context, loaded, page.url(), reasons);
      const smil = Math.max(first.smil, last.smil);
      const framesCount = Math.max(first.frames, last.frames);
      const videos = Math.max(videosSeen, first.videos, last.videos);
      if (smil) {
        reasons.push({
          code: 'uncontrolled-content',
          level: 'warn',
          message: `${smil} SVG animation element${smil === 1 ? '' : 's'} (SMIL <animate> or <set>) run on their own timeline, outside the page clock; their flashing can be missed.`,
        });
      }
      if (framesCount) {
        reasons.push({
          code: 'uncontrolled-content',
          level: 'warn',
          message: `The page has ${framesCount} frame${framesCount === 1 ? '' : 's'} (iframe); CSS animations and videos inside frames are not stepped, so their flashing can be missed. Screen the framed page on its own.`,
        });
      }
      // counted at the same moment as closedAll: roots made at the start may be gone by now
      const closedMade = last.closedMade;
      if (closedAll === null) {
        reasons.push({
          code: 'uncontrolled-content',
          level: 'warn',
          message: 'The page could not be checked for closed shadow roots; videos, images and animations inside any would not be controlled or checked.',
        });
      } else if (closedAll > closedMade) {
        const k = closedAll - closedMade;
        reasons.push({
          code: 'uncontrolled-content',
          level: 'warn',
          message: `${k} closed shadow root${k === 1 ? '' : 's'} (declared in the HTML) cannot be reached from the page; videos, images and animations inside ${k === 1 ? 'it' : 'them'} are not stepped or checked, so their flashing can be missed.`,
        });
      }
      if (videos) {
        reasons.push({
          code: 'sample-rate',
          level: 'warn',
          message: `${videos} video element${videos === 1 ? ' was' : 's were'} sampled at ${fps} fps by seeking; a video with more frames a second than that can hide flashing between the samples. Screen the video file directly, which reads every frame.`,
        });
      }
      if (timeouts) {
        reasons.push({
          code: 'incomplete',
          level: 'warn',
          message: `${timeouts} of ${n} frames were captured before the page finished stepping its videos (a seek took over 1.5 s); those frames may show a stale picture.`,
        });
      }
    } finally {
      await browser.close();
    }
  })();
  return {
    kind: 'url',
    source: input,
    width: d.width,
    height: d.height,
    format: 'rgba',
    display: d,
    fps,
    notes,
    sampled: true,
    reasons,
    frames,
  };
}

/**
 * Fetches or reads each image the page used and adds a warning for animated ones (they play in real time, outside
 * the page clock), for ones that could not be read, and for ones over the count or time budget.
 */
async function checkImages(
  images: string[],
  rootDir: string | null,
  context: import('playwright-core').BrowserContext,
  browserStatus: Map<string, Set<number>>,
  pageUrl: string,
  reasons: Reason[],
): Promise<void> {
  const animated: string[] = [];
  const unread: string[] = [];
  const refused: string[] = [];
  let unchecked = 0;
  const deadline = Date.now() + IMAGE_BUDGET_MS;
  for (let i = 0; i < images.length; i++) {
    const src = images[i];
    if (i >= MAX_IMAGES || Date.now() > deadline) {
      unchecked = images.length - i;
      break;
    }
    let bytes: Uint8Array | null = null;
    // a missing file, or an image the browser itself only ever got a 404 or 410 for, shows nothing on the page
    let gone = false;
    const label = src.startsWith('data:') ? 'an inline data: image' : src;
    const got = browserStatus.get(src);
    try {
      if (src.startsWith('data:')) {
        bytes = dataUriBytes(src);
      } else if (src.startsWith('file:')) {
        const got = readLocalImage(fileURLToPath(src), rootDir);
        if (!got.bytes) {
          if (got.why !== 'missing') {
            refused.push(`${label} (${got.why})`);
            continue;
          }
          gone = true;
        }
        bytes = got.bytes;
      } else if (/^https?:/i.test(src)) {
        if (got && [...got].every((s) => s === 404 || s === 410)) gone = true;
        else bytes = await fetchImage(src, context, pageUrl);
      }
    } catch {
      bytes = null;
    }
    const kind = bytes ? imageKind(bytes) : 'unknown';
    if (kind === 'animated') animated.push(label);
    else if (kind === 'unknown' && !gone) {
      // whatever its name says: a GIF can be served from any URL
      unread.push(label);
    }
  }
  const list = (xs: string[]) => xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` and ${xs.length - 3} more` : '');
  if (animated.length) {
    reasons.push({
      code: 'uncontrolled-content',
      level: 'warn',
      message:
        `${animated.length} animated image${animated.length === 1 ? '' : 's'} (${list(animated)}) play in real time, outside the ` +
        'page clock, so the capture can miss their flashing. Screen each image file directly.',
    });
  }
  if (unread.length) {
    reasons.push({
      code: 'uncontrolled-content',
      level: 'warn',
      message: `${unread.length} image${unread.length === 1 ? '' : 's'} could not be read to check for animation (${list(unread)}); any of them may play in real time, outside the page clock. Screen each image file directly.`,
    });
  }
  if (refused.length) {
    reasons.push({
      code: 'uncontrolled-content',
      level: 'warn',
      message:
        `${refused.length} local image${refused.length === 1 ? ' was' : 's were'} not read to check for animation (${list(refused)}): ` +
        "page mode reads only regular files inside the page's own folder. Screen each image file directly.",
    });
  }
  if (unchecked) {
    reasons.push({
      code: 'uncontrolled-content',
      level: 'warn',
      message: `The page uses ${images.length} images; ${unchecked} images were not checked for animation (page mode checks up to ${MAX_IMAGES} within ${IMAGE_BUDGET_MS / 1000} s). Any of them may play in real time, outside the page clock.`,
    });
  }
}

/**
 * Downloads an image again with the page's cookies and referrer, reading at most MAX_IMAGE_BYTES whatever the
 * server states. Null when the reply is not a success or is larger than that.
 */
async function fetchImage(src: string, context: import('playwright-core').BrowserContext, pageUrl: string): Promise<Uint8Array | null> {
  const headers: Record<string, string> = {};
  const cookies = await context.cookies(src);
  if (cookies.length) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  if (/^https?:/i.test(pageUrl)) headers.referer = pageUrl;
  const res = await fetch(src, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}
