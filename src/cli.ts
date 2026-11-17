#!/usr/bin/env node
// Stillfield command line. Exit codes: 0 no failure found, 1 a failure (or a warning with --strict), 2 could not run
// (or could not read the whole file and found no failure in the part it read).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatText } from './core/format.ts';
import { VERSION } from './core/analyzer.ts';
import type { AreaRule, Report } from './core/types.ts';
import { ToolMissingError } from './node/ffmpeg.ts';
import { fix, screen, toSarif } from './node/screen.ts';
import { parseDisplay } from './node/sources.ts';

const HELP = `stillfield ${VERSION}
Screens video, GIFs, PNG sequences and web pages for flashing over the WCAG 2.2 SC 2.3.1 thresholds.
It screens; it does not certify. Not medical advice.

Usage
  stillfield <file-or-url>... [options]

Input
  video (any format ffmpeg reads), .gif, a folder of .png frames, an http(s) URL or a local .html file

Options
  --json                 print the report as JSON (schema stillfield/report@1)
  --sarif <file>         also write SARIF 2.1.0 results ("-" for stdout)
  --out <file>           also write the JSON report to a file
  --timeline             include the per frame timeline in JSON output
  --display <WxH>        size the content is shown at, CSS px; or native, fullscreen, auto (default auto:
                         video full screen at 1024x768, GIFs and images at their own size, pages 1024x768)
  --area <rule>          wcag (default, 25% of any 341x256 field), understanding (87,296 CSS px), frame (25% of frame)
  --fix                  write a reduced flash version (video or GIF) and screen the written file again
  --fix-out <file>       where to write it (default <name>.reduced.mp4 or .gif next to the input; one input only)
  --fps <n>              frame rate for PNG folders and web pages (default 30)
  --duration <s>         seconds to record a web page (default 10)
  --settle <s>           seconds to let a web page settle first (default 1)
  --no-loop              screen a GIF once instead of looping it
  --background <hex>     colour behind transparent GIF and PNG pixels (default ffffff)
  --red-floor <n>        linear R+G+B under which colours count as black for the red test (default 0.01)
  --strict               exit 1 on warnings too
  --no-color             plain text
  -q, --quiet            print only the verdict line
  -h, --help             this help
  -v, --version          version

Exit codes: 0 no failure found, 1 failure found (or warning with --strict), 2 could not run, or could not read
the whole file (truncated or damaged) and found no failure in the part it read.`;

function hex(s: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) throw new Error(`--background must be a hex colour like ffffff (got "${s}")`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function num(name: string, v: string | undefined, positive = false): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) {
    throw new Error(`--${name} must be a ${positive ? 'positive' : 'non negative'} number (got "${v}")`);
  }
  return n;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      sarif: { type: 'string' },
      out: { type: 'string' },
      timeline: { type: 'boolean' },
      display: { type: 'string' },
      viewport: { type: 'string' },
      area: { type: 'string' },
      fix: { type: 'boolean' },
      'fix-out': { type: 'string' },
      fps: { type: 'string' },
      duration: { type: 'string' },
      settle: { type: 'string' },
      'no-loop': { type: 'boolean' },
      background: { type: 'string' },
      'red-floor': { type: 'string' },
      strict: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const fixOut = values['fix-out'];
  const inputs = [...positionals];
  if (!inputs.length) {
    console.error(HELP);
    return 2;
  }
  const area = (values.area ?? 'wcag') as AreaRule;
  if (!['wcag', 'understanding', 'frame'].includes(area)) throw new Error(`--area must be wcag, understanding or frame`);
  if (values.fix && fixOut && inputs.length > 1) {
    throw new Error('--fix-out names one file; with several inputs leave it out (each gets <name>.reduced next to it)');
  }
  const opts = {
    display: parseDisplay(values.display ?? values.viewport),
    areaRule: area,
    fps: num('fps', values.fps, true),
    duration: num('duration', values.duration, true),
    settle: num('settle', values.settle),
    loop: !values['no-loop'],
    background: values.background ? hex(values.background) : undefined,
    redBlackFloor: num('red-floor', values['red-floor']),
    timeline: true,
  };
  const color = !values['no-color'] && process.stdout.isTTY && !values.json;
  const reports: Report[] = [];
  /** One entry per input that produced a report: written by --json and by --out. */
  const jsonOut: unknown[] = [];
  let code = 0;
  for (const input of inputs) {
    try {
      let report: Report;
      if (values.fix) {
        if (/^https?:\/\//i.test(input)) throw new Error('--fix works on video files and GIFs, not URLs');
        const res = await fix(input, fixOut, opts);
        report = res.before;
        jsonOut.push({ before: strip(res.before, values.timeline), after: strip(res.after, values.timeline), output: res.output, tries: res.tries });
        if (!values.json) {
          console.log(values.quiet ? quietLine(res.before) : formatText(res.before, { color }));
          console.log('');
          console.log(`Reduced flash version written to ${res.output} (${res.tries.length} ${res.tries.length === 1 ? 'try' : 'tries'}, time constant ${res.tries[res.tries.length - 1].tau} s). Screen of the written file:`);
          console.log(values.quiet ? quietLine(res.after) : formatText(res.after, { color }));
          console.log(
            res.after.wcag231 === 'fail'
              ? 'The written file still fails the screen. Edit the source; the filter could not bring it under the thresholds.'
              : !res.after.complete
                ? 'The written file was not fully screened (see the warnings above), so this run cannot say whether it is under the thresholds. Screen it again on its own.'
                : `The written file screened without a WCAG 2.3.1 failure${res.after.verdict === 'warn' ? ', with warnings (see above)' : ''}. ` +
                  'Have it reviewed before use, frame by frame or by someone who is not photosensitive; this is not a certification.',
          );
        }
        reports.push(res.after);
      } else {
        report = await screen(input, opts);
        reports.push(report);
        jsonOut.push(strip(report, values.timeline));
        if (!values.json) console.log(values.quiet ? quietLine(report) : formatText(report, { color }));
      }
      if (report.verdict === 'fail' || (values.strict && report.verdict === 'warn')) code = Math.max(code, 1);
      if (values.fix && reports[reports.length - 1].wcag231 === 'fail') code = Math.max(code, 1);
      // the file could not be read in full and the part read had no failure: that is "could not run", not a pass
      if (report.verdict !== 'fail' && report.reasons.some((x) => x.code === 'incomplete')) code = 2;
      // the same for the written file's screen after --fix
      const written = values.fix ? reports[reports.length - 1] : null;
      if (written && written.wcag231 !== 'fail' && !written.complete) code = 2;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`stillfield: ${input}: ${msg}`);
      code = 2;
      if (e instanceof ToolMissingError) break;
    }
  }
  const single = inputs.length === 1 && jsonOut.length === 1;
  if (values.json) console.log(JSON.stringify(single ? jsonOut[0] : jsonOut, null, 2));
  if (values.out) writeFileSync(values.out, JSON.stringify(single ? jsonOut[0] : jsonOut, null, 2));
  if (values.sarif) {
    const s = JSON.stringify(toSarif(reports), null, 2);
    if (values.sarif === '-') console.log(s);
    else writeFileSync(values.sarif, s);
  }
  return code;
}

function strip(r: Report, timeline?: boolean): Report {
  if (timeline) return r;
  const { timeline: _t, ...rest } = r;
  return rest as Report;
}

function quietLine(r: Report): string {
  return `${r.verdict.toUpperCase()} ${r.media.source}`;
}

main(process.argv.slice(2)).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`stillfield: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  },
);
