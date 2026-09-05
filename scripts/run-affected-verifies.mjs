// Affected-only verify runner: runs the verifies that match files changed
// in the working tree (or an explicit file list). Full `npm test` stays for
// release gates; this covers the daily loop in seconds.
//
// Matching rule: a changed `X.ts` runs `X.verify.*` when present; otherwise
// every `*.verify.*` in the same directory is a candidate (directory-level
// suites).
//
// The directory fallback used to give up silently when a directory held more
// than 8 verifies, and print "no affected verifies" — success. That skipped 16
// directories covering 433 of the repo's 547 verify files, and they are the
// busiest ones: src/agent/tools (71), server/plugins (52), src/agent (45),
// src/editor (37), src/persist (25). Editing anything in them reported a clean
// run having executed nothing. Coverage now never shrinks quietly: a large
// selection is announced with its size, and the caller can interrupt it.
//
// Usage:
//   npm run verify:affected            — all working-tree changes vs HEAD
//   npm run verify:affected -- <file>… — explicit files
import { exec } from 'node:child_process';
import { cpus } from 'node:os';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONCURRENCY = Math.max(2, Math.min(8, Number(process.env.TEST_CONCURRENCY) || 4));

// Selected paths are reported (and looked up in package.json's canonical
// commands) with posix separators; platform join() would produce backslash
// paths on Windows that miss the command map and the suites' own expectations.
const toPosix = (value) => value.split(sep).join('/');

const gitChanged = () => new Promise((resolve) => {
  exec('git diff --name-only HEAD', (error, stdout) => {
    if (error) return resolve([]);
    resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  });
});

export function matchingVerifies(changedFiles) {
  const matches = new Set();
  for (const file of changedFiles) {
    if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
    const dir = dirname(file);
    let candidates;
    try {
      // .tsx and .mjs verifies count too — matching only `.verify.ts` left 20
      // of them permanently unreachable, including every remotion/ suite.
      candidates = readdirSync(dir).filter((name) => /\.verify\.(ts|tsx|mjs)$/.test(name));
    } catch {
      continue;
    }
    const base = file.split(/[\\/]/).pop().replace(/\.(ts|tsx|mjs)$/, '');
    const exact = candidates.find((name) => /^(.*)\.verify\.(ts|tsx|mjs)$/.exec(name)?.[1] === base);
    if (exact) {
      matches.add(toPosix(join(dir, exact)));
      continue;
    }
    // No per-file verify: the directory suite is the only thing that covers
    // this change, so run all of it. Never skip silently — that reported
    // success for a run that executed nothing.
    for (const name of candidates) matches.add(toPosix(join(dir, name)));
  }
  return [...matches].sort();
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
      const path = /(\S+\.verify\.(?:ts|tsx|mjs))\s*$/.exec(segment)?.[1];
      if (path && !byFile.has(path)) byFile.set(path, segment);
    }
  }
  return byFile;
})();

/** The command the suite itself uses, falling back to the usual runner. */
export function verifyCommand(file) {
  return CANONICAL_COMMANDS.get(file)
    ?? (file.endsWith('.mjs') ? `node ${file}` : `npx tsx ${file}`);
}

async function main() {
  const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const changed = explicit.length > 0 ? explicit : await gitChanged();
  const verifies = matchingVerifies(changed);
  if (verifies.length === 0) {
    console.log('✓ no affected verifies (changed files have no verify suites)');
    console.log(`  changed: ${changed.slice(0, 6).join(', ') || '(none)'}`);
    return;
  }
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
        exec(verifyCommand(file), { maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
          resolve({ file, error, output: stderr.slice(-600) });
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
