// Captures the README screenshots (docs/screenshots) from the built web page. Run from the repo root after npm run build:web.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http'; import { readFile } from 'node:fs/promises'; import { join, extname } from 'node:path';
const root = join(process.cwd(), 'web'); const types = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.woff2':'font/woff2','.svg':'image/svg+xml' };
const srv = createServer(async (q, r) => { try { const p = decodeURIComponent(q.url.split('?')[0]); const b = await readFile(join(root, p)); r.writeHead(200, {'content-type': types[extname(p)] || 'application/octet-stream'}); r.end(b); } catch { r.writeHead(404); r.end(); } });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
const b = await chromium.launch();
const shoot = async (hash, vp, file, opts={}) => { const p = await b.newPage({ viewport: vp, deviceScaleFactor: opts.dpr || 1 }); await p.goto(`${base}/${opts.page || 'index.html'}${hash}`); await p.evaluate(() => document.fonts.ready); if (hash) await p.waitForSelector('#report:not([hidden])', { timeout: 60000 }); await p.waitForTimeout(300); await p.screenshot({ path: file, fullPage: !!opts.full, clip: opts.clip }); await p.close(); };
await shoot('#sample=borderline-area-over', { width: 1440, height: 900 }, 'docs/screenshots/report-desktop.png', { full: true, clip: { x: 0, y: 0, width: 1440, height: 1560 } });
await shoot('', { width: 1440, height: 900 }, 'docs/screenshots/empty-desktop.png');
await shoot('#sample=fail-red-4hz', { width: 390, height: 844 }, 'docs/screenshots/report-mobile.png', { dpr: 2 });
await shoot('', { width: 1200, height: 420 }, 'docs/screenshots/fixation-display.png', { page: 'specimen.html' });
await b.close(); srv.close();
