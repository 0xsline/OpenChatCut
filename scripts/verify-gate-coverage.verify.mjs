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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log(`gate coverage checks passed (${onDisk.length} verify files, all reachable from npm test)`);
