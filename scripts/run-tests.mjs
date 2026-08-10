// Parallel test runner: executes every segment of the `test` script with a
// bounded concurrency (one child process per segment — verifies are isolated
// by their own HOME/temp dirs, so processes never share state).
//
// Falls back to serial execution on failure collection so a broken verify
// shows its output next to its name. Usage: npm test.
import { exec } from 'node:child_process';
import { cpus } from 'node:os';
import { readFileSync } from 'node:fs';

// Concurrency budget: many verifies are heavyweight (model loads, vite
// builds, ffmpeg, rendering) and a full parallel suite can exhaust RAM on
// smaller machines (measured: 8 workers × heavy suites filled swap on a
// 32 GB Mac and froze the system). Default 4 is safe; raise explicitly with
// TEST_CONCURRENCY=8 on machines with headroom (and a page file).

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const segments = pkg.scripts.test.split('&&').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(2, Math.min(8, Number(process.env.TEST_CONCURRENCY) || 4));

const run = (command) => new Promise((resolve) => {
  exec(command, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ command, error, output: (stderr || stdout).slice(-1200) });
  });
});

async function main() {
  const started = Date.now();
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < segments.length) {
      const command = segments[cursor];
      cursor += 1;
      const result = await run(command);
      const name = command.slice(0, 90);
      process.stdout.write(`${result.error ? '❌' : '✅'} ${name}\n`);
      results.push(result);
    }
  });
  await Promise.all(workers);
  const failed = results.filter((r) => r.error);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (failed.length === 0) {
    console.log(`\n✓ ${results.length} test segments passed in ${elapsed}s (${CONCURRENCY} parallel)`);
    process.exit(0);
  }
  console.log(`\n✗ ${failed.length}/${results.length} segments FAILED in ${elapsed}s:`);
  for (const f of failed) {
    console.log(`\n--- ${f.command} ---`);
    console.log(f.output);
  }
  process.exit(1);
}

main();
