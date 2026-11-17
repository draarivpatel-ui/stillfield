// GitHub Action entry point (run by action.yml with Node 22.18 or newer, which runs TypeScript directly).
import { appendFileSync, existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import type { AreaRule, Report } from './core/types.ts';
import { fmtTime } from './core/format.ts';
import { screen, toSarif } from './node/screen.ts';
import { parseDisplay } from './node/sources.ts';
import { escapeCell, escapeData, escapeProperty } from './node/workflow.ts';

const env = (k: string, d = '') => (process.env[k] ?? d).trim();

/** Changed paths, NUL separated and unquoted (git quotes names with non ASCII bytes otherwise). */
function gitDiff(args: string[]): string[] {
  const full = ['-c', 'core.quotePath=false', 'diff', '-z', '--name-only', '--diff-filter=AMR', ...args];
  const r = spawnSync('git', full, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${full.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** Media files changed by this pull request or push. */
export function changedFiles(exts: Set<string>): string[] {
  let files: string[] = [];
  const event = env('GITHUB_EVENT_NAME');
  const payload = existsSync(env('GITHUB_EVENT_PATH')) ? JSON.parse(readFileSync(env('GITHUB_EVENT_PATH'), 'utf8')) : {};
  if (event.startsWith('pull_request')) {
    // actions/checkout checks out the merge commit; its first parent is the base branch
    files = gitDiff(['HEAD^1', 'HEAD']);
  } else if (payload.before && !/^0+$/.test(payload.before)) {
    files = gitDiff([payload.before, payload.after ?? 'HEAD']);
  } else {
    files = gitDiff(['HEAD^1', 'HEAD']);
  }
  return files.filter((f) => exts.has(extname(f).toLowerCase().slice(1)) && existsSync(f));
}

function rank(v: Report['verdict']): number {
  return v === 'fail' ? 2 : v === 'warn' ? 1 : 0;
}

async function main(): Promise<number> {
  const exts = new Set(env('INPUT_EXTENSIONS', 'mp4 mov m4v webm mkv avi gif').split(/[\s,]+/).filter(Boolean).map((e) => e.replace(/^\./, '').toLowerCase()));
  const patterns = env('INPUT_PATHS').split('\n').map((s) => s.trim()).filter(Boolean);
  const files = patterns.length
    ? [...new Set(patterns.flatMap((p) => (/[*?[{]/.test(p) ? globSync(p) : [p])))].filter((f) => existsSync(f))
    : changedFiles(exts);
  const area = (env('INPUT_AREA', 'wcag') || 'wcag') as AreaRule;
  if (!['wcag', 'understanding', 'frame'].includes(area)) throw new Error(`area must be wcag, understanding or frame (got "${area}")`);
  const display = parseDisplay(env('INPUT_DISPLAY', 'auto') || 'auto');
  const failOn = env('INPUT_FAIL_ON', 'fail');
  const sarifPath = env('INPUT_SARIF', 'stillfield.sarif') || 'stillfield.sarif';
  const reports: Report[] = [];
  const rows: string[] = [];
  let errors = 0;
  for (const f of files) {
    try {
      const r = await screen(f, { areaRule: area, display, timeline: false });
      reports.push(r);
      const w = r.worstWindows[0];
      // a file that could not be read in full, with no failure in the part read, counts as an error, not a pass
      if (r.verdict !== 'fail' && r.reasons.some((x) => x.code === 'incomplete')) errors++;
      rows.push(
        `| \`${escapeCell(f)}\` | ${r.verdict.toUpperCase()}${r.complete ? '' : ' (not fully screened)'} | ${r.general.maxFlashesPerSecond} | ${r.red.maxFlashesPerSecond} | ${Math.round(Math.max(r.general.maxAreaRatio, r.red.maxAreaRatio) * 100)}% | ${w ? `${fmtTime(w.start)} to ${fmtTime(w.end)}` : ''} |`,
      );
      console.log(`${r.verdict.toUpperCase()} ${f}`);
      for (const x of r.reasons) {
        const cmd = x.level === 'fail' ? 'error' : x.level === 'warn' ? 'warning' : 'notice';
        console.log(`::${cmd} file=${escapeProperty(f)},title=${escapeProperty(`stillfield ${x.code}`)}::${escapeData(`${x.start !== undefined ? `${fmtTime(x.start)} to ${fmtTime(x.end ?? x.start)}: ` : ''}${x.message}`)}`);
      }
    } catch (e) {
      errors++;
      console.log(`::error file=${escapeProperty(f)},title=stillfield could not screen::${escapeData(e instanceof Error ? e.message : String(e))}`);
    }
  }
  writeFileSync(sarifPath, JSON.stringify(toSarif(reports), null, 2));
  const worst = reports.reduce<Report['verdict'] | 'none'>((acc, r) => (acc === 'none' || rank(r.verdict) > rank(acc) ? r.verdict : acc), 'none');
  const summary = [
    '## Stillfield',
    '',
    files.length
      ? `Screened ${files.length} file${files.length === 1 ? '' : 's'} against WCAG 2.2 SC 2.3.1 (area rule \`${area}\`).`
      : 'No changed media files to screen.',
    '',
    ...(rows.length
      ? ['| File | Verdict | General flashes per second | Red flashes per second | Fast flashing area vs limit | Worst window |', '| --- | --- | --- | --- | --- | --- |', ...rows, '']
      : []),
    'A screen, not a certification and not medical advice.',
    '',
  ].join('\n');
  if (env('GITHUB_STEP_SUMMARY')) appendFileSync(env('GITHUB_STEP_SUMMARY'), summary);
  else console.log(summary);
  if (env('GITHUB_OUTPUT')) appendFileSync(env('GITHUB_OUTPUT'), `verdict=${worst}\nsarif=${sarifPath}\n`);
  if (errors) return 2;
  if (worst === 'fail' || (failOn === 'warn' && worst === 'warn')) return 1;
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.log(`::error title=stillfield::${escapeData(e instanceof Error ? e.message : String(e))}`);
    process.exit(2);
  },
);
