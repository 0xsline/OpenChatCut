// Gate: every .frag shader has an up-to-date generated .frag.ts twin.
//
// The twins are what the GL catalogs import (Vite resolves `?raw` nowhere but in
// its own client build graph — not in Node, not in the desktop esbuild bundle, and
// not in the rolldown step that bundles config/vite.config.ts, which is how a stale
// or missing twin takes the whole app build down). Editing a .frag without
// regenerating silently renders nothing, so this runs in the suite.
//
// Fix: node scripts/sync-shader-sources.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts', 'sync-shader-sources.mjs');
const output = execFileSync(process.execPath, [script, '--check'], { cwd: root, encoding: 'utf8' });
process.stdout.write(output.trim() + '\n');

// The Windows packaging job checks out with core.autocrlf, so every .frag and
// twin arrives with CRLF, and a check that compared bytes failed `npm run build`
// there. Rebuild that checkout in a temp tree (the script takes its root from its
// own path) and require the same verdicts: current twins pass, and an edited
// shader still reads as stale.
const glRoot = join(root, 'src', 'gl');
const glFiles = readdirSync(glRoot, { recursive: true })
  .filter((name) => name.endsWith('.frag') || name.endsWith('.frag.ts'));
const shaders = glFiles.filter((name) => name.endsWith('.frag'));
assert.ok(shaders.length > 0, 'src/gl has .frag shaders');

const crlfRoot = mkdtempSync(join(tmpdir(), 'occ-shader-crlf-'));
try {
  const crlfScript = join(crlfRoot, 'scripts', 'sync-shader-sources.mjs');
  mkdirSync(dirname(crlfScript), { recursive: true });
  copyFileSync(script, crlfScript);
  for (const name of glFiles) {
    const target = join(crlfRoot, 'src', 'gl', name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(glRoot, name), 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  const runCheck = () => spawnSync(process.execPath, [crlfScript, '--check'], { cwd: crlfRoot, encoding: 'utf8' });

  const current = runCheck();
  assert.equal(current.status, 0, `a CRLF checkout reads as out of sync:\n${current.stderr}`);
  assert.match(current.stdout, new RegExp(`in sync \\(${shaders.length} shaders\\)`));

  const edited = join(crlfRoot, 'src', 'gl', shaders[0]);
  writeFileSync(edited, `// edited\r\n${readFileSync(edited, 'utf8')}`);
  const stale = runCheck();
  assert.notEqual(stale.status, 0, 'an edited CRLF shader must fail the check');
  assert.ok(stale.stderr.includes(`stale ${join('src', 'gl', `${shaders[0]}.ts`)}`), stale.stderr);
} finally {
  rmSync(crlfRoot, { recursive: true, force: true });
}
console.log(`shader-sources.verify: a CRLF checkout of ${shaders.length} shaders is in sync, and an edited one is stale`);
