// Gate-coverage invariant: every *.verify.* file on disk must actually run in `npm test`.
//
// The suite is a hand-maintained `&&` chain in package.json with no glob discovery, so a
// new verify file is only ever run because someone remembered to add it by name. Three
// files had silently never run at all (src/media/drag.verify.ts, src/gl/clipFxExport.verify.mjs,
// server/external-agent/external-skill.verify.mjs — the last one only via a separate CI step).
// Tests that never run are worse than no tests: they read as coverage in review.
//
// This check has no allowlist on purpose. An exception here would be invisible in exactly
// the way the original gap was, so a verify that genuinely cannot run in the suite should
// be deleted or fixed, not excused.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};

// `npm test` runs pretest, then run-tests.mjs over the `test:serial` segments, then posttest.
const expandNpmRun = (command, depth = 0) => (
  depth > 8 || !command
    ? ''
    : command.replace(/npm run ([a-z0-9:-]+)/g, (whole, name) => (
      scripts[name] ? expandNpmRun(scripts[name], depth + 1) : whole
    ))
);
const gate = expandNpmRun(
  [scripts.pretest, scripts['test:serial'], scripts.posttest].filter(Boolean).join(' && '),
);

// Longest-first alternation: a plain `ts|tsx` order truncates "Foo.verify.tsx" to
// "Foo.verify.ts" and silently reports a covered file as an orphan.
const VERIFY_EXTENSIONS = ['tsx', 'mts', 'cjs', 'mjs', 'ts', 'js'];
const extensionPattern = VERIFY_EXTENSIONS.join('|');
const referenced = new Set(
  [...gate.matchAll(new RegExp(`([A-Za-z0-9_./-]+\\.verify\\.(?:${extensionPattern}))(?![A-Za-z0-9])`, 'g'))]
    .map((match) => match[1].replace(/^\.\//, '')),
);

const isVerifyFile = new RegExp(`\\.verify\\.(?:${extensionPattern})$`);
const onDisk = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (isVerifyFile.test(entry.name)) onDisk.push(relative(root, full));
  }
};
walk(root);

assert.ok(onDisk.length > 400, `expected the full verify corpus, found ${onDisk.length}`);

const orphans = onDisk.filter((file) => !referenced.has(file)).sort();
assert.deepEqual(
  orphans,
  [],
  `${orphans.length} verify file(s) never run in \`npm test\`. Add each to the test:serial chain `
  + `in package.json:\n${orphans.map((file) => `  - ${file}`).join('\n')}`,
);

// Guard the guard: if the path regex ever stops matching, every file would look covered
// and this check would pass while asserting nothing.
assert.ok(
  referenced.has('scripts/verify-gate-coverage.verify.mjs'),
  'this file must appear in the gate chain, or the reference scan is broken',
);

// Linux intentionally skips exact frame mapping. At least one required CI job
// must execute the existing render fixture on a platform that keeps it enabled.
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
assert.ok(Object.hasOwn(workflow.on, 'pull_request'), 'verification must run on pull requests');
const frameSync = workflow.jobs['frame-sync'];
assert.match(frameSync['runs-on'], /^macos-/);
assert.equal(frameSync.if, undefined, 'the render gate cannot be optional on PRs');
assert.equal(frameSync['continue-on-error'], undefined);
assert.ok(frameSync.steps.some((step) => /^actions\/checkout@/.test(step.uses ?? '')));
assert.ok(frameSync.steps.some((step) => step.run === 'npm ci --loglevel=error'));
assert.ok(frameSync.steps.some((step) => step.run === 'brew install ffmpeg'));
const renderStep = frameSync.steps.find((step) => step.run === 'node src/gl/clipFxExport.verify.mjs');
assert.ok(renderStep, 'macOS must run the complete effect and transition render fixture');
assert.equal(renderStep.if, undefined);
assert.equal(renderStep['continue-on-error'], undefined);

// AGENTS.md's 500-line source ceiling applies to new files too. Ask Git for
// tracked + nonignored untracked paths, excluding local generated scratch files.
const dataModules = new Set([
  'src/i18n/dict/ru/index.ts', // Translation dictionary data, no application logic.
  'src/i18n/dict/en/settings.ts', // Translation dictionary data, no application logic.
]);
const sourceFiles = [...new Set(execFileSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '-z',
], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].filter((file) => (
  /\.(?:tsx|mts|cjs|mjs|ts|js)$/.test(file)
  && !/\.(?:verify|check|test|spec)(?:[.-])|\.d\.ts$/.test(file)
  && !dataModules.has(file)
  && existsSync(join(root, file))
));
const oversizedSources = sourceFiles.flatMap((file) => {
  const source = readFileSync(join(root, file), 'utf8');
  const lines = source.split('\n').length - Number(source.endsWith('\n'));
  return lines > 500 ? [`${file}: ${lines} lines`] : [];
}).sort();
assert.deepEqual(oversizedSources, [],
  `Source files must stay at or below 500 lines. Split by responsibility:\n${oversizedSources.join('\n')}`);

console.log(`gate coverage checks passed (${onDisk.length} verify files, all reachable from npm test)`);
