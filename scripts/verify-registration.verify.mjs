// A verify file that no script runs is not a test — it is a file that agrees
// with whatever the code does. 55 of the repo's tracked verifies had drifted
// into that state, including regression tests for data-loss bugs, and nothing
// reported it because the suite only ever ran what `test:serial` listed.
//
// This asserts every tracked *.verify.* file is reachable from an npm script.
// npm test runs scripts/run-tests.mjs, which splits `test:serial` on `&&`, so
// "registered" means "named somewhere in package.json scripts".
// node scripts/verify-registration.verify.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Verifies deliberately left out of the suite, each with the reason it cannot
 * run unattended (needs real credentials, hardware, or a human). Adding a name
 * here is a decision to stop testing it — say why.
 */
const EXCLUDED = new Map([]);

const root = new URL('..', import.meta.url).pathname;
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((file) => /\.verify\.(ts|tsx|mjs)$/.test(file));

assert.ok(tracked.length > 100, `expected the repo to track many verifies, found ${tracked.length}`);

const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
const allCommands = Object.values(scripts).join(' && ');

const unregistered = tracked.filter((file) => !allCommands.includes(file) && !EXCLUDED.has(file));
assert.deepEqual(
  unregistered,
  [],
  `these verify files are never run — add them to package.json "test:serial", or to EXCLUDED in ${
    'scripts/verify-registration.verify.mjs'} with the reason they cannot run:\n  ${unregistered.join('\n  ')}`,
);

// An exclusion for a file that no longer exists hides the next one behind it.
const staleExclusions = [...EXCLUDED.keys()].filter((file) => !tracked.includes(file));
assert.deepEqual(staleExclusions, [], `EXCLUDED names files that are not tracked verifies: ${staleExclusions.join(', ')}`);

console.log(`verify-registration.verify: all ${tracked.length} tracked verify files are registered`);
