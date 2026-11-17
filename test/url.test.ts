// Web page mode: Chromium under a controlled clock. The flashing pages are written here at test time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { join } from 'node:path';
import { CLI, OUT, runCli, writeClip } from './helpers.ts';

const page = (name: string, body: string, style = '') => {
  const f = join(OUT, `${name}.html`);
  writeFileSync(f, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000}${style}</style></head><body>${body}</body></html>`);
  return f;
};

const css = (period: number) =>
  `#f{position:fixed;inset:0;animation:fl ${period}s steps(1,end) infinite}@keyframes fl{0%{background:#000}50%{background:#fff}}`;

const run = (file: string, extra: string[] = []) => {
  const r = runCli([file, '--json', '--duration', '3', '--settle', '0.2', '--fps', '30', ...extra]);
  if (!r.stdout) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

test('CSS keyframes at 4 flashes a second fail, at 2 a second pass (stepped animation time)', () => {
  const f4 = run(page('css-4hz', '<div id="f"></div>', css(0.25)));
  const f2 = run(page('css-2hz', '<div id="f"></div>', css(0.5)));
  assert.equal(f4.wcag231, 'fail');
  assert.equal(f4.general.maxFlashesPerSecond, 4);
  assert.equal(f2.wcag231, 'pass');
  assert.equal(f2.general.maxFlashesPerSecond, 2);
  assert.equal(f4.media.kind, 'url');
  assert.equal(f4.settings.display.width, 1024);
});

test('requestAnimationFrame animation driven by performance.now() follows the page clock', () => {
  const js = (hz: number) =>
    `<canvas id="c" width="1024" height="768" style="position:fixed;inset:0"></canvas><script>const c=document.getElementById('c').getContext('2d');function d(){const s=Math.floor(performance.now()/1000*${2 * hz})%2;c.fillStyle=s?'#fff':'#000';c.fillRect(0,0,1024,768);requestAnimationFrame(d)}requestAnimationFrame(d)</script>`;
  const r5 = run(page('raf-5hz', js(5)));
  const r1 = run(page('raf-1hz', js(1)));
  assert.equal(r5.wcag231, 'fail');
  // the page draws on its own 16 ms animation ticks and is sampled at 30 fps, so a toggle can land one frame early
  // or late: the measured rate may read half a flash high
  assert.ok(r5.general.maxFlashesPerSecond >= 5 && r5.general.maxFlashesPerSecond <= 5.5, String(r5.general.maxFlashesPerSecond));
  assert.equal(r1.wcag231, 'pass');
});

test('setInterval flashing a 100 x 100 CSS px box is measured at 10,000 CSS px and passes on area', () => {
  const body = `<div id="b" style="position:fixed;left:200px;top:200px;width:100px;height:100px;background:#000"></div><script>let s=0;setInterval(()=>{s^=1;document.getElementById('b').style.background=s?'#fff':'#000'},100)</script>`;
  const f = page('interval-small', body);
  const small = run(f);
  assert.equal(small.wcag231, 'pass');
  assert.equal(small.general.maxAreaOverRate, 10000);
});

test('a playing <video> is stepped by seeking', async () => {
  const clip = await writeClip('fail-full-4hz', '.mp4');
  const f = page('video', `<video src="${clip.split('/').pop()}" muted autoplay loop playsinline style="position:fixed;inset:0;width:100%;height:100%;object-fit:fill"></video>`);
  const r = run(f);
  assert.equal(r.wcag231, 'fail');
  // a video in a page is sampled at the capture rate, which is said as a warning
  assert.ok(r.reasons.some((x: { code: string }) => x.code === 'sample-rate'));
});

test('animated images, SVG animation and frames in a page are named as not controlled, never silently passed', async () => {
  const gif = (await writeClip('fail-full-4hz', '.gif')).split('/').pop();
  const still = join(OUT, 'still.png');
  if (!existsSync(still)) {
    const png = new PNG({ width: 8, height: 8 });
    png.data.fill(255);
    writeFileSync(still, PNG.sync.write(png));
  }
  const withGif = run(page('page-gif', `<img src="${gif}?v=1" style="width:1024px;height:768px">`));
  assert.notEqual(withGif.verdict, 'pass');
  assert.equal(withGif.complete, false);
  const r = withGif.reasons.find((x: { code: string }) => x.code === 'uncontrolled-content');
  assert.ok(r, withGif.reasons.map((x: { code: string }) => x.code).join(', '));
  assert.match(r.message, /fail-full-4hz\.gif/);
  // as a CSS background too
  const bg = run(page('page-gif-bg', '<div style="position:fixed;inset:0;background:url(' + gif + ') center/cover"></div>'));
  assert.ok(bg.reasons.some((x: { code: string }) => x.code === 'uncontrolled-content'));
  // a still image is not flagged
  const calm = run(page('page-still', '<img src="still.png">'));
  assert.equal(calm.verdict, 'pass', calm.reasons.map((x: { message: string }) => x.message).join(' | '));
  assert.equal(calm.complete, true);
  const smil = run(page('page-smil', '<svg width="100" height="100"><rect width="100" height="100" fill="#000"><set attributeName="fill" to="#fff" begin="0.5s"/></rect></svg>'));
  assert.ok(smil.reasons.some((x: { message: string }) => /SVG animation/.test(x.message)));
  const framed = run(page('page-iframe', '<iframe src="still.png" width="100" height="100"></iframe>'));
  assert.ok(framed.reasons.some((x: { message: string }) => /iframe/.test(x.message)));
});

// ---------------------------------------------------------------- regressions: nothing unchecked reads as Pass

const stillPng = () => {
  const still = join(OUT, 'still.png');
  if (!existsSync(still)) {
    const png = new PNG({ width: 8, height: 8 });
    png.data.fill(255);
    writeFileSync(still, PNG.sync.write(png));
  }
  return still;
};
type Rep = { verdict: string; complete: boolean; wcag231: string; reasons: { code: string; message: string }[] };
const msgs = (r: Rep) => r.reasons.map((x) => `${x.code}: ${x.message}`).join(' | ');
const short = (file: string, extra: string[] = []) => run(file, ['--duration', '1.5', ...extra]) as Rep;

test('a CSS animation and a <video> inside shadow roots (open and closed) are stepped like the rest of the page', async () => {
  const anim = run(
    page(
      'shadow-css',
      `<div id="h"></div><script>const r=document.getElementById('h').attachShadow({mode:'open'});r.innerHTML='<style>${css(0.25)}</style><div id="f"></div>'</script>`,
    ),
  );
  assert.equal(anim.wcag231, 'fail', msgs(anim));
  assert.equal(anim.general.maxFlashesPerSecond, 4);
  const clip = (await writeClip('fail-full-4hz', '.mp4')).split('/').pop();
  const vid = run(
    page(
      'shadow-video',
      `<flash-player></flash-player><script>customElements.define('flash-player',class extends HTMLElement{constructor(){super();const r=this.attachShadow({mode:'closed'});r.innerHTML='<video src="${clip}" muted autoplay loop playsinline style="position:fixed;inset:0;width:100%;height:100%;object-fit:fill"></video>'}})</script>`,
    ),
  );
  assert.equal(vid.wcag231, 'fail', msgs(vid));
  assert.ok(vid.reasons.some((x: { code: string }) => x.code === 'sample-rate'), msgs(vid));
});

test('a closed shadow root the page clock cannot reach is named, not passed', () => {
  stillPng();
  const r = short(page('shadow-declarative', '<div><template shadowrootmode="closed"><img src="still.png"></template></div>'));
  assert.equal(r.complete, false, msgs(r));
  assert.notEqual(r.verdict, 'pass');
  assert.ok(r.reasons.some((x) => x.code === 'uncontrolled-content' && /shadow root/.test(x.message)), msgs(r));
});

test('more images than page mode checks gives a warning that names how many were not checked', () => {
  stillPng();
  const imgs = Array.from({ length: 205 }, (_, i) => `<img src="still.png?i=${i}" width="4" height="4">`).join('');
  const r = short(page('many-images', imgs));
  assert.equal(r.complete, false, msgs(r));
  assert.ok(r.reasons.some((x) => x.code === 'uncontrolled-content' && /5 images were not checked/.test(x.message)), msgs(r));
});

test('an animated image added after the settle time, or on a pseudo element, is named', async () => {
  const gif = (await writeClip('fail-full-4hz', '.gif')).split('/').pop();
  // small (60 x 60 CSS px), so the capture alone cannot fail on area and only the warning stops a plain Pass
  const late = short(
    page('late-gif', `<script>setTimeout(()=>{const i=new Image();i.src='${gif}?late';i.style.cssText='width:60px;height:60px';document.body.append(i)},500)</script>`),
    ['--settle', '0.2'],
  );
  assert.equal(late.complete, false, msgs(late));
  assert.ok(late.reasons.some((x) => x.code === 'uncontrolled-content' && /animated image/.test(x.message)), msgs(late));
  const pseudo = short(page('pseudo-gif', '<div id="p"></div>', `#p::before{content:"";display:block;width:60px;height:60px;background:url(${gif}?pseudo) center/cover}`));
  assert.equal(pseudo.complete, false, msgs(pseudo));
  assert.ok(pseudo.reasons.some((x) => x.code === 'uncontrolled-content' && /animated image/.test(x.message)), msgs(pseudo));
  const content = short(page('pseudo-content-gif', '<div id="p"></div>', `#p::after{content:url(${gif}?content)}`));
  assert.ok(content.reasons.some((x) => x.code === 'uncontrolled-content' && /animated image/.test(x.message)), msgs(content));
});

test('page mode reads local images only from inside the page folder, and only regular files', async () => {
  const dir = join(OUT, 'site');
  mkdirSync(dir, { recursive: true });
  const gif = await writeClip('fail-full-4hz', '.gif');
  // a FIFO inside the folder: reading it would block forever. The image is lazy and far below, so Chromium never
  // loads it, but its URL is on the page.
  const fifo = join(dir, 'pipe.gif');
  if (!existsSync(fifo)) spawnSync('mkfifo', [fifo]);
  const link = join(dir, 'escape.gif');
  rmSync(link, { force: true });
  symlinkSync(gif, link);
  const f = join(dir, 'index.html');
  writeFileSync(
    f,
    `<!doctype html><html><body style="margin:0;background:#000"><img loading="lazy" src="pipe.gif" style="position:absolute;top:100000px"><img src="../fail-full-4hz.gif" width="40" height="40"><img src="escape.gif" width="40" height="40"></body></html>`,
  );
  const r = runCli([f, '--json', '--duration', '1', '--settle', '0.2'], {}, 60000);
  assert.equal(r.timedOut, false, 'page mode blocked reading a FIFO');
  const rep = JSON.parse(r.stdout) as Rep;
  assert.equal(rep.complete, false, msgs(rep));
  const refused = rep.reasons.find((x) => x.code === 'uncontrolled-content' && /not read/.test(x.message));
  assert.ok(refused, msgs(rep));
  for (const name of ['pipe.gif', 'fail-full-4hz.gif', 'escape.gif']) assert.match(refused.message, new RegExp(name.replace('.', '\\.')));
  // none of them was read and found animated: the files outside the folder were never opened
  assert.ok(!rep.reasons.some((x) => /animated image/.test(x.message)), msgs(rep));
});

test('an image the page shows but page mode could not read is named whatever its URL looks like', async () => {
  // served once (to the browser), then refused: the URL has no image extension
  const { createServer } = await import('node:http');
  const { readFileSync } = await import('node:fs');
  const gif = readFileSync(await writeClip('fail-full-4hz', '.gif'));
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(200, { 'content-type': 'image/gif' });
      res.end(gif);
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const f = page('unreadable-image', `<img src="http://127.0.0.1:${port}/media?id=1" width="60" height="60">`);
    // run the CLI without blocking this process, which serves the image
    const { spawn } = await import('node:child_process');
    const out = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, [CLI, f, '--json', '--duration', '1.5', '--settle', '0.2', '--fps', '30']);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s));
    });
    const rep = JSON.parse(out) as Rep;
    assert.ok(hits >= 2, `server hits ${hits}`);
    assert.equal(rep.complete, false, msgs(rep));
    assert.ok(rep.reasons.some((x) => x.code === 'uncontrolled-content' && /could not be read/.test(x.message) && /media\?id=1/.test(x.message)), msgs(rep));
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------- regressions

const flashSvg = (anim: 'smil' | 'css') =>
  anim === 'smil'
    ? '<?xml version="1.0"?>\n<!-- spinner --><svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#000"><animate attributeName="fill" values="#000;#fff" dur="0.25s" calcMode="discrete" repeatCount="indefinite"/></rect></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><style>rect{animation:f .25s steps(1,end) infinite}@keyframes f{0%{fill:#000}50%{fill:#fff}}</style><rect width="60" height="60"/></svg>';

test('an animated SVG shown as an image (img, CSS url(), data: URI) is named; a static SVG still passes', () => {
  writeFileSync(join(OUT, 'flash-smil.svg'), flashSvg('smil'));
  writeFileSync(join(OUT, 'flash-css.svg'), flashSvg('css'));
  writeFileSync(join(OUT, 'still.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#888"/></svg>');
  const named = (r: Rep) => r.reasons.some((x) => x.code === 'uncontrolled-content' && /animated image/.test(x.message));
  const img = short(page('svg-img', '<img src="flash-smil.svg" width="60" height="60">'));
  assert.equal(img.complete, false, msgs(img));
  assert.ok(named(img), msgs(img));
  const bg = short(page('svg-bg', '<div id="b"></div>', '#b{width:60px;height:60px;background:url(flash-css.svg)}'));
  assert.equal(bg.complete, false, msgs(bg));
  assert.ok(named(bg), msgs(bg));
  const data = short(page('svg-data', `<img src="data:image/svg+xml,${encodeURIComponent(flashSvg('css'))}" width="60" height="60">`));
  assert.equal(data.complete, false, msgs(data));
  assert.ok(named(data), msgs(data));
  // a data: SVG in CSS holds quotes and brackets of its own
  const inline = `<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60'><g transform='rotate(0)'><rect width='60' height='60'><animate attributeName='fill' values='black;white' dur='0.25s' calcMode='discrete' repeatCount='indefinite'/></rect></g></svg>`;
  const cssData = short(page('svg-css-data', '<div id="b"></div>', `#b{width:60px;height:60px;background:url("data:image/svg+xml,${inline}")}`));
  assert.equal(cssData.complete, false, msgs(cssData));
  assert.ok(named(cssData), msgs(cssData));
  const calm = short(page('svg-still', '<img src="still.svg" width="60" height="60">'));
  // a static data: SVG in CSS, as framework stylesheets use for icons, with a literal % too
  const icon = `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' width='100%'%3e%3cpath stroke='%23343a40' d='m2 5 6 6 6-6'/%3e%3c/svg%3e")`;
  const iconPage = short(page('svg-css-icon', '<div id="b"></div>', `#b{width:60px;height:60px;background:${icon}}`));
  assert.equal(iconPage.complete, true, msgs(iconPage));
  assert.equal(calm.verdict, 'pass', msgs(calm));
  assert.equal(calm.complete, true, msgs(calm));
});

test('an image the browser showed but that reads as gone, not an image, or too big on the second fetch is named', async () => {
  const { createServer } = await import('node:http');
  const { readFileSync } = await import('node:fs');
  const gif = readFileSync(await writeClip('fail-full-4hz', '.gif'));
  const hits: Record<string, number> = {};
  let sent = 0;
  const srv = createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0];
    hits[p] = (hits[p] ?? 0) + 1;
    if (hits[p] === 1) {
      res.writeHead(200, { 'content-type': 'image/gif' });
      res.end(gif);
    } else if (p === '/gone') {
      res.writeHead(404);
      res.end();
    } else if (p === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Sign in</title>');
    } else {
      // no content-length: about 70 MB, chunked, starting like a JPEG (a still, if it were read whole)
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      const chunk = Buffer.alloc(1 << 20);
      if (!sent) res.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      const more = () => {
        while (sent < 70 && !res.destroyed) {
          sent++;
          if (!res.write(chunk)) return void res.once('drain', more);
        }
        res.end();
      };
      res.on('error', () => {});
      more();
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const imgs = ['gone', 'html', 'big'].map((p) => `<img src="http://127.0.0.1:${port}/${p}" width="60" height="60">`).join('');
    const f = page('refetch-differs', imgs);
    const { spawn } = await import('node:child_process');
    const out = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, [CLI, f, '--json', '--duration', '1.5', '--settle', '0.2', '--fps', '30']);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s));
    });
    const rep = JSON.parse(out) as Rep;
    assert.equal(rep.complete, false, msgs(rep));
    const r = rep.reasons.find((x) => x.code === 'uncontrolled-content' && /could not be read/.test(x.message));
    assert.ok(r, msgs(rep));
    for (const p of ['gone', 'html', 'big']) assert.match(r.message, new RegExp(`/${p}\\b`));
  } finally {
    srv.close();
  }
});

test('a declared closed shadow root is named even when script made closed roots are gone by the end', () => {
  const r = short(
    page(
      'shadow-closed-gone',
      `<div><template shadowrootmode="closed"><span>hi</span></template></div><div id="h"></div><script>document.getElementById('h').attachShadow({mode:'closed'});setTimeout(()=>document.getElementById('h').remove(),600)</script>`,
    ),
  );
  assert.equal(r.complete, false, msgs(r));
  assert.ok(r.reasons.some((x) => x.code === 'uncontrolled-content' && /1 closed shadow root/.test(x.message)), msgs(r));
});

test('a local page that navigates elsewhere keeps the folder of the page given', async () => {
  const a = join(OUT, 'nav-a');
  const b = join(OUT, 'nav-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const { copyFileSync } = await import('node:fs');
  copyFileSync(await writeClip('fail-full-4hz', '.gif'), join(b, 'anim.gif'));
  writeFileSync(join(b, 'index.html'), '<!doctype html><body style="margin:0;background:#000"><img src="anim.gif" width="40" height="40"></body>');
  const f = join(a, 'index.html');
  writeFileSync(f, `<!doctype html><body style="margin:0;background:#000"><script>location.href='../nav-b/index.html'</script></body>`);
  const rep = short(f, ['--settle', '0.5']);
  assert.equal(rep.complete, false, msgs(rep));
  // the image beside the page it went to is outside the folder of the page given, so it is not read
  assert.ok(rep.reasons.some((x) => /not read/.test(x.message) && /anim\.gif/.test(x.message) && /outside/.test(x.message)), msgs(rep));
  assert.ok(!rep.reasons.some((x) => /animated image/.test(x.message)), msgs(rep));
});
