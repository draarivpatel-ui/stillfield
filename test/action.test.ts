// The GitHub Action entry point, run locally with the environment GitHub would give it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, writeClip } from './helpers.ts';

const ACTION = join(import.meta.dirname, '..', 'src', 'action.ts');

function runAction(cwd: string, env: Record<string, string>) {
  const summary = join(cwd, 'summary.md');
  const output = join(cwd, 'output.txt');
  writeFileSync(summary, '');
  writeFileSync(output, '');
  const r = spawnSync(process.execPath, [ACTION], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, summary: readFileSync(summary, 'utf8'), output: readFileSync(output, 'utf8') };
}

test('explicit paths: fails the job on a failing clip and writes SARIF, summary and outputs', async () => {
  const fail = await writeClip('fail-full-4hz', '.mp4');
  const pass = await writeClip('pass-full-2hz', '.mp4');
  const dir = join(OUT, 'action-explicit');
  mkdirSync(dir, { recursive: true });
  const r = runAction(dir, { INPUT_PATHS: `${fail}\n${pass}`, INPUT_SARIF: join(dir, 'out.sarif') });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::error file=.*fail-full-4hz\.mp4,title=stillfield general-flash::/);
  assert.match(r.summary, /\| FAIL \|/);
  assert.match(r.summary, /\| PASS \|/);
  assert.match(r.summary, /not a certification/);
  assert.match(r.output, /verdict=fail/);
  const sarif = JSON.parse(readFileSync(join(dir, 'out.sarif'), 'utf8'));
  assert.equal(sarif.runs[0].results[0].ruleId, 'general-flash');
});

test('changed files mode: screens only media added by the last commit of a pull request', async () => {
  const dir = join(OUT, 'action-repo');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  g('init', '-q');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'test');
  copyFileSync(await writeClip('fail-red-4hz', '.mp4'), join(dir, 'old.mp4'));
  g('add', '.');
  g('commit', '-qm', 'base');
  copyFileSync(await writeClip('pass-small-4hz', '.mp4'), join(dir, 'new.mp4'));
  writeFileSync(join(dir, 'notes.txt'), 'not media');
  g('add', '.');
  g('commit', '-qm', 'pr');
  const r = runAction(dir, { GITHUB_EVENT_NAME: 'pull_request', INPUT_PATHS: '' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS new\.mp4/);
  assert.doesNotMatch(r.stdout, /old\.mp4/);
  assert.match(r.output, /verdict=pass/);
});

test('fail-on warn fails the job on a warning', async () => {
  const warn = await writeClip('borderline-area-under', '.mp4');
  const dir = join(OUT, 'action-warn');
  mkdirSync(dir, { recursive: true });
  assert.equal(runAction(dir, { INPUT_PATHS: warn }).code, 0);
  assert.equal(runAction(dir, { INPUT_PATHS: warn, INPUT_FAIL_ON: 'warn' }).code, 1);
});

test('changed files mode finds media with non ASCII names (git path quoting is off)', async () => {
  const dir = join(OUT, 'action-unicode');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  g('init', '-q');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'test');
  writeFileSync(join(dir, 'readme.txt'), 'base');
  g('add', '.');
  g('commit', '-qm', 'base');
  copyFileSync(await writeClip('fail-full-4hz', '.mp4'), join(dir, 'vidéo, 1.mp4'));
  g('add', '.');
  g('commit', '-qm', 'pr');
  const r = runAction(dir, { GITHUB_EVENT_NAME: 'pull_request', INPUT_PATHS: '' });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL vidéo, 1\.mp4/);
  // the comma in the name is escaped in the workflow command property
  assert.match(r.stdout, /::error file=vidéo%2C 1\.mp4,title=stillfield general-flash::/);
  assert.match(r.summary, /\| `vidéo, 1\.mp4` \| FAIL \|/);
});

test('workflow command and table escaping', async () => {
  const { escapeProperty, escapeData, escapeCell } = await import('../src/node/workflow.ts');
  assert.equal(escapeProperty('a,b:c%d\ne'), 'a%2Cb%3Ac%25d%0Ae');
  assert.equal(escapeData('50%\nnext'), '50%25%0Anext');
  assert.equal(escapeCell('a|b'), 'a\\|b');
});

test('a bad area input stops the job with exit 2', () => {
  const dir = join(OUT, 'action-bad-area');
  mkdirSync(dir, { recursive: true });
  const r = runAction(dir, { INPUT_PATHS: 'none.mp4', INPUT_AREA: 'wcga' });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /area must be/);
});
