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
import { readdirSync } from 'node:fs';
import { matchingVerifies, verifyCommand } from './run-affected-verifies.mjs';

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

// ── non-source changes select nothing ──────────────────────────────────────
{
  assert.deepEqual(matchingVerifies(['README.md', 'assets/x.png']), [],
    'documentation and assets have no verify suites');
  assert.deepEqual(matchingVerifies(['no/such/dir/file.ts']), [],
    'a missing directory is skipped rather than throwing');
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
}

console.log('run-affected-verifies.verify: affected selection never shrinks silently');
