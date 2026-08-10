// Affected-only verify runner: runs the verifies that match files changed
// in the working tree (or an explicit file list). Full `npm test` stays for
// release gates; this covers the daily loop in seconds.
//
// Matching rule: a changed `X.ts` runs `X.verify.ts` when present; otherwise
// every `*.verify.ts` in the same directory is a candidate (directory-level
// suites). Usage:
//   npm run verify:affected            — all working-tree changes vs HEAD
//   npm run verify:affected -- <file>… — explicit files
import { exec } from 'node:child_process';
import { cpus } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const CONCURRENCY = Math.max(2, Math.min(8, Number(process.env.TEST_CONCURRENCY) || 4));

const gitChanged = () => new Promise((resolve) => {
  exec('git diff --name-only HEAD', (error, stdout) => {
    if (error) return resolve([]);
    resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  });
});

function matchingVerifies(changedFiles) {
  const matches = new Set();
  for (const file of changedFiles) {
    if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
    const dir = dirname(file);
    let candidates;
    try {
      candidates = readdirSync(dir).filter((name) => name.endsWith('.verify.ts'));
    } catch {
      continue;
    }
    const base = file.split('/').pop().replace(/\.(ts|tsx)$/, '');
    const exact = candidates.find((name) => name === `${base}.verify.ts`);
    if (exact) {
      matches.add(join(dir, exact));
      continue;
    }
    // Directory-level suites: the changed file has no per-file verify, so run
    // the whole directory suite when it is small (≤ 8 files), else nothing.
    if (candidates.length <= 8) {
      for (const name of candidates) matches.add(join(dir, name));
    }
  }
  return [...matches].sort();
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
  const started = Date.now();
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < verifies.length) {
      const file = verifies[cursor];
      cursor += 1;
      const result = await new Promise((resolve) => {
        exec(`npx tsx ${file}`, { maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
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

main();
