// Plain text rendering of a report, for terminals and logs.
import type { Report } from './types.ts';

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
}

const LABEL: Record<Report['verdict'], string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

export function formatText(report: Report, opts: { color?: boolean } = {}): string {
  const c = opts.color
    ? { fail: '\x1b[31m', warn: '\x1b[33m', pass: '\x1b[32m', dim: '\x1b[2m', off: '\x1b[0m' }
    : { fail: '', warn: '', pass: '', dim: '', off: '' };
  const m = report.media;
  const s = report.settings;
  const lines: string[] = [];
  lines.push(
    `${m.source}: ${m.width} x ${m.height}, ${m.duration.toFixed(2)} s, ${m.frames} frames at ${m.fps.toFixed(2)} fps`,
  );
  lines.push(
    `${c.dim}screened at ${s.display.width} x ${s.display.height} CSS px; area rule "${s.areaRule}": more than ` +
      `${s.areaLimit.toLocaleString('en-US')} CSS px flashing together in ${s.areaRule === 'frame' ? 'the frame' : `any 341 x 256 CSS px field (searched with a ${s.window.width} x ${s.window.height} window)`}${c.off}`,
  );
  const partial = report.complete === false;
  lines.push(
    `${c[report.verdict]}${LABEL[report.verdict]}${c.off}  WCAG 2.2 SC 2.3.1 screen: ${report.wcag231 === 'fail' ? 'fails' : partial ? 'no failure in the part screened' : 'passes'}`,
  );
  if (partial) lines.push(`  ${c.warn}Not fully screened: part of the content was not read or was sampled too slowly (see the warnings).${c.off}`);
  const chan = (label: string, x: Report['general']) => {
    if (x.maxFlashesPerSecond === 0 && x.maxAreaOverRate === 0) return `  ${label}none over an area above the limit`;
    const rate = `${x.maxFlashesPerSecond}${x.rateIsMinimum ? ' or more' : ''}`;
    const area = x.maxAreaOverRate
      ? `; largest area flashing more than 3 times a second: ${x.maxAreaOverRate.toLocaleString('en-US')} CSS px (${Math.round(x.maxAreaRatio * 100)}% of the limit)`
      : '';
    const head = x.maxFlashesPerSecond > 0 ? `up to ${rate} a second over an area above the limit` : 'none over an area above the limit';
    return `  ${label}${head}${area}`;
  };
  lines.push(chan('general flashes: ', report.general));
  lines.push(chan('red flashes:     ', report.red));
  for (const x of report.reasons) {
    const when = x.start !== undefined && x.end !== undefined ? `${fmtTime(x.start)} to ${fmtTime(x.end)}  ` : '';
    const col = x.level === 'fail' ? c.fail : x.level === 'warn' ? c.warn : c.dim;
    lines.push(`  ${col}${x.level.padEnd(4)}${c.off}  ${when}${x.message}`);
  }
  for (const n of m.notes) lines.push(`  ${c.dim}note  ${n}${c.off}`);
  lines.push(`${c.dim}${report.disclaimer}${c.off}`);
  return lines.join('\n');
}
