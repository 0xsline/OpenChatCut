// Affected-only verify runner: runs the verifies that match files changed
// in the working tree (or an explicit file list). Full `npm test` stays for
// release gates; this covers the daily loop in seconds.
//
// Exact suites win, otherwise select the nearest directory with suites.
// This is a heuristic, not an import graph. Shared/configuration/assets and
// unmapped changes require the full gate instead of claiming affected coverage.
//
// Usage:
//   npm run verify:affected            — all working-tree changes vs HEAD
//   npm run verify:affected -- <file>… — explicit files
//   npm run verify:affected -- --list <file>… — inspect without executing tests
import { exec, execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const CONCURRENCY = Math.max(1, Math.min(8, Math.floor(Number(process.env.TEST_CONCURRENCY)) || 4));
const SOURCE_EXTENSION = /\.(?:tsx|mts|cjs|mjs|ts|js|frag|vert|glsl)$/;
const VERIFY_EXTENSION = /\.verify\.(?:tsx|mts|cjs|mjs|ts|js)$/;
const FULL_GATE = /^(?:package(?:-lock)?\.json$|npm-shrinkwrap\.json$|tsconfig(?:\.[^/]+)?\.json$|config\/|shared\/|assets\/|public\/|\.github\/)/;
const DOCUMENTATION = /^(?:docs\/|README(?:_[A-Z]+)?\.md$|CHANGELOG\.md$|LICENSE$|AGENTS\.md$|CLAUDE\.md$)/;
const toPosix = (value) => value.split(sep).join('/');

export async function gitChanged(cwd = process.cwd()) {
  const run = promisify(execFile);
  const outputs = await Promise.all([
    run('git', ['diff', '--name-only', '--no-renames', '-z', 'HEAD'], { cwd }),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd }),
  ]);
  return [...new Set(outputs.flatMap(({ stdout }) => stdout.split('\0').filter(Boolean)))];
}

function directoryVerifies(dir, cwd) {
  try {
    return readdirSync(resolve(cwd, dir)).filter((name) => VERIFY_EXTENSION.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function affectedSelection(changedFiles, cwd = process.cwd()) {
  const matches = new Set();
  const requiresFullGate = new Set();
  for (const changed of changedFiles) {
    const file = toPosix(relative(cwd, resolve(cwd, changed)));
    if (DOCUMENTATION.test(file)) continue;
    if (FULL_GATE.test(file) && !VERIFY_EXTENSION.test(file)) requiresFullGate.add(file);
    if (!SOURCE_EXTENSION.test(file) || file.startsWith('../')) {
      requiresFullGate.add(file);
      continue;
    }
    if (/^src\/gl\/.*\.(?:frag|vert|glsl)$/.test(file)) {
      for (const name of directoryVerifies('src/gl', cwd)) matches.add(toPosix(join('src/gl', name)));
    }
    let dir = dirname(file);
    let candidates = directoryVerifies(dir, cwd);
    const base = file.split('/').pop().replace(SOURCE_EXTENSION, '');
    const exact = candidates.filter((name) => name.replace(VERIFY_EXTENSION, '') === base
      || toPosix(join(dir, name)) === file);
    if (exact.length) candidates = exact;
    while (!candidates.length && dir !== '.') {
      dir = dirname(dir);
      candidates = directoryVerifies(dir, cwd);
    }
    if (!candidates.length) requiresFullGate.add(file);
    for (const name of candidates) matches.add(toPosix(join(dir, name)));
  }
  return { verifies: [...matches].sort(), requiresFullGate: [...requiresFullGate].sort() };
}

export function matchingVerifies(changedFiles) {
  return affectedSelection(changedFiles).verifies;
}

// How each verify is invoked is already decided in package.json, and not every
// one is `tsx <file>`: the suites whose import graph reaches a Vite-only `?raw`
// or `.frag` import run through scripts/run-check.mjs, and .mjs suites run on
// bare node. Reading those commands back means this runner cannot drift from
// the suite — guessing `npx tsx` failed effect-tools and library-edit-item.
const CANONICAL_COMMANDS = (() => {
  const scripts = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).scripts;
  const byFile = new Map();
  for (const script of Object.values(scripts)) {
    if (typeof script !== 'string') continue;
    for (const segment of script.split('&&').map((s) => s.trim())) {
      const path = /(\S+\.verify\.(?:tsx|mts|cjs|mjs|ts|js))\s*$/.exec(segment)?.[1];
      if (path && !byFile.has(path)) byFile.set(path, segment);
    }
  }
  return byFile;
})();

/** The command the suite itself uses, falling back to the usual runner. */
export function verifyCommand(file) {
  return CANONICAL_COMMANDS.get(file)
    ?? (/\.(?:mjs|cjs|js)$/.test(file) ? `node ${file}` : `npx tsx ${file}`);
}

async function main() {
  const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const changed = explicit.length > 0 ? explicit : await gitChanged();
  const { verifies, requiresFullGate } = affectedSelection(changed);
  if (process.argv.includes('--list')) console.log(verifies.join('\n'));
  if (requiresFullGate.length) {
    console.error(`Affected selection cannot establish coverage for:\n  ${requiresFullGate.join('\n  ')}`);
    console.error('Run the broader gate: npm run lint && npm test && npm run build');
    process.exitCode = 2;
    return;
  }
  if (process.argv.includes('--list')) return;
  if (verifies.length === 0) {
    console.log('✓ no affected verifies (no changes or documentation only)');
    console.log(`  changed: ${changed.slice(0, 6).join(', ') || '(none)'}`);
    return;
  }
  await runSelected(verifies);
}

async function runSelected(verifies) {
  console.log(`Running ${verifies.length} affected verifies (${CONCURRENCY} parallel):`);
  if (verifies.length > 40) {
    // Say so rather than trimming the selection: the caller can interrupt, and
    // a quietly trimmed run is what made this tool untrustworthy before.
    console.log('  (large selection — a changed file with no per-file verify pulls in its whole directory)');
  }
  const started = Date.now();
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < verifies.length) {
      const file = verifies[cursor];
      cursor += 1;
      const result = await new Promise((resolve) => {
        exec(verifyCommand(file), { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
          resolve({ file, error, output: [stdout.slice(-1200), stderr.slice(-1200)].filter(Boolean).join('\n') });
        });
      });
      process.stdout.write(`${result.error ? '❌' : '✅'} ${result.file}\n`);
      results.push(result);
    }
  });
  await Promise.all(workers);
  const failed = results.filter((r) => r.error);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (failed.length === 0) {
    console.log(`\n✓ ${results.length} affected verifies passed in ${elapsed}s`);
    process.exit(0);
  }
  console.log(`\n✗ ${failed.length}/${results.length} failed in ${elapsed}s:`);
  for (const f of failed) {
    console.log(`\n--- ${f.file} ---`);
    console.log(f.output);
  }
  process.exit(1);
}

// Only run when invoked directly, so the verify can import the matcher.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
