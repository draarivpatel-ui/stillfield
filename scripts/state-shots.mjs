// Captures the pass, warn, error, busy and long file name states. Usage: node scripts/state-shots.mjs <out dir> <video file>
import { chromium } from 'playwright-core';
import { createServer } from 'node:http'; import { readFile } from 'node:fs/promises'; import { join, extname } from 'node:path';
const root = join(process.cwd(), 'web'); const types = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.woff2':'font/woff2','.svg':'image/svg+xml' };
const srv = createServer(async (q, r) => { try { const p = decodeURIComponent(q.url.split('?')[0]); const b = await readFile(join(root, p)); r.writeHead(200, {'content-type': types[extname(p)] || 'application/octet-stream'}); r.end(b); } catch { r.writeHead(404); r.end(); } });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
const b = await chromium.launch(); const out = process.argv[2] ?? '.scratch/states';
await import('node:fs').then((fs) => fs.mkdirSync(out, { recursive: true }));
const views = [['d', { width: 1440, height: 900 }], ['m', { width: 390, height: 844 }]];
const longFile = process.argv[3]; // any video file, ideally with a long name
for (const [v, vp] of views) {
  for (const s of ['pass-full-2hz', 'borderline-area-under']) {
    const p = await b.newPage({ viewport: vp }); await p.goto(`${base}/index.html#sample=${s}`); await p.waitForSelector('#report:not([hidden])'); await p.waitForTimeout(200);
    await p.screenshot({ path: `${out}/${s}-${v}.png`, fullPage: true }); await p.close();
  }
  let p = await b.newPage({ viewport: vp }); await p.goto(`${base}/index.html`); await p.fill('#url', 'https://example.invalid/clip.mp4'); await p.click('#url-form button');
  await p.waitForSelector('#error:not([hidden])'); await p.screenshot({ path: `${out}/error-${v}.png` }); await p.close();
  p = await b.newPage({ viewport: vp }); await p.goto(`${base}/index.html`); await p.setInputFiles('#file', longFile); await p.waitForTimeout(700);
  await p.screenshot({ path: `${out}/busy-${v}.png` }); await p.waitForSelector('#report:not([hidden])', { timeout: 90000 }); await p.waitForTimeout(200);
  await p.screenshot({ path: `${out}/long-${v}.png`, fullPage: true }); await p.close();
}
await b.close(); srv.close();
