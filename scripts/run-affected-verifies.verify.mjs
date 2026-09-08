// verify:affected is the loop developers actually run; npm test is the gate.
// A fast runner that quietly runs nothing is worse than a slow one, and this
// runner did exactly that: the directory fallback bailed out when a directory
// held more than 8 verifies and printed "no affected verifies" — success —
// which silently covered 16 directories and 433 of the repo's verify files,
// the busiest ones included. It also only ever matched `.verify.ts`, leaving
// every `.verify.tsx` and `.verify.mjs` unreachable, and it assumed every
// suite runs under `npx tsx`, which is false for the ones importing Vite-only
// `?raw`/`.frag` modules.
// node scripts/run-affected-verifies.verify.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { affectedSelection, gitChanged, matchingVerifies, verifyCommand } from './run-affected-verifies.mjs';

const countIn = (dir, re = /\.verify\.(ts|tsx|mjs)$/) => readdirSync(dir).filter((n) => re.test(n)).length;

// ── a per-file verify wins: just that one, nothing else in the directory ────
{
  const picked = matchingVerifies(['src/export/browserExport.ts']);
  assert.deepEqual(picked, ['src/export/browserExport.verify.ts'],
    'an exact same-name verify is the whole selection');
}

// ── no per-file verify: the directory suite runs, however big ───────────────
{
  // src/components/timeline holds 17 verifies; the old >8 bail-out returned [].
  const picked = matchingVerifies(['src/components/timeline/useTimelineController.ts']);
  const expected = countIn('src/components/timeline');
  assert.ok(expected > 8, 'fixture directory must be past the old cutoff');
  assert.equal(picked.length, expected,
    'a directory larger than the old cutoff must run, not silently select nothing');
  assert.ok(picked.every((p) => p.startsWith('src/components/timeline/')), 'stays in the directory');
}

{
  // The largest directory in the repo, and the one most edited.
  const picked = matchingVerifies(['src/agent/tools/beat-tools.ts']);
  assert.equal(picked.length, countIn('src/agent/tools'));
  assert.ok(picked.length > 40, 'src/agent/tools is the worst case and must not be skipped');
}

// ── .tsx and .mjs suites are reachable ─────────────────────────────────────
{
  const picked = matchingVerifies(['remotion/render-timeout.mjs']);
  assert.deepEqual(picked, ['remotion/render-timeout.verify.mjs'],
    'an .mjs verify matches its .mjs source');

  const preview = matchingVerifies(['src/components/preview/previewCanvasGeometry.ts']);
  assert.ok(preview.some((p) => p.endsWith('.verify.tsx')),
    '.tsx verifies must be selectable');
}

// ── runtime assets/global changes need an explicit broader gate ────────────
{
  assert.deepEqual(affectedSelection(['README.md']), { verifies: [], requiresFullGate: [] });
  for (const file of ['assets/x.png', 'package.json', 'package-lock.json', 'config/vite.config.ts',
    'shared/project-version.ts', 'no/such/dir/file.ts', 'src/agent/skills/new/SKILL.md']) {
    assert.ok(affectedSelection([file]).requiresFullGate.includes(file), `${file} cannot silently pass`);
  }
  assert.ok(matchingVerifies(['src/gl/fx/invert.frag']).includes('src/gl/clipFxExport.verify.mjs'),
    'shader changes reach the render verification in the parent directory');
  assert.ok(matchingVerifies(['desktop/prepare-target.mts']).includes('desktop/desktop.verify.ts'),
    '.mts sources reach their directory suites');
}

// ── the command matches what the suite itself uses ─────────────────────────
{
  // These two reach a Vite-only `?raw` import and fail under bare tsx.
  for (const file of [
    'src/agent/tools/effect-tools.verify.ts',
    'src/agent/tools/library-edit-item.verify.ts',
  ]) {
    assert.match(verifyCommand(file), /run-check\.mjs/,
      `${file} must run through run-check.mjs, as package.json does`);
  }
  assert.match(verifyCommand('src/export/browserExport.verify.ts'), /tsx/,
    'ordinary suites run under tsx');
  // A registered suite always uses package.json's own command, whatever it is —
  // remotion/render-timeout.verify.mjs is registered under tsx, not node, and
  // this runner must not "correct" it.
  assert.equal(
    verifyCommand('remotion/render-timeout.verify.mjs'),
    'tsx remotion/render-timeout.verify.mjs',
    'the registered command wins over any extension-based guess',
  );
  // Only unregistered files fall back, and then the extension decides.
  assert.match(verifyCommand('src/does/not/exist.verify.ts'), /^npx tsx /,
    'an unregistered .ts suite still gets a usable default');
  assert.match(verifyCommand('src/does/not/exist.verify.mjs'), /^node /,
    'an unregistered .mjs suite falls back to bare node');
  assert.match(verifyCommand('src/does/not/exist.verify.cjs'), /^node /);
  assert.match(verifyCommand('src/does/not/exist.verify.js'), /^node /);
  assert.match(verifyCommand('src/does/not/exist.verify.mts'), /^npx tsx /);
}

const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'openchatcut-affected-')));
try {
  mkdirSync(join(temporary, 'scripts'));
  mkdirSync(join(temporary, 'src'));
  for (const extension of ['mts', 'js', 'cjs']) {
    writeFileSync(join(temporary, `src/example.verify.${extension}`), '');
  }
  assert.equal(affectedSelection(['src/example.js'], temporary).verifies.length, 3,
    'all supported same-name suites run, not just the first directory entry');
  assert.deepEqual(affectedSelection(['src/example.verify.cjs'], temporary).verifies,
    ['src/example.verify.cjs'], 'an edited verify runs itself');

  // A real isolated Git repository proves both tracked and untracked collection.
  const git = (...args) => execFileSync('git', ['-C', temporary, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=Verify', '-c', 'user.email=verify@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'test fixture');
  git('add', 'src/example.verify.js');
  assert.deepEqual((await gitChanged(temporary)).sort(), [
    'src/example.verify.cjs', 'src/example.verify.js', 'src/example.verify.mts',
  ]);

  // Execute only tiny fixture suites, never the real expensive selected suite.
  for (const runner of ['run-tests.mjs', 'run-affected-verifies.mjs']) {
    copyFileSync(new URL(runner, import.meta.url), join(temporary, 'scripts', runner));
  }
  const script = `node -e "console.log('fixture passed')"`;
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ scripts: { 'test:serial': script } }));
  const run = (runner, args = []) => spawnSync(process.execPath, [join(temporary, 'scripts', runner), ...args], {
    cwd: temporary, encoding: 'utf8', env: { ...process.env, TEST_CONCURRENCY: '1' },
  });
  const serial = run('run-tests.mjs');
  assert.equal(serial.status, 0, serial.stderr);
  assert.match(serial.stdout, /\(1 parallel\)/);
  const affected = run('run-affected-verifies.mjs', ['src/example.verify.cjs']);
  assert.equal(affected.status, 0, affected.stderr);
  assert.match(affected.stdout, /\(1 parallel\)/);
  const broader = run('run-affected-verifies.mjs', ['--list', 'package.json']);
  assert.equal(broader.status, 2);
  assert.match(broader.stderr, /broader gate: npm run lint && npm test && npm run build/);

  writeFileSync(join(temporary, 'src/example.verify.cjs'),
    `console.log('stdout failure detail'); console.error('stderr failure detail'); process.exit(1);`);
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({
    scripts: { 'test:serial': 'node src/example.verify.cjs' },
  }));
  for (const runner of ['run-tests.mjs', 'run-affected-verifies.mjs']) {
    const failure = run(runner, runner.startsWith('run-affected') ? ['src/example.verify.cjs'] : []);
    assert.equal(failure.status, 1);
    assert.match(failure.stdout, /stdout failure detail/);
    assert.match(failure.stdout, /stderr failure detail/);
  }
  const missingGit = spawnSync(process.execPath, [resolve('scripts/run-affected-verifies.mjs')], {
    cwd: tmpdir(), encoding: 'utf8',
  });
  assert.equal(missingGit.status, 1, 'Git failure must not become a successful empty selection');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log('run-affected-verifies.verify: affected selection never shrinks silently');
