// Generate a Node/vite-config-loadable module for every GL shader source.
//
// Why: the GL catalogs used to import shaders as `./x.frag?raw`. Vite resolves
// that in the browser build, but no other loader does — not Node (tsx), not the
// desktop esbuild bundle, and not the rolldown step that bundles
// config/vite.config.ts before Vite starts. That last one is why the whole app
// build failed the moment a server module reached the GL catalogs.
//
// Each `.frag` stays the authored source (syntax highlighting, one source of
// truth); this script emits `<shader>.frag.ts` next to it, and
// `--check` fails when a twin is missing, stale, or orphaned.
//
// Usage: node scripts/sync-shader-sources.mjs [--check]
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const SUFFIX = '.frag';
const TWIN_SUFFIX = '.frag.ts';

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else found.push(full);
  }
  return found;
}

function twinPath(shaderPath) {
  return `${shaderPath}.ts`;
}

function twinContent(shaderPath, text) {
  return [
    `// GENERATED from ${relative(root, shaderPath)} by scripts/sync-shader-sources.mjs — do not edit.`,
    `export default ${JSON.stringify(text)};`,
    '',
  ].join('\n');
}

const files = await walk(join(root, 'src', 'gl'));
const shaders = files.filter((file) => file.endsWith(SUFFIX) && !file.endsWith(TWIN_SUFFIX));
const stale = [];
let written = 0;

for (const shader of shaders) {
  const text = await readFile(shader, 'utf8');
  const expected = twinContent(shader, text);
  const twin = twinPath(shader);
  const current = existsSync(twin) ? await readFile(twin, 'utf8') : null;
  if (current === expected) continue;
  if (check) {
    stale.push(current === null ? `missing ${relative(root, twin)}` : `stale ${relative(root, twin)}`);
    continue;
  }
  await writeFile(twin, expected);
  written += 1;
}

if (check) {
  const expectedTwins = new Set(shaders.map(twinPath));
  const orphans = files
    .filter((file) => file.endsWith(TWIN_SUFFIX) && !expectedTwins.has(file))
    .map((file) => `orphan ${relative(root, file)}`);
  const problems = [...stale, ...orphans];
  if (problems.length > 0) {
    console.error(`shader sources out of sync${problems.length ? ':' : ''}`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('Run: node scripts/sync-shader-sources.mjs');
    process.exit(1);
  }
  console.log(`shader sources in sync (${shaders.length} shaders)`);
} else {
  console.log(`shader sources: ${written} written, ${shaders.length - written} already current`);
}
