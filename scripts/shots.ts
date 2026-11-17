// Serves web/ locally and screenshots it in headless Chromium. Usage: node scripts/shots.ts <out dir> [hash...]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const root = join(import.meta.dirname, '..', 'web');
const out = process.argv[2] ?? join(import.meta.dirname, '..', '.scratch', 'shots');
const hashes = process.argv.slice(3);
mkdirSync(out, { recursive: true });
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, p.endsWith('/') ? p + 'index.html' : p);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true });
try {
  const views = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ];
  for (const h of ['', ...hashes]) {
    for (const v of views) {
      const page = await browser.newPage({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.name === 'mobile' ? 2 : 1 });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`http://127.0.0.1:${port}/index.html${h ? '#' + h : ''}`);
      await page.evaluate(() => document.fonts.ready);
      if (h.startsWith('sample=')) await page.waitForSelector('#report:not([hidden])', { timeout: 60000 });
      await page.waitForTimeout(300);
      const tag = (h || 'empty').replace(/[^\w-]+/g, '_');
      await page.screenshot({ path: join(out, `${tag}-${v.name}.png`), fullPage: true });
      await page.screenshot({ path: join(out, `${tag}-${v.name}-top.png`), fullPage: false });
      if (errors.length) console.log(tag, v.name, 'ERRORS', errors);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log('shots in', out);
