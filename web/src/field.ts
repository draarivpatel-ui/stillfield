// The field printout: a still of the worst moment with the 10 degree field marked, and a greytone dot map of how
// fast each part of that field flashes, drawn like a visual field test printout.
import type { Rect, Settings } from '../../src/core/index.ts';
import type { FieldSnapshot, Still } from './protocol.ts';

const INK = '#0e1b2c';
const INK3 = '#56636f';
const GREY = '#a9b4ba';
const FIX = '#e8a317';
const SHEET = '#ffffff';
const FIELD_W = 341;

function setup(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function drawStill(
  c: HTMLCanvasElement,
  pixels: Uint8ClampedArray | null,
  still: Still | null,
  region: Rect | null,
  display: { width: number; height: number },
): void {
  const w = 320;
  const h = Math.round((w * display.height) / display.width);
  const ctx = setup(c, w, h);
  ctx.fillStyle = '#eaeeee';
  ctx.fillRect(0, 0, w, h);
  if (pixels && still) {
    const tmp = new OffscreenCanvas(still.width, still.height);
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), still.width, still.height), 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, w, h);
  }
  if (region) {
    const k = w / display.width;
    const x = region.x * k;
    const y = region.y * k;
    const rw = region.width * k;
    const rh = region.height * k;
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.strokeRect(x - 1, y - 1, rw + 2, rh + 2);
    ctx.strokeStyle = FIX;
    ctx.strokeRect(x + 1, y + 1, rw - 2, rh - 2);
    const cx = x + rw / 2;
    const cy = y + rh / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = FIX;
    ctx.stroke();
  }
}

export function drawField(c: HTMLCanvasElement, snap: FieldSnapshot | null, region: Rect | null, settings: Settings): void {
  const cw = 440;
  const reg = region ?? { x: 0, y: 0, width: Math.min(settings.display.width, 344), height: Math.min(settings.display.height, 256) };
  const ch = Math.round((cw * reg.height) / reg.width);
  const H = ch + 22;
  const ctx = setup(c, cw, H);
  ctx.fillStyle = SHEET;
  ctx.fillRect(0, 0, cw, H);
  const k = cw / reg.width; // canvas px per CSS px
  const cx = cw / 2;
  const cy = ch / 2;
  // frame
  ctx.strokeStyle = GREY;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1);
  if (snap) {
    const bx0 = Math.floor(reg.x / snap.blockCssW);
    const by0 = Math.floor(reg.y / snap.blockCssH);
    const bx1 = Math.min(snap.bw, Math.ceil((reg.x + reg.width) / snap.blockCssW));
    const by1 = Math.min(snap.bh, Math.ceil((reg.y + reg.height) / snap.blockCssH));
    const pitch = snap.blockCssW * k;
    // greytone: dot size grows with transitions in the last second; 7 or more (over 3 flashes) in ink
    for (let by = by0; by < by1; by++) {
      for (let bx = bx0; bx < bx1; bx++) {
        const v = snap.blocks[by * snap.bw + bx];
        if (!v) continue;
        const px = (bx * snap.blockCssW - reg.x + snap.blockCssW / 2) * k;
        const py = (by * snap.blockCssH - reg.y + snap.blockCssH / 2) * k;
        const r = (pitch / 2) * Math.sqrt(Math.min(v, 12) / 12) * 0.95;
        ctx.fillStyle = v >= 7 ? INK : GREY;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.6, r), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // threshold style numbers: flashes a second, highest in each of 6 x 4 parts of the field
    const cols = 6;
    const rows = 4;
    ctx.font = '500 13px "Atkinson Hyperlegible Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        let m = 0;
        const x0 = bx0 + Math.floor(((bx1 - bx0) * q) / cols);
        const x1 = bx0 + Math.floor(((bx1 - bx0) * (q + 1)) / cols);
        const y0 = by0 + Math.floor(((by1 - by0) * r) / rows);
        const y1 = by0 + Math.floor(((by1 - by0) * (r + 1)) / rows);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m = Math.max(m, snap.blocks[y * snap.bw + x]);
        const tx = ((q + 0.5) / cols) * cw;
        const ty = ((r + 0.5) / rows) * ch;
        const label = m ? String(m / 2).replace(/\.0$/, '') : '0';
        ctx.lineWidth = 4;
        ctx.strokeStyle = SHEET;
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = m >= 7 ? INK : INK3;
        ctx.fillText(label, tx, ty);
      }
    }
  } else {
    ctx.fillStyle = INK3;
    ctx.font = '15px "Atkinson Hyperlegible Next", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No fast flashing to map', cx, cy - 26);
  }
  // axes through fixation, ticks every degree (341 CSS px = 10 degrees)
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(cw, cy);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, ch);
  ctx.stroke();
  const deg = (FIELD_W / 10) * k;
  ctx.font = '11px "Atkinson Hyperlegible Mono", ui-monospace, monospace';
  ctx.fillStyle = INK3;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let d = -10; d <= 10; d++) {
    const x = cx + d * deg;
    if (x < 0 || x > cw) continue;
    const len = d % 5 === 0 ? 6 : 3;
    ctx.beginPath();
    ctx.moveTo(x, cy - len);
    ctx.lineTo(x, cy + len);
    ctx.stroke();
  }
  for (let d = -10; d <= 10; d++) {
    const y = cy + d * deg;
    if (y < 0 || y > ch) continue;
    const len = d % 5 === 0 ? 6 : 3;
    ctx.beginPath();
    ctx.moveTo(cx - len, y);
    ctx.lineTo(cx + len, y);
    ctx.stroke();
  }
  // fixation target
  ctx.strokeStyle = FIX;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.stroke();
  // scale under the map
  ctx.fillStyle = INK3;
  ctx.textAlign = 'left';
  ctx.fillText('-5°', Math.max(2, cx - 5 * deg - 8), ch + 8);
  ctx.textAlign = 'center';
  ctx.fillText('0°', cx, ch + 8);
  ctx.textAlign = 'right';
  ctx.fillText('+5°', Math.min(cw - 2, cx + 5 * deg + 10), ch + 8);
  // key

}
