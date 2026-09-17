// Gate: every .frag shader has an up-to-date generated .frag.ts twin.
//
// The twins are what the GL catalogs import (Vite resolves `?raw` nowhere but in
// its own client build graph — not in Node, not in the desktop esbuild bundle, and
// not in the rolldown step that bundles config/vite.config.ts, which is how a stale
// or missing twin takes the whole app build down). Editing a .frag without
// regenerating silently renders nothing, so this runs in the suite.
//
// Fix: node scripts/sync-shader-sources.mjs
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = execFileSync(
  process.execPath,
  [resolve(root, 'scripts', 'sync-shader-sources.mjs'), '--check'],
  { cwd: root, encoding: 'utf8' },
);
process.stdout.write(output.trim() + '\n');
